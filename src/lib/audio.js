import { useEffect, useRef, useState } from 'react'

const MAX_WAVEFORM_SECONDS = 20 * 60 // audios más largos no se decodifican: se muestra una barra plana
const PEAK_RESOLUTION = 2000 // buckets de min/max sobre toda la fuente, independiente del zoom del timeline

let sharedContext = null
// un solo AudioContext compartido para decodificar waveforms (acá) y para
// programar la reproducción en vivo de las pistas agregadas (RecordingEditor) —
// crear varios contextos es innecesario y algunos navegadores limitan la cantidad.
export function getAudioContext() {
  if (!sharedContext) sharedContext = new (window.AudioContext || window.webkitAudioContext)()
  return sharedContext
}

// un <audio> nunca insertado en el DOM no puede cargar appasset:// (mismo bug
// ya visto con un <video> "suelto": Chromium tira net::ERR_UNEXPECTED en vez
// de disparar loadedmetadata) — sin esto, esta función siempre resolvía 0 y
// loadTrackAudio() de más abajo nunca llegaba a decodificar nada: ni
// waveform ni audio en la edición en vivo.
export function probeAudioDuration(url) {
  return new Promise((resolve) => {
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.style.display = 'none'
    document.body.appendChild(audio)
    const cleanup = (value) => {
      audio.remove()
      resolve(value)
    }
    audio.onloadedmetadata = () => cleanup(Number.isFinite(audio.duration) ? audio.duration : 0)
    audio.onerror = () => cleanup(0)
    audio.src = url
  })
}

function computePeaks(audioBuffer, bucketCount) {
  const channelCount = audioBuffer.numberOfChannels
  const length = audioBuffer.length
  const samplesPerBucket = Math.max(1, Math.floor(length / bucketCount))
  const channels = []
  for (let c = 0; c < channelCount; c++) channels.push(audioBuffer.getChannelData(c))
  const peaks = new Float32Array(bucketCount * 2)
  for (let b = 0; b < bucketCount; b++) {
    const start = b * samplesPerBucket
    const end = Math.min(length, start + samplesPerBucket)
    let min = 0
    let max = 0
    for (let i = start; i < end; i++) {
      for (let c = 0; c < channelCount; c++) {
        const v = channels[c][i]
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    peaks[b * 2] = min
    peaks[b * 2 + 1] = max
  }
  return peaks
}

const decodeCache = new Map() // url -> Promise<{peaks: Float32Array|null, duration: number, audioBuffer: AudioBuffer|null}>

// decodifica una vez por url (cacheado) — audios de más de 20min no se
// decodifican completos (costo de memoria/tiempo en el renderer), quedan sin
// waveform y sin preview en vivo, pero siguen sonando bien en la mezcla
// final (eso corre en el main process vía ffmpeg, sin este límite). El mismo
// AudioBuffer decodificado se reusa para dibujar la waveform Y para
// programar la reproducción en vivo (RecordingEditor) — un solo decode por pista.
function loadTrackAudio(url) {
  if (!url) return Promise.resolve(null)
  if (decodeCache.has(url)) return decodeCache.get(url)
  const promise = (async () => {
    const duration = await probeAudioDuration(url)
    if (!duration || duration > MAX_WAVEFORM_SECONDS) return { peaks: null, duration, audioBuffer: null }
    const response = await fetch(url)
    const buffer = await response.arrayBuffer()
    const audioBuffer = await getAudioContext().decodeAudioData(buffer)
    return { peaks: computePeaks(audioBuffer, PEAK_RESOLUTION), duration: audioBuffer.duration, audioBuffer }
  })().catch(() => ({ peaks: null, duration: 0, audioBuffer: null }))
  decodeCache.set(url, promise)
  return promise
}

export function useWaveformPeaks(url) {
  const [state, setState] = useState(null)
  useEffect(() => {
    if (!url) {
      setState(null)
      return
    }
    let cancelled = false
    loadTrackAudio(url).then((result) => {
      if (!cancelled) setState(result)
    })
    return () => {
      cancelled = true
    }
  }, [url])
  return state
}

// para el scheduler de preview en vivo: mismo caché, pero solo interesa el
// AudioBuffer ya decodificado (o null si superó el tope o todavía no cargó)
export async function getDecodedAudioBuffer(url) {
  if (!url) return null
  const result = await loadTrackAudio(url)
  return result?.audioBuffer ?? null
}

// Reproducción con mezcla en vivo de las pistas agregadas, sincronizada al
// <video> por eventos (no hay forma de "pausar y reanudar" un
// AudioBufferSourceNode, así que cada play/seek arranca fuentes nuevas).
// El audio ORIGINAL no pasa por acá — RecordingEditor lo maneja mapeando
// originalTrack.volume/muted directo a video.volume/video.muted (nativo, sin
// límite de duración ni costo de decode).
export function useTrackMixPreview({ videoRef, tracks, trimStart }) {
  const nodesRef = useRef(new Map()) // trackId -> { gain, source: AudioBufferSourceNode|null }
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const trimStartRef = useRef(trimStart)
  trimStartRef.current = trimStart
  // cada scheduleAll/stopAll reclama una generación nueva; una llamada vieja
  // que sigue esperando un await (decode, ctx.resume) chequea esto al volver
  // y aborta si ya quedó obsoleta — sin esto, un seek rápido mientras un
  // decode todavía está en vuelo podía terminar arrancando una fuente que
  // ya nadie referencia (huérfana, sonando para siempre)
  const genRef = useRef(0)

  // volumen/mute en caliente (solo toca el GainNode ya existente, nunca
  // reprograma) + para de sonar y libera cualquier pista que ya no esté en
  // `tracks` (si se borra una pista mientras está sonando, no debe quedar huérfana)
  useEffect(() => {
    const currentIds = new Set(tracks.map((t) => t.id))
    for (const [id, entry] of nodesRef.current) {
      if (!currentIds.has(id)) {
        try {
          entry.source?.stop()
        } catch {
          // ya estaba detenido
        }
        try {
          entry.gain.disconnect()
        } catch {
          // nada que desconectar
        }
        nodesRef.current.delete(id)
      }
    }
    for (const t of tracks) {
      const entry = nodesRef.current.get(t.id)
      if (entry) entry.gain.gain.value = t.muted ? 0 : t.volume
    }
  }, [tracks])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    function stopAll() {
      genRef.current += 1
      for (const [id, entry] of nodesRef.current) {
        try {
          entry.source?.stop()
        } catch {
          // ya estaba detenido
        }
        nodesRef.current.set(id, { gain: entry.gain, source: null })
      }
    }

    async function scheduleAll() {
      const myGen = ++genRef.current
      const ctx = getAudioContext()
      if (ctx.state === 'suspended') await ctx.resume()
      const activeTracks = tracksRef.current.filter((t) => !t.muted)
      // los decodes se piden todos en paralelo y se espera a que terminen
      // TODOS antes de programar nada — con un await por pista adentro del
      // for (como antes), Chromium dispara un 'seeked' espurio casi
      // inmediatamente después de 'play' al arrancar un webm/vp9 (alineación
      // a keyframe), y esa segunda llamada podía interponerse a mitad del
      // loop: algunas pistas ya programadas por la llamada vieja quedaban
      // huérfanas (nadie las podía parar después) y otras nunca llegaban a
      // programarse — por eso a veces "solo sonaba la primera pista".
      // Con un solo punto de espera, cada llamada o programa TODO o aborta
      // limpio sin tocar nada, sin estados a medio camino.
      const buffers = await Promise.all(activeTracks.map((t) => getDecodedAudioBuffer(t.url)))
      if (myGen !== genRef.current) return // otra llamada más nueva tomó la posta mientras esperábamos los decodes
      const outputTime = video.currentTime - trimStartRef.current
      activeTracks.forEach((t, i) => {
        const audioBuffer = buffers[i]
        if (!audioBuffer || video.paused) return
        const clipLen = t.outPoint - t.inPoint
        if (outputTime >= t.offset + clipLen) return // ya terminó de sonar

        let entry = nodesRef.current.get(t.id)
        if (!entry) {
          const gain = ctx.createGain()
          gain.connect(ctx.destination)
          entry = { gain, source: null }
        }
        entry.gain.gain.value = t.muted ? 0 : t.volume
        const source = ctx.createBufferSource()
        source.buffer = audioBuffer
        source.connect(entry.gain)
        if (outputTime >= t.offset) {
          const withinClip = t.inPoint + (outputTime - t.offset)
          const remaining = t.outPoint - withinClip
          if (remaining <= 0) return
          source.start(ctx.currentTime, withinClip, remaining)
        } else {
          source.start(ctx.currentTime + (t.offset - outputTime), t.inPoint, clipLen)
        }
        nodesRef.current.set(t.id, { gain: entry.gain, source })
      })
    }

    const onPlay = () => scheduleAll()
    const onPause = () => stopAll()
    const onSeeked = () => {
      if (!video.paused) {
        stopAll()
        scheduleAll()
      }
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('seeked', onSeeked)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeked', onSeeked)
      stopAll()
    }
    // el efecto se suscribe una sola vez al montar (videoRef es estable) —
    // los handlers leen tracksRef.current, así que siempre ven el estado
    // más reciente sin necesidad de reprogramar en cada edición de pista
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef])
}

// dibuja la porción [inPoint, outPoint] de una waveform ya decodificada
// (sobre toda la fuente), estirada al ancho actual del canvas — así el
// recorte/zoom no requiere volver a decodificar nada.
export function drawWaveform(canvas, waveformState, { color, inPoint, outPoint, sourceDuration }) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  ctx.clearRect(0, 0, width, height)
  if (!waveformState?.peaks || !sourceDuration) return
  const { peaks } = waveformState
  const bucketCount = peaks.length / 2
  const startBucket = Math.max(0, Math.floor((inPoint / sourceDuration) * bucketCount))
  const endBucket = Math.min(bucketCount, Math.max(startBucket + 1, Math.ceil((outPoint / sourceDuration) * bucketCount)))
  const visibleBuckets = endBucket - startBucket
  const mid = height / 2
  ctx.fillStyle = color
  for (let x = 0; x < width; x++) {
    const bucketIndex = startBucket + Math.floor((x / width) * visibleBuckets)
    if (bucketIndex < 0 || bucketIndex >= bucketCount) continue
    const min = peaks[bucketIndex * 2]
    const max = peaks[bucketIndex * 2 + 1]
    const y1 = mid - max * mid
    const y2 = mid - min * mid
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1))
  }
}
