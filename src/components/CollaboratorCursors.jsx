import { memo } from 'react'

/**
 * Renderiza los punteros / cursores flotantes de los demás usuarios en tiempo real,
 * estilo Google Docs / Word / Figma, con nombre y color individual.
 */
function CollaboratorCursors({ cursors }) {
  if (!cursors || Object.keys(cursors).length === 0) return null

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-40 overflow-visible select-none"
    >
      {Object.values(cursors).map((cursor) => {
        if (!cursor || cursor.hidden || cursor.x == null || cursor.y == null) return null

        const color = cursor.color || {
          bg: '#2563eb',
          text: '#ffffff',
          border: '#60a5fa',
          ring: 'rgba(37, 99, 235, 0.35)',
        }

        return (
          <div
            key={cursor.userId}
            className="pointer-events-none absolute left-0 top-0 will-change-transform"
            style={{
              transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)`,
              transition: 'transform 75ms cubic-bezier(0.2, 0, 0, 1)',
            }}
          >
            {/* Ícono de flecha de puntero */}
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.35))' }}
            >
              <path
                d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L11.7841 12.3673H5.65376Z"
                fill={color.bg}
                stroke="#ffffff"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>

            {/* Etiqueta con el nombre del colaborador */}
            <div
              className="ml-3.5 -mt-2 inline-flex max-w-[140px] items-center truncate rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide shadow-md"
              style={{
                backgroundColor: color.bg,
                color: color.text,
                boxShadow: `0 2px 8px ${color.ring || 'rgba(0,0,0,0.25)'}`,
              }}
              title={cursor.name}
            >
              <span className="truncate">{cursor.name}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default memo(CollaboratorCursors)
