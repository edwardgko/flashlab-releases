import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { formatTime } from '../lib/time.js'
import { resolveDuration } from '../lib/video.js'
import { probeAudioDuration, useTrackMixPreview } from '../lib/audio.js'
import { COLOR_PALETTE } from './SchemaEditor.jsx'
import AudioTimeline from './AudioTimeline.jsx'

const MIN_GAP = 0.2

// mueve el playhead y espera a que el salto se complete de verdad. Con un
// timeout de seguridad: si el archivo no puede posicionarse ahí (grabación
// sin índice de búsqueda), no queremos quedarnos colgados esperando.
function seekAndWait(video, time) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      video.removeEventListener('seeked', finish)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, 1500)
    video.addEventListener('seeked', finish)
    video.currentTime = time
  })
}

// Editor de grabaciones: recorte (dual-range, sin cambios) + timeline
// multi-pista de audio (AudioTimeline). Las pistas se mezclan todas juntas
// con el audio original (no lo reemplazan por default) y cada una se puede
// arrastrar a cualquier posición del timeline de salida — ver el plan
// aprobado para el porqué de cada decisión de diseño.
//
// La edición sobrescribe la grabación original (decisión del usuario) — el
// main process nunca pisa el archivo/metadata viejos hasta que ffmpeg
// termina bien (ver replaceRecordingAsset en electron/main.js), así que un
// error acá no arriesga nada.
export default function RecordingEditor({ rec, pageId, onClose, onSaved }) {
  const videoRef = useRef(null)
  const [duration, setDuration] = useState(0)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [originalTrack, setOriginalTrack] = useState({ volume: 1, muted: false })
  const [tracks, setTracks] = useState([])
  const [applying, setApplying] = useState(false)
  const [progressPct, setProgressPct] = useState(0)
  const [error, setError] = useState('')
  // en Windows, abrir una grabación recién terminada (todavía "tibia" en
  // disco) a veces falla la primera vez — el <video> nunca llega a
  // `loadedmetadata` y queda en blanco — pero abrirla de nuevo siempre
  // funciona (reportado por el usuario: cerrar y volver a abrir "arregla"
  // el editor). En vez de obligar a ese paso manual, un solo reintento
  // automático hace lo mismo: reasignar `.src` + `.load()` en el MISMO
  // elemento (no remontarlo con una `key` nueva) — remontar rompería a los
  // otros efectos de acá abajo y de useTrackMixPreview (audio.js), que
  // atan sus listeners una sola vez al montar y quedarían escuchando al
  // <video> viejo si el DOM real cambiara por debajo.
  const [loadingVideo, setLoadingVideo] = useState(true)
  const retriedRef = useRef(false)

  const handleVideoError = () => {
    if (retriedRef.current) return
    retriedRef.current = true
    setTimeout(() => {
      const video = videoRef.current
      if (!video) return
      video.src = rec.url
      video.load()
    }, 400)
  }

  // La duración se pide a ffmpeg apenas se abre el editor, SIN depender de
  // ningún evento del <video>: si 'loadedmetadata' no llega (que es
  // justamente el caso que rompía el editor la primera vez), igual quedamos
  // con la duración correcta y el recorte usable. handleLoadedMetadata más
  // abajo la vuelve a resolver cuando el elemento sí carga — el que llegue
  // primero con un valor válido gana, el otro no pisa nada.
  useEffect(() => {
    let cancelled = false
    api
      .probeAssetDuration?.(rec.url)
      .then((probed) => {
        if (cancelled || !Number.isFinite(probed) || probed <= 0) return
        setDuration((prev) => prev || probed)
        setTrimEnd((prev) => prev || probed)
        setLoadingVideo(false)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [rec.url])

  const videoLen = Math.max(trimEnd - trimStart, 0)
  const trimmed = trimStart > MIN_GAP / 2 || trimEnd < duration - MIN_GAP / 2
  const hasAudioChange = originalTrack.muted || originalTrack.volume !== 1 || tracks.length > 0

  // el audio original se previsualiza nativo (video.volume/video.muted) — sin
  // límite de duración ni costo de decode; las pistas agregadas se
  // previsualizan vía Web Audio, sincronizadas por eventos play/pause/seeked
  useTrackMixPreview({ videoRef, tracks, trimStart })

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = originalTrack.muted
    video.volume = Math.min(1, Math.max(0, originalTrack.volume))
  }, [originalTrack])

  // posición del playhead mientras está pausado (arrastrar los handles hace
  // seek y eso dispara timeupdate). El corte en trimEnd NO se hace acá: ver
  // el efecto de abajo — timeupdate solo dispara ~4 veces por segundo, muy
  // poco para frenar justo en el punto de fin.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTimeUpdate = () => setCurrentTime(video.currentTime)
    video.addEventListener('timeupdate', onTimeUpdate)
    return () => video.removeEventListener('timeupdate', onTimeUpdate)
  }, [])

  // el estado `playing` maneja el ícono ▶/⏸ y el intervalo de corte, así que
  // tiene que seguir al <video> de verdad y no solo al botón: si la
  // reproducción se detiene por cualquier otra vía (fin del archivo, el
  // navegador la interrumpe), el ícono quedaría mostrando ⏸ sobre un video
  // ya pausado y el primer click siguiente no haría nada visible
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [])

  // mientras reproduce: cortar exactamente en trimEnd. Se chequea con un
  // intervalo (cada 40ms) y no con requestAnimationFrame ni con timeupdate:
  // rAF se congela cuando la ventana no está dibujando (minimizada, en
  // segundo plano) y timeupdate solo dispara ~4 veces por segundo. Con el
  // intervalo, la vista previa reproduce SOLO el tramo entre inicio y fin.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !playing) return
    const id = setInterval(() => {
      if (video.currentTime >= trimEnd) {
        video.pause()
        video.currentTime = trimStart
        setCurrentTime(trimStart)
        setPlaying(false)
        return
      }
      setCurrentTime(video.currentTime)
    }, 40)
    return () => clearInterval(id)
  }, [playing, trimStart, trimEnd])

  useEffect(
    () =>
      api.onRecordingEditProgress((payload) => {
        if (payload.recordingId !== rec.id) return
        setProgressPct(payload.pct)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rec.id]
  )

  const handleLoadedMetadata = async () => {
    const video = videoRef.current
    if (!video) return
    const realDuration = await resolveDuration(video, rec.url)
    setDuration(realDuration)
    setTrimEnd(realDuration)
    setLoadingVideo(false)
  }

  // arrastrar los handles de recorte dispara onChange en cada tick del
  // drag — asignar video.currentTime en cada uno sin esperar satura al
  // decoder (esta grabación no tiene un keyframe en cada frame) y el
  // cuadro que se ve queda atrasado/pegado respecto de dónde está el
  // handle ("no encaja" con el rango). Acá se encola solo el ÚLTIMO valor
  // pedido mientras hay un seek en vuelo, y recién se dispara cuando el
  // anterior termina (o a los 700ms si el archivo no puede resolverlo,
  // mismo tipo de timeout de seguridad que seekAndWait).
  const seekStateRef = useRef({ seeking: false, pending: null })

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let watchdog = null
    const flushNext = () => {
      clearTimeout(watchdog)
      const state = seekStateRef.current
      const next = state.pending
      if (next === null) {
        state.seeking = false
        return
      }
      state.pending = null
      video.currentTime = next
      watchdog = setTimeout(flushNext, 700)
    }
    video.addEventListener('seeked', flushNext)
    return () => {
      video.removeEventListener('seeked', flushNext)
      clearTimeout(watchdog)
    }
  }, [])

  const seek = (time) => {
    const video = videoRef.current
    if (!video) return
    const state = seekStateRef.current
    if (state.seeking) {
      state.pending = time
      return
    }
    state.seeking = true
    video.currentTime = time
  }

  const handleStartChange = (event) => {
    const value = Math.min(Number(event.target.value), trimEnd - MIN_GAP)
    setTrimStart(value)
    seek(value)
  }

  const handleEndChange = (event) => {
    const value = Math.max(Number(event.target.value), trimStart + MIN_GAP)
    setTrimEnd(value)
    seek(value)
  }

  const togglePlay = async () => {
    const video = videoRef.current
    if (!video) return
    if (playing) {
      video.pause()
      setPlaying(false)
      return
    }
    // si el playhead está fuera del recorte hay que volver al inicio ANTES de
    // reproducir, y esperar a que el salto termine de verdad: en grabaciones
    // largas (escritas por chunks, sin índice de búsqueda) el seek tarda, y
    // llamar a play() sin esperarlo arrancaba la reproducción desde donde
    // estuviera el video — normalmente el segundo 0, ignorando el recorte.
    if (video.currentTime < trimStart || video.currentTime >= trimEnd - 0.05) {
      // descartar cualquier seek de arrastre todavía encolado: si quedara
      // pendiente, se dispararía al terminar este salto y movería el
      // playhead fuera del inicio justo antes de reproducir
      seekStateRef.current = { seeking: false, pending: null }
      await seekAndWait(video, trimStart)
    }
    try {
      await video.play()
      setPlaying(true)
    } catch {
      setPlaying(false)
    }
  }

  const handleSeekTimeline = (secondsFromTrimStart) => seek(trimStart + secondsFromTrimStart)

  // Playhead de la barra de recorte: define desde dónde arranca el play.
  // Se puede clickear o arrastrar en cualquier punto de la barra, pero
  // siempre queda dentro del recorte — reproducir desde afuera del rango no
  // tendría sentido, la salida final no incluye ese tramo.
  const barRef = useRef(null)

  const movePlayheadTo = (clientX) => {
    const bar = barRef.current
    if (!bar || !duration) return
    const rect = bar.getBoundingClientRect()
    const ratio = (clientX - rect.left) / rect.width
    const time = Math.min(trimEnd, Math.max(trimStart, ratio * duration))
    setCurrentTime(time)
    seek(time)
  }

  const handleBarPointerDown = (event) => {
    // los thumbs de recorte son los únicos hijos con pointer-events: dejarlos
    // arrastrar como siempre en vez de tratarlo como un click de playhead
    if (applying || event.target.tagName === 'INPUT') return
    event.preventDefault()
    movePlayheadTo(event.clientX)
    // el seguimiento va en window y no en la barra: si el puntero se sale del
    // elemento mientras arrastra, el playhead tiene que seguir respondiendo
    const onMove = (moveEvent) => movePlayheadTo(moveEvent.clientX)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // la duración la mide ffmpeg en el main process (ver probeMediaDuration en
  // electron/main.js) — el <audio> del renderer devuelve 0 en silencio para
  // formatos que Chromium no decodifica, y con duración 0 la pista quedaba de
  // ancho cero, muda e imposible de estirar. El probe del renderer queda solo
  // como respaldo por si el de ffmpeg no pudo leer el header.
  const importPickedAudio = async () => {
    const picked = await api.pickAudioFile()
    if (!picked) return null
    const imported = await api.importAudioAsset(picked.path)
    const sourceDuration = imported.duration || (await probeAudioDuration(imported.url))
    if (!sourceDuration) throw new Error(`no se pudo leer la duración de "${imported.name}"`)
    return { ...imported, sourceDuration }
  }

  const buildTrack = (imported, { offset, color }) => ({
    id: crypto.randomUUID(),
    path: imported.path,
    url: imported.url,
    name: imported.name,
    sourceDuration: imported.sourceDuration,
    inPoint: 0,
    // el clip arranca del largo del video: la mezcla final se corta ahí de
    // todos modos (-t videoLen), así que mostrarlo más largo sería mentir
    outPoint: Math.min(imported.sourceDuration, videoLen || imported.sourceDuration),
    offset,
    volume: 1,
    muted: false,
    color,
  })

  const handleAddTrack = async () => {
    setError('')
    try {
      const imported = await importPickedAudio()
      if (!imported) return
      setTracks((prev) => [
        ...prev,
        buildTrack(imported, {
          offset: Math.max(0, Math.min(videoLen, currentTime - trimStart)),
          color: COLOR_PALETTE[prev.length % COLOR_PALETTE.length],
        }),
      ])
    } catch (err) {
      setError(err.message || 'no se pudo agregar la pista')
    }
  }

  const handleChangeTrack = (id, patch) => setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  const handleDeleteTrack = (id) => setTracks((prev) => prev.filter((t) => t.id !== id))

  // reordena la LISTA (arriba/abajo) — no afecta la mezcla en sí, todas las
  // pistas suenan juntas independientemente del orden; es puramente para
  // organizarse cuando hay varias pistas agregadas
  const handleReorderTracks = (dragId, dropId, side) => {
    setTracks((prev) => {
      const dragged = prev.find((t) => t.id === dragId)
      if (!dragged) return prev
      const rest = prev.filter((t) => t.id !== dragId)
      let insertAt = rest.findIndex((t) => t.id === dropId)
      if (insertAt === -1) return prev
      if (side === 'after') insertAt += 1
      const next = [...rest]
      next.splice(insertAt, 0, dragged)
      return next
    })
  }
  const handleChangeOriginal = (patch) => setOriginalTrack((prev) => ({ ...prev, ...patch }))

  const handleApply = async () => {
    setError('')
    setApplying(true)
    setProgressPct(0)
    try {
      const result = await api.applyRecordingEdits(pageId, rec.id, {
        trim: { start: trimStart, end: trimEnd },
        originalTrack,
        tracks: tracks.map(({ id, path, inPoint, outPoint, offset, volume, muted }) => ({
          id,
          path,
          inPoint,
          outPoint,
          offset,
          volume,
          muted,
        })),
      })
      onSaved(result)
      onClose()
    } catch (err) {
      setError(err.message || 'no se pudo aplicar la edición')
      setApplying(false)
    }
  }

  const closeIfIdle = () => {
    if (!applying) onClose()
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={closeIfIdle} />
      <div className="fixed left-1/2 top-1/2 z-40 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <p className="mb-3 text-sm font-semibold text-gray-800 dark:text-neutral-100">Editar grabación</p>

        <div className="relative">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            src={rec.url}
            controls={false}
            onLoadedMetadata={handleLoadedMetadata}
            onError={handleVideoError}
            className="w-full rounded-lg border border-gray-200 bg-black dark:border-neutral-700"
          />
          {loadingVideo && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 text-xs text-white/80">
              Cargando video…
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            disabled={applying}
            className="shrink-0 rounded-md border border-gray-200 px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {playing ? '⏸' : '▶'}
          </button>

          <div
            ref={barRef}
            onPointerDown={handleBarPointerDown}
            className="relative h-6 min-w-0 flex-1 cursor-pointer"
          >
            <div className="absolute inset-y-0 my-auto h-1.5 w-full rounded-full bg-gray-200 dark:bg-neutral-700" />
            <div
              className="absolute inset-y-0 my-auto h-1.5 rounded-full bg-blue-500"
              style={{
                left: duration ? `${(trimStart / duration) * 100}%` : 0,
                right: duration ? `${100 - (trimEnd / duration) * 100}%` : 0,
              }}
            />
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.05}
              value={trimStart}
              onChange={handleStartChange}
              disabled={applying}
              className="pointer-events-none absolute inset-0 h-full w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-blue-600 [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-600"
            />
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.05}
              value={trimEnd}
              onChange={handleEndChange}
              disabled={applying}
              className="pointer-events-none absolute inset-0 h-full w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-blue-600 [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-600"
            />
            {/* va último a propósito: así la línea se dibuja por encima de los
                thumbs de recorte y no queda tapada cuando el play arranca
                justo sobre el inicio o el fin */}
            {duration > 0 && (
              <div
                className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-gray-900 dark:bg-white"
                style={{ left: `${(currentTime / duration) * 100}%` }}
              >
                <div className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-gray-900 dark:bg-white" />
              </div>
            )}
          </div>
        </div>
        <div className="mt-1 flex justify-between text-xs text-gray-400 dark:text-neutral-500">
          <span>Inicio {formatTime(trimStart)}</span>
          <span>
            Duración {formatTime(trimEnd - trimStart)} · ▶ desde {formatTime(currentTime)}
          </span>
          <span>Fin {formatTime(trimEnd)}</span>
        </div>

        <AudioTimeline
          videoLen={Math.max(videoLen, 0.01)}
          playheadTime={Math.max(0, Math.min(videoLen, currentTime - trimStart))}
          onSeek={handleSeekTimeline}
          originalTrack={originalTrack}
          onChangeOriginal={handleChangeOriginal}
          tracks={tracks}
          onChangeTrack={handleChangeTrack}
          onDeleteTrack={handleDeleteTrack}
          onAddTrack={handleAddTrack}
          onReorderTracks={handleReorderTracks}
          disabled={applying}
        />

        {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}

        {applying ? (
          <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-neutral-700">
              <div
                className="h-full rounded-full bg-blue-500 transition-[width]"
                style={{ width: `${Math.round(progressPct * 100)}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-gray-400 dark:text-neutral-500">
              Aplicando cambios… {Math.round(progressPct * 100)}% — los videos largos pueden tardar varios minutos.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!trimmed && !hasAudioChange}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              Aplicar
            </button>
          </div>
        )}
      </div>
    </>
  )
}
