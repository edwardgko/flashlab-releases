import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import SchemaEditor, { COLOR_PALETTE, CREATABLE_TYPE_LABEL } from './SchemaEditor.jsx'
import { isImageIcon } from '../lib/icon.js'
import { setDragPreview, setDragPreviewFromHandle } from '../lib/dragPreview.js'
import { useIsMobile } from '../lib/useIsMobile.js'

function GalleryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <rect x="3" y="4" width="8" height="8" rx="1.5" />
      <rect x="13" y="4" width="8" height="8" rx="1.5" />
      <rect x="3" y="14" width="8" height="6" rx="1.5" />
      <rect x="13" y="14" width="8" height="6" rx="1.5" />
    </svg>
  )
}
function ListViewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  )
}

function BoardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  )
}
function TableIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 10v10" />
    </svg>
  )
}
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
// asa de arrastre para reordenar filas a mano (Tabla/Lista) — 6 puntos en
// 2 columnas, mismo ícono que usan la mayoría de las apps tipo Notion.
function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <circle cx="9" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="15" cy="18" r="1.4" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  )
}
function DuplicateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="1.5" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  )
}
function SortIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3" />
    </svg>
  )
}
function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <path d="M4 5h16l-6 8v5l-4 2v-7z" />
    </svg>
  )
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}
function ChevronDownIcon({ className = 'h-3 w-3' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h14M22 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    </svg>
  )
}

// mismo criterio que ChatView.jsx/HomeView.jsx (formatRelative) — cada
// archivo tiene el suyo, pero acá se quiere fecha+hora absoluta, no relativa.
function formatModified(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
}

function firstSelectProperty(schema) {
  return schema.find((p) => p.type === 'select') ?? null
}

// Popover flotante montado en <body> vía portal: los popovers de celda/columna
// viven dentro de un contenedor con scroll (overflow-x-auto en TableView, que
// por la semántica de overflow del CSS termina recortando también en Y) — si
// se posicionaran con position:absolute ahí adentro, quedarían cortados en
// vez de flotar libremente sobre el resto de la página. anchorRect es el
// getBoundingClientRect() del disparador tomado al abrir (fixed, no sigue
// scroll/resize — asumible para un popover que se cierra apenas cambia el layout).
function Popover({ anchorRect, onClose, className, children }) {
  if (!anchorRect) return null
  const margin = 8
  const spaceBelow = window.innerHeight - anchorRect.bottom - margin
  const spaceAbove = anchorRect.top - margin
  const openUp = spaceBelow < 200 && spaceAbove > spaceBelow
  // Deja que el popover crezca con el contenido hasta ocupar el espacio
  // libre real hacia donde abre (no una altura estimada fija) — las listas
  // largas (opciones de Select, etc.) hacen su propio scroll interno recién
  // cuando ni así entran.
  const maxHeight = Math.max(160, openUp ? spaceAbove : spaceBelow)
  const style = {
    position: 'fixed',
    left: Math.max(4, Math.min(anchorRect.left, window.innerWidth - 272)),
    maxHeight,
    ...(openUp ? { bottom: window.innerHeight - anchorRect.top + 4 } : { top: anchorRect.bottom + 4 }),
  }
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div onClick={(event) => event.stopPropagation()} style={style} className={`z-50 flex flex-col overflow-hidden ${className}`}>
        {children}
      </div>
    </>,
    document.body
  )
}

// tag hex + alpha en formato #rrggbbaa — nuestros colores por defecto son hex de 7 chars
function tint(hex, alpha = '26') {
  return hex?.startsWith('#') && hex.length === 7 ? `${hex}${alpha}` : hex
}

// mezcla un hex hacia blanco o negro una fracción dada (0 = el color tal
// cual, 1 = el destino puro) — para el texto de las etiquetas: un tono del
// mismo color, no blanco/gris fijo (ver .tag-text en index.css)
function mixHex(hex, target, ratio) {
  if (!hex?.startsWith('#') || hex.length !== 7) return hex
  const h = hex.slice(1)
  const t = target.slice(1)
  const toHex = (n) => n.toString(16).padStart(2, '0')
  const mix = (a, b) => toHex(Math.round(a + (b - a) * ratio))
  return `#${mix(parseInt(h.slice(0, 2), 16), parseInt(t.slice(0, 2), 16))}${mix(
    parseInt(h.slice(2, 4), 16),
    parseInt(t.slice(2, 4), 16)
  )}${mix(parseInt(h.slice(4, 6), 16), parseInt(t.slice(4, 6), 16))}`
}

// { light, dark }: qué color de texto usar en cada tema para una etiqueta
// de este color — más oscuro que el hue en claro (legible sobre blanco),
// casi blanco en oscuro (pedido explícito: que se lea claro contra el fondo
// casi negro, no un tono opaco). Los ratios están elegidos para mantener
// contraste WCAG AA (>=4.5:1) en claro y AAA en oscuro en toda la paleta.
function tagTextColors(color) {
  return { light: mixHex(color, '#000000', 0.44), dark: mixHex(color, '#ffffff', 0.82) }
}

function tagTextStyle(color, extra) {
  const { light, dark } = tagTextColors(color)
  return { ...extra, '--tag-text-light': light, '--tag-text-dark': dark }
}

// mismo mecanismo que tagTextStyle pero para fondo/borde tintados — en
// oscuro un poco más saturados (el fondo casi negro lo banca sin perder
// contraste), en claro más sutiles (para no competir con el blanco de la
// página). alphas en formato tint(): 2 hex chars.
function tagBgStyle(color, { bg, bgDark, border, borderDark } = {}, extra) {
  const style = { ...extra }
  if (bg) style['--tag-bg-light'] = tint(color, bg)
  if (bgDark) style['--tag-bg-dark'] = tint(color, bgDark)
  if (border) style['--tag-border-light'] = tint(color, border)
  if (borderDark) style['--tag-border-dark'] = tint(color, borderDark)
  return style
}

function compareValues(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

function sortRows(rows, schema, sort) {
  if (!sort) return rows
  const dir = sort.dir === 'desc' ? -1 : 1
  const prop = schema.find((p) => p.id === sort.propId)
  const getVal = (row) => {
    if (sort.propId === 'title') return row.title || ''
    const raw = row.properties?.[sort.propId]
    if (prop?.type === 'select') return prop.options.find((o) => o.id === raw)?.name ?? ''
    return raw
  }
  return [...rows].sort((a, b) => dir * compareValues(getVal(a), getVal(b)))
}

function matchesFilter(row, schema, filter) {
  if (!filter) return true
  const prop = schema.find((p) => p.id === filter.propId)
  const raw = prop?.type === 'title' ? row.title : row.properties?.[filter.propId]
  if (prop?.type === 'select') {
    const match = raw === filter.value
    return filter.condition === 'is_not' ? !match : match
  }
  if (prop?.type === 'checkbox') {
    return filter.condition === 'unchecked' ? !raw : !!raw
  }
  const str = String(raw ?? '').toLowerCase()
  const q = String(filter.value ?? '').toLowerCase()
  return filter.condition === 'not_contains' ? !str.includes(q) : str.includes(q)
}

function DragHandleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <circle cx="9" cy="6" r="1.3" />
      <circle cx="15" cy="6" r="1.3" />
      <circle cx="9" cy="12" r="1.3" />
      <circle cx="15" cy="12" r="1.3" />
      <circle cx="9" cy="18" r="1.3" />
      <circle cx="15" cy="18" r="1.3" />
    </svg>
  )
}

function SmallXIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-2.5 w-2.5" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

// swatch extra al final de la paleta fija: abre el selector de color nativo
// del sistema operativo (<input type="color">, soportado por Chromium/Electron
// sin ningún plugin) para elegir cualquier color, no solo los 15 predefinidos.
//
// El onChange de React en un <input type="color"> equivale al evento nativo
// "input" (se dispara en cada frame mientras arrastrás dentro del picker),
// no a "change" (una sola vez, al soltar). Si lo usábamos para escribir el
// color, cada frame disparaba onUpdateSchema -> IPC completo -> re-render,
// que desmontaba el <input> a mitad de interacción y cerraba el picker apenas
// se tocaba el cuadro de color — por eso "sacaba" antes de poder elegir
// nada. Escuchamos el evento nativo "change" directo (ref + addEventListener)
// para commitear una sola vez, al confirmar.
function CustomColorSwatch({ color, onChange, title = 'Color personalizado' }) {
  const inputRef = useRef(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const handleChange = (event) => onChange(event.target.value)
    input.addEventListener('change', handleChange)
    return () => input.removeEventListener('change', handleChange)
  }, [onChange])

  return (
    <label
      title={title}
      className="relative h-4 w-4 shrink-0 cursor-pointer overflow-hidden rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/20"
      style={{ background: 'conic-gradient(from 0deg, #f87171, #facc15, #4ade80, #22d3ee, #818cf8, #f472b6, #f87171)' }}
    >
      <input
        ref={inputRef}
        type="color"
        defaultValue={/^#[0-9a-f]{6}$/i.test(color) ? color : '#94a3b8'}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  )
}

function OptionPill({ name, color, onRemove }) {
  return (
    <span
      // min-w-0: sin esto, un flex item con contenido "nowrap" (el truncate
      // de acá abajo) nunca se achica por debajo del ancho natural del texto
      // — es el motivo por el que angostar una columna con select no
      // recortaba el chip, solo lo hacía desbordar por encima de la columna
      // vecina en vez de truncar.
      className="tag-text inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 truncate rounded px-2 py-1 text-sm font-medium"
      style={tagTextStyle(color, { backgroundColor: tint(color, '66') })}
    >
      <span className="truncate">{name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
          className="shrink-0 rounded hover:bg-black/10"
        >
          <SmallXIcon />
        </button>
      )}
    </span>
  )
}

// Popover de edición de una celda Select, calcado del picker de Notion real:
// pill del valor actual (con "×" para vaciarlo), buscador que también sirve
// para crear una opción nueva al vuelo, y la lista reordenable por drag&drop.
function SelectCellPopover({ prop, value, onChange, onUpdatePropOptions, anchorRect, onClose }) {
  const isMobile = useIsMobile()
  const [query, setQuery] = useState('')
  const [dragId, setDragId] = useState(null)
  const [colorPickerId, setColorPickerId] = useState(null)
  const selected = prop.options.find((o) => o.id === value)
  const q = query.trim().toLowerCase()
  const filtered = q ? prop.options.filter((o) => o.name.toLowerCase().includes(q)) : prop.options
  const exactMatch = prop.options.some((o) => o.name.toLowerCase() === q)

  const selectOption = (optId) => {
    onChange(optId)
    onClose()
  }

  const createOption = () => {
    const name = query.trim()
    if (!name) return
    const color = COLOR_PALETTE[prop.options.length % COLOR_PALETTE.length]
    const newOpt = { id: crypto.randomUUID(), name, color }
    onUpdatePropOptions([...prop.options, newOpt])
    onChange(newOpt.id)
    onClose()
  }

  const reorder = (fromId, toId) => {
    const opts = [...prop.options]
    const fromIdx = opts.findIndex((o) => o.id === fromId)
    const toIdx = opts.findIndex((o) => o.id === toId)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = opts.splice(fromIdx, 1)
    opts.splice(toIdx, 0, moved)
    onUpdatePropOptions(opts)
  }

  const changeColor = (optId, color) => {
    onUpdatePropOptions(prop.options.map((o) => (o.id === optId ? { ...o, color } : o)))
    setColorPickerId(null)
  }

  return (
    <Popover
      anchorRect={anchorRect}
      onClose={onClose}
      className="w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
    >
      {selected && (
        <div className="mb-2 shrink-0 flex flex-wrap gap-1 border-b border-gray-100 pb-2 dark:border-neutral-700">
          <OptionPill name={selected.name} color={selected.color} onRemove={() => selectOption(null)} />
        </div>
      )}
      <input
        // en mobile, autoFocus abre el teclado apenas se toca la celda —
        // aparece de sorpresa tapando media pantalla cuando lo más común es
        // solo querer tocar una opción existente, no buscar/crear una nueva.
        autoFocus={!isMobile}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && query.trim() && !exactMatch && createOption()}
        placeholder="Selecciona o crea una opción"
        className="mb-1.5 w-full shrink-0 rounded border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-blue-400 dark:border-neutral-700"
      />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {filtered.map((opt) => (
          <div key={opt.id}>
            <div
              draggable
              onDragStart={() => setDragId(opt.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragId && dragId !== opt.id) reorder(dragId, opt.id)
                setDragId(null)
              }}
              onClick={() => selectOption(opt.id)}
              className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-1 hover:bg-gray-100 dark:hover:bg-white/5"
            >
              <span className="shrink-0 cursor-grab text-gray-300 dark:text-neutral-600">
                <DragHandleIcon />
              </span>
              <button
                type="button"
                aria-label="Cambiar color"
                onClick={(event) => {
                  event.stopPropagation()
                  setColorPickerId((id) => (id === opt.id ? null : opt.id))
                }}
                className="h-3.5 w-3.5 shrink-0 rounded-full hover:ring-2 hover:ring-gray-300 dark:hover:ring-neutral-600"
                style={{ backgroundColor: opt.color }}
              />
              <OptionPill name={opt.name} color={opt.color} />
            </div>
            {colorPickerId === opt.id && (
              <div
                onClick={(event) => event.stopPropagation()}
                className="ml-6 mb-1 flex flex-wrap gap-1.5 rounded-md bg-gray-50 p-1.5 dark:bg-white/5"
              >
                {COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Color ${color}`}
                    onClick={() => changeColor(opt.id, color)}
                    className={`h-4 w-4 rounded-full ${
                      color === opt.color ? 'ring-2 ring-offset-1 ring-gray-400 dark:ring-neutral-400 dark:ring-offset-neutral-800' : ''
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
                <CustomColorSwatch color={opt.color} onChange={(color) => changeColor(opt.id, color)} />
              </div>
            )}
          </div>
        ))}
        {query.trim() && !exactMatch && (
          <button
            type="button"
            onClick={createOption}
            className="flex w-full items-center gap-1.5 rounded px-1 py-1.5 text-left text-xs text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-white/5"
          >
            Crear
            <OptionPill name={query.trim()} color={COLOR_PALETTE[prop.options.length % COLOR_PALETTE.length]} />
          </button>
        )}
      </div>
    </Popover>
  )
}

export function PropertyCell({ prop, value, onChange, onUpdatePropOptions }) {
  const [selectAnchor, setSelectAnchor] = useState(null) // DOMRect | null — también hace de "abierto?"

  if (prop.type === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-blue-600"
      />
    )
  }
  if (prop.type === 'number') {
    return (
      <input
        type="number"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
        className="w-full min-w-0 bg-transparent px-1 py-0.5 text-sm outline-none"
      />
    )
  }
  if (prop.type === 'date') {
    return (
      <input
        type="date"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className="w-full min-w-0 bg-transparent px-1 py-0.5 text-sm outline-none"
      />
    )
  }
  if (prop.type === 'select') {
    const selected = prop.options.find((o) => o.id === value)
    return (
      <>
        <button
          type="button"
          onClick={(event) => setSelectAnchor(event.currentTarget.getBoundingClientRect())}
          className="flex min-h-6 w-full items-center rounded px-1 py-0.5 text-left hover:bg-gray-100 dark:hover:bg-white/5"
        >
          {selected ? <OptionPill name={selected.name} color={selected.color} /> : <span className="text-gray-300 dark:text-neutral-600">—</span>}
        </button>
        {selectAnchor && (
          <SelectCellPopover
            prop={prop}
            value={value}
            onChange={onChange}
            onUpdatePropOptions={onUpdatePropOptions}
            anchorRect={selectAnchor}
            onClose={() => setSelectAnchor(null)}
          />
        )}
      </>
    )
  }
  // text
  return (
    <input
      type="text"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
      className="w-full min-w-0 bg-transparent px-1 py-0.5 text-sm outline-none"
    />
  )
}

const TITLE_SAVE_DELAY_MS = 500

// título editable in-place: escribís directo en la tarjeta, sin abrir la página.
// Un click en el ícono de expandir (esquina) abre la página completa aparte.
function InlineTitle({ id, title, onUpdateTitle, className, style, placeholder = 'Sin título', onFocus, onBlur }) {
  const [value, setValue] = useState(title)
  const ref = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => {
    // Si el usuario local está escribiendo en este textarea ahora mismo,
    // no pisar lo que tipea con el valor que llega del sync remoto
    if (ref.current && document.activeElement === ref.current) return
    setValue(title)
  }, [title, id])

  const autosize = (el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  return (
    <textarea
      ref={(el) => {
        ref.current = el
        autosize(el)
      }}
      rows={1}
      value={value}
      placeholder={placeholder}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={() => onFocus?.(id)}
      onChange={(event) => {
        setValue(event.target.value)
        autosize(event.target)
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => onUpdateTitle(id, event.target.value), TITLE_SAVE_DELAY_MS)
      }}
      onBlur={() => {
        clearTimeout(timerRef.current)
        onUpdateTitle(id, value)
        onBlur?.(id)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) event.currentTarget.blur()
      }}
      style={style}
      className={`w-full resize-none overflow-hidden bg-transparent outline-none ${className}`}
    />
  )
}

// encabezado de columna del Tablero: doble clic para renombrar la opción
// (Enter o blur guarda), botón de eliminar que aparece al pasar el mouse
// (mismo patrón de "click arma, click confirma" que OptionRow en
// SchemaEditor.jsx) — antes había que abrir todo el panel de Configuración
// para esto. La columna "Sin estado" (opt null) no tiene opción de fondo
// que editar/borrar, así que no muestra ninguno de los dos.
function BoardColumnHeader({ opt, color, count, onRename, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(opt?.name ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => setName(opt?.name ?? ''), [opt?.name, opt?.id])

  const commit = (value) => {
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed && trimmed !== opt.name) onRename(trimmed)
    else setName(opt.name)
  }

  return (
    <div className="mb-2.5 flex items-center gap-1 px-1 pt-1">
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit(event.currentTarget.value)
            }
            if (event.key === 'Escape') {
              setName(opt.name)
              setEditing(false)
            }
          }}
          style={{ ...tagTextStyle(color), ...tagBgStyle(color, { bg: '22', bgDark: '40' }) }}
          className="tag-text tag-bg min-w-0 rounded-md px-2 py-1 text-[13px] font-semibold outline-none ring-1 ring-inset ring-current/30"
        />
      ) : (
        <span
          onDoubleClick={() => opt && setEditing(true)}
          title={opt ? 'Doble clic para renombrar' : undefined}
          className={`tag-text tag-bg inline-flex min-w-0 items-center gap-1.5 truncate rounded-md px-2 py-1 text-[13px] font-semibold ${
            opt ? 'cursor-pointer' : ''
          }`}
          style={{ ...tagTextStyle(color), ...tagBgStyle(color, { bg: '22', bgDark: '40' }) }}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
          {opt?.name ?? 'Sin estado'}
        </span>
      )}
      <span className="shrink-0 text-xs text-gray-400 dark:text-neutral-500">{count}</span>
      {opt && (
        <button
          type="button"
          aria-label="Eliminar columna"
          title="Eliminar columna"
          onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
          onMouseLeave={() => setConfirmDelete(false)}
          className={`ml-auto shrink-0 cursor-pointer rounded p-1 opacity-0 hover:bg-black/10 group-hover:opacity-100 dark:hover:bg-white/10 ${
            confirmDelete ? '!opacity-100 text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-neutral-500'
          }`}
        >
          <TrashIcon />
        </button>
      )}
    </div>
  )
}

// tarjeta de una fila en el Tablero — los tres botones que aparecen al pasar
// el mouse (duplicar/abrir/eliminar) van con fondo propio (no solo texto
// tenue) a propósito: sin eso quedaban casi invisibles sobre el color de
// fondo tintado de la tarjeta (reportado con captura — un gris clarito
// encima de una tarjeta verde oscuro no se distinguía). El fondo sólido
// blanco/negro-90% garantiza contraste sea cual sea el color de la etiqueta.
// Eliminar sigue el mismo patrón "un clic arma, el segundo confirma" que el
// resto de los botones de borrado de la app (OptionRow, BoardColumnHeader).
function BoardCard({
  row,
  color,
  onOpenRow,
  onUpdateTitle,
  onDuplicateRow,
  onDeleteRow,
  onDragStart,
  onDragEnd,
  remoteCollaborator,
  onFocus,
  onBlur,
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  const iconBubbleStyle = tagBgStyle(color, { bg: '38', bgDark: '4d' })
  const iconButtonClass = 'tag-text cursor-pointer rounded-full p-1 transition hover:brightness-125 dark:hover:brightness-150'

  const cardStyle = tagBgStyle(color, { bg: '14', bgDark: '26', border: '30', borderDark: '4a' })
  if (remoteCollaborator) {
    cardStyle.outline = `2px solid ${remoteCollaborator.color?.bg || '#2563eb'}`
    cardStyle.boxShadow = `0 0 10px ${remoteCollaborator.color?.ring || 'rgba(37,99,235,0.3)'}`
  }

  return (
    <div
      data-row-id={row.id}
      draggable
      onClick={() => onFocus?.(row.id)}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', row.id)
        setDragPreview(event, event.currentTarget)
        onDragStart(row.id)
      }}
      onDragEnd={onDragEnd}
      style={cardStyle}
      className="tag-bg tag-border relative cursor-pointer rounded-lg border p-3 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
    >
      {remoteCollaborator && (
        <div
          className="pointer-events-none absolute -top-2.5 right-3 z-10 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-xs select-none"
          style={{ backgroundColor: remoteCollaborator.color?.bg || '#2563eb' }}
        >
          <span>{remoteCollaborator.name}</span>
        </div>
      )}
      <InlineTitle
        id={row.id}
        title={row.title}
        onUpdateTitle={onUpdateTitle}
        onFocus={() => onFocus?.(row.id)}
        onBlur={() => onBlur?.(row.id)}
        style={tagTextStyle(color)}
        className="tag-text text-base font-medium leading-snug placeholder:font-normal placeholder:italic placeholder:text-gray-400 dark:placeholder:text-neutral-500"
      />
      <div className="mt-1 flex items-center gap-2">
        {row.updatedAt ? (
          <p className="min-w-0 flex-1 truncate text-[11px] opacity-60" style={tagTextStyle(color)}>
            {formatModified(row.updatedAt)}
          </p>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <div style={iconBubbleStyle} className="tag-bg flex shrink-0 items-center gap-0.5 rounded-full p-0.5 shadow-sm">
          <button
            type="button"
            aria-label="Eliminar"
            title="Eliminar"
            onClick={(event) => {
              event.stopPropagation()
              if (confirmDelete) onDeleteRow(row.id)
              else setConfirmDelete(true)
            }}
            onMouseLeave={() => setConfirmDelete(false)}
            style={confirmDelete ? undefined : tagTextStyle(color)}
            className={`${iconButtonClass} ${confirmDelete ? '!bg-red-600 !text-white dark:!bg-red-600' : ''}`}
          >
            <TrashIcon />
          </button>
          <button
            type="button"
            aria-label="Duplicar"
            title="Duplicar"
            onClick={(event) => {
              event.stopPropagation()
              onDuplicateRow?.(row.id)
            }}
            style={tagTextStyle(color)}
            className={iconButtonClass}
          >
            <DuplicateIcon />
          </button>
          <button
            type="button"
            aria-label="Abrir página completa"
            title="Abrir página completa"
            onClick={() => onOpenRow(row.id)}
            style={tagTextStyle(color)}
            className={iconButtonClass}
          >
            <ExpandIcon />
          </button>
        </div>
      </div>
    </div>
  )
}

function BoardView({
  rows,
  schema,
  groupProp,
  onOpenRow,
  onUpdateProperty,
  onUpdateTitle,
  onCreateRow,
  onDuplicateRow,
  onUpdateSchema,
  onTrashRows,
  remoteCursors,
  broadcastElementFocus,
}) {
  const [dragId, setDragId] = useState(null)
  const [overOptionId, setOverOptionId] = useState(undefined)
  const containerRef = useRef(null)
  const isMobile = useIsMobile()

  useEffect(() => {
    const el = containerRef.current
    if (!el || isMobile) return

    const handleWheel = (event) => {
      // En desktop, al presionar Ctrl (o Cmd) y usar la rueda del scroll,
      // se convierte en scroll horizontal fluido del tablero
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
        const raw = event.deltaY !== 0 ? event.deltaY : event.deltaX
        const delta = event.deltaMode === 1 ? raw * 24 : event.deltaMode === 2 ? raw * 300 : raw
        el.scrollLeft += delta
        return
      }

      // Sin Ctrl: rueda vertical hace scroll de la página contenedora para no atrapar al usuario
      if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      const scrollRoot = el.closest('[data-page-scroll]')
      if (!scrollRoot) return
      scrollRoot.scrollTop += event.deltaY
      event.preventDefault()
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [isMobile])

  const renameOption = (optionId, name) => {
    onUpdateSchema(
      schema.map((p) => (p.id === groupProp.id ? { ...p, options: p.options.map((o) => (o.id === optionId ? { ...o, name } : o)) } : p))
    )
  }
  const deleteOption = (optionId) => {
    onUpdateSchema(
      schema.map((p) => (p.id === groupProp.id ? { ...p, options: p.options.filter((o) => o.id !== optionId) } : p))
    )
  }

  const columns = [...groupProp.options, null] // null = "Sin estado"
  const rowsByOption = new Map(columns.map((opt) => [opt?.id ?? null, []]))
  for (const row of rows) {
    const val = row.properties?.[groupProp.id] ?? null
    const key = rowsByOption.has(val) ? val : null
    rowsByOption.get(key).push(row)
  }

  return (
    <div
      ref={containerRef}
      data-board-scroll
      className="flex min-h-[calc(100vh-200px)] items-start gap-3 overflow-x-auto pb-6"
    >
      {columns.map((opt) => {
        const optionId = opt?.id ?? null
        const colRows = rowsByOption.get(optionId) ?? []
        const color = opt?.color ?? '#94a3b8'
        return (
          <div
            key={optionId ?? '__none__'}
            data-board-column={opt?.name ?? 'Sin estado'}
            onDragOver={(event) => {
              event.preventDefault()
              setOverOptionId(optionId)
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setOverOptionId(undefined)
            }}
            onDrop={(event) => {
              event.preventDefault()
              setOverOptionId(undefined)
              const id = dragId ?? event.dataTransfer.getData('text/plain')
              setDragId(null)
              if (id) onUpdateProperty(id, groupProp.id, optionId)
            }}
            className="tag-bg w-72 shrink-0 rounded-xl p-2 transition-colors"
            style={
              overOptionId === optionId
                ? tagBgStyle(color, { bg: '22', bgDark: '38' })
                : tagBgStyle(color, { bg: '08', bgDark: '14' })
            }
          >
            <BoardColumnHeader
              opt={opt}
              color={color}
              count={colRows.length}
              onRename={(name) => renameOption(optionId, name)}
              onDelete={() => deleteOption(optionId)}
            />
            <div className="space-y-2">
              {colRows.map((row) => {
                const remoteCollab = Object.values(remoteCursors || {}).find(
                  (c) => !c?.hidden && c?.activeRowId === row.id
                )
                return (
                  <BoardCard
                    key={row.id}
                    row={row}
                    color={color}
                    onOpenRow={onOpenRow}
                    onUpdateTitle={onUpdateTitle}
                    onDuplicateRow={onDuplicateRow}
                    onDeleteRow={(id) => onTrashRows?.([id])}
                    onDragStart={setDragId}
                    onDragEnd={() => setDragId(null)}
                    remoteCollaborator={remoteCollab}
                    onFocus={(rowId) => broadcastElementFocus?.({ rowId })}
                    onBlur={() => broadcastElementFocus?.({ rowId: null })}
                  />
                )
              })}
            </div>
            <button
              type="button"
              onClick={() => onCreateRow({ [groupProp.id]: optionId })}
              className="mt-1.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-gray-400 hover:bg-black/[0.04] hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/[0.06] dark:hover:text-neutral-300"
            >
              <PlusIcon /> Nueva página
            </button>
          </div>
        )
      })}
    </div>
  )
}

function TableRowView({
  row,
  schema,
  selected,
  onToggleSelect,
  onOpenRow,
  onUpdateTitle,
  onUpdateProperty,
  onDuplicateRow,
  onUpdatePropOptions,
  reorderable,
  dropSide,
  onDragStart,
  onDragEndRow,
  onDragOverRow,
  onDragLeaveRow,
  onDropRow,
  remoteCollaborator,
  onFocus,
  onBlur,
}) {
  return (
    <tr
      data-row-id={row.id}
      onDragOver={onDragOverRow}
      onDragLeave={onDragLeaveRow}
      onDrop={(event) => {
        event.preventDefault()
        onDropRow?.()
      }}
      // el indicador de dónde va a caer la fila (línea arriba/abajo, mismo
      // criterio que dropHint en las columnas del header) tiene que vivir en
      // el borde de la FILA, no de una celda — por eso border-t/b acá y no
      // dentro de un <td>.
      className={`border-b border-gray-100 dark:border-neutral-700 ${selected ? 'bg-blue-50/60 dark:bg-blue-500/10' : ''} ${
        dropSide === 'before' ? 'border-t-2 border-t-blue-400' : ''
      } ${dropSide === 'after' ? 'border-b-2 border-b-blue-400' : ''}`}
    >
      <td className="relative p-0 align-top">
        {remoteCollaborator && (
          <span
            className="absolute left-0 top-0 bottom-0 w-1 rounded-r shadow-xs z-10"
            style={{ backgroundColor: remoteCollaborator.color?.bg || '#2563eb' }}
            title={`Editado por ${remoteCollaborator.name}`}
          />
        )}
        <label className="absolute inset-0 flex cursor-pointer items-start justify-center pt-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`Seleccionar ${row.title || 'Sin título'}`}
            className="cursor-pointer"
          />
        </label>
      </td>
      {schema.map((prop) =>
        prop.type === 'title' ? (
          <td key={prop.id} className="overflow-hidden px-3 py-2 align-top">
            <InlineTitle
              id={row.id}
              title={row.title}
              onUpdateTitle={onUpdateTitle}
              onFocus={() => onFocus?.(row.id)}
              onBlur={() => onBlur?.(row.id)}
              className="text-sm font-medium text-gray-800 placeholder:font-normal placeholder:italic placeholder:text-gray-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </td>
        ) : (
          <td key={prop.id} className="overflow-hidden px-3 py-2 align-top">
            <PropertyCell
              prop={prop}
              value={row.properties?.[prop.id]}
              onChange={(value) => onUpdateProperty(row.id, prop.id, value)}
              onUpdatePropOptions={(options) => onUpdatePropOptions(prop.id, options)}
            />
          </td>
        )
      )}
      {/* columna propia (ver ACTIONS_COL_WIDTH), no flotando encima del
          título — antes eran absolute + opacity-0 con un pr-10 de resguardo
          en la celda del título, que no alcanzaba con títulos largos/columna
          angosta y quedaban montados sobre el texto. Siempre visibles: en
          una fila de tabla no hace falta un hover para descubrirlos, y así
          tampoco parpadean al pasar el mouse. */}
      <td className="px-1.5 py-2 align-top">
        <div className="flex items-center justify-end gap-0.5">
          {reorderable && (
            <button
              type="button"
              aria-label="Arrastrar para reordenar"
              title="Arrastrar para reordenar"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                // sin esto, lo que sigue al cursor es la foto del botón: un
                // cuadradito con los 6 puntos y nada más (ver dragPreview.js)
                setDragPreviewFromHandle(event, 'tr[data-row-id]')
                onDragStart()
              }}
              onDragEnd={onDragEndRow}
              // cursor-grab (no cursor-pointer): esto no hace nada al
              // CLICKEARLO, solo al arrastrarlo — el cursor tiene que
              // comunicar eso, no invitar a un click que no pasa nada.
              className="cursor-grab rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-500 active:cursor-grabbing dark:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-400"
            >
              <GripIcon />
            </button>
          )}
          <button
            type="button"
            aria-label="Duplicar"
            title="Duplicar"
            onClick={() => onDuplicateRow?.(row.id)}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300"
          >
            <DuplicateIcon />
          </button>
          <button
            type="button"
            aria-label="Abrir página completa"
            title="Abrir página completa"
            onClick={() => onOpenRow(row.id)}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300"
          >
            <ExpandIcon />
          </button>
        </div>
      </td>
    </tr>
  )
}

function MenuItem({ label, onClick, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded px-2 py-2 text-left text-sm font-normal ${
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
          : 'text-gray-600 hover:bg-gray-100 dark:text-neutral-300 dark:hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  )
}

// menú al clickear el nombre de una columna: insertar propiedades nuevas al
// lado (como en Notion real), ocultar, eliminar, o abrir el panel completo
// para renombrar/cambiar tipo/editar opciones.
function ColumnMenu({ schema, prop, onUpdateSchema, onEditProperty, onInsertSelect, anchorRect, onClose }) {
  const [inserting, setInserting] = useState(null) // 'before' | 'after' | null
  const [name, setName] = useState('')
  const [type, setType] = useState('text')
  const idx = schema.findIndex((p) => p.id === prop.id)

  const insert = (offset) => {
    const newProp = { id: crypto.randomUUID(), name: name.trim() || 'Propiedad', type, hidden: false }
    if (type === 'select') newProp.options = [{ id: crypto.randomUUID(), name: 'Opción 1', color: COLOR_PALETTE[0] }]
    const next = [...schema]
    next.splice(idx + offset, 0, newProp)
    onUpdateSchema(next)
    onClose()
    // Select recién creado: abrir directo el editor de opciones en vez de
    // dejar que el usuario tenga que encontrarlo — es lo primero que va a
    // querer hacer con una columna de este tipo.
    if (type === 'select') onInsertSelect(newProp.id)
  }

  const toggleHidden = () => {
    onUpdateSchema(schema.map((p) => (p.id === prop.id ? { ...p, hidden: !p.hidden } : p)))
    onClose()
  }

  const remove = () => {
    onUpdateSchema(schema.filter((p) => p.id !== prop.id))
    onClose()
  }

  return (
    <Popover
      anchorRect={anchorRect}
      onClose={onClose}
      className="w-60 rounded-lg border border-gray-200 bg-white p-1 font-normal shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
    >
      {inserting ? (
          <div className="p-1.5">
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nombre de la propiedad"
              onKeyDown={(event) => event.key === 'Enter' && insert(inserting === 'before' ? 0 : 1)}
              className="mb-1.5 w-full rounded border border-gray-200 bg-transparent px-2 py-1 text-sm outline-none focus:border-blue-400 dark:border-neutral-700"
            />
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="mb-1.5 w-full rounded border border-gray-200 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
            >
              {Object.entries(CREATABLE_TYPE_LABEL).map(([t, label]) => (
                <option key={t} value={t}>
                  {label}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-1">
              <button
                type="button"
                onClick={() => setInserting(null)}
                className="rounded px-2 py-1 text-sm text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => insert(inserting === 'before' ? 0 : 1)}
                className="rounded bg-blue-600 px-2 py-1 text-sm font-medium text-white hover:bg-blue-700"
              >
                Crear
              </button>
            </div>
          </div>
        ) : (
          <>
            <MenuItem label="Editar propiedad" onClick={onEditProperty} />
            <MenuItem label="Insertar a la izquierda" onClick={() => setInserting('before')} />
            <MenuItem label="Insertar a la derecha" onClick={() => setInserting('after')} />
            {prop.type !== 'title' && <MenuItem label={prop.hidden ? 'Mostrar' : 'Ocultar'} onClick={toggleHidden} />}
            {prop.type !== 'title' && (
              <>
                <div className="my-1 border-t border-gray-100 dark:border-neutral-700" />
                <MenuItem label="Eliminar propiedad" danger onClick={remove} />
              </>
            )}
          </>
        )}
    </Popover>
  )
}

// resumen no editable de una propiedad (para Galería/Lista, donde se abre la
// fila para editar en vez de tener celdas inline como en la tabla)
function PropertyPreview({ prop, value }) {
  if (value == null || value === '') return null
  if (prop.type === 'select') {
    const opt = prop.options.find((o) => o.id === value)
    return opt ? <OptionPill name={opt.name} color={opt.color} /> : null
  }
  if (prop.type === 'checkbox') {
    return value ? <span className="text-xs text-gray-400 dark:text-neutral-500">✓ {prop.name}</span> : null
  }
  return <span className="truncate text-xs text-gray-400 dark:text-neutral-500">{String(value)}</span>
}

function RowIcon({ icon, size = 'h-4 w-4', textSize = 'text-base' }) {
  if (!icon) return <span className={`${textSize} shrink-0 leading-none text-gray-300 dark:text-neutral-700`}>📄</span>
  return isImageIcon(icon) ? (
    <img src={icon} alt="" className={`${size} shrink-0 rounded-sm object-cover`} />
  ) : (
    <span className={`${textSize} shrink-0 leading-none`}>{icon}</span>
  )
}

function GalleryView({ rows, schema, onOpenRow, onCreateRow, onDuplicateRow }) {
  const visibleProps = schema.filter((p) => p.type !== 'title' && !p.hidden).slice(0, 3)
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {rows.map((row) => (
        <div
          key={row.id}
          onClick={() => onOpenRow(row.id)}
          className="group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-neutral-700 dark:bg-neutral-800"
        >
          <button
            type="button"
            aria-label="Duplicar"
            title="Duplicar"
            onClick={(event) => {
              event.stopPropagation()
              onDuplicateRow?.(row.id)
            }}
            className="absolute right-1.5 top-1.5 z-10 rounded bg-white/80 p-1 text-gray-500 opacity-0 hover:bg-white hover:text-gray-700 group-hover:opacity-100 dark:bg-neutral-900/80 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-200"
          >
            <DuplicateIcon />
          </button>
          <div className="flex h-24 items-center justify-center overflow-hidden border-b border-gray-100 bg-gray-50 dark:border-neutral-700 dark:bg-white/[0.02]">
            <RowIcon icon={row.icon} size="h-full w-full" textSize="text-4xl" />
          </div>
          <div className="space-y-1.5 p-3">
            <p className="truncate text-sm font-medium text-gray-800 dark:text-neutral-100">{row.title || 'Sin título'}</p>
            {visibleProps.some((prop) => row.properties?.[prop.id] != null && row.properties?.[prop.id] !== '') && (
              <div className="flex flex-wrap gap-1">
                {visibleProps.map((prop) => (
                  <PropertyPreview key={prop.id} prop={prop} value={row.properties?.[prop.id]} />
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onCreateRow({})}
        className="flex min-h-[9.5rem] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-gray-200 text-sm text-gray-400 hover:border-gray-300 hover:text-gray-600 dark:border-neutral-700 dark:text-neutral-500 dark:hover:border-neutral-600 dark:hover:text-neutral-300"
      >
        <PlusIcon /> Nueva página
      </button>
    </div>
  )
}

function ListView({ rows, schema, onOpenRow, onCreateRow, onDuplicateRow, onMoveRow, reorderable }) {
  const visibleProps = schema.filter((p) => p.type !== 'title' && !p.hidden).slice(0, 3)
  // mismo mecanismo que TableView (ver el comentario largo ahí): arrastrar
  // la asa reordena vía movePage, solo activo cuando `reorderable` (sin
  // orden/búsqueda aplicados en la vista).
  const [dragRowId, setDragRowId] = useState(null)
  const [dropHint, setDropHint] = useState(null) // { rowId, side } | null
  const handleDrop = (targetId, side) => {
    if (dragRowId && dragRowId !== targetId) {
      const withoutDragged = rows.filter((r) => r.id !== dragRowId)
      let targetIdx = withoutDragged.findIndex((r) => r.id === targetId)
      if (targetIdx === -1) targetIdx = withoutDragged.length
      if (side === 'after') targetIdx += 1
      onMoveRow?.(dragRowId, targetIdx)
    }
    setDragRowId(null)
    setDropHint(null)
  }
  return (
    <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-neutral-700 dark:border-neutral-700">
      {rows.map((row) => (
        <div
          key={row.id}
          // lo usa setDragPreviewFromHandle para encontrar la fila entera
          // desde la manijita de 6 puntos (ver dragPreview.js)
          data-row-id={row.id}
          onClick={() => onOpenRow(row.id)}
          onDragOver={(event) => {
            if (!dragRowId || dragRowId === row.id) return
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            const side = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
            setDropHint({ rowId: row.id, side })
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDropHint(null)
          }}
          onDrop={(event) => {
            event.preventDefault()
            handleDrop(row.id, dropHint?.side ?? 'before')
          }}
          className={`group flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-white/[0.03] ${
            dropHint?.rowId === row.id && dropHint.side === 'before' ? 'border-t-2 border-t-blue-400' : ''
          } ${dropHint?.rowId === row.id && dropHint.side === 'after' ? 'border-b-2 border-b-blue-400' : ''}`}
        >
          {reorderable && (
            <button
              type="button"
              aria-label="Arrastrar para reordenar"
              title="Arrastrar para reordenar"
              draggable
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => {
                event.stopPropagation()
                event.dataTransfer.effectAllowed = 'move'
                setDragPreviewFromHandle(event, '[data-row-id]')
                setDragRowId(row.id)
              }}
              onDragEnd={() => {
                setDragRowId(null)
                setDropHint(null)
              }}
              className="shrink-0 cursor-grab rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-500 active:cursor-grabbing dark:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-400"
            >
              <GripIcon />
            </button>
          )}
          <RowIcon icon={row.icon} />
          <span className="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-neutral-300">{row.title || 'Sin título'}</span>
          {/* en pantalla chica no entran 3 etiquetas al lado del título sin
              desbordar la fila — se muestra solo la primera, y el resto
              vuelve desde sm: en adelante */}
          <div className="flex shrink-0 items-center gap-1">
            {visibleProps.map((prop, i) => (
              <div key={prop.id} className={i === 0 ? '' : 'hidden sm:block'}>
                <PropertyPreview prop={prop} value={row.properties?.[prop.id]} />
              </div>
            ))}
          </div>
          <button
            type="button"
            aria-label="Duplicar"
            title="Duplicar"
            onClick={(event) => {
              event.stopPropagation()
              onDuplicateRow?.(row.id)
            }}
            className="shrink-0 rounded p-1 text-gray-300 opacity-0 hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100 dark:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-300"
          >
            <DuplicateIcon />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onCreateRow({})}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-gray-400 hover:bg-gray-50 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/[0.03] dark:hover:text-neutral-300"
      >
        <PlusIcon /> Nueva página
      </button>
    </div>
  )
}

const DEFAULT_COL_WIDTH = 200
const DEFAULT_TITLE_COL_WIDTH = 260
const MIN_COL_WIDTH = 80
const DEFAULT_CHECKBOX_COL_WIDTH = 32
const MIN_CHECKBOX_COL_WIDTH = 28
// clave reservada para el ancho de la columna de checkboxes dentro de
// `colWidths` — esa columna no es una propiedad del schema, así que no tiene
// un prop.id real al que engancharse.
const CHECKBOX_COL_ID = '__checkbox__'
// columna fija de acciones (asa de arrastre + Duplicar/Abrir) al final de
// cada fila — a diferencia de las columnas de arriba, no es resizeable ni
// parte del schema, tres íconos de 28px con un poco de aire alcanzan.
const ACTIONS_COL_WIDTH = 92

// handle de arrastre en el borde derecho del <th> — sigue el mouse con
// estado local (sin tocar el schema en cada pixel, eso dispararía un
// round-trip por IPC por frame) y recién persiste el ancho final al soltar.
// El delta es el mismo signo para ambos lados: mover a la izquierda angosta
// la columna, a la derecha la ensancha — "min" se parametriza porque la
// columna de checkboxes necesita un piso mucho más chico que el resto.
function ColumnResizeHandle({ width, onResize, onCommit, min = MIN_COL_WIDTH }) {
  const dragRef = useRef(null)
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dragRef.current = { startX: event.clientX, startWidth: width }
        const onMove = (moveEvent) => {
          const delta = moveEvent.clientX - dragRef.current.startX
          onResize(Math.max(min, dragRef.current.startWidth + delta))
        }
        const onUp = (upEvent) => {
          const delta = upEvent.clientX - dragRef.current.startX
          onCommit(Math.max(min, dragRef.current.startWidth + delta))
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }}
      onClick={(event) => event.stopPropagation()}
      // 10px de hitbox (antes 6px): ese ancho competía con el encabezado
      // completo, que también es "arrastrable" para reordenar columnas — un
      // click a un par de píxeles del borde exacto terminaba moviendo la
      // columna entera en vez de achicarla.
      className="absolute -right-1 top-0 z-10 h-full w-2.5 cursor-col-resize select-none hover:bg-blue-400/70 active:bg-blue-500"
    />
  )
}

// misma idea que "value" en PropertyPreview pero como texto plano, para
// pegar en una hoja de cálculo (ver handleCopyActivities en TableView) — un
// tab o salto de línea suelto dentro de una celda correría las columnas del
// resto de la fila al pegarlo, por eso se sanitiza.
function propertyValueToText(prop, value) {
  if (value == null || value === '') return ''
  if (prop.type === 'select') return prop.options.find((o) => o.id === value)?.name ?? ''
  if (prop.type === 'checkbox') return value ? 'Sí' : 'No'
  return String(value).replace(/[\t\n\r]+/g, ' ')
}

function TableView({
  schema,
  rows,
  onOpenRow,
  onUpdateTitle,
  onUpdateProperty,
  onCreateRow,
  onDuplicateRow,
  onMoveRow,
  onTrashRows,
  onUpdateSchema,
  checkboxColWidth,
  onCommitCheckboxColWidth,
  onEditProperty,
  onInsertSelect,
  reorderable,
  remoteCursors,
  broadcastElementFocus,
}) {
  const [menu, setMenu] = useState(null) // { propId, rect } | null
  const [dragPropId, setDragPropId] = useState(null)
  const [dropHint, setDropHint] = useState(null) // { propId, side: 'before' | 'after' } | null
  // arrastrar filas para reordenarlas a mano — reusa movePage (mismo
  // mecanismo del árbol del sidebar: las filas de una base de datos SON
  // páginas, hijas de ella). Solo tiene sentido si `rows` está en su orden
  // natural: con una columna ordenada o una búsqueda activa, el índice que
  // se vería acá no correspondería al índice real entre TODAS las filas —
  // `reorderable` (calculado en DatabaseView) apaga el arrastre en esos casos.
  const [dragRowId, setDragRowId] = useState(null)
  const [rowDropHint, setRowDropHint] = useState(null) // { rowId, side } | null
  const handleRowDrop = (targetId, side) => {
    if (dragRowId && dragRowId !== targetId) {
      const withoutDragged = rows.filter((r) => r.id !== dragRowId)
      let targetIdx = withoutDragged.findIndex((r) => r.id === targetId)
      if (targetIdx === -1) targetIdx = withoutDragged.length
      if (side === 'after') targetIdx += 1
      onMoveRow?.(dragRowId, targetIdx)
    }
    setDragRowId(null)
    setRowDropHint(null)
  }
  const [colWidths, setColWidths] = useState({}) // propId -> px, override local mientras se arrastra
  const [selected, setSelected] = useState(new Set())
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [copied, setCopied] = useState(false)
  const visibleSchema = schema.filter((p) => !p.hidden)
  const updatePropOptions = (propId, options) => {
    onUpdateSchema(schema.map((p) => (p.id === propId ? { ...p, options } : p)))
  }

  const rowIds = rows.map((r) => r.id)
  const allSelected = rowIds.length > 0 && rowIds.every((id) => selected.has(id))

  const toggleRowSelected = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllSelected = () => {
    setSelected((prev) => (rowIds.every((id) => prev.has(id)) ? new Set() : new Set(rowIds)))
  }

  const handleDeleteSelected = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    setConfirmingDelete(false)
    const ids = [...selected]
    setSelected(new Set())
    await onTrashRows?.(ids)
  }

  // arma un TSV (columnas separadas por tab, filas por salto de línea) con
  // las mismas columnas y el mismo orden que se ve en la tabla — pegado en
  // Sheets/Excel cae directo en sus celdas, sin tener que retipear nada a
  // mano. Sin fila de encabezados: se pega directo abajo de filas ya
  // existentes en la planilla de destino. Si hay filas seleccionadas copia
  // solo esas, si no, todas las que están visibles (ya filtradas/ordenadas).
  const handleCopyActivities = async () => {
    const targetRows = selected.size > 0 ? rows.filter((r) => selected.has(r.id)) : rows
    const lines = targetRows.map((row) =>
      visibleSchema
        .map((prop) => propertyValueToText(prop, prop.type === 'title' ? row.title : row.properties?.[prop.id]))
        .join('\t')
    )
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // portapapeles bloqueado por el SO — no hay mucho más que hacer acá
    }
  }

  const widthFor = (prop) =>
    colWidths[prop.id] ?? prop.width ?? (prop.type === 'title' ? DEFAULT_TITLE_COL_WIDTH : DEFAULT_COL_WIDTH)

  const commitWidth = (propId, width) => {
    setColWidths((w) => ({ ...w, [propId]: width }))
    onUpdateSchema(schema.map((p) => (p.id === propId ? { ...p, width } : p)))
  }

  const checkboxColWidthValue = colWidths[CHECKBOX_COL_ID] ?? checkboxColWidth
  const commitCheckboxWidth = (width) => {
    setColWidths((w) => ({ ...w, [CHECKBOX_COL_ID]: width }))
    onCommitCheckboxColWidth(width)
  }

  // reordena en el schema COMPLETO (no solo el visible), insertando antes/después
  // de la columna destino según de qué lado se soltó
  const reorderColumn = (fromId, targetId, side) => {
    const fromIdx = schema.findIndex((p) => p.id === fromId)
    if (fromIdx === -1 || fromId === targetId) return
    const next = [...schema]
    const [moved] = next.splice(fromIdx, 1)
    let targetIdx = next.findIndex((p) => p.id === targetId)
    if (targetIdx === -1) targetIdx = next.length
    if (side === 'after') targetIdx += 1
    next.splice(targetIdx, 0, moved)
    onUpdateSchema(next)
  }

  const tableContainerRef = useRef(null)
  const isMobile = useIsMobile()

  useEffect(() => {
    const el = tableContainerRef.current
    if (!el || isMobile) return

    const handleWheel = (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
        const raw = event.deltaY !== 0 ? event.deltaY : event.deltaX
        const delta = event.deltaMode === 1 ? raw * 24 : event.deltaMode === 2 ? raw * 300 : raw
        el.scrollLeft += delta
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [isMobile])

  return (
    <div
      ref={tableContainerRef}
      className="inline-block max-w-full overflow-x-auto rounded-lg border border-gray-200 align-top dark:border-neutral-700"
    >
      <div
        className={`flex items-center justify-between gap-2 border-b px-3 py-1.5 text-sm ${
          selected.size > 0
            ? 'border-gray-200 bg-blue-50 dark:border-neutral-700 dark:bg-blue-500/10'
            : 'border-gray-200 bg-gray-50/70 dark:border-neutral-700 dark:bg-white/[0.03]'
        }`}
      >
        <span className={selected.size > 0 ? 'text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-neutral-400'}>
          {selected.size > 0
            ? `${selected.size} seleccionada${selected.size === 1 ? '' : 's'}`
            : `${rows.length} fila${rows.length === 1 ? '' : 's'}`}
        </span>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <>
              <button
                type="button"
                onClick={() => {
                  setSelected(new Set())
                  setConfirmingDelete(false)
                }}
                className="cursor-pointer text-xs text-gray-500 hover:underline dark:text-neutral-400"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleDeleteSelected}
                onMouseLeave={() => setConfirmingDelete(false)}
                className={`cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium ${
                  confirmingDelete
                    ? 'bg-red-600 text-white'
                    : 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-400'
                }`}
              >
                {confirmingDelete ? `¿Eliminar ${selected.size}?` : 'Eliminar'}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleCopyActivities}
            title="Copia esta tabla como texto separado por tabs, lista para pegar en una hoja de cálculo"
            className={`cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium ${
              copied
                ? 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:text-neutral-300 dark:hover:bg-white/20'
            }`}
          >
            {copied ? '✓ Copiado' : 'Copiar actividades'}
          </button>
        </div>
      </div>
      <table
        className="border-collapse text-left"
        style={{
          // table-layout:fixed solo respeta los anchos de <col> si la tabla
          // TAMBIÉN tiene su propio width — sin esto, medido directo en el
          // navegador: el ancho de columna declarado se ignora igual, el
          // texto se parte letra por letra (el bug reportado en mobile,
          // donde el contenedor angosto le da al navegador el empujón para
          // hacerlo). El overflow-x-auto del contenedor de más arriba es lo
          // que después deja hacer scroll horizontal a esto.
          tableLayout: 'fixed',
          width: checkboxColWidthValue + visibleSchema.reduce((sum, prop) => sum + widthFor(prop), 0),
        }}
      >
        <colgroup>
          <col style={{ width: `${checkboxColWidthValue}px` }} />
          {visibleSchema.map((prop) => (
            <col key={prop.id} style={{ width: `${widthFor(prop)}px` }} />
          ))}
          {/* Duplicar/Abrir — columna fija, no flotando encima del título
              (ver comentario en TableRowView: antes eran absolute + opacity-0
              con pr-10 de resguardo, que no alcanzaba con títulos largos o la
              columna angosta, y quedaban montados sobre el texto). */}
          <col style={{ width: `${ACTIONS_COL_WIDTH}px` }} />
        </colgroup>
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50/70 text-xs text-gray-500 dark:border-neutral-700 dark:bg-white/[0.03] dark:text-neutral-400">
            <th className="relative p-0">
              <label className="absolute inset-0 flex cursor-pointer items-center justify-center">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAllSelected}
                  aria-label="Seleccionar todas las filas"
                  className="cursor-pointer"
                />
              </label>
              <ColumnResizeHandle
                width={checkboxColWidthValue}
                min={MIN_CHECKBOX_COL_WIDTH}
                onResize={(width) => setColWidths((w) => ({ ...w, [CHECKBOX_COL_ID]: width }))}
                onCommit={commitCheckboxWidth}
              />
            </th>
            {visibleSchema.map((prop) => (
              <th
                key={prop.id}
                onDragOver={(event) => {
                  if (!dragPropId || dragPropId === prop.id) return
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  const side = event.clientX - rect.left < rect.width / 2 ? 'before' : 'after'
                  setDropHint({ propId: prop.id, side })
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget === event.target) setDropHint(null)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragPropId && dropHint?.propId === prop.id) reorderColumn(dragPropId, dropHint.propId, dropHint.side)
                  setDragPropId(null)
                  setDropHint(null)
                }}
                className={`group relative p-0 font-medium ${
                  dropHint?.propId === prop.id && dropHint.side === 'before' ? 'border-l-2 border-blue-400' : ''
                } ${dropHint?.propId === prop.id && dropHint.side === 'after' ? 'border-r-2 border-blue-400' : ''}`}
              >
                <button
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    setDragPreview(event, event.currentTarget)
                    setDragPropId(prop.id)
                  }}
                  onDragEnd={() => {
                    setDragPropId(null)
                    setDropHint(null)
                  }}
                  onClick={(event) => {
                    // capturar el rect ya, no adentro del updater: React (en
                    // StrictMode) puede volver a invocar esta función más
                    // tarde para detectar impurezas, cuando el evento ya no
                    // es válido y currentTarget quedó en null.
                    const rect = event.currentTarget.getBoundingClientRect()
                    setMenu((m) => (m?.propId === prop.id ? null : { propId: prop.id, rect }))
                  }}
                  className="flex w-full cursor-pointer items-center justify-between gap-1 px-3 py-2.5 text-left hover:bg-gray-100 dark:hover:bg-white/10"
                >
                  <span className="truncate">{prop.name}</span>
                  <ChevronDownIcon
                    className={`h-3 w-3 shrink-0 text-gray-400 dark:text-neutral-500 ${
                      menu?.propId === prop.id ? '' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  />
                </button>
                {menu?.propId === prop.id && (
                  <ColumnMenu
                    schema={schema}
                    prop={prop}
                    onUpdateSchema={onUpdateSchema}
                    onEditProperty={() => {
                      setMenu(null)
                      onEditProperty()
                    }}
                    onInsertSelect={onInsertSelect}
                    anchorRect={menu.rect}
                    onClose={() => setMenu(null)}
                  />
                )}
                <ColumnResizeHandle
                  width={widthFor(prop)}
                  onResize={(width) => setColWidths((w) => ({ ...w, [prop.id]: width }))}
                  onCommit={(width) => commitWidth(prop.id, width)}
                />
              </th>
            ))}
            <th className="p-0" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const remoteCollab = Object.values(remoteCursors || {}).find(
              (c) => !c?.hidden && c?.activeRowId === row.id
            )
            return (
              <TableRowView
                key={row.id}
                row={row}
                schema={visibleSchema}
                selected={selected.has(row.id)}
                onToggleSelect={() => toggleRowSelected(row.id)}
                onOpenRow={onOpenRow}
                onUpdateTitle={onUpdateTitle}
                onUpdateProperty={onUpdateProperty}
                onDuplicateRow={onDuplicateRow}
                onUpdatePropOptions={updatePropOptions}
                reorderable={reorderable}
                dropSide={dragRowId && rowDropHint?.rowId === row.id ? rowDropHint.side : null}
                onDragStart={() => setDragRowId(row.id)}
                onDragEndRow={() => {
                  setDragRowId(null)
                  setRowDropHint(null)
                }}
                onDragOverRow={(event) => {
                  if (!dragRowId || dragRowId === row.id) return
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  const side = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
                  setRowDropHint({ rowId: row.id, side })
                }}
                onDragLeaveRow={(event) => {
                  if (event.currentTarget === event.target) setRowDropHint(null)
                }}
                onDropRow={() => handleRowDrop(row.id, rowDropHint?.side ?? 'before')}
                remoteCollaborator={remoteCollab}
                onFocus={(rowId) => broadcastElementFocus?.({ rowId })}
                onBlur={() => broadcastElementFocus?.({ rowId: null })}
              />
            )
          })}
        </tbody>
      </table>
      <button
        type="button"
        onClick={() => onCreateRow({})}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-gray-400 hover:bg-gray-50 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/[0.03] dark:hover:text-neutral-300"
      >
        <PlusIcon /> Nueva página
      </button>
    </div>
  )
}

function ToolbarButton({ active, onClick, label, icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rounded-md p-1.5 ${
        active
          ? 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-neutral-200'
          : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300'
      }`}
    >
      {icon}
    </button>
  )
}

function SortPanel({ schema, sort, onSetSort }) {
  // "title" ya viene incluido en schema como una propiedad más (ver TITLE_PROP_ID)
  const options = schema
  return (
    <div className="w-56 p-1">
      {options.map((opt) => {
        const active = sort?.propId === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onSetSort(active ? { propId: opt.id, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { propId: opt.id, dir: 'asc' })}
            className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
              active ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' : 'hover:bg-gray-100 dark:hover:bg-white/5'
            }`}
          >
            {opt.name}
            {active && <span className="text-xs">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
          </button>
        )
      })}
      {sort && (
        <button
          type="button"
          onClick={() => onSetSort(null)}
          className="mt-1 w-full rounded-md border-t border-gray-100 px-2 py-1.5 text-left text-sm text-gray-400 hover:text-gray-600 dark:border-neutral-700 dark:hover:text-neutral-300"
        >
          Quitar orden
        </button>
      )}
    </div>
  )
}

function FilterPanel({ schema, filter, onSetFilter }) {
  const [propId, setPropId] = useState(filter?.propId ?? schema[0]?.id ?? '')
  const prop = schema.find((p) => p.id === propId)

  const apply = (patch) => {
    if (!prop) return
    onSetFilter({ propId: prop.id, condition: 'contains', value: '', ...filter, ...patch, propId: prop.id })
  }

  if (schema.length === 0) {
    return <p className="w-56 p-2 text-xs text-gray-400 dark:text-neutral-500">No hay propiedades para filtrar.</p>
  }

  return (
    <div className="w-64 space-y-2 p-2">
      <select
        value={propId}
        onChange={(event) => {
          setPropId(event.target.value)
          onSetFilter(null)
        }}
        className="w-full rounded border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none dark:border-neutral-700"
      >
        {schema.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      {prop?.type === 'select' && (
        <div className="flex gap-1">
          <select
            value={filter?.condition ?? 'is'}
            onChange={(event) => apply({ condition: event.target.value })}
            className="rounded border border-gray-200 bg-transparent px-1.5 py-1 text-xs outline-none dark:border-neutral-700"
          >
            <option value="is">Es</option>
            <option value="is_not">No es</option>
          </select>
          <select
            value={filter?.value ?? ''}
            onChange={(event) => apply({ value: event.target.value })}
            className="min-w-0 flex-1 rounded border border-gray-200 bg-transparent px-1.5 py-1 text-xs outline-none dark:border-neutral-700"
          >
            <option value="">—</option>
            {prop.options.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {prop?.type === 'checkbox' && (
        <select
          value={filter?.condition ?? 'checked'}
          onChange={(event) => apply({ condition: event.target.value, value: null })}
          className="w-full rounded border border-gray-200 bg-transparent px-1.5 py-1 text-xs outline-none dark:border-neutral-700"
        >
          <option value="checked">Marcado</option>
          <option value="unchecked">No marcado</option>
        </select>
      )}
      {prop && prop.type !== 'select' && prop.type !== 'checkbox' && (
        <div className="flex gap-1">
          <select
            value={filter?.condition ?? 'contains'}
            onChange={(event) => apply({ condition: event.target.value })}
            className="rounded border border-gray-200 bg-transparent px-1.5 py-1 text-xs outline-none dark:border-neutral-700"
          >
            <option value="contains">Contiene</option>
            <option value="not_contains">No contiene</option>
          </select>
          <input
            value={filter?.value ?? ''}
            onChange={(event) => apply({ value: event.target.value })}
            placeholder="Valor…"
            className="min-w-0 flex-1 rounded border border-gray-200 bg-transparent px-1.5 py-1 text-xs outline-none dark:border-neutral-700"
          />
        </div>
      )}

      {filter && (
        <button
          type="button"
          onClick={() => onSetFilter(null)}
          className="w-full rounded-md border-t border-gray-100 pt-1.5 text-left text-sm text-gray-400 hover:text-gray-600 dark:border-neutral-700 dark:hover:text-neutral-300"
        >
          Quitar filtro
        </button>
      )}
    </div>
  )
}

const VIEW_TABS = [
  { id: 'board', label: 'Tablero', icon: <BoardIcon /> },
  { id: 'table', label: 'Todas', icon: <TableIcon /> },
  { id: 'gallery', label: 'Galería', icon: <GalleryIcon /> },
  { id: 'list', label: 'Lista', icon: <ListViewIcon /> },
]

export default function DatabaseView({
  page,
  rows,
  onOpenRow,
  onUpdateTitle,
  onUpdateProperty,
  onCreateRow,
  onDuplicateRow,
  onMoveRow,
  onTrashRows,
  onUpdateSchema,
  remoteCursors,
  broadcastElementFocus,
}) {
  // por base de datos, no global: sin esto, view era un simple useState que
  // siempre arrancaba en 'board' de nuevo al remontar (cambiar de pestaña o
  // de página remonta DatabaseView) — se sentía como "la vista de una se le
  // pega a la otra" aunque en realidad cada una simplemente no recordaba la
  // suya. localStorage además la mantiene entre reinicios de la app.
  const [view, setViewState] = useState(() => localStorage.getItem(`flashlab-db-view-${page.id}`) || 'board')
  const setView = (next) => {
    setViewState(next)
    localStorage.setItem(`flashlab-db-view-${page.id}`, next)
  }
  // mismo patrón que `view` arriba: la columna de checkboxes no es una
  // propiedad del schema (no tiene dónde vivir su ancho ahí), así que su
  // ancho manual se guarda aparte, por base de datos.
  const [checkboxColWidth, setCheckboxColWidthState] = useState(() => {
    const stored = Number(localStorage.getItem(`flashlab-db-checkbox-col-width-${page.id}`))
    return stored >= MIN_CHECKBOX_COL_WIDTH ? stored : DEFAULT_CHECKBOX_COL_WIDTH
  })
  const setCheckboxColWidth = (next) => {
    setCheckboxColWidthState(next)
    localStorage.setItem(`flashlab-db-checkbox-col-width-${page.id}`, String(next))
  }
  const [openPanel, setOpenPanel] = useState(null) // 'sort' | 'filter' | 'settings' | null
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState(null)
  const [filter, setFilter] = useState(null)
  const [focusPropId, setFocusPropId] = useState(null)
  const toolbarRef = useRef(null)
  const schema = page.databaseSchema ?? []
  const groupProp = firstSelectProperty(schema)

  useEffect(() => {
    const onDocMouseDown = (event) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target)) setOpenPanel(null)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

  const visibleRows = useMemo(() => {
    let list = rows
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((r) => (r.title || '').toLowerCase().includes(q))
    }
    if (filter) list = list.filter((r) => matchesFilter(r, schema, filter))
    return sortRows(list, schema, sort)
  }, [rows, search, filter, sort, schema])

  // arrastrar para reordenar a mano solo tiene sentido en el orden NATURAL
  // de las filas: con una columna de "Ordenar" activa, o buscando, el índice
  // que se ve en pantalla no corresponde al índice real entre todas las
  // filas de la base — soltar ahí movería la fila a un lugar distinto del
  // que se ve, apenas se borre el filtro/orden. Con las dos apagadas,
  // visibleRows queda igual a rows (mismo orden), así que sí es seguro.
  const reorderable = Boolean(onMoveRow) && !sort && !search.trim()

  const toggle = (panel) => setOpenPanel((p) => (p === panel ? null : panel))

  const dbContainerRef = useRef(null)
  const isMobile = useIsMobile()

  useEffect(() => {
    const el = dbContainerRef.current
    if (!el || isMobile) return

    const handleWheel = (event) => {
      if ((event.ctrlKey || event.metaKey) && view === 'board') {
        const boardEl = el.querySelector('[data-board-scroll]')
        if (boardEl) {
          event.preventDefault()
          const raw = event.deltaY !== 0 ? event.deltaY : event.deltaX
          const delta = event.deltaMode === 1 ? raw * 24 : event.deltaMode === 2 ? raw * 300 : raw
          boardEl.scrollLeft += delta
        }
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [isMobile, view])

  return (
    <div ref={dbContainerRef}>
      <div ref={toolbarRef} className="relative mb-4 flex items-center justify-between border-b border-gray-100 dark:border-neutral-700">
        <div
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
          onWheel={(event) => {
            // mismo motivo que TabBar.jsx: overflow-x-auto no responde a la
            // rueda vertical de un mouse común, solo a touch/trackpad
            // horizontal.
            if (event.deltaY === 0) return
            event.currentTarget.scrollLeft += event.deltaY
            event.preventDefault()
          }}
        >
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setView(tab.id)}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${
                view === tab.id
                  ? 'border-gray-800 text-gray-800 dark:border-neutral-200 dark:text-neutral-100'
                  : 'border-transparent text-gray-400 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300'
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        <div className="mb-1.5 flex shrink-0 items-center gap-0.5">
          {searchOpen && (
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onBlur={() => !search && setSearchOpen(false)}
              placeholder="Buscar en esta vista…"
              className="mr-1 w-40 rounded-md border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-blue-400 dark:border-neutral-700"
            />
          )}
          <ToolbarButton label="Ordenar" icon={<SortIcon />} active={openPanel === 'sort' || !!sort} onClick={() => toggle('sort')} />
          <ToolbarButton label="Filtrar" icon={<FilterIcon />} active={openPanel === 'filter' || !!filter} onClick={() => toggle('filter')} />
          <ToolbarButton label="Buscar" icon={<SearchIcon />} active={searchOpen} onClick={() => setSearchOpen((s) => !s)} />
          <ToolbarButton label="Configuración" icon={<SettingsIcon />} active={openPanel === 'settings'} onClick={() => toggle('settings')} />
          <button
            type="button"
            onClick={() => onCreateRow({})}
            className="ml-1 flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <PlusIcon /> Nuevo
          </button>
        </div>

        {openPanel && (
          <div className="absolute right-0 top-full z-20 mt-1 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
            {openPanel === 'sort' && <SortPanel schema={schema} sort={sort} onSetSort={setSort} />}
            {openPanel === 'filter' && <FilterPanel schema={schema} filter={filter} onSetFilter={setFilter} />}
            {openPanel === 'settings' && (
              <SchemaEditor schema={schema} onUpdateSchema={onUpdateSchema} focusPropId={focusPropId} />
            )}
          </div>
        )}
      </div>

      {view === 'board' && groupProp && (
        <BoardView
          rows={visibleRows}
          schema={schema}
          groupProp={groupProp}
          onOpenRow={onOpenRow}
          onUpdateTitle={onUpdateTitle}
          onUpdateProperty={onUpdateProperty}
          onCreateRow={onCreateRow}
          onDuplicateRow={onDuplicateRow}
          onUpdateSchema={onUpdateSchema}
          onTrashRows={onTrashRows}
          remoteCursors={remoteCursors}
          broadcastElementFocus={broadcastElementFocus}
        />
      )}
      {view === 'board' && !groupProp && (
        <p className="text-sm text-gray-400 dark:text-neutral-500">
          Esta base de datos no tiene una propiedad de tipo "select" para agrupar en el Tablero. Agregá una desde el
          ícono de configuración (⚙) arriba.
        </p>
      )}
      {view === 'table' && (
        <TableView
          schema={schema}
          rows={visibleRows}
          onOpenRow={onOpenRow}
          onUpdateTitle={onUpdateTitle}
          onUpdateProperty={onUpdateProperty}
          onCreateRow={onCreateRow}
          onDuplicateRow={onDuplicateRow}
          onMoveRow={onMoveRow}
          reorderable={reorderable}
          onTrashRows={onTrashRows}
          onUpdateSchema={onUpdateSchema}
          checkboxColWidth={checkboxColWidth}
          onCommitCheckboxColWidth={setCheckboxColWidth}
          onEditProperty={() => setOpenPanel('settings')}
          onInsertSelect={(propId) => {
            setFocusPropId(propId)
            setOpenPanel('settings')
          }}
          remoteCursors={remoteCursors}
          broadcastElementFocus={broadcastElementFocus}
        />
      )}
      {view === 'gallery' && (
        <GalleryView
          rows={visibleRows}
          schema={schema}
          onOpenRow={onOpenRow}
          onCreateRow={onCreateRow}
          onDuplicateRow={onDuplicateRow}
        />
      )}
      {view === 'list' && (
        <ListView
          rows={visibleRows}
          schema={schema}
          onOpenRow={onOpenRow}
          onMoveRow={onMoveRow}
          reorderable={reorderable}
          onCreateRow={onCreateRow}
          onDuplicateRow={onDuplicateRow}
        />
      )}
    </div>
  )
}
