import { useState } from 'react'
import { isImageIcon } from '../lib/icon.js'

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3 w-3" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export default function TabBar({ tabs, activeTabId, labelFor, iconFor, onSelect, onClose, onNewTab, onReorder, isMobile }) {
  const [dragId, setDragId] = useState(null)
  const [dropHint, setDropHint] = useState(null) // { tabId, side: 'before' | 'after' } | null

  // esta fila solo scrollea horizontal (overflow-x-auto), pero una rueda de
  // mouse común solo manda deltaY vertical — sin esto, quien no tenga touch
  // ni trackpad horizontal (p. ej. controlando el celular desde una PC con
  // Enlace móvil de Windows, mouse reenviado, nada de gestos táctiles reales)
  // no tiene cómo mover esta fila. Traduce la rueda vertical a scroll
  // horizontal, patrón estándar para listas horizontales.
  const onWheel = (event) => {
    if (event.deltaY === 0) return
    event.currentTarget.scrollLeft += event.deltaY
    event.preventDefault()
  }

  return (
    <div
      onWheel={onWheel}
      className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-gray-200 bg-gray-50 px-1.5 dark:border-neutral-800 dark:bg-[#202020]"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        const icon = iconFor?.(tab)
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            // arrastrar para reordenar es un gesto de mouse — en touch, un
            // elemento draggable="true" le gana la interpretación del gesto
            // al scroll horizontal nativo del navegador (el dedo termina
            // intentando "arrastrar" en vez de scrollear), así que en mobile
            // directamente no se marca draggable.
            draggable={!isMobile}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              setDragId(tab.id)
            }}
            onDragEnd={() => {
              setDragId(null)
              setDropHint(null)
            }}
            onDragOver={(event) => {
              if (!dragId || dragId === tab.id) return
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              const side = event.clientX - rect.left < rect.width / 2 ? 'before' : 'after'
              setDropHint({ tabId: tab.id, side })
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDropHint(null)
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dragId && dropHint?.tabId === tab.id) onReorder?.(dragId, dropHint.tabId, dropHint.side)
              setDragId(null)
              setDropHint(null)
            }}
            onClick={() => onSelect(tab.id)}
            className={`group flex max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 py-1.5 text-xs ${
              active
                ? 'bg-white text-gray-700 dark:bg-neutral-800 dark:text-neutral-100'
                : 'text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60'
            } ${dropHint?.tabId === tab.id && dropHint.side === 'before' ? 'border-l-2 border-blue-400' : ''} ${
              dropHint?.tabId === tab.id && dropHint.side === 'after' ? 'border-r-2 border-blue-400' : ''
            }`}
          >
            {icon &&
              (isImageIcon(icon) ? (
                <img src={icon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm object-cover" />
              ) : (
                <span className="shrink-0 text-sm leading-none">{icon}</span>
              ))}
            <span className="min-w-0 flex-1 truncate">{labelFor(tab)}</span>
            <button
              type="button"
              aria-label="Cerrar pestaña"
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
              // opacity-0 + group-hover no revela nada en touch (sin :hover)
              // — mismo patrón ya repetido en Sidebar.jsx/MobileEditor.jsx,
              // acá con max-md:opacity-100 (siempre visible bajo 768px).
              className="shrink-0 rounded p-0.5 text-gray-400 opacity-0 hover:bg-gray-200 group-hover:opacity-100 max-md:opacity-100 dark:text-neutral-500 dark:hover:bg-neutral-700"
            >
              <XIcon />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        aria-label="Nueva pestaña"
        onClick={onNewTab}
        className="ml-0.5 shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
      >
        <PlusIcon />
      </button>
    </div>
  )
}
