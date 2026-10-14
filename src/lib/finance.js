import { supabase } from './supabaseClient.js'

// Finanzas personales (0028_finance.sql): ingresos y gastos por mes, con
// fijos que se repiten solos. Va directo a Supabase como chat.js — no pasa
// por api.js porque no hay nada que Electron tenga que hacer distinto.
// Una sola consulta trae TODO lo de la cuenta y los meses se arman del lado
// del cliente: son unos cientos de filas en años de uso, y así el historial
// no necesita una consulta por mes.

const COLUMNS = 'id, kind, description, amount, category, start_month, recurring, end_month, created_at'

const FIELD_TO_COLUMN = {
  kind: 'kind',
  description: 'description',
  amount: 'amount',
  category: 'category',
  startMonth: 'start_month',
  recurring: 'recurring',
  endMonth: 'end_month',
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

export function monthTotals(entries, key) {
  let income = 0
  let fixedExpense = 0
  let variableExpense = 0
  for (const entry of entries) {
    if (!appliesToMonth(entry, key)) continue
    if (entry.kind === 'income') income += entry.amount
    else if (entry.recurring) fixedExpense += entry.amount
    else variableExpense += entry.amount
  }
  const expense = fixedExpense + variableExpense
  // redondeo a centavos: sumar decimales en float deja colas tipo 0.30000000000000004
  const round = (n) => Math.round(n * 100) / 100
  return {
    income: round(income),
    expense: round(expense),
    fixedExpense: round(fixedExpense),
    variableExpense: round(variableExpense),
    balance: round(income - expense),
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

const SAME_KEYS = ['kind', 'description', 'amount', 'category', 'recurring', 'endMonth']

export async function saveEntry(store, original, draft, viewMonth) {
  const fields = {
    kind: draft.kind,
    description: draft.description.trim(),
    amount: draft.amount,
    category: draft.category.trim(),
    recurring: draft.recurring,
    endMonth: draft.recurring ? draft.endMonth || null : null,
  }
  if (!original) {
    return { upserted: [await store.create({ ...fields, startMonth: viewMonth })], removedIds: [] }
  }
  if (!(original.recurring && viewMonth > original.startMonth)) {
    return { upserted: [await store.update(original.id, fields)], removedIds: [] }
  }
  if (SAME_KEYS.every((key) => (original[key] ?? null) === (fields[key] ?? null))) {
    return { upserted: [], removedIds: [] }
  }
  const closed = await store.update(original.id, { endMonth: addMonths(viewMonth, -1) })
  const opened = await store.create({ ...fields, startMonth: viewMonth })
  return { upserted: [closed, opened], removedIds: [] }
}

export async function removeEntry(store, entry, viewMonth) {
  if (entry.recurring && viewMonth > entry.startMonth) {
    return { upserted: [await store.update(entry.id, { endMonth: addMonths(viewMonth, -1) })], removedIds: [] }
  }
  await store.remove(entry.id)
  return { upserted: [], removedIds: [entry.id] }
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
