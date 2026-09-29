import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'

export default function QuickSwitcher({ open, onClose, onSelect }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    ;(async () => {
      const q = query.trim()
      let list
      if (!q) {
        const index = await api.listPages()
        list = index.pages
          .filter((p) => !p.trashedAt)
          .slice(0, 20)
          .map((p) => ({ id: p.id, title: p.title, snippet: '' }))
      } else {
        list = await api.search(q)
      }
      if (!cancelled) {
        setResults(list)
        setActiveIndex(0)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [query, open])

  if (!open) return null

  const choose = (id) => {
    if (!id) return
    onSelect(id)
    onClose()
  }

  return (
    <div
      data-quick-switcher
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[15vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-label="Buscar página"
        className="w-full max-w-lg rounded-lg bg-white shadow-2xl dark:bg-neutral-800"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex((i) => Math.min(i + 1, results.length - 1))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((i) => Math.max(i - 1, 0))
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              choose(results[activeIndex]?.id)
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
          placeholder="Buscar una página…"
          autoComplete="off"
          className="w-full border-b border-gray-100 px-4 py-3 text-sm text-gray-900 outline-none dark:border-neutral-700 dark:bg-transparent dark:text-neutral-100"
        />
        <div className="max-h-80 overflow-y-auto p-1">
          {results.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-gray-400 dark:text-neutral-500">Sin resultados</p>
          )}
          {results.map((r, i) => (
            <button
              key={r.id}
              type="button"
              data-result-id={r.id}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => choose(r.id)}
              className={`block w-full rounded-md px-3 py-2 text-left ${
                i === activeIndex ? 'bg-gray-100 dark:bg-neutral-700' : ''
              }`}
            >
              <div className="truncate text-sm text-gray-800 dark:text-neutral-200">{r.title || 'Sin título'}</div>
              {r.snippet && <div className="truncate text-xs text-gray-400 dark:text-neutral-500">{r.snippet}</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
