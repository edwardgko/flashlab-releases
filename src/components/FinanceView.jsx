import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { IS_CAPACITOR } from '../lib/supabaseClient.js'
import { onReloadContent } from '../lib/liveSync.js'
import {
  DEFAULT_CATEGORIES,
  PERIODS,
  addMonths,
  appliesToMonth,
  compareOrder,
  defaultFortnight,
  formatMoney,
  formatPlain,
  monthKey,
  monthLabel,
  monthTotals,
  parseAmount,
  periodOf,
  removeEntry,
  reorderUpdates,
  saveEntry,
  supabaseFinanceStore,
} from '../lib/finance.js'

const KIND_LABEL = { income: 'Ingreso', expense: 'Gasto' }

// cuántos meses hacia atrás muestra "Últimos meses" (incluido el que se mira)
const HISTORY_MONTHS = 6

// el estado del saldo nunca va solo por color: ícono + texto siempre
function balanceStatus(balance) {
  if (balance > 0)
    return { icon: '▲', label: 'Te sobra este mes', tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' }
  if (balance < 0)
    return { icon: '▼', label: 'Te falta este mes', tone: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400' }
  return { icon: '●', label: 'Quedás en cero', tone: 'bg-gray-100 text-gray-600 dark:bg-neutral-700 dark:text-neutral-300' }
}

function Chevron({ direction }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d={direction === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
    </svg>
  )
}

function SectionLabel({ children }) {
  return (
    <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500">
      {children}
    </p>
  )
}

// cabecera de Ingresos/Gastos: el total es lo que más se mira, así que va
// grande y con el color de su lado (verde entra, azul sale; azul y no rojo para que no se lea como alarma) — el +/− del
// ícono repite lo mismo para quien no distingue esos colores
const SECTION_TONE = {
  income: {
    title: 'Ingresos',
    sign: '+',
    box: 'bg-emerald-50 dark:bg-emerald-500/10',
    badge: 'bg-emerald-600 text-white dark:bg-emerald-500',
    text: 'text-emerald-800 dark:text-emerald-300',
  },
  expense: {
    title: 'Gastos',
    sign: '−',
    box: 'bg-blue-50 dark:bg-blue-500/10',
    badge: 'bg-blue-600 text-white dark:bg-blue-500',
    text: 'text-blue-800 dark:text-blue-300',
  },
}

function SectionHeader({ kind, total, detail }) {
  const tone = SECTION_TONE[kind]
  return (
    <div className={`mb-1 flex items-center gap-3 rounded-xl px-3 py-3 ${tone.box}`}>
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg font-bold leading-none ${tone.badge}`}
        aria-hidden="true"
      >
        {tone.sign}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-base font-semibold ${tone.text}`}>{tone.title}</p>
        {detail && <p className="text-xs text-gray-500 dark:text-neutral-400">{detail}</p>}
      </div>
      <p className={`shrink-0 text-xl font-bold tabular-nums sm:text-2xl ${tone.text}`}>{formatMoney(total)}</p>
    </div>
  )
}

const countLabel = (n) => `${n} ${n === 1 ? 'movimiento' : 'movimientos'}`

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      {[6, 12, 18].map((y) => (
        <g key={y}>
          <circle cx="9" cy={y} r="1.6" />
          <circle cx="15" cy={y} r="1.6" />
        </g>
      ))}
    </svg>
  )
}

// shifting: hay un arrastre en curso y esta fila se corre para hacerle
// lugar. La transición va SOLO entonces: si quedara puesta al soltar, el
// salto del transform al orden nuevo se animaría y las filas "volarían".
function EntryRow({ entry, onOpen, handleProps, style, dragging, shifting }) {
  const fixedLabel = entry.recurring
    ? entry.endMonth
      ? `Fijo hasta ${monthLabel(entry.endMonth, { short: true })}`
      : 'Fijo'
    : null
  // la quincena no va acá: la fila ya está dentro de la sección de su período
  const meta = [entry.category, fixedLabel].filter(Boolean).join(' · ')
  return (
    <li
      style={style}
      className={`relative flex items-center bg-white dark:bg-neutral-800 ${
        dragging
          ? 'z-10 rounded-lg shadow-lg ring-1 ring-gray-200 dark:ring-neutral-600'
          : shifting
            ? 'transition-transform duration-150'
            : ''
      }`}
    >
      {/* manija aparte (no toda la fila): así tocar la fila sigue abriendo
          la edición y deslizar el dedo fuera de la manija sigue scrolleando.
          touch-none: sin eso Android se lleva el gesto para scrollear */}
      <button
        type="button"
        {...handleProps}
        aria-label={`Mover ${entry.description || 'movimiento'} (flechas arriba/abajo)`}
        title="Arrastrá para cambiar el orden"
        className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-gray-400 hover:text-gray-600 active:cursor-grabbing dark:text-neutral-500 dark:hover:text-neutral-300"
      >
        <GripIcon />
      </button>
      <button
        type="button"
        onClick={() => onOpen(entry)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg py-2.5 pl-1 pr-3 text-left hover:bg-gray-50 active:bg-gray-100 dark:hover:bg-white/5 dark:active:bg-white/10"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-gray-800 dark:text-neutral-100">
            {entry.description || 'Sin descripción'}
          </span>
          {meta && <span className="block truncate text-xs text-gray-400 dark:text-neutral-500">{meta}</span>}
        </span>
        <span className="shrink-0 text-sm font-medium tabular-nums text-gray-800 dark:text-neutral-100">
          {formatMoney(entry.amount)}
        </span>
      </button>
    </li>
  )
}

function PeriodCard({ period, totals, className = '' }) {
  const status = balanceStatus(totals.balance)
  return (
    <div className={`rounded-xl border border-gray-200 p-3 dark:border-neutral-700 ${className}`}>
      <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">{period.label}</p>
      <p className="text-[11px] text-gray-400 dark:text-neutral-500">{period.range}</p>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-gray-400 dark:text-neutral-500">Ingresos</dt>
          <dd className="tabular-nums text-gray-700 dark:text-neutral-200">{formatMoney(totals.income)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-gray-400 dark:text-neutral-500">Gastos</dt>
          <dd className="tabular-nums text-gray-700 dark:text-neutral-200">{formatMoney(totals.expense)}</dd>
        </div>
      </dl>
      <div className="mt-2 flex items-center justify-between gap-1 border-t border-gray-100 pt-2 dark:border-neutral-700/60">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${status.tone}`}>
          <span aria-hidden="true">{status.icon}</span>
          Saldo
        </span>
        <span className="truncate text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
          {formatMoney(totals.balance)}
        </span>
      </div>
    </div>
  )
}

// arrastrar para reordenar con pointer events (no el drag & drop nativo de
// HTML5, que con el dedo no anda en el WebView de Android): mismo código
// para mouse y touch. Las filas no se mueven en el DOM mientras se arrastra,
// solo se corren con transform; el orden real cambia recién al soltar.
const AUTOSCROLL_EDGE = 56

function EntryList({ entries, onOpen, onReorder }) {
  const listRef = useRef(null)
  // lo que cambia en cada pointermove sin necesitar render propio
  const dragRef = useRef(null)
  const [drag, setDrag] = useState(null) // { from, over, dy, height }

  useEffect(() => () => cancelAnimationFrame(dragRef.current?.raf ?? 0), [])

  const update = () => {
    const d = dragRef.current
    if (!d) return
    // coordenadas de contenido (clientY + scroll), así el autoscroll no
    // descuadra la fila de debajo del dedo
    const dy = d.lastClientY + (d.scroller?.scrollTop ?? 0) - d.startY
    const center = d.mids[d.from] + dy
    d.over = d.mids.filter((mid, i) => i !== d.from && mid < center).length
    setDrag({ from: d.from, over: d.over, dy, height: d.height })
  }

  const autoScroll = () => {
    const d = dragRef.current
    if (!d) return
    if (d.scroller) {
      const box = d.scroller.getBoundingClientRect()
      let speed = 0
      if (d.lastClientY < box.top + AUTOSCROLL_EDGE) {
        speed = -Math.ceil((box.top + AUTOSCROLL_EDGE - d.lastClientY) / 6)
      } else if (d.lastClientY > box.bottom - AUTOSCROLL_EDGE) {
        speed = Math.ceil((d.lastClientY - (box.bottom - AUTOSCROLL_EDGE)) / 6)
      }
      if (speed) {
        d.scroller.scrollTop += speed
        update()
      }
    }
    d.raf = requestAnimationFrame(autoScroll)
  }

  const startDrag = (event, index) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const scroller = listRef.current.closest('[data-finance-scroll]')
    const scrollTop = scroller?.scrollTop ?? 0
    const rects = [...listRef.current.children].map((row) => row.getBoundingClientRect())
    dragRef.current = {
      scroller,
      from: index,
      over: index,
      height: rects[index].height,
      startY: event.clientY + scrollTop,
      lastClientY: event.clientY,
      mids: rects.map((rect) => rect.top + scrollTop + rect.height / 2),
      raf: 0,
    }
    dragRef.current.raf = requestAnimationFrame(autoScroll)
    setDrag({ from: index, over: index, dy: 0, height: rects[index].height })
  }

  const moveDrag = (event) => {
    if (!dragRef.current) return
    dragRef.current.lastClientY = event.clientY
    update()
  }

  const endDrag = (commit) => {
    const d = dragRef.current
    if (!d) return
    cancelAnimationFrame(d.raf)
    dragRef.current = null
    setDrag(null)
    if (commit && d.over !== d.from) onReorder(entries[d.from].id, d.over)
  }

  // teclado: flechas sobre la manija mueven de a un lugar
  const onHandleKey = (event, index) => {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null
    if (to === null) return
    event.preventDefault()
    if (to >= 0 && to < entries.length) onReorder(entries[index].id, to)
  }

  const styleFor = (index) => {
    if (!drag) return undefined
    if (index === drag.from) return { transform: `translateY(${drag.dy}px)` }
    if (drag.from < drag.over && index > drag.from && index <= drag.over) {
      return { transform: `translateY(${-drag.height}px)` }
    }
    if (drag.over < drag.from && index >= drag.over && index < drag.from) {
      return { transform: `translateY(${drag.height}px)` }
    }
    return undefined
  }

  return (
    <ul ref={listRef} className="divide-y divide-gray-100 dark:divide-neutral-700/60">
      {entries.map((entry, index) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          onOpen={onOpen}
          style={styleFor(index)}
          dragging={drag?.from === index}
          shifting={drag !== null && drag.from !== index}
          handleProps={{
            onPointerDown: (event) => startDrag(event, index),
            onPointerMove: moveDrag,
            onPointerUp: () => endDrag(true),
            onPointerCancel: () => endDrag(false),
            onKeyDown: (event) => onHandleKey(event, index),
          }}
        />
      ))}
    </ul>
  )
}

// el detalle de Ingresos/Gastos partido por período (1ª quincena, 2ª,
// mes completo), cada uno con su subtotal y solo los que tienen algo. El
// orden manual vale dentro de cada sección: arrastrar no cambia el período
// (eso se cambia editando el movimiento).
function PeriodSections({ entries, emptyText, onOpen, onReorder }) {
  if (entries.length === 0) {
    return <p className="px-3 py-2 text-sm text-gray-400 dark:text-neutral-500">{emptyText}</p>
  }
  return (
    <>
      {PERIODS.map((period) => {
        const group = entries.filter((entry) => periodOf(entry) === period.id)
        if (group.length === 0) return null
        const subtotal = Math.round(group.reduce((sum, entry) => sum + entry.amount, 0) * 100) / 100
        return (
          <div key={period.id} className="mt-3 first:mt-2">
            <div className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-white/5">
              <p className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-neutral-300">
                {period.label}
                <span className="ml-1.5 font-normal normal-case tracking-normal text-gray-400 dark:text-neutral-500">
                  {period.range}
                </span>
              </p>
              <p className="shrink-0 text-sm font-semibold tabular-nums text-gray-800 dark:text-neutral-100">
                {formatMoney(subtotal)}
              </p>
            </div>
            <EntryList
              entries={group}
              onOpen={onOpen}
              onReorder={(entryId, toIndex) => onReorder(group, entryId, toIndex)}
            />
          </div>
        )
      })}
    </>
  )
}

// hoja para cargar/editar un movimiento: sube desde abajo en el celular
// (donde llega el pulgar y el teclado no la tapa) y se centra desde sm:
function EntrySheet({ entry, initialKind, month, categories, store, onClose, onSaved }) {
  const [kind, setKind] = useState(entry?.kind ?? initialKind)
  const [amountText, setAmountText] = useState(entry ? formatPlain(entry.amount) : '')
  const [description, setDescription] = useState(entry?.description ?? '')
  const [category, setCategory] = useState(entry?.category ?? '')
  const [recurring, setRecurring] = useState(entry?.recurring ?? false)
  const [endMonth, setEndMonth] = useState(entry?.endMonth ?? '')
  // 1, 2 o null (mes completo) — ver PERIODS
  const [fortnight, setFortnight] = useState(entry ? (entry.fortnight ?? null) : defaultFortnight(month))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // un fijo que se mira desde un mes posterior al que empezó: lo que se
  // cambie acá no toca los meses anteriores (ver saveEntry en finance.js)
  const fromLaterMonth = Boolean(entry?.recurring && month > entry.startMonth)

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Android: atrás cierra la hoja, como cualquier overlay
  useEffect(() => {
    if (!IS_CAPACITOR) return undefined
    const subPromise = CapacitorApp.addListener('backButton', onClose)
    return () => {
      subPromise.then((sub) => sub.remove())
    }
  }, [onClose])

  const run = async (action) => {
    setSaving(true)
    setError('')
    try {
      onSaved(await action())
      onClose()
    } catch (err) {
      console.error('no se pudo guardar el movimiento:', err)
      setError(err.message || 'No se pudo guardar')
      setSaving(false)
    }
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    const amount = parseAmount(amountText)
    if (Number.isNaN(amount)) {
      setError('Ingresá un monto válido, por ejemplo 1500 o 1.500,50')
      return
    }
    if (recurring && endMonth && endMonth < month) {
      setError(`El mes en que termina no puede ser anterior a ${monthLabel(month)}`)
      return
    }
    run(() => saveEntry(store, entry, { kind, amount, description, category, recurring, endMonth, fortnight }, month))
  }

  const inputClass =
    'w-full rounded-lg border border-gray-200 bg-transparent px-3 py-2.5 text-base outline-none focus:border-blue-500 sm:text-sm dark:border-neutral-700 dark:focus:border-blue-400'

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/30" onClick={onClose} aria-hidden="true" />
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-label={entry ? 'Editar movimiento' : `Nuevo ${KIND_LABEL[kind].toLowerCase()}`}
        className="fixed inset-x-0 bottom-0 z-40 max-h-[90vh] overflow-y-auto rounded-t-2xl border-t border-gray-200 bg-white px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:pb-4 dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-200 sm:hidden dark:bg-neutral-700" aria-hidden="true" />

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-neutral-800">
          {['expense', 'income'].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setKind(value)}
              aria-pressed={kind === value}
              className={`cursor-pointer rounded-md py-2 text-sm font-medium ${
                kind === value
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                  : 'text-gray-500 dark:text-neutral-400'
              }`}
            >
              {KIND_LABEL[value]}
            </button>
          ))}
        </div>

        <label className="mt-4 block">
          <span className="text-xs font-medium text-gray-500 dark:text-neutral-400">Monto</span>
          <span className="mt-1 flex items-center gap-1 rounded-lg border border-gray-200 px-3 focus-within:border-blue-500 dark:border-neutral-700 dark:focus-within:border-blue-400">
            <span className="text-xl text-gray-400 dark:text-neutral-500">$</span>
            <input
              autoFocus={!entry}
              inputMode="decimal"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              placeholder="0"
              className="min-w-0 flex-1 bg-transparent py-2 text-2xl font-semibold tabular-nums outline-none"
            />
          </span>
        </label>

        <label className="mt-3 block">
          <span className="text-xs font-medium text-gray-500 dark:text-neutral-400">Descripción</span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={kind === 'income' ? 'Sueldo, venta, extra…' : 'Alquiler, súper, luz…'}
            className={`mt-1 ${inputClass}`}
          />
        </label>

        <label className="mt-3 block">
          <span className="text-xs font-medium text-gray-500 dark:text-neutral-400">Categoría (opcional)</span>
          <input
            list="finance-categories"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className={`mt-1 ${inputClass}`}
          />
          <datalist id="finance-categories">
            {categories[kind].map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>

        <div className="mt-3">
          <span className="text-xs font-medium text-gray-500 dark:text-neutral-400">Quincena</span>
          <div className="mt-1 grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-neutral-800">
            {PERIODS.map((period) => (
              <button
                key={period.id}
                type="button"
                onClick={() => setFortnight(period.fortnight)}
                aria-pressed={fortnight === period.fortnight}
                className={`cursor-pointer rounded-md px-1 py-1.5 text-sm ${
                  fortnight === period.fortnight
                    ? 'bg-white font-medium text-gray-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                    : 'text-gray-500 dark:text-neutral-400'
                }`}
              >
                {period.option}
              </button>
            ))}
          </div>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={recurring}
            onChange={(event) => setRecurring(event.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-blue-600"
          />
          <span>
            <span className="block text-sm text-gray-800 dark:text-neutral-100">Se repite todos los meses</span>
            <span className="block text-xs text-gray-400 dark:text-neutral-500">
              Sueldo, alquiler, servicios, cuotas — se cargan una vez y aparecen solos.
            </span>
          </span>
        </label>

        {recurring && (
          <label className="mt-3 block">
            <span className="text-xs font-medium text-gray-500 dark:text-neutral-400">
              Termina en (opcional, para cuotas)
            </span>
            <input
              type="month"
              value={endMonth}
              min={month}
              onChange={(event) => setEndMonth(event.target.value)}
              className={`mt-1 ${inputClass}`}
            />
          </label>
        )}

        {fromLaterMonth && (
          <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-neutral-800 dark:text-neutral-400">
            Es fijo desde {monthLabel(entry.startMonth)}. Lo que cambies vale desde {monthLabel(month)} en adelante;
            los meses anteriores quedan como estaban.
          </p>
        )}

        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {confirmingDelete ? (
          <div className="mt-4 rounded-lg border border-red-200 p-3 dark:border-red-500/30">
            <p className="text-sm text-gray-700 dark:text-neutral-200">
              {fromLaterMonth
                ? `Se quita desde ${monthLabel(month)} en adelante. Los meses anteriores lo conservan.`
                : entry.recurring
                  ? 'Se borra de todos los meses.'
                  : 'Se borra este movimiento.'}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="cursor-pointer rounded-lg px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                No
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => run(() => removeEntry(store, entry, month))}
                className="cursor-pointer rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                Sí, borrar
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex items-center gap-2">
            {entry && (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="cursor-pointer rounded-lg px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
              >
                Borrar
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="ml-auto cursor-pointer rounded-lg px-3 py-2.5 text-sm text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving || !amountText.trim()}
              className="cursor-pointer rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}
      </form>
    </>
  )
}

// `store` es inyectable para poder probar la vista sin Supabase; en la app
// siempre es el de Supabase
export default function FinanceView({ insetLeft = false, store = supabaseFinanceStore }) {
  const [entries, setEntries] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [month, setMonth] = useState(() => monthKey())
  const [sheet, setSheet] = useState(null) // { entry, kind } | null
  const currentMonth = monthKey()

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      setEntries(await store.list())
      setLoadError('')
    } catch (err) {
      console.error('no se pudieron cargar las finanzas:', err)
      setLoadError(err.message || 'error desconocido')
    } finally {
      setRefreshing(false)
    }
  }, [store])

  useEffect(() => {
    load()
  }, [load])

  // "Recargar" del sidebar, y al volver a la app: lo que se cargó desde el
  // celular aparece en la PC (y al revés) sin tener que tocar nada
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    const offReload = onReloadContent(load)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      offReload()
    }
  }, [load])

  const applyResult = useCallback(({ upserted, removedIds }) => {
    setEntries((prev) => {
      const byId = new Map((prev ?? []).map((entry) => [entry.id, entry]))
      for (const id of removedIds) byId.delete(id)
      for (const entry of upserted) byId.set(entry.id, entry)
      return [...byId.values()]
    })
  }, [])

  const closeSheet = useCallback(() => setSheet(null), [])

  // optimista: la fila queda donde se soltó al instante; si el guardado
  // falla se vuelve a traer todo para no mostrar un orden que no existe
  const reorder = useCallback(
    async (list, entryId, toIndex) => {
      const updates = reorderUpdates(list, entryId, toIndex)
      if (updates.length === 0) return
      const byId = new Map(updates.map((u) => [u.id, u.sortOrder]))
      setEntries((prev) => prev.map((entry) => (byId.has(entry.id) ? { ...entry, sortOrder: byId.get(entry.id) } : entry)))
      try {
        await Promise.all(updates.map((u) => store.update(u.id, { sortOrder: u.sortOrder })))
      } catch (err) {
        console.error('no se pudo guardar el orden:', err)
        load()
      }
    },
    [store, load]
  )

  const all = entries ?? []
  const monthEntries = all.filter((entry) => appliesToMonth(entry, month)).sort(compareOrder)
  const incomes = monthEntries.filter((entry) => entry.kind === 'income')
  const expenses = monthEntries.filter((entry) => entry.kind === 'expense')
  const totals = monthTotals(all, month)
  const status = balanceStatus(totals.balance)
  const hasMonthly = totals.periods[0].count > 0

  const categories = useMemo(() => {
    const byKind = { income: new Set(DEFAULT_CATEGORIES.income), expense: new Set(DEFAULT_CATEGORIES.expense) }
    for (const entry of entries ?? []) if (entry.category) byKind[entry.kind].add(entry.category)
    return { income: [...byKind.income], expense: [...byKind.expense] }
  }, [entries])

  // desde el mes que se mira hacia atrás, sin pasar del primer mes con datos
  const history = useMemo(() => {
    if (!entries?.length) return []
    const earliest = entries.reduce((min, entry) => (entry.startMonth < min ? entry.startMonth : min), month)
    const rows = []
    for (let i = 0; i < HISTORY_MONTHS; i++) {
      const key = addMonths(month, -i)
      if (key < earliest) break
      rows.push({ key, ...monthTotals(entries, key) })
    }
    return rows
  }, [entries, month])
  const historyBalance = Math.round(history.reduce((sum, row) => sum + row.balance, 0) * 100) / 100

  const spentPct = totals.income > 0 ? Math.round((totals.expense / totals.income) * 100) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex h-10 shrink-0 items-center justify-between px-4 sm:px-6 ${insetLeft ? 'pl-14 sm:pl-14' : ''}`}>
        <span className="text-sm font-medium text-gray-700 dark:text-neutral-200">Finanzas</span>
        <button
          type="button"
          aria-label="Recargar finanzas"
          title="Recargar finanzas"
          onClick={load}
          disabled={refreshing}
          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <span className={refreshing ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
        </button>
      </div>

      <div data-finance-scroll className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 sm:px-8">
        <div className="mx-auto max-w-2xl">
          <div className="mt-1 flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label="Mes anterior"
              onClick={() => setMonth((m) => addMonths(m, -1))}
              className="cursor-pointer rounded-lg p-2.5 text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-700"
            >
              <Chevron direction="left" />
            </button>
            <div className="min-w-0 text-center">
              <p className="truncate text-lg font-semibold text-gray-800 dark:text-neutral-100">{monthLabel(month)}</p>
              {month !== currentMonth && (
                <button
                  type="button"
                  onClick={() => setMonth(currentMonth)}
                  className="cursor-pointer text-xs text-blue-600 hover:underline dark:text-blue-400"
                >
                  Volver a este mes
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label="Mes siguiente"
              onClick={() => setMonth((m) => addMonths(m, 1))}
              className="cursor-pointer rounded-lg p-2.5 text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-700"
            >
              <Chevron direction="right" />
            </button>
          </div>

          {entries === null && !loadError && (
            <p className="mt-8 text-center text-sm text-gray-400 dark:text-neutral-500">Cargando…</p>
          )}

          {loadError && (
            <div className="mt-6 rounded-xl border border-red-200 p-4 text-sm dark:border-red-500/30">
              <p className="text-gray-700 dark:text-neutral-200">No se pudieron cargar tus finanzas.</p>
              <p className="mt-1 text-xs text-gray-400 dark:text-neutral-500">{loadError}</p>
              <button
                type="button"
                onClick={load}
                className="mt-3 cursor-pointer rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50 dark:border-neutral-700 dark:hover:bg-white/5"
              >
                Reintentar
              </button>
            </div>
          )}

          {entries !== null && (
            <>
              <div className="mt-3 rounded-xl border border-gray-200 p-4 dark:border-neutral-700">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500">
                  Saldo del mes
                </p>
                <p className="mt-1 text-3xl font-semibold tabular-nums text-gray-900 dark:text-white">
                  {formatMoney(totals.balance)}
                </p>
                <p className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.tone}`}>
                  <span aria-hidden="true">{status.icon}</span>
                  {status.label}
                </p>
                {spentPct !== null && (
                  <p className="mt-2 text-xs text-gray-400 dark:text-neutral-500">
                    Gastás el {spentPct}% de lo que ingresa
                  </p>
                )}
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-100 pt-3 dark:border-neutral-700/60">
                  <div>
                    <p className="text-xs text-gray-400 dark:text-neutral-500">Ingresos</p>
                    <p className="text-base font-medium tabular-nums text-gray-800 dark:text-neutral-100">
                      {formatMoney(totals.income)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 dark:text-neutral-500">Gastos</p>
                    <p className="text-base font-medium tabular-nums text-gray-800 dark:text-neutral-100">
                      {formatMoney(totals.expense)}
                    </p>
                  </div>
                </div>
              </div>

              {/* "Mes completo" solo si hay algo cargado así: en el celular
                  ocupa una fila entera debajo de las dos quincenas */}
              <div className={`mt-3 grid grid-cols-2 gap-2 ${hasMonthly ? 'sm:grid-cols-3' : ''}`}>
                {PERIODS.filter((period) => period.id !== 0 || hasMonthly).map((period) => (
                  <PeriodCard
                    key={period.id}
                    period={period}
                    totals={totals.periods[period.id]}
                    className={period.id === 0 ? 'col-span-2 sm:col-span-1' : ''}
                  />
                ))}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSheet({ entry: null, kind: 'income' })}
                  className="cursor-pointer rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-white/5"
                >
                  + Ingreso
                </button>
                <button
                  type="button"
                  onClick={() => setSheet({ entry: null, kind: 'expense' })}
                  className="cursor-pointer rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-white/5"
                >
                  + Gasto
                </button>
              </div>

              {all.length === 0 && (
                <p className="mt-4 rounded-lg bg-gray-50 px-3 py-3 text-sm text-gray-500 dark:bg-neutral-900/40 dark:text-neutral-400">
                  Empezá por tu sueldo y tus gastos fijos (alquiler, servicios, cuotas) marcando "Se repite todos
                  los meses": vas a cargarlos una sola vez y aparecen solos cada mes.
                </p>
              )}

              <div className="mt-6">
                <SectionHeader kind="income" total={totals.income} detail={incomes.length > 0 && countLabel(incomes.length)} />
                <PeriodSections
                  entries={incomes}
                  emptyText="Sin ingresos este mes."
                  onOpen={(entry) => setSheet({ entry, kind: entry.kind })}
                  onReorder={reorder}
                />
              </div>

              <div className="mt-6">
                <SectionHeader
                  kind="expense"
                  total={totals.expense}
                  detail={
                    expenses.length > 0 &&
                    `Fijos ${formatMoney(totals.fixedExpense)} · Variables ${formatMoney(totals.variableExpense)}`
                  }
                />
                <PeriodSections
                  entries={expenses}
                  emptyText="Sin gastos este mes."
                  onOpen={(entry) => setSheet({ entry, kind: entry.kind })}
                  onReorder={reorder}
                />
              </div>

              {history.length > 1 && (
                <div className="mt-8">
                  <SectionLabel>Últimos meses</SectionLabel>
                  <table className="w-full text-sm tabular-nums">
                    <thead>
                      <tr className="text-xs text-gray-400 dark:text-neutral-500">
                        <th className="px-1 py-1.5 text-left font-normal">Mes</th>
                        <th className="hidden px-1 py-1.5 text-right font-normal sm:table-cell">Ingresos</th>
                        <th className="hidden px-1 py-1.5 text-right font-normal sm:table-cell">Gastos</th>
                        <th className="px-1 py-1.5 text-right font-normal">Saldo</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-neutral-700/60">
                      {history.map((row) => {
                        const rowStatus = balanceStatus(row.balance)
                        return (
                          <tr key={row.key} className={row.key === month ? 'font-medium' : ''}>
                            <td className="px-1 py-2">
                              <button
                                type="button"
                                onClick={() => setMonth(row.key)}
                                className="cursor-pointer text-left text-gray-700 hover:underline dark:text-neutral-200"
                              >
                                {monthLabel(row.key, { short: true })}
                              </button>
                            </td>
                            <td className="hidden px-1 py-2 text-right text-gray-600 sm:table-cell dark:text-neutral-300">
                              {formatMoney(row.income)}
                            </td>
                            <td className="hidden px-1 py-2 text-right text-gray-600 sm:table-cell dark:text-neutral-300">
                              {formatMoney(row.expense)}
                            </td>
                            <td className="px-1 py-2 text-right text-gray-800 dark:text-neutral-100">
                              <span className={`mr-1.5 inline-block rounded px-1 text-[10px] ${rowStatus.tone}`} aria-label={rowStatus.label}>
                                {rowStatus.icon}
                              </span>
                              {formatMoney(row.balance)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-gray-200 text-gray-800 dark:border-neutral-700 dark:text-neutral-100">
                        <td className="px-1 py-2 text-xs text-gray-500 dark:text-neutral-400">
                          Acumulado {history.length} meses
                        </td>
                        <td className="hidden sm:table-cell" />
                        <td className="hidden sm:table-cell" />
                        <td className="px-1 py-2 text-right font-semibold">{formatMoney(historyBalance)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {sheet && (
        <EntrySheet
          key={sheet.entry?.id ?? `new-${sheet.kind}`}
          entry={sheet.entry}
          initialKind={sheet.kind}
          month={month}
          categories={categories}
          store={store}
          onClose={closeSheet}
          onSaved={applyResult}
        />
      )}
    </div>
  )
}
