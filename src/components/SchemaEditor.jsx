import { useEffect, useRef, useState } from 'react'

// los inputs de nombre (propiedad/opción) son controlados y el guardado
// dispara un viaje redondo por IPC (setDatabaseSchema -> syncFromBackend) —
// si onChange llamara a onRename en cada tecla, ese round-trip asíncrono
// podía volver justo cuando el usuario ya había movido el cursor a mitad de
// palabra y el navegador lo reubicaba al final al reasignar .value. Por eso
// estado local + debounce (mismo patrón que InlineTitle/handleTitle).
const RENAME_DELAY_MS = 400

// "title" es un tipo especial (una sola columna por base de datos, el valor
// vive en page.title) — aparece para mostrar el badge de tipo, pero nunca
// como opción elegible al crear una propiedad nueva.
export const TYPE_LABEL = { title: 'Título', text: 'Texto', number: 'Número', select: 'Select', checkbox: 'Casilla', date: 'Fecha' }
export const CREATABLE_TYPE_LABEL = Object.fromEntries(Object.entries(TYPE_LABEL).filter(([type]) => type !== 'title'))
// Ampliada de 9 a 15 tonos vívidos (equivalentes a los "400" de Tailwind) en
// vez de los hues reales de Notion — esos son bastante apagados de por sí y
// a alpha 40% terminan viéndose apagados/oscuros en vez de alegres. Con 9
// nomás, listas de más de 9 opciones (comunes en Select reales) empezaban a
// repetir color cada 9. El texto sobre cada tag es un tono del mismo color
// (ver tagTextColors en DatabaseView.jsx), no un blanco/gris fijo.
export const COLOR_PALETTE = [
  '#9ca3af', // gris
  '#c98a54', // marrón
  '#fbbf24', // ámbar
  '#fb923c', // naranja
  '#facc15', // amarillo
  '#a3e635', // lima
  '#34d399', // verde
  '#2dd4bf', // esmeralda
  '#22d3ee', // cian
  '#38bdf8', // azul
  '#818cf8', // índigo
  '#a78bfa', // violeta
  '#e879f9', // fucsia
  '#f472b6', // rosa
  '#fb7185', // rojo
]

function EyeIcon({ open }) {
  return open ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.5 5.2A9.8 9.8 0 0 1 12 5c6 0 10 7 10 7a15 15 0 0 1-3.1 3.7M6.6 6.6C4 8.3 2 12 2 12s4 7 10 7a9.5 9.5 0 0 0 3.4-.6" />
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
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
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

function OptionRow({ option, onRename, onChangeColor, onDelete, onCommitEnter, autoFocus }) {
  const [confirm, setConfirm] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [name, setName] = useState(option.name)
  const inputRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => setName(option.name), [option.name, option.id])

  useEffect(() => {
    if (autoFocus) inputRef.current?.select()
  }, [autoFocus])

  const commit = (value) => {
    clearTimeout(timerRef.current)
    onRename(value)
  }

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Cambiar color"
          onClick={() => setPickerOpen((p) => !p)}
          className="h-2.5 w-2.5 shrink-0 rounded-full ring-offset-1 hover:ring-2 hover:ring-gray-300 dark:hover:ring-neutral-600"
          style={{ backgroundColor: option.color }}
        />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={name}
          onChange={(event) => {
            const value = event.target.value
            setName(value)
            clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => onRename(value), RENAME_DELAY_MS)
          }}
          onKeyDown={(event) => {
            // mismo patrón que Notion: Enter guarda esta opción y abre una
            // nueva debajo ya enfocada, para cargar varias seguidas sin
            // tocar el mouse — no hace falta blur() acá, el foco pasa solo
            // al input de la opción nueva en cuanto se monta (ver autoFocus
            // más abajo).
            if (event.key === 'Enter') {
              event.preventDefault()
              commit(event.currentTarget.value)
              onCommitEnter()
            }
          }}
          onBlur={(event) => commit(event.target.value)}
          className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-xs outline-none hover:bg-gray-100 focus:bg-gray-100 dark:hover:bg-white/5 dark:focus:bg-white/5"
        />
        <button
          type="button"
          onClick={() => (confirm ? onDelete() : setConfirm(true))}
          onMouseLeave={() => setConfirm(false)}
          className={`shrink-0 rounded p-1 ${
            confirm ? 'text-red-600' : 'text-gray-300 hover:text-gray-600 dark:text-neutral-600 dark:hover:text-neutral-300'
          }`}
        >
          <TrashIcon />
        </button>
      </div>
      {pickerOpen && (
        <div className="ml-4 mt-1 flex flex-wrap gap-1">
          {COLOR_PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Color ${color}`}
              onClick={() => {
                onChangeColor(color)
                setPickerOpen(false)
              }}
              className={`h-4 w-4 rounded-full ${color === option.color ? 'ring-2 ring-offset-1 ring-gray-400 dark:ring-neutral-400' : ''}`}
              style={{ backgroundColor: color }}
            />
          ))}
          <CustomColorSwatch color={option.color} onChange={onChangeColor} />
        </div>
      )}
    </div>
  )
}

function PropertyRow({ prop, onChange, onDelete, autoOpen }) {
  const [confirm, setConfirm] = useState(false)
  const [showOptions, setShowOptions] = useState(autoOpen)
  const [justAddedOptionId, setJustAddedOptionId] = useState(null)
  const [name, setName] = useState(prop.name)
  const nameTimerRef = useRef(null)

  useEffect(() => setName(prop.name), [prop.name, prop.id])

  const patchOption = (optId, patch) => {
    onChange({ ...prop, options: prop.options.map((o) => (o.id === optId ? { ...o, ...patch } : o)) })
  }
  const addOption = () => {
    const color = COLOR_PALETTE[prop.options.length % COLOR_PALETTE.length]
    const id = crypto.randomUUID()
    onChange({ ...prop, options: [...prop.options, { id, name: 'Nueva opción', color }] })
    setJustAddedOptionId(id)
  }
  const deleteOption = (optId) => {
    onChange({ ...prop, options: prop.options.filter((o) => o.id !== optId) })
  }
  const toggleOptions = () =>
    setShowOptions((s) => {
      if (s) setJustAddedOptionId(null)
      return !s
    })

  return (
    <div className="rounded-md px-1 py-1 hover:bg-gray-50 dark:hover:bg-white/[0.03]">
      <div className="flex items-center gap-1.5">
        {prop.type !== 'title' && (
          <button
            type="button"
            title={prop.hidden ? 'Mostrar en la Tabla' : 'Ocultar en la Tabla'}
            onClick={() => onChange({ ...prop, hidden: !prop.hidden })}
            className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300"
          >
            <EyeIcon open={!prop.hidden} />
          </button>
        )}
        <input
          value={name}
          onChange={(event) => {
            const value = event.target.value
            setName(value)
            clearTimeout(nameTimerRef.current)
            nameTimerRef.current = setTimeout(() => onChange({ ...prop, name: value }), RENAME_DELAY_MS)
          }}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          onBlur={(event) => {
            clearTimeout(nameTimerRef.current)
            onChange({ ...prop, name: event.target.value })
          }}
          className="min-w-0 flex-1 rounded bg-transparent px-1.5 py-1 text-sm outline-none hover:bg-gray-100 focus:bg-gray-100 dark:hover:bg-white/5 dark:focus:bg-white/5"
        />
        <span className="shrink-0 text-xs text-gray-400 dark:text-neutral-500">{TYPE_LABEL[prop.type]}</span>
        {prop.type === 'select' && (
          <button
            type="button"
            onClick={toggleOptions}
            className="shrink-0 rounded px-1.5 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300"
          >
            Opciones
          </button>
        )}
        {prop.type !== 'title' && (
          <button
            type="button"
            onClick={() => (confirm ? onDelete() : setConfirm(true))}
            onMouseLeave={() => setConfirm(false)}
            className={`shrink-0 rounded p-1 ${
              confirm ? 'text-red-600' : 'text-gray-300 hover:text-gray-600 dark:text-neutral-600 dark:hover:text-neutral-300'
            }`}
          >
            <TrashIcon />
          </button>
        )}
      </div>
      {prop.type === 'select' && showOptions && (
        <div className="ml-7 mt-1 border-l border-gray-200 pl-2 dark:border-neutral-700">
          {prop.options.map((opt) => (
            <OptionRow
              key={opt.id}
              option={opt}
              onRename={(name) => patchOption(opt.id, { name })}
              onChangeColor={(color) => patchOption(opt.id, { color })}
              onDelete={() => deleteOption(opt.id)}
              onCommitEnter={addOption}
              autoFocus={opt.id === justAddedOptionId}
            />
          ))}
          <button
            type="button"
            onClick={addOption}
            className="mt-0.5 flex items-center gap-1 rounded px-1 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300"
          >
            <PlusIcon /> Opción
          </button>
        </div>
      )}
    </div>
  )
}

export default function SchemaEditor({ schema, onUpdateSchema, focusPropId = null }) {
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState('text')
  const [justAddedId, setJustAddedId] = useState(null)

  const patchProp = (propId, next) => {
    onUpdateSchema(schema.map((p) => (p.id === propId ? next : p)))
  }
  const deleteProp = (propId) => {
    onUpdateSchema(schema.filter((p) => p.id !== propId))
  }
  const addProp = () => {
    const name = newName.trim() || 'Propiedad'
    const prop = { id: crypto.randomUUID(), name, type: newType, hidden: false }
    if (newType === 'select') {
      prop.options = [{ id: crypto.randomUUID(), name: 'Opción 1', color: COLOR_PALETTE[0] }]
      setJustAddedId(prop.id)
    }
    onUpdateSchema([...schema, prop])
    setNewName('')
  }

  return (
    <div className="w-72 p-2">
      <p className="mb-1 px-1 text-xs font-semibold text-gray-400 dark:text-neutral-500">Propiedades</p>
      <div className="max-h-64 overflow-y-auto">
        {schema.map((prop) => (
          <PropertyRow
            key={prop.id}
            prop={prop}
            onChange={(next) => patchProp(prop.id, next)}
            onDelete={() => deleteProp(prop.id)}
            autoOpen={prop.id === focusPropId || prop.id === justAddedId}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1 border-t border-gray-100 pt-2 dark:border-neutral-700">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Nueva propiedad"
          onKeyDown={(event) => event.key === 'Enter' && addProp()}
          className="min-w-0 flex-1 rounded border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-blue-400 dark:border-neutral-700"
        />
        <select
          value={newType}
          onChange={(event) => setNewType(event.target.value)}
          className="rounded border border-gray-200 bg-transparent px-1 py-1 text-xs outline-none dark:border-neutral-700"
        >
          {Object.entries(CREATABLE_TYPE_LABEL).map(([type, label]) => (
            <option key={type} value={type}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={addProp}
          className="shrink-0 rounded-md bg-blue-600 p-1.5 text-white hover:bg-blue-700"
        >
          <PlusIcon />
        </button>
      </div>
    </div>
  )
}
