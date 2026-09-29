import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, isDesktop } from '../lib/api.js'
import { isImageIcon } from '../lib/icon.js'
import { useAuthSession } from '../lib/supabaseClient.js'
import { onReloadContent, subscribeToDatabaseRows, subscribeToPageContent } from '../lib/liveSync.js'
import { stableStringify } from '../lib/stableStringify.js'
import { useIsMobile } from '../lib/useIsMobile.js'
import { CREATABLE_TYPE_LABEL, COLOR_PALETTE } from './SchemaEditor.jsx'
import { addCustomIcon, deleteCustomIcon, getCustomIcons } from '../lib/customIcons.js'
import { resolveDuration } from '../lib/video.js'
import {
  getSnapshot as getRecordingSnapshot,
  startScreenRecording,
  stopScreenRecording,
  subscribe as subscribeRecording,
} from '../lib/screenRecording.js'
import { getDriveUploadsVersion, subscribeDriveUploads, withLiveDriveState } from '../lib/driveUploadTracker.js'

// modales que solo se montan bajo demanda (Compartir / Editar grabación) —
// no tiene sentido pagarlos en el bundle inicial si nunca se abren en la sesión.
const ShareDialog = lazy(() => import('./ShareDialog.jsx'))
const RecordingEditor = lazy(() => import('./RecordingEditor.jsx'))
// Editor.jsx (con @editorjs y sus 9 plugins) y DatabaseView.jsx (board/tabla/
// galería/popovers, el archivo más grande del proyecto) hacían que el chunk
// inicial pesara ~980kB/270kB gzip — bastante para parsear/ejecutar antes de
// que la app sea usable, y se nota en una PC menos potente (reportado por un
// compañero del usuario). Los dos entran acá:
// - Editor/MobileEditor: mutuamente excluyentes por sesión (isMobile decide
//   cuál se monta) — SIEMPRE se estaba pagando el que no hacía falta.
// - DatabaseView/PropertyCell: mismo archivo, dos exports — PropertyCell
//   (RowPropertiesBar, más abajo) lo necesita CUALQUIER página con
//   propiedades, no solo una base de datos completa, así que un mismo
//   Suspense boundary cubre las tres. import() de un named export: React.lazy
//   solo resuelve el default, por eso el .then() para PropertyCell — apunta
//   al MISMO chunk que DatabaseView (Vite lo deduplica), no lo duplica.
// App.jsx dispara un prefetch de estos dos en segundo plano apenas arranca
// la app (ver ese archivo) para que estén listos antes de que hagan falta.
const Editor = lazy(() => import('./Editor.jsx'))
const MobileEditor = lazy(() => import('./MobileEditor.jsx'))
const DatabaseView = lazy(() => import('./DatabaseView.jsx'))
const PropertyCell = lazy(() => import('./DatabaseView.jsx').then((m) => ({ default: m.PropertyCell })))

// getDisplayMedia (captura de pantalla) es una API de navegador de
// ESCRITORIO — no existe en el WebView de Android ni en navegadores
// mobile en general (reportado: tocar "Grabar" ahí tira
// "navigator.mediaDevices.getDisplayMedia is not a function"). No es
// "isDesktop" (Electron) lo que hay que chequear — la versión web en un
// navegador de escritorio SÍ la soporta — sino la capacidad real, para no
// mostrar un botón que en esa plataforma no puede funcionar.
const SCREEN_RECORDING_SUPPORTED = typeof navigator?.mediaDevices?.getDisplayMedia === 'function'

function SuspenseFallback() {
  return (
    <div className="flex items-center justify-center py-16 text-sm text-gray-400 dark:text-neutral-500">
      Cargando…
    </div>
  )
}

const STATUS = {
  loading: { label: 'Cargando…', className: 'text-gray-400 dark:text-neutral-500' },
  idle: { label: '', className: '' },
  saving: { label: 'Guardando…', className: 'animate-pulse text-amber-600 dark:text-amber-400' },
  saved: { label: 'Guardado', className: 'text-gray-400 dark:text-neutral-500' },
  error: { label: 'Error al guardar', className: 'text-red-600 dark:text-red-400' },
}

const RENAME_DELAY_MS = 400
// cada cuánto se vuelve a intentar aplicar un cambio remoto que quedó
// esperando porque se estaba escribiendo. Corto: apenas soltás el teclado y
// sacás el foco del editor, entra sola.
const REMOTE_RELOAD_RETRY_MS = 2500
// el autoguardado ajeno dispara cada 800ms mientras la otra persona escribe:
// sin agrupar, cada uno sería una recarga y la página parpadearía
const REMOTE_APPLY_DEBOUNCE_MS = 2000
// cortacircuitos: más de estas recargas automáticas dentro de la ventana y se
// vuelve al cartel manual — un bucle de comparación jamás puede degenerar en
// una pantalla parpadeando
const REMOTE_MAX_BURST = 4
const REMOTE_BURST_WINDOW_MS = 15_000
// mover una fila de columna en el tablero escribe varias páginas seguidas —
// se agrupa la ráfaga en un solo refetch del índice
const ROW_SYNC_DEBOUNCE_MS = 700
const DRIVE_DEFAULT_KEY = 'flashlab-record-to-drive'
const RECORD_AUDIO_KEY = 'flashlab-record-audio'
const RECORD_RESOLUTION_KEY = 'flashlab-record-resolution'

const ICON_CHOICES = [
  '📄', '📝', '📌', '📋', '☑️', '📁', '🗂️', '📚', '📖', '🔖', '📇', '🗒️', '🗓️', '📔', '📒', '📕',
  '💡', '⭐', '🔥', '✅', '🎯', '🚀', '💻', '🛠️', '🔧', '🔩', '🖥️', '⌨️', '🖱️', '💾', '🧩', '🔗',
  '📅', '⏰', '⏳', '🎨', '🎬', '🎵', '🎮', '🎲', '♟️', '🎤', '🎧', '📷', '📹', '🖼️', '🧵', '🧶',
  '⚽', '🏀', '🏈', '🎾', '🏐', '🍕', '☕', '🍔', '🍎', '🍰', '🍷', '🍺', '🥑', '🌮', '🍫', '🍿',
  '🌟', '🌈', '🌙', '☀️', '⛅', '❄️', '🌊', '🌴', '🌱', '🌵', '🌻', '🍀', '🍁', '🌍', '🪐', '⚡',
  '🐱', '🐶', '🦊', '🐻', '🐼', '🦁', '🐸', '🦋', '🐝', '🐳', '🦄', '🐢', '🦉', '🐧', '🐙', '🦖',
  '❤️', '💙', '💚', '💛', '🧡', '💜', '🖤', '🤍', '💬', '💭', '📣', '🔊',
  '📊', '📈', '📉', '🧮', '🧾', '🧭', '🗺️', '🔍', '🔒', '🔓', '🔑', '🛡️', '⚙️', '🧠', '🧪', '🧬',
  '🎓', '🎒', '✏️', '🖊️', '📐', '📏', '📎', '🏅', '🥇', '🎗️', '✈️', '🚗', '🚲', '🚢', '🚉', '🗽',
  '🏠', '🏢', '🏫', '🏥', '🏦', '⛺', '🗼', '🎪', '💰', '💳', '💸', '🪙', '📞', '📱', '✉️', '📬',
  '🔔', '🔕', '🏆', '🎁', '🎉', '🎈', '🕯️', '🧸', '🐾', '👥', '🧑‍💻', '🧑‍🎨', '🧑‍🚀', '🧑‍🍳', '🧘', '🏃',
]

function IconPicker({ current, onPick, onClose }) {
  const [custom, setCustom] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [customIcons, setCustomIcons] = useState([])
  const fileInputRef = useRef(null)

  useEffect(() => {
    getCustomIcons().then(setCustomIcons)
  }, [])

  const uploadFile = async (file) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setUploadError('Eso no es una imagen')
      return
    }
    setUploadError('')
    setUploading(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { file: saved } = await api.saveImage(bytes, file.name, file.type)
      await addCustomIcon(saved.url)
      setCustomIcons(await getCustomIcons())
      onPick(saved.url)
    } catch {
      setUploadError('No se pudo subir la imagen')
      setUploading(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        onClick={(event) => event.stopPropagation()}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          uploadFile(event.dataTransfer.files?.[0])
        }}
        className={`absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border bg-white p-2 shadow-lg dark:bg-neutral-800 ${
          dragging ? 'border-blue-400 ring-2 ring-blue-400/40' : 'border-gray-200 dark:border-neutral-700'
        }`}
      >
        <div className="mb-2 flex items-center gap-1">
          <input
            autoFocus
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && custom.trim()) onPick(custom.trim())
            }}
            placeholder="Pegá cualquier emoji…"
            className="min-w-0 flex-1 rounded border border-gray-200 bg-transparent px-2 py-1 text-sm outline-none focus:border-blue-400 dark:border-neutral-700"
          />
          {current && (
            <button
              type="button"
              onClick={() => onPick(null)}
              className="shrink-0 rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-neutral-700"
            >
              Quitar
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            uploadFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="mb-2 flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-gray-300 px-2 py-1.5 text-xs text-gray-500 hover:border-gray-400 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-60 dark:border-neutral-600 dark:text-neutral-400 dark:hover:bg-white/5"
        >
          {uploading ? 'Subiendo…' : 'Subir imagen (o arrastrala acá)'}
        </button>
        {uploadError && <p className="mb-2 -mt-1 text-xs text-red-500">{uploadError}</p>}
        {customIcons.length > 0 && (
          <>
            <p className="mb-1 px-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-500">
              Personalizados
            </p>
            <div className="mb-2 grid grid-cols-8 gap-0.5">
              {customIcons.map((url) => (
                <div key={url} className="group relative">
                  <button
                    type="button"
                    onClick={() => onPick(url)}
                    className="flex w-full items-center justify-center rounded p-1 hover:bg-gray-100 dark:hover:bg-white/10"
                  >
                    <img src={url} alt="" className="h-6 w-6 rounded-sm object-cover" />
                  </button>
                  <button
                    type="button"
                    aria-label="Borrar ícono"
                    title="Borrar"
                    onClick={async (event) => {
                      event.stopPropagation()
                      await deleteCustomIcon(url)
                      setCustomIcons((prev) => prev.filter((u) => u !== url))
                    }}
                    className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-full bg-gray-700 text-[8px] text-white hover:bg-red-600 group-hover:flex"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="grid max-h-64 grid-cols-8 gap-0.5 overflow-y-auto">
          {ICON_CHOICES.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onPick(emoji)}
              className="rounded p-1 text-xl hover:bg-gray-100 dark:hover:bg-white/10"
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

const PROP_TYPE_GLYPH = { text: '≡', number: '#', select: '◆', checkbox: '☑', date: '📅' }

// barra de propiedades tipo Notion: cuando esta página es una fila de una
// base de datos (page.parentId apunta a una base), muestra sus propiedades
// (Estado, Etiquetas, etc.) arriba del contenido, reusando el mismo
// PropertyCell que la tabla/tablero.
function RowPropertiesBar({ parentDb, page, onUpdateProperty, onUpdateDatabaseSchema }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState('text')
  const schema = parentDb.databaseSchema.filter((p) => p.type !== 'title' && !p.hidden)

  const addProperty = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const newProp = { id: crypto.randomUUID(), name: trimmed, type, hidden: false }
    if (type === 'select') newProp.options = [{ id: crypto.randomUUID(), name: 'Opción 1', color: COLOR_PALETTE[0] }]
    onUpdateDatabaseSchema(parentDb.id, [...parentDb.databaseSchema, newProp])
    setName('')
    setType('text')
    setAdding(false)
  }

  return (
    <div className="mb-6 space-y-0.5 border-b border-gray-100 pb-4 dark:border-neutral-700">
      {schema.map((prop) => (
        <div key={prop.id} className="flex items-start gap-2 text-sm">
          <span className="mt-1.5 flex w-32 shrink-0 items-center gap-1.5 text-gray-400 dark:text-neutral-500">
            <span className="w-4 shrink-0 text-center text-xs leading-none">{PROP_TYPE_GLYPH[prop.type] ?? '≡'}</span>
            <span className="truncate">{prop.name}</span>
          </span>
          <div className="min-w-0 flex-1">
            <PropertyCell
              prop={prop}
              value={page.properties?.[prop.id]}
              onChange={(value) => onUpdateProperty(page.id, prop.id, value)}
              onUpdatePropOptions={(options) =>
                onUpdateDatabaseSchema(
                  parentDb.id,
                  parentDb.databaseSchema.map((p) => (p.id === prop.id ? { ...p, options } : p))
                )
              }
            />
          </div>
        </div>
      ))}
      {adding ? (
        <div className="flex items-center gap-1.5 pt-1">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addProperty()
              if (event.key === 'Escape') setAdding(false)
            }}
            placeholder="Nombre de la propiedad"
            className="w-40 rounded border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-blue-400 dark:border-neutral-700"
          />
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="rounded border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none dark:border-neutral-700"
          >
            {Object.entries(CREATABLE_TYPE_LABEL).map(([t, label]) => (
              <option key={t} value={t}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addProperty}
            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
          >
            Crear
          </button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10"
          >
            Cancelar
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1 text-sm text-gray-400 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300"
        >
          + Agregar una propiedad
        </button>
      )}
    </div>
  )
}

function formatElapsed(totalSeconds) {
  const pad = (n) => String(n).padStart(2, '0')
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function Spinner({ className = 'h-4 w-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-90" />
    </svg>
  )
}

// Lo que ve alguien a quien le compartieron la página: la grabación existe y
// se puede abrir, pero el archivo es de otro (vive en SU disco y SU Drive) —
// no hay Editar, ni Copiar, ni Eliminar, ni reproducirlo local. Da igual que
// tenga permiso de 'editor' en la página: las grabaciones ajenas son siempre
// de solo lectura (lo hace cumplir la policy de page_recordings, esto es
// nada más la UI que corresponde).
function SharedRecordingRow({ rec }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-neutral-200" title={rec.name}>
        🎥 {rec.name}
      </span>
      <span className="shrink-0 text-xs text-gray-400 dark:text-neutral-500">solo lectura</span>
      <button
        type="button"
        onClick={() => api.openExternal(rec.driveUrl)}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-blue-600 hover:bg-gray-100 dark:text-blue-400 dark:hover:bg-neutral-800"
      >
        ☁️ Ver en Drive
      </button>
    </li>
  )
}

function RecordingRow({ rec, expanded, onToggle, onEdit, onDelete, onUploadDrive, onCopy, onCancelDrive, onReshareDrive }) {
  const [confirming, setConfirming] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [copying, setCopying] = useState(false)
  // null | 'sharing' | { shared, failed } | { error }
  const [reshare, setReshare] = useState(null)
  const handleCopy = async () => {
    setCopyError('')
    setCopying(true)
    try {
      // arma un .mp4 antes de copiar (el original queda intacto), así que
      // esto ya no es instantáneo — puede tardar según la duración
      await onCopy(rec.id)
    } catch (err) {
      setCopyError(err.message || 'no se pudo copiar')
    } finally {
      setCopying(false)
    }
  }
  const handleReshareDrive = async () => {
    setReshare('sharing')
    try {
      setReshare(await onReshareDrive(rec.id))
    } catch (err) {
      setReshare({ error: err.message || 'no se pudo compartir' })
    }
  }
  return (
    <li>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          🎥 {rec.name}
        </button>
        {!rec.driveStatus && (
          <button
            type="button"
            onClick={() => onUploadDrive(rec.id)}
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            Subir a Drive
          </button>
        )}
        {(rec.driveStatus === 'uploading' || rec.driveStatus === 'converting') && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-gray-400 dark:text-neutral-500">
            <Spinner className="h-3 w-3" />
            {rec.driveStatus === 'converting' ? 'Preparando video' : 'Subiendo a Drive'}
            {typeof rec.driveProgress === 'number' ? ` ${rec.driveProgress}%` : '…'}
            <button
              type="button"
              onClick={() => onCancelDrive(rec.id)}
              className="ml-0.5 rounded px-1 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-neutral-800 dark:hover:text-red-400"
            >
              Cancelar
            </button>
          </span>
        )}
        {rec.driveStatus === 'done' && (
          <>
            <button
              type="button"
              onClick={() => api.openExternal(rec.driveUrl)}
              className="shrink-0 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              ☁️ Drive
            </button>
            {isDesktop && (
              <button
                type="button"
                onClick={handleReshareDrive}
                disabled={reshare === 'sharing'}
                title="Volver a darle acceso en Drive a todos los que tienen esta página compartida"
                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                {reshare === 'sharing' ? 'Compartiendo…' : 'Reenviar acceso'}
              </button>
            )}
            {isDesktop && (
              <button
                type="button"
                onClick={() => onUploadDrive(rec.id)}
                title="Reemplazar el archivo en Drive (mismo link) — sirve para las que se subieron sin audio"
                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                Volver a subir
              </button>
            )}
          </>
        )}
        {rec.driveStatus === 'error' && (
          <button
            type="button"
            title={rec.driveError || undefined}
            onClick={() => onUploadDrive(rec.id)}
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/50"
          >
            Reintentar subida a Drive
          </button>
        )}
        {isDesktop && (
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            Editar
          </button>
        )}
        {isDesktop && (
          <button
            type="button"
            title={copyError || 'Guardar una copia en .mp4, lista para ver con otro programa'}
            onClick={handleCopy}
            disabled={copying}
            className={`shrink-0 rounded px-1.5 py-0.5 text-xs disabled:opacity-50 ${
              copyError
                ? 'text-red-600 dark:text-red-400'
                : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
            }`}
          >
            {copying ? 'Copiando…' : 'Copiar'}
          </button>
        )}
        <button
          type="button"
          onClick={() => (confirming ? onDelete() : setConfirming(true))}
          onMouseLeave={() => setConfirming(false)}
          className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
            confirming
              ? 'bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400'
              : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
          }`}
        >
          {confirming ? '¿Borrar?' : 'Eliminar'}
        </button>
      </div>
      {reshare && reshare !== 'sharing' && (
        <p
          className={`mt-1 text-xs ${
            reshare.error || reshare.failed?.length
              ? 'text-red-600 dark:text-red-400'
              : 'text-gray-400 dark:text-neutral-500'
          }`}
        >
          {reshare.error
            ? reshare.error
            : reshare.failed?.length
              ? `No se pudo compartir con ${reshare.failed.map((f) => f.email).join(', ')}`
              : `Listo: ${reshare.shared} ${reshare.shared === 1 ? 'persona ya puede' : 'personas ya pueden'} abrir esta grabación.`}
        </p>
      )}
      {expanded && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={rec.url}
          controls
          onLoadedMetadata={(event) => resolveDuration(event.currentTarget, rec.url)}
          className="mt-2 w-full max-w-xl rounded-lg border border-gray-200 dark:border-neutral-700"
        />
      )}
    </li>
  )
}

export default function PageView({
  page,
  path = [],
  insetLeft = false,
  onRename,
  onSetIcon,
  onNavigate,
  onOpenRow,
  rows,
  onCreateRow,
  onDuplicateRow,
  onMoveRow,
  onTrashRows,
  onUpdateProperty,
  onUpdateSchema,
  onUpdateDatabaseSchema,
  // opcional: solo lo pasa App (PagePeek no sincroniza filas en vivo, es una
  // vista de vistazo que se cierra enseguida)
  onSyncRows,
}) {
  const parentDb = path.length > 0 && path[path.length - 1]?.isDatabase ? path[path.length - 1] : null
  // Editor.js está armado para mouse (manijas de arrastre, barras con
  // :hover) — en táctil se cambia por MobileEditor, que edita el mismo
  // formato de bloques con un alcance más chico (texto/título/lista) pero
  // sin romper lo hecho en desktop.
  const isMobile = useIsMobile()
  const [status, setStatus] = useState(page.isDatabase ? 'idle' : 'loading')
  const [title, setTitle] = useState(page.title)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [editingRecordingId, setEditingRecordingId] = useState(null)
  const session = useAuthSession()
  const isOwner = !isDesktop || !page.ownerId || page.ownerId === session?.user?.id
  const [remoteChange, setRemoteChange] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const lastContentRef = useRef(null)

  // stableStringify, no JSON.stringify: el contenido vuelve del servidor con
  // las claves reordenadas por jsonb — ver el comentario en liveSync.js.
  const handleContentSynced = useCallback((data) => {
    lastContentRef.current = stableStringify(data ?? null)
  }, [])

  const handleReloadRemote = useCallback(() => {
    setRemoteChange(false)
    setReloadNonce((n) => n + 1)
  }, [])

  // ¿se puede recargar el editor de una sin arruinarle el trabajo a nadie?
  // Recargar remonta Editor/MobileEditor (ver la `key` con reloadNonce más
  // abajo), o sea que se pierden el cursor, la selección y cualquier tecla
  // que todavía no llegó al autoguardado. Eso está perfecto si nadie está
  // escribiendo, y es inaceptable si sí. Dos señales:
  //   - status 'saving': hay un guardado en vuelo, o sea que se tipeó hace
  //     menos de 800ms (el debounce de AUTOSAVE_DELAY_MS).
  //   - el foco está DENTRO del editor: aunque no se esté tipeando ahora
  //     mismo, el cursor está puesto y perderlo se siente como un salto.
  const statusRef = useRef(status)
  statusRef.current = status
  const editorAreaRef = useRef(null)
  const isEditingNow = useCallback(() => {
    if (statusRef.current === 'saving') return true
    const area = editorAreaRef.current
    return Boolean(area && document.activeElement && area.contains(document.activeElement))
  }, [])

  // Sincronización con otras personas en la MISMA página compartida.
  // Antes esto solo levantaba un cartel ("Alguien actualizó esta página") y
  // esperaba un clic. Ahora, si no estás editando, se aplica solo — como en
  // un documento de Drive. El cartel queda para el único caso donde
  // recargar sería destructivo: que estés escribiendo justo en ese momento.
  // Cuando dejás de escribir se aplica igual, sin que tengas que clickear.
  //
  // Sigue siendo solo para páginas COMPARTIDAS: si el único con acceso sos
  // vos, un UPDATE remoto solo puede ser tuyo desde otro dispositivo, y
  // recargar la vista por eso confunde más de lo que ayuda (reportado:
  // aparecía en páginas sin compartir con nadie).
  useEffect(() => {
    if (page.isDatabase) return undefined
    setRemoteChange(false)
    lastContentRef.current = null
    let cancelled = false
    let unsubscribe = null
    let retryTimer = null
    let debounceTimer = null
    // cortacircuitos: cuántas recargas automáticas seguidas se hicieron sin
    // que el usuario tocara nada. Ver applyRemote.
    let burstCount = 0
    let burstTimer = null

    const applyRemote = () => {
      if (cancelled) return
      if (isEditingNow()) {
        // no pisar lo que se está escribiendo: mostrar el aviso y volver a
        // intentar sola en un rato. Sin este reintento, quedarse con el
        // cursor puesto en la página dejaba el cartel colgado para siempre.
        setRemoteChange(true)
        clearTimeout(retryTimer)
        retryTimer = setTimeout(applyRemote, REMOTE_RELOAD_RETRY_MS)
        return
      }
      // Aunque la comparación de arriba sea correcta, recargar en cada
      // guardado ajeno haría parpadear la página mientras la otra persona
      // escribe (su autoguardado dispara cada 800ms). Se corta la racha en
      // una sola recarga, cuando dejó de escribir.
      burstCount += 1
      clearTimeout(burstTimer)
      burstTimer = setTimeout(() => {
        burstCount = 0
      }, REMOTE_BURST_WINDOW_MS)
      if (burstCount > REMOTE_MAX_BURST) {
        // Llegar acá significa que algo nos está diciendo "cambió" en loop —
        // exactamente el bug de jsonb que hizo parpadear las páginas
        // compartidas. Ante la duda: dejar de recargar sola y volver al
        // cartel manual. Molesto, pero jamás una pantalla estroboscópica.
        console.warn('[liveSync] demasiadas recargas seguidas, se vuelve al aviso manual')
        setRemoteChange(true)
        return
      }
      handleReloadRemote()
    }

    api.listShares(page.id).then((shares) => {
      if (cancelled || shares.length === 0) return
      unsubscribe = subscribeToPageContent(page.id, (content) => {
        const incoming = stableStringify(content ?? null)
        // lastContentRef todavía en null = el editor ni terminó de cargar;
        // e igual al último sincronizado = es el eco de tu propio guardado.
        if (lastContentRef.current === null || incoming === lastContentRef.current) return
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(applyRemote, REMOTE_APPLY_DEBOUNCE_MS)
      })
    })
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
      clearTimeout(debounceTimer)
      clearTimeout(burstTimer)
      unsubscribe?.()
    }
  }, [page.id, page.isDatabase, handleReloadRemote, isEditingNow])

  // "Recargar" del sidebar: mismo remontaje, pero pedido a mano — acá no hace
  // falta preguntar si está compartida (lo pidió el usuario explícitamente).
  useEffect(() => onReloadContent(handleReloadRemote), [handleReloadRemote])

  // Lo mismo pero para BASES DE DATOS. Las filas son páginas hijas y viven en
  // el estado de App (llegan acá como prop `rows`), así que este componente no
  // puede recargarlas por su cuenta: le pide a App que vuelva a traer el
  // índice. Por ref para que la identidad de la función (que cambia con la
  // pestaña activa) no rearme la suscripción a cada rato.
  const syncRowsRef = useRef(onSyncRows)
  syncRowsRef.current = onSyncRows
  useEffect(() => {
    if (!page.isDatabase) return undefined
    let cancelled = false
    let unsubscribe = null
    let timer = null
    const refresh = () => {
      // reordenar o mover filas dispara varios UPDATE seguidos — sin agrupar,
      // cada uno se llevaría su propio refetch del índice entero
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!cancelled) syncRowsRef.current?.()
      }, ROW_SYNC_DEBOUNCE_MS)
    }
    api.listShares(page.id).then((shares) => {
      if (cancelled || shares.length === 0) return
      unsubscribe = subscribeToDatabaseRows(page.id, refresh)
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe?.()
    }
  }, [page.id, page.isDatabase])
  const [backlinks, setBacklinks] = useState([])
  const [recordings, setRecordings] = useState([])
  // las que publicó otro en una página que me compartieron (solo lectura)
  const [sharedRecordings, setSharedRecordings] = useState([])
  // qué grabaciones ya se publicaron en esta sesión, para no repetir el upsert
  const publishedRef = useRef(new Set())
  // la grabación de pantalla vive en screenRecording.js (fuera de React) para
  // sobrevivir a que esta página se desmonte al cambiar de pestaña — ver el
  // comentario ahí. `isMine` distingue "la grabación en curso es de ESTA
  // página" de "hay una grabación en curso, pero de otra página" (bloquea
  // arrancar una segunda en simultáneo, ver el botón "Grabar" más abajo).
  const recordingSnapshot = useSyncExternalStore(subscribeRecording, getRecordingSnapshot)
  // re-renderiza cuando cambia el % de subida a Drive de CUALQUIER grabación
  // (de esta página o no) — el merge real pasa en el render de abajo, ver
  // withLiveDriveState. Esto es lo que hace que el % no se pierda al volver
  // a esta pestaña después de haber estado en otra.
  useSyncExternalStore(subscribeDriveUploads, getDriveUploadsVersion)
  const isMine = recordingSnapshot.pageId === page.id
  const recordingState = isMine ? recordingSnapshot.state : 'idle'
  const recordError = isMine ? recordingSnapshot.error : ''
  const recordingElsewhere = !isMine && recordingSnapshot.state !== 'idle'
  const [saveToDrive, setSaveToDrive] = useState(() => localStorage.getItem(DRIVE_DEFAULT_KEY) === '1')
  // default true (!== '0'): antes de que existiera esta opción, grabar
  // SIEMPRE incluía audio — quien nunca tocó el control no debería
  // notar el cambio.
  const [recordIncludeAudio, setRecordIncludeAudio] = useState(() => localStorage.getItem(RECORD_AUDIO_KEY) !== '0')
  const [recordResolution, setRecordResolution] = useState(() => localStorage.getItem(RECORD_RESOLUTION_KEY) || '1080p')
  const [driveConnecting, setDriveConnecting] = useState(false)
  const [driveCheckboxError, setDriveCheckboxError] = useState('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [expandedRecordingId, setExpandedRecordingId] = useState(null)
  const editingRecording = recordings.find((r) => r.id === editingRecordingId) ?? null
  const renameTimer = useRef(null)
  const pendingTitle = useRef(null)

  // renombrados desde el sidebar mientras esta página está abierta
  useEffect(() => {
    setTitle(page.title)
  }, [page.title])

  useEffect(() => {
    let cancelled = false
    api.backlinks(page.id).then((links) => {
      if (!cancelled) setBacklinks(links)
    })
    return () => {
      cancelled = true
    }
  }, [page.id, status])

  // las propias (archivo local) solo las tiene el dueño de la página; si la
  // página es compartida, lo que hay para mostrar son las publicadas por
  // quien grabó (ver 0019_page_recordings.sql)
  useEffect(() => {
    let cancelled = false
    if (isOwner) {
      api.listRecordings(page.id).then((list) => {
        if (!cancelled) setRecordings(list)
      })
    } else {
      setRecordings([])
      api.listPageRecordings(page.id).then(
        (list) => {
          if (!cancelled) setSharedRecordings(list)
        },
        (err) => console.error('no se pudieron cargar las grabaciones compartidas:', err)
      )
    }
    return () => {
      cancelled = true
    }
  }, [page.id, isOwner])

  // publicar (upsert idempotente) lo que ya está en Drive, para que le
  // aparezca a quien tenga la página compartida. Se hace acá, cada vez que
  // se abre la página, en vez de solo al terminar una subida: así también
  // quedan publicadas las grabaciones subidas antes de que esto existiera.
  useEffect(() => {
    if (!isDesktop || !isOwner) return
    for (const rec of recordings) {
      if (rec.driveStatus !== 'done' || !rec.driveUrl) continue
      // `recordings` cambia seguido (progreso de subida, edición): sin esto
      // se repetiría el upsert en cada render con cambios
      const stamp = `${rec.id}:${rec.name}:${rec.driveUrl}`
      if (publishedRef.current.has(stamp)) continue
      publishedRef.current.add(stamp)
      api.publishRecording(page.id, rec).catch((err) => console.error('no se pudo publicar la grabación:', err))
    }
  }, [page.id, isOwner, recordings])

  // la misma grabación puede estar editándose desde la vista global de
  // Grabaciones, o terminando de subir a Drive en segundo plano — el patch
  // trae solo los campos que cambiaron (url al editar, driveStatus/driveUrl
  // al subir), se mergea entero en vez de asumir una forma fija.
  useEffect(
    () =>
      api.onRecordingsUpdated(({ pageId: updatedPageId, recordingId, patch }) => {
        if (updatedPageId !== page.id) return
        setRecordings((prev) => prev.map((r) => (r.id === recordingId ? { ...r, ...patch } : r)))
      }),
    [page.id]
  )

  // grabación nueva recién guardada (ver screenRecording.js) — si esta
  // página seguía montada todo el tiempo (el caso común, sin cambiar de
  // pestaña) hay que sumarla acá; si se cambió de pestaña y se volvió, el
  // efecto de arriba (api.listRecordings) ya la trae fresca del disco al
  // remontar, así que este evento simplemente no encuentra nada que hacer.
  useEffect(() => {
    const onSaved = (event) => {
      if (event.detail.pageId !== page.id) return
      setRecordings((prev) => (prev.some((r) => r.id === event.detail.entry.id) ? prev : [...prev, event.detail.entry]))
    }
    window.addEventListener('flashlab:recording-saved', onSaved)
    return () => window.removeEventListener('flashlab:recording-saved', onSaved)
  }, [page.id])

  useEffect(() => {
    if (!isMine || recordingSnapshot.state !== 'recording') return
    const tick = () => setElapsedSeconds(Math.floor((Date.now() - recordingSnapshot.startedAt) / 1000))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [isMine, recordingSnapshot.state, recordingSnapshot.startedAt])

  const startRecording = () =>
    startScreenRecording(page.id, { saveToDrive, includeAudio: recordIncludeAudio, resolution: recordResolution })
  const stopRecording = () => stopScreenRecording()

  const toggleRecordAudio = (checked) => {
    setRecordIncludeAudio(checked)
    localStorage.setItem(RECORD_AUDIO_KEY, checked ? '1' : '0')
  }

  const changeRecordResolution = (value) => {
    setRecordResolution(value)
    localStorage.setItem(RECORD_RESOLUTION_KEY, value)
  }

  // dispara el mismo baile OAuth que "Conectar Calendar" (CalendarView.jsx),
  // pidiendo el scope de Drive — solo si todavía no está conectado (una vez
  // conectada, la cuenta queda para todas las grabaciones futuras). La usan
  // tanto el checkbox como "Subir a Drive"/"Reintentar" en una grabación ya
  // existente.
  const connectDriveIfNeeded = async () => {
    const { connected } = await api.getDriveAuthStatus()
    if (!connected) await api.connectDriveUnified()
  }

  const toggleSaveToDrive = async (checked) => {
    setDriveCheckboxError('')
    if (!checked) {
      setSaveToDrive(false)
      localStorage.setItem(DRIVE_DEFAULT_KEY, '0')
      return
    }
    setDriveConnecting(true)
    try {
      await connectDriveIfNeeded()
      setSaveToDrive(true)
      localStorage.setItem(DRIVE_DEFAULT_KEY, '1')
    } catch (err) {
      if (err.message !== 'cancelado') setDriveCheckboxError(err.message || 'no se pudo conectar con Drive')
    } finally {
      setDriveConnecting(false)
    }
  }

  // sirve tanto para grabaciones que nunca se subieron (hechas antes de
  // tener esta función, o grabadas sin tildar el checkbox) como para
  // reintentar una que falló — mismo botón en RecordingRow para los dos casos.
  const uploadRecordingToDriveNow = async (recordingId) => {
    setRecordings((prev) =>
      prev.map((r) => (r.id === recordingId ? { ...r, driveStatus: 'uploading', driveError: null } : r))
    )
    try {
      await connectDriveIfNeeded()
    } catch (err) {
      setRecordings((prev) =>
        prev.map((r) =>
          r.id === recordingId
            ? { ...r, driveStatus: 'error', driveError: err.message || 'no se pudo conectar con Drive' }
            : r
        )
      )
      return
    }
    const shares = await api.listShares(page.id).catch(() => [])
    api.uploadRecordingToDrive(page.id, recordingId, shares.map((s) => s.email))
  }

  // el archivo de Drive se comparte una sola vez, al terminar la subida, con
  // los emails de ese momento: a quien se sume a la página después no le
  // llega nada. Esto reparte el acceso con los compartidos de AHORA.
  const reshareOnDrive = async (recordingId) => {
    const shares = await api.listShares(page.id)
    const emails = shares.map((s) => s.email)
    if (emails.length === 0) throw new Error('esta página todavía no está compartida con nadie')
    return api.shareRecordingOnDrive(page.id, recordingId, emails)
  }

  // al invitar a alguien nuevo desde el diálogo de Compartir, darle también
  // el acceso a las grabaciones que ya están en Drive — si no, tendría la
  // página pero no podría abrir los videos que se subieron antes de sumarse.
  const syncDriveAccessAfterShare = () => {
    for (const rec of recordings) {
      if (rec.driveStatus !== 'done') continue
      reshareOnDrive(rec.id).catch((err) =>
        console.error('no se pudo sincronizar el acceso a la grabación en Drive:', err)
      )
    }
  }

  // también sirve para destrabar una grabación que quedó en 'uploading' para
  // siempre (p.ej. se cerró la app a mitad de subida en una sesión previa) —
  // cancelar ahí no aborta nada real (ya no hay nada corriendo), pero limpia
  // el estado igual para poder reintentar.
  const cancelDriveUpload = async (recordingId) => {
    await api.cancelDriveUpload(page.id, recordingId)
    setRecordings((prev) =>
      prev.map((r) => (r.id === recordingId ? { ...r, driveStatus: null, driveError: null, driveProgress: null } : r))
    )
  }

  const deleteRecording = async (recordingId) => {
    // que deje de aparecerle también a quien tiene la página compartida
    api.unpublishRecording(recordingId).catch((err) => console.error('no se pudo despublicar la grabación:', err))
    await api.deleteRecording(page.id, recordingId)
    setRecordings((prev) => prev.filter((r) => r.id !== recordingId))
    setExpandedRecordingId((id) => (id === recordingId ? null : id))
  }

  const handleTitle = (value) => {
    setTitle(value)
    pendingTitle.current = value
    clearTimeout(renameTimer.current)
    renameTimer.current = setTimeout(() => {
      pendingTitle.current = null
      onRename(page.id, value)
    }, RENAME_DELAY_MS)
  }

  // al desmontar (cambio de página), no perder un renombrado pendiente
  useEffect(
    () => () => {
      clearTimeout(renameTimer.current)
      if (pendingTitle.current != null) onRename(page.id, pendingTitle.current)
    },
    [page.id, onRename]
  )

  const handleNavigatePage = useCallback((id) => onNavigate(id), [onNavigate])

  const { label, className } = STATUS[status]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex h-10 shrink-0 items-center justify-between px-6 ${insetLeft ? 'pl-14' : ''}`}>
        <nav aria-label="Ruta de la página" className="flex min-w-0 items-center gap-1 text-xs text-gray-400 dark:text-neutral-500">
          {path.map((ancestor) => (
            <span key={ancestor.id} className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => onNavigate(ancestor.id)}
                className="max-w-40 truncate hover:text-gray-600 dark:hover:text-neutral-300"
              >
                {ancestor.title || 'Sin título'}
              </button>
              <span aria-hidden="true">/</span>
            </span>
          ))}
          <span className="max-w-40 truncate text-gray-500 dark:text-neutral-400">{title || 'Sin título'}</span>
        </nav>
        <div className="flex min-w-0 items-center gap-3 overflow-x-auto">
          {isOwner && (
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              className="shrink-0 cursor-pointer rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Compartir
            </button>
          )}
          {!page.isDatabase && SCREEN_RECORDING_SUPPORTED && (
            <>
              {recordingState === 'idle' && (
                <>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-500 dark:text-neutral-400">
                    <input
                      type="checkbox"
                      checked={saveToDrive}
                      disabled={driveConnecting}
                      onChange={(event) => toggleSaveToDrive(event.target.checked)}
                      className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-neutral-600"
                    />
                    {driveConnecting ? (
                      <span className="flex items-center gap-1">
                        <Spinner className="h-3 w-3" />
                        Conectando Drive…
                      </span>
                    ) : (
                      'Guardar también en Drive'
                    )}
                  </label>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-500 dark:text-neutral-400">
                    <input
                      type="checkbox"
                      checked={recordIncludeAudio}
                      onChange={(event) => toggleRecordAudio(event.target.checked)}
                      className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-neutral-600"
                    />
                    Audio
                  </label>
                  <select
                    value={recordResolution}
                    onChange={(event) => changeRecordResolution(event.target.value)}
                    title="Resolución de la grabación"
                    className="shrink-0 rounded-md border border-gray-200 bg-transparent px-1.5 py-1 text-xs text-gray-500 outline-none dark:border-neutral-700 dark:text-neutral-400"
                  >
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                  </select>
                </>
              )}
              {driveConnecting && (
                <button
                  type="button"
                  onClick={() => api.cancelGoogleAuth()}
                  className="shrink-0 text-xs text-gray-400 underline hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                >
                  Cancelar
                </button>
              )}
              {driveCheckboxError && (
                <span className="max-w-40 shrink-0 truncate text-xs text-red-600 dark:text-red-400" title={driveCheckboxError}>
                  {driveCheckboxError}
                </span>
              )}
              <button
                type="button"
                onClick={recordingState === 'recording' ? stopRecording : startRecording}
                disabled={recordingState === 'starting' || recordingState === 'saving' || recordingElsewhere}
                title={recordingElsewhere ? 'Ya hay una grabación en curso en otra página' : undefined}
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium disabled:cursor-default ${
                  recordingState === 'recording'
                    ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-950'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50 disabled:hover:bg-transparent dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:disabled:hover:bg-transparent'
                }`}
              >
                {recordingState === 'recording' && (
                  <>
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-sm bg-red-600" aria-hidden="true" />
                    Detener
                    <span className="tabular-nums text-red-500/80 dark:text-red-400/70">{formatElapsed(elapsedSeconds)}</span>
                  </>
                )}
                {recordingState === 'idle' && (
                  <>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                    Grabar
                  </>
                )}
                {recordingState === 'starting' && (
                  <>
                    <Spinner className="h-3 w-3" />
                    Iniciando…
                  </>
                )}
                {recordingState === 'saving' && (
                  <>
                    <Spinner className="h-3 w-3" />
                    Guardando…
                  </>
                )}
              </button>
            </>
          )}
          <span className={`shrink-0 text-xs font-medium ${className}`} aria-live="polite">
            {label}
          </span>
        </div>
      </div>
      <div data-page-scroll className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {recordingState === 'saving' && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-white/70 backdrop-blur-[1px] dark:bg-neutral-900/70">
            <Spinner className="h-6 w-6 text-gray-500 dark:text-neutral-400" />
            <p className="text-sm text-gray-500 dark:text-neutral-400">Guardando grabación…</p>
          </div>
        )}
        {/* antes las páginas normales (no database) quedaban en una columna
        fija de max-w-3xl (768px) centrada, sin importar cuánto más ancha
        fuera la ventana — listas, texto, citas, todo se angostaba igual
        aunque hubiera cientos de píxeles libres a los costados. Mismo
        max-w-none que ya usan las bases de datos, para las dos.
        pl asimétrico en desktop (más que pr): el toolbar de bloque de
        Editor.js (⋮⋮ + su popover "Convertir a/Mover/Eliminar") se posiciona
        A LA IZQUIERDA del texto, fuera del bloque — con solo 40px libres
        quedaba prácticamente pegado al borde de la ventana, reportado como
        "se ve mal". Editor.js no tiene una opción propia para esto, la forma
        estándar de darle aire es correr todo el contenido hacia la derecha.
        Mobile no lo necesita (usa MobileEditor.jsx, sin este toolbar). */}
        <div className="mx-auto max-w-none px-6 pb-16 sm:pl-16 sm:pr-10">
          <div className="mt-8 mb-3 flex items-start gap-2">
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setIconPickerOpen((o) => !o)}
                aria-label="Cambiar ícono de la página"
                className="flex h-12 w-12 items-center justify-center rounded-md p-1 text-4xl leading-none hover:bg-gray-100 dark:hover:bg-white/5"
              >
                {page.icon ? (
                  isImageIcon(page.icon) ? (
                    <img src={page.icon} alt="" className="h-full w-full rounded-md object-cover" />
                  ) : (
                    page.icon
                  )
                ) : (
                  '📄'
                )}
              </button>
              {iconPickerOpen && (
                <IconPicker
                  current={page.icon}
                  onPick={(icon) => {
                    onSetIcon(page.id, icon)
                    setIconPickerOpen(false)
                  }}
                  onClose={() => setIconPickerOpen(false)}
                />
              )}
            </div>
            <Suspense fallback={null}>
              {shareOpen && (
                <ShareDialog
                  pageId={page.id}
                  onClose={() => setShareOpen(false)}
                  onShared={syncDriveAccessAfterShare}
                />
              )}
              {editingRecording && (
                <RecordingEditor
                  rec={editingRecording}
                  pageId={page.id}
                  onClose={() => setEditingRecordingId(null)}
                  onSaved={(updated) =>
                    setRecordings((prev) => prev.map((r) => (r.id === updated.id ? { ...r, url: updated.url } : r)))
                  }
                />
              )}
            </Suspense>
            <input
              id="page-title"
              value={title}
              onChange={(event) => handleTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  document.querySelector('.ce-paragraph')?.focus()
                }
              }}
              placeholder="Sin título"
              autoComplete="off"
              className="min-w-0 flex-1 border-none bg-transparent text-4xl font-bold outline-none placeholder:text-gray-300 dark:placeholder:text-neutral-600"
            />
          </div>
          <Suspense fallback={<SuspenseFallback />}>
            {page.isDatabase ? (
              <DatabaseView
                page={page}
                rows={rows}
                onOpenRow={onOpenRow ?? onNavigate}
                onUpdateTitle={onRename}
                onUpdateProperty={onUpdateProperty}
                onCreateRow={onCreateRow}
                onDuplicateRow={onDuplicateRow}
                onMoveRow={onMoveRow}
                onTrashRows={onTrashRows}
                onUpdateSchema={onUpdateSchema}
              />
            ) : (
              <>
                {parentDb && (
                  <RowPropertiesBar
                    parentDb={parentDb}
                    page={page}
                    onUpdateProperty={onUpdateProperty}
                    onUpdateDatabaseSchema={onUpdateDatabaseSchema}
                  />
                )}
                {recordError && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{recordError}</p>}
                {/* ahora solo aparece mientras se está escribiendo: el
                    cambio remoto se aplica solo apenas soltás el editor (ver
                    applyRemote más arriba), el botón es para no esperar. */}
                {remoteChange && (
                  <div className="mb-3 flex items-center justify-between gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                    <span>Alguien más editó esta página. Se va a actualizar en cuanto dejes de escribir.</span>
                    <button
                      type="button"
                      onClick={handleReloadRemote}
                      className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      Actualizar ya
                    </button>
                  </div>
                )}
                {/* el ref envuelve al editor para poder preguntar "¿el foco
                    está acá adentro?" antes de remontarlo (ver isEditingNow) */}
                <div ref={editorAreaRef}>
                  {isMobile ? (
                    <MobileEditor
                      key={`${page.id}-${reloadNonce}`}
                      pageId={page.id}
                      onStatusChange={setStatus}
                      onNavigatePage={handleNavigatePage}
                      onContentSynced={handleContentSynced}
                    />
                  ) : (
                    <Editor
                      key={`${page.id}-${reloadNonce}`}
                      pageId={page.id}
                      onStatusChange={setStatus}
                      onNavigatePage={handleNavigatePage}
                      onContentSynced={handleContentSynced}
                    />
                  )}
                </div>
              </>
            )}
          </Suspense>
          {!page.isDatabase && (
            <>
              {sharedRecordings.length > 0 && (
                <div data-recordings className="mt-10 border-t border-gray-100 pt-4 dark:border-neutral-700">
                  <p className="mb-2 text-xs font-medium text-gray-400 dark:text-neutral-500">
                    {sharedRecordings.length} grabación{sharedRecordings.length === 1 ? '' : 'es'}
                  </p>
                  <ul className="space-y-2">
                    {sharedRecordings.map((rec) => (
                      <SharedRecordingRow key={rec.id} rec={rec} />
                    ))}
                  </ul>
                </div>
              )}
              {recordings.length > 0 && (
                <div data-recordings className="mt-10 border-t border-gray-100 pt-4 dark:border-neutral-700">
                  <p className="mb-2 text-xs font-medium text-gray-400 dark:text-neutral-500">
                    {recordings.length} grabación{recordings.length === 1 ? '' : 'es'}
                  </p>
                  <ul className="space-y-2">
                    {recordings.map((rec) => (
                      <RecordingRow
                        key={rec.id}
                        rec={withLiveDriveState(rec)}
                        expanded={expandedRecordingId === rec.id}
                        onToggle={() => setExpandedRecordingId((id) => (id === rec.id ? null : rec.id))}
                        onEdit={() => setEditingRecordingId(rec.id)}
                        onDelete={() => deleteRecording(rec.id)}
                        onUploadDrive={uploadRecordingToDriveNow}
                        onCopy={(recordingId) => api.copyRecordingToFolder(page.id, recordingId)}
                        onCancelDrive={cancelDriveUpload}
                        onReshareDrive={reshareOnDrive}
                      />
                    ))}
                  </ul>
                </div>
              )}
              {backlinks.length > 0 && (
                <div data-backlinks className="mt-10 border-t border-gray-100 pt-4 dark:border-neutral-700">
                  <p className="mb-2 text-xs font-medium text-gray-400 dark:text-neutral-500">
                    Mencionada en {backlinks.length} página{backlinks.length === 1 ? '' : 's'}
                  </p>
                  <ul className="space-y-1">
                    {backlinks.map((link) => (
                      <li key={link.id}>
                        <button
                          type="button"
                          onClick={() => onNavigate(link.id)}
                          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {link.title || 'Sin título'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
