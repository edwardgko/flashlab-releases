import { supabase } from './supabaseClient.js'

// Finanzas personales (0028_finance.sql): ingresos y gastos por mes, con
// fijos que se repiten solos. Va directo a Supabase como chat.js — no pasa
// por api.js porque no hay nada que Electron tenga que hacer distinto.
// Una sola consulta trae TODO lo de la cuenta y los meses se arman del lado
// del cliente: son unos cientos de filas en años de uso, y así el historial
// no necesita una consulta por mes.

const COLUMNS = 'id, kind, description, amount, category, start_month, recurring, end_month, fortnight, sort_order, created_at'

const FIELD_TO_COLUMN = {
  kind: 'kind',
  description: 'description',
  amount: 'amount',
  category: 'category',
  startMonth: 'start_month',
  recurring: 'recurring',
  endMonth: 'end_month',
  fortnight: 'fortnight',
  sortOrder: 'sort_order',
}

async function currentUserId() {
  const { data } = await supabase.auth.getSession()
  const id = data.session?.user?.id
  if (!id) throw new Error('No hay sesión activa')
  return id
}

const fromRow = (row) => ({
  id: row.id,
  kind: row.kind,
  description: row.description,
  // numeric de Postgres puede llegar como string según el tamaño — siempre Number
  amount: Number(row.amount),
  category: row.category ?? '',
  startMonth: row.start_month,
  recurring: row.recurring,
  endMonth: row.end_month,
  fortnight: row.fortnight ?? null,
  sortOrder: row.sort_order ?? null,
  createdAt: row.created_at,
})

// solo las claves presentes — sirve igual para un insert completo que para
// un update parcial (cerrar un fijo toca nada más que endMonth)
function toRow(fields) {
  const row = {}
  for (const [key, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (key in fields) row[column] = key === 'category' ? fields.category || null : fields[key]
  }
  return row
}

export const supabaseFinanceStore = {
  async list() {
    const userId = await currentUserId()
    const { data, error } = await supabase
      .from('finance_entries')
      .select(COLUMNS)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return data.map(fromRow)
  },
  async create(fields) {
    const userId = await currentUserId()
    const { data, error } = await supabase
      .from('finance_entries')
      .insert({ ...toRow(fields), user_id: userId })
      .select(COLUMNS)
      .single()
    if (error) throw error
    return fromRow(data)
  },
  async update(id, fields) {
    const { data, error } = await supabase
      .from('finance_entries')
      .update({ ...toRow(fields), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(COLUMNS)
      .single()
    if (error) throw error
    return fromRow(data)
  },
  async remove(id) {
    const { error } = await supabase.from('finance_entries').delete().eq('id', id)
    if (error) throw error
  },
}

// --- meses ('YYYY-MM', comparables como string) ---

export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function addMonths(key, delta) {
  const [year, month] = key.split('-').map(Number)
  return monthKey(new Date(year, month - 1 + delta, 1))
}

export function monthLabel(key, { short = false } = {}) {
  const [year, month] = key.split('-').map(Number)
  const label = new Date(year, month - 1, 1).toLocaleDateString('es-AR', {
    month: short ? 'short' : 'long',
    year: 'numeric',
  })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function appliesToMonth(entry, key) {
  if (!entry.recurring) return entry.startMonth === key
  return entry.startMonth <= key && (!entry.endMonth || key <= entry.endMonth)
}

// --- quincenas (0029_finance_fortnight.sql) ---
// fortnight 1 = días 1 a 15, 2 = del 16 a fin de mes, null = mes completo
// (no cae en una quincena en particular). Lo cargado antes de que existiera
// la columna también quedó en null, y "mes completo" es justo lo que era.
// En los totales y las secciones, null es el período 0.

export const PERIODS = [
  { id: 1, fortnight: 1, label: '1ª quincena', range: 'días 1 al 15', option: '1ª (1–15)' },
  { id: 2, fortnight: 2, label: '2ª quincena', range: 'del 16 a fin de mes', option: '2ª (16–fin)' },
  { id: 0, fortnight: null, label: 'Mes completo', range: 'sin quincena fija', option: 'Mes completo' },
]

export function periodOf(entry) {
  return entry.fortnight === 1 || entry.fortnight === 2 ? entry.fortnight : 0
}

// para un movimiento nuevo: la quincena en curso si se está mirando el mes
// actual, la primera si no
export function defaultFortnight(viewMonth) {
  return viewMonth === monthKey() && new Date().getDate() > 15 ? 2 : 1
}

export function monthTotals(entries, key) {
  let income = 0
  let fixedExpense = 0
  let variableExpense = 0
  // por período (ver PERIODS): 1 y 2 = quincenas, 0 = mes completo
  const buckets = { 0: { income: 0, expense: 0, count: 0 }, 1: { income: 0, expense: 0, count: 0 }, 2: { income: 0, expense: 0, count: 0 } }
  for (const entry of entries) {
    if (!appliesToMonth(entry, key)) continue
    const bucket = buckets[periodOf(entry)]
    bucket.count += 1
    if (entry.kind === 'income') {
      income += entry.amount
      bucket.income += entry.amount
      continue
    }
    bucket.expense += entry.amount
    if (entry.recurring) fixedExpense += entry.amount
    else variableExpense += entry.amount
  }
  const expense = fixedExpense + variableExpense
  // redondeo a centavos: sumar decimales en float deja colas tipo 0.30000000000000004
  const round = (n) => Math.round(n * 100) / 100
  const periods = {}
  for (const [id, bucket] of Object.entries(buckets)) {
    periods[id] = {
      income: round(bucket.income),
      expense: round(bucket.expense),
      balance: round(bucket.income - bucket.expense),
      count: bucket.count,
    }
  }
  return {
    income: round(income),
    expense: round(expense),
    fixedExpense: round(fixedExpense),
    variableExpense: round(variableExpense),
    balance: round(income - expense),
    periods,
  }
}

// --- montos ---

// sin decimales si es redondo, con los dos centavos si no ("$1.500" y
// "$1.500,50", nunca "$1.500,5")
const wholeFormat = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 })
const centsFormat = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatPlain(amount) {
  return (Number.isInteger(amount) ? wholeFormat : centsFormat).format(amount)
}

export function formatMoney(amount) {
  return `${amount < 0 ? '-' : ''}$${formatPlain(Math.abs(amount))}`
}

// acepta lo que se tipea a mano en cualquiera de las dos costumbres:
// "1500", "1.500", "1.500,50", "1500,5", "1500.50", "1,500,000"
export function parseAmount(text) {
  let s = String(text ?? '').replace(/[\s$]/g, '')
  if (!s) return NaN
  const commas = (s.match(/,/g) || []).length
  const dots = (s.match(/\./g) || []).length
  if (commas > 1) s = s.replace(/,/g, '')
  else if (commas === 1) s = s.replace(/\./g, '').replace(',', '.')
  else if (dots > 1 || /\.\d{3}$/.test(s)) s = s.replace(/\./g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN
  return Math.round(Number(s) * 100) / 100
}

// --- guardar / borrar respetando el pasado ---
// Un fijo editado o borrado desde un mes POSTERIOR al que empezó no puede
// tocar los meses anteriores (el sueldo de marzo no cambia porque en
// octubre hubo aumento): se cierra la fila vieja en el mes anterior y, si
// hace falta, se abre una nueva desde el mes que se está mirando.
// Devuelven { upserted, removedIds } para actualizar el estado local sin
// volver a traer todo.

const SAME_KEYS = ['kind', 'description', 'amount', 'category', 'recurring', 'endMonth', 'fortnight']

export async function saveEntry(store, original, draft, viewMonth) {
  const fields = {
    kind: draft.kind,
    description: draft.description.trim(),
    amount: draft.amount,
    category: draft.category.trim(),
    recurring: draft.recurring,
    endMonth: draft.recurring ? draft.endMonth || null : null,
    fortnight: draft.fortnight ?? null,
  }
  if (!original) {
    // al final de la lista (mismo número que usa el default de la columna)
    return { upserted: [await store.create({ ...fields, startMonth: viewMonth, sortOrder: Date.now() / 1000 })], removedIds: [] }
  }
  if (!(original.recurring && viewMonth > original.startMonth)) {
    return { upserted: [await store.update(original.id, fields)], removedIds: [] }
  }
  if (SAME_KEYS.every((key) => (original[key] ?? null) === (fields[key] ?? null))) {
    return { upserted: [], removedIds: [] }
  }
  const closed = await store.update(original.id, { endMonth: addMonths(viewMonth, -1) })
  // hereda el lugar en la lista: para quien mira, sigue siendo la misma fila
  const opened = await store.create({ ...fields, startMonth: viewMonth, sortOrder: original.sortOrder ?? Date.now() / 1000 })
  return { upserted: [closed, opened], removedIds: [] }
}

export async function removeEntry(store, entry, viewMonth) {
  if (entry.recurring && viewMonth > entry.startMonth) {
    return { upserted: [await store.update(entry.id, { endMonth: addMonths(viewMonth, -1) })], removedIds: [] }
  }
  await store.remove(entry.id)
  return { upserted: [], removedIds: [entry.id] }
}

// --- orden manual (0030_finance_sort_order.sql) ---

export function compareOrder(a, b) {
  const pa = a.sortOrder ?? Infinity
  const pb = b.sortOrder ?? Infinity
  if (pa !== pb) return pa < pb ? -1 : 1
  return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
}

// qué sortOrder cambiar para mover `entryId` a `toIndex` dentro de `list`
// (ya ordenada). Normalmente UNA sola fila: el punto medio entre sus nuevas
// vecinas, así el orden del resto no cambia en ningún otro mes. Si entre las
// vecinas ya no entra un número (muchos movimientos al mismo hueco), se
// renumera la lista entera.
export function reorderUpdates(list, entryId, toIndex) {
  const from = list.findIndex((entry) => entry.id === entryId)
  if (from === -1 || from === toIndex) return []
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(toIndex, 0, moved)
  const before = next[toIndex - 1]?.sortOrder ?? null
  const after = next[toIndex + 1]?.sortOrder ?? null
  let position = 0
  if (before !== null && after !== null) position = (before + after) / 2
  else if (before !== null) position = before + 1
  else if (after !== null) position = after - 1
  const fits = (before === null || position > before) && (after === null || position < after)
  if (fits) return [{ id: moved.id, sortOrder: position }]
  const base = Math.min(...next.map((entry) => entry.sortOrder ?? 0))
  return next.map((entry, i) => ({ id: entry.id, sortOrder: base + i }))
}

export const DEFAULT_CATEGORIES = {
  income: ['Sueldo', 'Extra', 'Ventas', 'Otros'],
  expense: [
    'Vivienda',
    'Servicios',
    'Comida',
    'Transporte',
    'Salud',
    'Educación',
    'Deudas',
    'Suscripciones',
    'Entretenimiento',
    'Ahorro',
    'Otros',
  ],
}
