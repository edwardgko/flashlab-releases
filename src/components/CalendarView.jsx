import { useEffect, useMemo, useState } from 'react'
import { api, isDesktop } from '../lib/api.js'

const WEEKDAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
const MONTH_LABELS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

// lunes=0 ... domingo=6 (getDay() nativo es domingo=0)
function mondayIndex(date) {
  return (date.getDay() + 6) % 7
}

function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1)
  const gridStart = new Date(year, month, 1 - mondayIndex(first))
  const days = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    days.push(d)
  }
  return days
}

function toDateKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toTimeInput(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const EMPTY_DRAFT = { title: '', description: '', date: '', allDay: true, startTime: '09:00', endTime: '10:00' }

function eventToDraft(ev) {
  if (ev.allDay) {
    return { title: ev.title, description: ev.description, date: ev.start, allDay: true, startTime: '09:00', endTime: '10:00' }
  }
  const start = new Date(ev.start)
  const end = new Date(ev.end)
  return {
    title: ev.title,
    description: ev.description,
    date: toDateKey(start),
    allDay: false,
    startTime: toTimeInput(start),
    endTime: toTimeInput(end),
  }
}

// Google: el "end" de un evento de día completo es exclusivo (el día siguiente)
function draftToPayload(draft) {
  const [y, m, d] = draft.date.split('-').map(Number)
  if (draft.allDay) {
    const end = new Date(y, m - 1, d + 1)
    return { title: draft.title, description: draft.description, allDay: true, start: draft.date, end: toDateKey(end) }
  }
  const [sh, sm] = draft.startTime.split(':').map(Number)
  const [eh, em] = draft.endTime.split(':').map(Number)
  const start = new Date(y, m - 1, d, sh, sm)
  const end = new Date(y, m - 1, d, eh, em)
  return { title: draft.title, description: draft.description, allDay: false, start: start.toISOString(), end: end.toISOString() }
}

function MeetingNotesSection({ eventId, eventTitle, onOpenPage, onCreateMeetingNotes }) {
  const [pageId, setPageId] = useState(undefined) // undefined = cargando, null = sin vincular
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getEventPage(eventId).then((id) => {
      if (!cancelled) setPageId(id)
    })
    return () => {
      cancelled = true
    }
  }, [eventId])

  const createAndOpen = async () => {
    setCreating(true)
    try {
      const page = await onCreateMeetingNotes(eventTitle || 'Reunión')
      await api.linkEventPage(eventId, page.id)
      onOpenPage(page.id)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mb-3 border-b border-gray-100 pb-3 dark:border-neutral-700">
      {pageId === undefined ? (
        <p className="text-xs text-gray-400 dark:text-neutral-500">Notas de la reunión…</p>
      ) : pageId ? (
        <button
          type="button"
          onClick={() => onOpenPage(pageId)}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Abrir notas de la reunión →
        </button>
      ) : (
        <button
          type="button"
          onClick={createAndOpen}
          disabled={creating}
          className="text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
        >
          {creating ? 'Creando…' : '+ Crear notas de la reunión'}
        </button>
      )}
    </div>
  )
}

function EventModal({ draft, setDraft, onSave, onDelete, onClose, isNew, eventId, onOpenPage, onCreateMeetingNotes }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-800"
      >
        <input
          autoFocus
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          placeholder="Título del evento"
          className="mb-3 w-full border-b border-gray-200 bg-transparent pb-1 text-lg font-medium outline-none placeholder:text-gray-300 dark:border-neutral-700 dark:placeholder:text-neutral-600"
        />
        {!isNew && (
          <MeetingNotesSection
            eventId={eventId}
            eventTitle={draft.title}
            onOpenPage={onOpenPage}
            onCreateMeetingNotes={onCreateMeetingNotes}
          />
        )}
        <label className="mb-2 flex items-center gap-2 text-sm text-gray-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={draft.allDay}
            onChange={(event) => setDraft({ ...draft, allDay: event.target.checked })}
          />
          Todo el día
        </label>
        <div className="mb-2 flex items-center gap-2">
          <input
            type="date"
            value={draft.date}
            onChange={(event) => setDraft({ ...draft, date: event.target.value })}
            className="rounded-md border border-gray-200 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
          />
          {!draft.allDay && (
            <>
              <input
                type="time"
                value={draft.startTime}
                onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
                className="rounded-md border border-gray-200 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
              />
              <span className="text-gray-400">–</span>
              <input
                type="time"
                value={draft.endTime}
                onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
                className="rounded-md border border-gray-200 bg-transparent px-2 py-1 text-sm outline-none dark:border-neutral-700"
              />
            </>
          )}
        </div>
        <textarea
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          placeholder="Descripción (opcional)"
          rows={3}
          className="mb-3 w-full resize-none rounded-md border border-gray-200 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-gray-300 dark:border-neutral-700 dark:placeholder:text-neutral-600"
        />
        <div className="flex items-center justify-between">
          {!isNew ? (
            <button type="button" onClick={onDelete} className="text-sm text-red-600 hover:underline dark:text-red-400">
              Eliminar
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-700"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!draft.title.trim() || !draft.date}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              Guardar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function CalendarView({ insetLeft = false, onOpenPage, onCreateMeetingNotes }) {
  const today = new Date()
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [connected, setConnected] = useState(null) // null = verificando estado
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null) // { id: string|null, draft }

  // Conexión automática: el login ya pide el permiso de Google Calendar (ver
  // LoginGate.jsx), así que abrir esta vista no debería requerir ningún paso
  // extra. ensureCalendarConnected() además recupera solo el permiso ya
  // otorgado cuando esta instalación no tiene el token local. Solo si la
  // cuenta nunca lo otorgó (sesión iniciada con una versión anterior de la
  // app) se dispara el consentimiento de Google, también sin botón de por
  // medio.
  const connectNow = async () => {
    setError('')
    setLoading(true)
    try {
      await api.connectCalendarUnified()
      setConnected(true)
    } catch (err) {
      setConnected(false)
      if (err.message !== 'cancelado') setError(err.message || 'no se pudo conectar con Google')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const status = await api.ensureCalendarConnected().catch(() => ({ connected: false }))
      if (cancelled) return
      if (status.connected) {
        setConnected(true)
        return
      }
      setConnected(false)
      await connectNow()
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const monthDays = useMemo(() => buildMonthGrid(cursor.getFullYear(), cursor.getMonth()), [cursor])

  const loadEvents = async () => {
    setLoading(true)
    setError('')
    try {
      const timeMin = monthDays[0]
      const timeMax = new Date(monthDays[41])
      timeMax.setDate(timeMax.getDate() + 1)
      const data = await api.listCalendarEvents(timeMin.toISOString(), timeMax.toISOString())
      setEvents(data)
    } catch (err) {
      setError(err.message || 'no se pudieron cargar los eventos')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (connected) loadEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, cursor])

  const eventsByDay = useMemo(() => {
    const map = new Map()
    for (const ev of events) {
      // los eventos de "todo el día" traen solo fecha ("2026-07-24", sin
      // hora): new Date("2026-07-24") lo interpreta como medianoche UTC, no
      // medianoche local — en un huso horario negativo (Argentina) eso cae
      // en el día anterior. El string ya viene en el mismo formato Y-M-D que
      // toDateKey, así que se usa directo sin pasar por Date.
      const key = ev.allDay ? ev.start : toDateKey(new Date(ev.start))
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(ev)
    }
    return map
  }, [events])

  const openNewEvent = (date) => setEditing({ id: null, draft: { ...EMPTY_DRAFT, date: toDateKey(date) } })
  const openEditEvent = (ev) => setEditing({ id: ev.id, draft: eventToDraft(ev) })

  const handleSaveEvent = async () => {
    const payload = draftToPayload(editing.draft)
    try {
      if (editing.id) await api.updateCalendarEvent(editing.id, payload)
      else await api.createCalendarEvent(payload)
      setEditing(null)
      await loadEvents()
    } catch (err) {
      setError(err.message || 'no se pudo guardar el evento')
    }
  }

  const handleDeleteEvent = async () => {
    try {
      await api.deleteCalendarEvent(editing.id)
      setEditing(null)
      await loadEvents()
    } catch (err) {
      setError(err.message || 'no se pudo eliminar el evento')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex h-10 shrink-0 items-center justify-between px-6 ${insetLeft ? 'pl-14' : ''}`}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-700 dark:text-neutral-200">
            {MONTH_LABELS[cursor.getMonth()]} {cursor.getFullYear()}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Mes anterior"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}
              className="rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              Hoy
            </button>
            <button
              type="button"
              aria-label="Mes siguiente"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              ›
            </button>
          </div>
        </div>
        {connected === true && (
          // sin "Desconectar": el calendario es siempre el de la cuenta de
          // Google con la que se inició sesión, no hay otra a la que cambiar
          <button
            type="button"
            aria-label="Actualizar calendario"
            title="Actualizar calendario"
            onClick={loadEvents}
            disabled={loading}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            <span className={loading ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 sm:px-10">
        {connected === null && <p className="mt-8 text-sm text-gray-400 dark:text-neutral-500">Cargando…</p>}

        {connected === false && (
          <div className="mt-12 flex flex-col items-center gap-3 px-2 text-center">
            {!isDesktop && (
              <p className="max-w-sm text-xs text-amber-600 dark:text-amber-400">
                Modo navegador (desarrollo): esto conecta un calendario simulado en memoria, no tu cuenta real.
              </p>
            )}
            {loading ? (
              <>
                <p className="text-sm text-gray-500 dark:text-neutral-400">Conectando tu Google Calendar…</p>
                <div className="flex flex-col items-center gap-1 sm:flex-row sm:gap-2">
                  <p className="text-xs text-gray-400 dark:text-neutral-500">
                    Esperando autorización en tu navegador…
                  </p>
                  <button
                    type="button"
                    onClick={() => api.cancelGoogleAuth()}
                    className="text-xs text-gray-400 underline hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                  >
                    Cancelar
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="max-w-sm text-sm text-gray-500 dark:text-neutral-400">
                  No se pudo conectar tu Google Calendar.
                </p>
                <button
                  type="button"
                  onClick={connectNow}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Reintentar
                </button>
              </>
            )}
          </div>
        )}

        {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}

        {connected === true && (
          <div className="mt-4">
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-gray-200 bg-gray-200 dark:border-neutral-800 dark:bg-neutral-800">
              {WEEKDAY_LABELS.map((label) => (
                <div
                  key={label}
                  className="bg-gray-50 px-2 py-1.5 text-center text-xs font-medium text-gray-400 dark:bg-neutral-900 dark:text-neutral-500"
                >
                  {label}
                </div>
              ))}
              {monthDays.map((day) => {
                const key = toDateKey(day)
                const dayEvents = eventsByDay.get(key) ?? []
                const inMonth = day.getMonth() === cursor.getMonth()
                const isToday = isSameDay(day, today)
                return (
                  <div
                    key={key}
                    onClick={() => openNewEvent(day)}
                    className={`group flex min-h-24 cursor-pointer flex-col gap-1 bg-white p-1.5 dark:bg-neutral-900 ${
                      inMonth ? '' : 'opacity-40'
                    }`}
                  >
                    <span
                      className={`self-start rounded px-1.5 text-xs ${
                        isToday ? 'bg-blue-600 font-semibold text-white' : 'text-gray-500 dark:text-neutral-400'
                      }`}
                    >
                      {day.getDate()}
                    </span>
                    <div className="flex flex-col gap-0.5">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <button
                          key={ev.id}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            openEditEvent(ev)
                          }}
                          title={ev.title}
                          className="truncate rounded bg-blue-50 px-1 py-0.5 text-left text-[11px] text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-300 dark:hover:bg-blue-900"
                        >
                          {ev.allDay ? '' : `${toTimeInput(new Date(ev.start))} `}
                          {ev.title}
                        </button>
                      ))}
                      {dayEvents.length > 3 && (
                        <span className="px-1 text-[10px] text-gray-400 dark:text-neutral-500">
                          +{dayEvents.length - 3} más
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            {loading && <p className="mt-2 text-xs text-gray-400 dark:text-neutral-500">Actualizando…</p>}
          </div>
        )}
      </div>

      {editing && (
        <EventModal
          draft={editing.draft}
          setDraft={(draft) => setEditing({ ...editing, draft })}
          onSave={handleSaveEvent}
          onDelete={handleDeleteEvent}
          onClose={() => setEditing(null)}
          isNew={!editing.id}
          eventId={editing.id}
          onOpenPage={(pageId) => {
            setEditing(null)
            onOpenPage(pageId)
          }}
          onCreateMeetingNotes={onCreateMeetingNotes}
        />
      )}
    </div>
  )
}
