import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWaveformPeaks, drawWaveform } from '../lib/audio.js'

const MIN_GAP = 0.2
const ZOOM_MIN = 5
const ZOOM_MAX = 200
const TICK_INTERVALS = [0.5, 1, 2, 5, 10, 30, 60, 300, 600]
const MIN_TICK_PX = 56
const ROW_HEIGHT = 48 // h-12

function pickTickInterval(pxPerSecond) {
  for (const interval of TICK_INTERVALS) {
    if (interval * pxPerSecond >= MIN_TICK_PX) return interval
  }
  return TICK_INTERVALS[TICK_INTERVALS.length - 1]
}

// con intervalos menores a 1s hay que mostrar decimales, si no salen
// etiquetas repetidas (0:00, 0:00, 0:01, 0:01…) al hacer zoom
function formatTick(seconds, interval) {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  const decimals = interval < 1 ? 1 : 0
  return `${m}:${s.toFixed(decimals).padStart(decimals > 0 ? 4 : 2, '0')}`
}

function Ruler({ videoLen, pxPerSecond, onSeek }) {
  const interval = pickTickInterval(pxPerSecond)
  const ticks = []
  for (let t = 0; t <= videoLen + interval; t += interval) ticks.push(t)
  return (
    <div
      className="relative h-6 shrink-0 cursor-pointer border-b border-gray-200 dark:border-neutral-700"
      style={{ width: Math.max(videoLen * pxPerSecond, 1) }}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        onSeek(Math.max(0, Math.min(videoLen, (event.clientX - rect.left) / pxPerSecond)))
      }}
    >
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute top-0 h-full border-l border-gray-200 pl-1 text-[10px] text-gray-400 dark:border-neutral-700 dark:text-neutral-500"
          style={{ left: t * pxPerSecond }}
        >
          {formatTick(t, interval)}
        </div>
      ))}
    </div>
  )
}

// clip de una pista: cuerpo arrastrable (reposicionar en el tiempo, Y
// reordenar arriba/abajo con el mismo gesto — arrastrar verticalmente más de
// medio alto de fila mueve la pista un lugar y reinicia el punto de
// referencia, para poder cruzar varias filas en un solo arrastre continuo) +
// 2 handles en los bordes (recortar in/out). Técnica base: onMouseDown
// captura el punto de partida en un ref, document.addEventListener
// ('mousemove'/'mouseup') calcula el delta — igual que ColumnResizeHandle en
// DatabaseView.jsx.
function Clip({ row, isOriginal, pxPerSecond, disabled, onChange, onReorderStep }) {
  const dragRef = useRef(null)
  const canvasRef = useRef(null)
  const peaks = useWaveformPeaks(row.url)

  const width = Math.max((row.outPoint - row.inPoint) * pxPerSecond, 6)

  // en un efecto (no durante el render): el atributo width/height del canvas
  // recién queda aplicado en el DOM después del commit, y cambiarlo resetea
  // el bitmap — dibujar antes de eso pinta sobre un canvas con el tamaño viejo
  useLayoutEffect(() => {
    drawWaveform(canvasRef.current, peaks, {
      color: row.color,
      inPoint: row.inPoint,
      outPoint: row.outPoint,
      sourceDuration: row.sourceDuration,
    })
  }, [peaks, width, row.color, row.inPoint, row.outPoint, row.sourceDuration])

  const startDrag = (mode) => (event) => {
    if (disabled || isOriginal) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = { startX: event.clientX, startY: event.clientY, offset: row.offset, inPoint: row.inPoint, outPoint: row.outPoint }
    const onMove = (moveEvent) => {
      const deltaSeconds = (moveEvent.clientX - dragRef.current.startX) / pxPerSecond
      if (mode === 'move') {
        onChange({ offset: Math.max(0, dragRef.current.offset + deltaSeconds) })
        // arrastrar el clip verticalmente reordena — mismo gesto que en
        // CapCut, sin necesidad de un ícono aparte. Al pasar el umbral se
        // reinicia startY para poder seguir cruzando filas en el mismo drag.
        const deltaY = moveEvent.clientY - dragRef.current.startY
        if (Math.abs(deltaY) >= ROW_HEIGHT / 2) {
          onReorderStep?.(deltaY > 0 ? 'down' : 'up')
          dragRef.current.startY = moveEvent.clientY
        }
      } else if (mode === 'left') {
        // el delta real es el más restrictivo entre "no hay más fuente a la
        // izquierda" (inPoint>=0) y "no hay más timeline a la izquierda"
        // (offset>=0) — si se clampean inPoint/offset por separado, uno
        // puede seguir moviéndose más que el otro y el ancho del clip queda
        // desincronizado con lo que el usuario realmente arrastró
        const { inPoint: startIn, offset: startOffset, outPoint } = dragRef.current
        const minDelta = -Math.min(startIn, startOffset)
        const maxDelta = outPoint - MIN_GAP - startIn
        const applied = Math.min(Math.max(deltaSeconds, minDelta), maxDelta)
        onChange({ inPoint: startIn + applied, offset: startOffset + applied })
      } else {
        const newOut = Math.max(Math.min(row.sourceDuration, dragRef.current.outPoint + deltaSeconds), dragRef.current.inPoint + MIN_GAP)
        onChange({ outPoint: newOut })
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`absolute top-1 h-10 overflow-hidden rounded-md border ${isOriginal ? '' : 'cursor-grab active:cursor-grabbing'}`}
      style={{ left: row.offset * pxPerSecond, width, borderColor: row.color, backgroundColor: `${row.color}33` }}
      onMouseDown={startDrag('move')}
    >
      <canvas ref={canvasRef} width={width} height={40} className="pointer-events-none absolute inset-0 h-full w-full" />
      <span
        className="pointer-events-none absolute left-1 top-0.5 truncate text-[10px] text-gray-700 dark:text-neutral-200"
        style={{ maxWidth: Math.max(width - 8, 0) }}
      >
        {row.name}
      </span>
      {!isOriginal && (
        <>
          <div
            title="Recortar inicio"
            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-black/20 hover:bg-black/40 dark:bg-white/20 dark:hover:bg-white/40"
            onMouseDown={startDrag('left')}
          />
          <div
            title="Recortar fin"
            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-black/20 hover:bg-black/40 dark:bg-white/20 dark:hover:bg-white/40"
            onMouseDown={startDrag('right')}
          />
        </>
      )}
    </div>
  )
}

function TrackHeader({ row, isOriginal, disabled, onToggleMute, onVolumeChange, onDelete }) {
  return (
    <div className="flex h-12 items-center gap-1.5 border-b border-gray-100 px-2 dark:border-neutral-800">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
      <span className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-neutral-300" title={row.name}>
        {row.name}
      </span>
      <button
        type="button"
        onClick={onToggleMute}
        disabled={disabled}
        title={row.muted ? 'Activar' : 'Silenciar'}
        className={`shrink-0 rounded p-1 text-xs ${row.muted ? 'text-red-500' : 'text-gray-400 hover:text-gray-600 dark:hover:text-neutral-300'}`}
      >
        {row.muted ? '🔇' : '🔊'}
      </button>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={row.volume}
        onChange={(event) => onVolumeChange(Number(event.target.value))}
        disabled={disabled}
        title={`Volumen ${Math.round(row.volume * 100)}%`}
        className="w-12 shrink-0 accent-blue-600"
      />
      {!isOriginal && (
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          aria-label="Quitar pista"
          className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-40 dark:hover:bg-neutral-800"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// Timeline multi-pista para mezclar audio sobre una grabación. Solo edita
// pistas de audio — el recorte del video en sí sigue viviendo en el slider
// dual de RecordingEditor.jsx, a propósito (ver plan: dos mecanismos
// editando el mismo valor sería fuente de bugs de desincronización).
export default function AudioTimeline({
  videoLen,
  playheadTime,
  onSeek,
  originalTrack,
  onChangeOriginal,
  tracks,
  onChangeTrack,
  onDeleteTrack,
  onAddTrack,
  onReorderTracks,
  disabled,
}) {
  const [pxPerSecond, setPxPerSecond] = useState(30)

  const originalRow = useMemo(
    () => ({
      name: 'Audio original',
      color: '#9ca3af',
      offset: 0,
      inPoint: 0,
      outPoint: videoLen,
      sourceDuration: videoLen,
      volume: originalTrack.volume,
      muted: originalTrack.muted,
      url: null,
    }),
    [videoLen, originalTrack]
  )

  const rows = [originalRow, ...tracks]
  // el carril acompaña a la pista más larga, no solo al video: una pista
  // arrastrada más allá del final del video (se corta al exportar, pero se
  // puede posicionar ahí) tiene que seguir siendo visible y agarrable
  const contentEnd = tracks.reduce((max, t) => Math.max(max, t.offset + (t.outPoint - t.inPoint)), videoLen)
  const laneWidth = Math.max(contentEnd * pxPerSecond, 200)

  // un paso arriba/abajo entre las pistas AGREGADAS — la fila "Audio
  // original" está siempre fija arriba de todo, nunca participa del reorden
  const handleReorderStep = (id, direction) => {
    const idx = tracks.findIndex((t) => t.id === id)
    if (idx === -1) return
    const swapWith = direction === 'up' ? idx - 1 : idx + 1
    if (swapWith < 0 || swapWith >= tracks.length) return
    onReorderTracks?.(id, tracks[swapWith].id, direction === 'up' ? 'before' : 'after')
  }

  return (
    <div className="mt-4 rounded-lg border border-gray-200 dark:border-neutral-700">
      <div className="flex items-center justify-between border-b border-gray-100 px-2 py-1.5 dark:border-neutral-800">
        <span className="text-xs font-medium text-gray-500 dark:text-neutral-400">Pistas de audio</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPxPerSecond((z) => Math.max(ZOOM_MIN, z * 0.8))}
            disabled={disabled}
            className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => setPxPerSecond((z) => Math.min(ZOOM_MAX, z * 1.25))}
            disabled={disabled}
            className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            +
          </button>
          <button
            type="button"
            onClick={onAddTrack}
            disabled={disabled}
            className="ml-2 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            + Agregar pista
          </button>
        </div>
      </div>

      <div className="grid max-h-56 grid-cols-[160px_1fr] overflow-y-auto">
        <div className="border-r border-gray-100 dark:border-neutral-800">
          <div className="h-6 border-b border-gray-100 dark:border-neutral-800" />
          {rows.map((row, i) => (
            <TrackHeader
              key={row.id ?? 'original'}
              row={row}
              isOriginal={i === 0}
              disabled={disabled}
              onToggleMute={() =>
                i === 0 ? onChangeOriginal({ muted: !row.muted }) : onChangeTrack(row.id, { muted: !row.muted })
              }
              onVolumeChange={(v) => (i === 0 ? onChangeOriginal({ volume: v }) : onChangeTrack(row.id, { volume: v }))}
              onDelete={() => onDeleteTrack(row.id)}
            />
          ))}
        </div>

        <div className="overflow-x-auto">
          <div style={{ width: laneWidth }}>
            <Ruler videoLen={videoLen} pxPerSecond={pxPerSecond} onSeek={onSeek} />
            <div className="relative">
              {rows.map((row, i) => (
                <div key={row.id ?? 'original'} className="relative h-12 border-b border-gray-100 dark:border-neutral-800">
                  <Clip
                    row={row}
                    isOriginal={i === 0}
                    pxPerSecond={pxPerSecond}
                    disabled={disabled}
                    onChange={(patch) => onChangeTrack(row.id, patch)}
                    onReorderStep={(direction) => handleReorderStep(row.id, direction)}
                  />
                </div>
              ))}
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-red-500"
                style={{ left: playheadTime * pxPerSecond }}
              />
            </div>
          </div>
        </div>
      </div>

      {tracks.length === 0 && (
        <p className="border-t border-gray-100 px-3 py-2 text-xs text-gray-400 dark:border-neutral-800 dark:text-neutral-500">
          Agregá música o narración — se mezclan con el audio original del video.
        </p>
      )}
    </div>
  )
}
