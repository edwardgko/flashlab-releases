import { useEffect, useRef, useState } from 'react'
import { Browser } from '@capacitor/browser'
import { isImageIcon } from '../lib/icon.js'
import { api, isDesktop } from '../lib/api.js'
import { supabase, useAuthSession, IS_CAPACITOR } from '../lib/supabaseClient.js'
import { getUnreadCounts, listConversationPartners, listIncomingSince, subscribeToInbox } from '../lib/chat.js'
import {
  getGroupUnreadCounts,
  listGroupIncomingSince,
  listGroupMembers,
  listMyGroups,
  subscribeToAnyGroupMessage,
} from '../lib/groupChat.js'
import { notifyNewMessage, previewForMessage, updateTaskbarBadge } from '../lib/desktopNotify.js'
import { setDragPreview } from '../lib/dragPreview.js'

// cada cuánto se vuelve a preguntar por mensajes nuevos aunque Realtime diga
// que todo está bien. 30s es el compromiso: bastante seguido como para que
// una notificación perdida se note tarde y no nunca, y lo bastante espaciado
// como para no pesar (son dos SELECT chicos con índice por destinatario).
const CHAT_CATCHUP_INTERVAL_MS = 30_000

const EXPANDED_KEY = 'nc-expanded'
const WIDTH_KEY = 'nc-sidebar-width'
const DEFAULT_WIDTH = 256
const MIN_WIDTH = 180
const MAX_WIDTH = 480

// viewBox configurable: el árbol necesita recortarlo al dibujo real del ícono para que ocupe
// todo su recuadro, igual que un emoji o una imagen (ver el ícono de base de datos en TreeNode).
function Icon({ d, className = 'h-3.5 w-3.5', viewBox = '0 0 24 24' }) {
  return (
    <svg
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {d.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}

const ICONS = {
  pin: ['M12 17v5', 'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z'],
  home: ['M4 11.5 12 4l8 7.5', 'M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9'],
  trash: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M10 11v6M14 11v6'],
  chevronsLeft: ['M11 17l-5-5 5-5', 'M18 17l-5-5 5-5'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  chevronRight: ['M9 18l6-6-6-6'],
  chevronDown: ['M6 9l6 6 6-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  restore: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.35-4.35'],
  sun: ['M12 3v2', 'M12 19v2', 'M3 12h2', 'M19 12h2', 'M5.6 5.6l1.4 1.4', 'M17 17l1.4 1.4', 'M17 7l1.4-1.4', 'M5.6 18.4L7 17', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z'],
  monitor: ['M4 5h16v10H4z', 'M9 19h6', 'M12 15v4'],
  database: ['M4 4h16v16H4z', 'M10 4v16', 'M16 4v16'],
  duplicate: ['M9 9h12v12H9z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  calendar: ['M8 2v4', 'M16 2v4', 'M4 8h16', 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z'],
  video: ['M4 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z', 'm16 10 5-3v10l-5-3'],
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  cloud: ['M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 9.2 4 4 0 0 0 7 19h10.5Z'],
  refresh: ['M20 11a8 8 0 1 0-.6 4', 'M20 5v6h-6'],
}

// avatar + email de la cuenta: al tocarlo abre un menú hacia arriba (la fila
// vive pegada abajo del todo) con el tema y cerrar sesión — un solo lugar
// para "la cuenta", en vez de un botón de tema aparte flotando en el medio
// de la sidebar.
// Acá vivía un ítem "Conectar Google Drive". Se sacó: entrar con Google ya
// pide el permiso de Drive en la MISMA pantalla de consentimiento del login
// (ver auth:login en electron/main.js, que además reintenta con
// prompt=consent si la cuenta se quedó sin refresh_token), así que el ítem
// solo servía para mandar al usuario a una segunda pantalla de permisos de
// Google idéntica a la que ya había aceptado al entrar. Si el permiso se
// vence, ensureDriveAccessToken lo renueva solo — ver
// reconnectDriveInteractively en electron/main.js.
function AccountRow({ theme, onCycleTheme }) {
  const session = useAuthSession()
  const [avatarBroken, setAvatarBroken] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const areaRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event) => {
      if (areaRef.current && !areaRef.current.contains(event.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuOpen])

  if (!session) return null
  const email = session.user?.email ?? ''
  const meta = session.user?.user_metadata ?? {}
  const avatarUrl = meta.avatar_url || meta.picture
  const initial = (meta.full_name || meta.name || email || '?').trim().charAt(0).toUpperCase()
  return (
    <div ref={areaRef} className="relative">
      {menuOpen && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-full min-w-[180px] rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
          <button
            type="button"
            aria-label={`Cambiar tema (actual: ${THEME_LABEL[theme]})`}
            onClick={onCycleTheme}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-gray-600 hover:bg-gray-100 dark:text-neutral-300 dark:hover:bg-white/10"
          >
            <Icon d={ICONS[THEME_ICON[theme]]} />
            Tema: {THEME_LABEL[theme]}
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false)
              supabase.auth.signOut()
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md border-t border-gray-100 px-2 py-1.5 text-left text-sm text-gray-600 hover:bg-gray-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-white/10"
          >
            <Icon d={ICONS.logout} className="h-3.5 w-3.5" />
            Cerrar sesión
          </button>
        </div>
      )}
      <button
        type="button"
        title={email}
        onClick={() => setMenuOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        {avatarUrl && !avatarBroken ? (
          <img
            src={avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setAvatarBroken(true)}
            className="h-5 w-5 shrink-0 rounded-full"
          />
        ) : (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500 text-[10px] font-semibold text-white">
            {initial}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{email}</span>
        <Icon d={ICONS.chevronDown} className="h-3 w-3 shrink-0 text-gray-400 dark:text-neutral-500" />
      </button>
    </div>
  )
}

const THEME_LABEL = { system: 'Sistema', light: 'Claro', dark: 'Oscuro' }
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' }

function isDescendantLocal(pageMap, ancestorId, pageId) {
  let current = pageMap.get(pageId)
  while (current && current.parentId != null) {
    if (current.parentId === ancestorId) return true
    current = pageMap.get(current.parentId)
  }
  return false
}

function TreeNode({ page, depth, ctx }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const children = ctx.byParent.get(page.id) ?? []
  // las bases de datos siempre aparecen compactadas en el árbol — sus filas
  // ya se ven en el Tablero/Tabla, desplegarlas acá encima solo agrega ruido
  // (y antes pasaba solo, al abrir la app o una pestaña nueva sobre una fila).
  const isExpanded = ctx.expanded.has(page.id) && !page.isDatabase
  const active = page.id === ctx.currentId
  const hint = ctx.dropHint?.id === page.id ? ctx.dropHint.pos : null

  const commit = () => {
    setEditing(false)
    if (draft !== page.title) ctx.onRename(page.id, draft)
  }

  return (
    <div>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(false)
          }}
          style={{ marginLeft: depth * 12 }}
          className="my-0.5 w-[calc(100%-0.5rem)] rounded-md border border-blue-400 bg-white px-1.5 py-1 text-sm text-gray-900 outline-none dark:bg-neutral-800 dark:text-neutral-100"
        />
      ) : (
        <div
          data-page-id={page.id}
          draggable
          onDragStart={(event) => ctx.onDragStart(event, page.id)}
          onDragEnd={ctx.onDragEnd}
          onDragOver={(event) => ctx.onDragOverItem(event, page)}
          onDrop={(event) => ctx.onDropItem(event, page)}
          onDragLeave={(event) => ctx.onDragLeaveItem(event, page)}
          onMouseLeave={() => setConfirmDelete(false)}
          className={`group my-0.5 flex items-center rounded-md ${
            active ? 'bg-gray-200 dark:bg-neutral-700' : 'hover:bg-gray-100 dark:hover:bg-neutral-800'
          } ${hint === 'before' ? 'border-t-2 border-blue-400' : ''} ${
            hint === 'after' ? 'border-b-2 border-blue-400' : ''
          } ${hint === 'inside' ? 'bg-blue-50 ring-2 ring-inset ring-blue-300 dark:bg-blue-950' : ''}`}
          style={{ paddingLeft: depth * 12 }}
        >
          {children.length > 0 && !page.isDatabase ? (
            <button
              type="button"
              aria-label={isExpanded ? 'Colapsar' : 'Expandir'}
              onClick={() => ctx.toggleExpand(page.id)}
              className="ml-0.5 shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 cursor-pointer"
            >
              <Icon d={isExpanded ? ICONS.chevronDown : ICONS.chevronRight} className="h-3 w-3" />
            </button>
          ) : (
            <span className="ml-0.5 w-4 shrink-0" />
          )}
          <button
            type="button"
            onClick={() => ctx.onSelect(page.id)}
            onDoubleClick={() => {
              setDraft(page.title)
              setEditing(true)
            }}
            title="Doble clic para renombrar"
            className="flex min-w-0 flex-1 items-center gap-1.5 truncate px-1.5 py-1.5 text-left text-sm text-gray-700 dark:text-neutral-300 cursor-pointer"
          >
            {/* slot de 20px con TODOS los íconos renderizados al mismo tamaño (20px): imagen,
                SVG de base de datos y emoji. El emoji a 15px de fuente avanza ~20.6px, así que
                queda del ancho del slot en vez de desbordarlo — sin esto cada tipo de ícono
                arrancaba en un x distinto y las filas se veían corridas entre sí. */}
            <span className="flex h-5 w-5 shrink-0 items-center justify-center">
              {page.icon ? (
                isImageIcon(page.icon) ? (
                  <img src={page.icon} alt="" className="h-5 w-5 rounded-sm object-cover" />
                ) : (
                  <span className="text-[15px] leading-none">{page.icon}</span>
                )
              ) : (
                page.isDatabase && (
                  // el path va de 4 a 20 en un viewBox de 0-24, así que sobra ~17% de aire a cada
                  // lado; recortado al dibujo + medio trazo (1.8/2) el ícono llena los 20px y
                  // arranca en el mismo x que un emoji o una imagen
                  <Icon
                    d={ICONS.database}
                    viewBox="3.1 3.1 17.8 17.8"
                    className="h-5 w-5 text-gray-400 dark:text-neutral-500"
                  />
                )
              )}
            </span>
            <span className="truncate">
              {page.title || <span className="italic text-gray-400 dark:text-neutral-500">Sin título</span>}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Nueva subpágina en ${page.title || 'Sin título'}`}
            title="Nueva subpágina"
            onClick={(event) => {
              event.stopPropagation()
              ctx.expandNode(page.id)
              ctx.onCreateChild(page.id)
            }}
            className="cursor-pointer shrink-0 rounded p-1 text-gray-400 opacity-0 max-md:opacity-100 hover:bg-gray-200 hover:text-gray-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          >
            <Icon d={ICONS.plus} />
          </button>
          <button
            type="button"
            aria-label={`Duplicar ${page.title || 'Sin título'}`}
            title="Duplicar página"
            onClick={(event) => {
              event.stopPropagation()
              ctx.onDuplicate(page.id)
            }}
            className="cursor-pointer shrink-0 rounded p-1 text-gray-400 opacity-0 max-md:opacity-100 hover:bg-gray-200 hover:text-gray-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          >
            <Icon d={ICONS.duplicate} />
          </button>
          <button
            type="button"
            aria-label={`Enviar a la papelera ${page.title || 'Sin título'}`}
            title={confirmDelete ? 'Clic de nuevo para confirmar eliminación' : 'Mover a la papelera'}
            onClick={(event) => {
              event.stopPropagation()
              if (confirmDelete) {
                setConfirmDelete(false)
                ctx.onTrash(page.id)
              } else {
                setConfirmDelete(true)
              }
            }}
            onMouseLeave={() => setConfirmDelete(false)}
            className={`cursor-pointer mr-1 shrink-0 rounded p-1 transition-colors ${
              confirmDelete
                ? '!bg-red-600 !text-white !opacity-100'
                : 'text-gray-400 opacity-0 max-md:opacity-100 hover:bg-gray-200 hover:text-gray-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200'
            }`}
          >
            <Icon d={ICONS.trash} />
          </button>
        </div>
      )}
      {isExpanded &&
        children.map((child) => <TreeNode key={child.id} page={child} depth={depth + 1} ctx={ctx} />)}
    </div>
  )
}

function TrashRow({ page, onRestore, onDeleteForever }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div
      data-trash-id={page.id}
      onMouseLeave={() => setConfirming(false)}
      className="group flex items-center rounded-md px-1 hover:bg-gray-100 dark:hover:bg-neutral-800"
    >
      <span className="min-w-0 flex-1 truncate px-1.5 py-1.5 text-sm text-gray-500 dark:text-neutral-400">
        {page.title || <span className="italic text-gray-400 dark:text-neutral-500">Sin título</span>}
      </span>
      <button
        type="button"
        aria-label={`Restaurar ${page.title || 'Sin título'}`}
        title="Restaurar página"
        onClick={(event) => {
          event.stopPropagation()
          onRestore(page.id)
        }}
        className="cursor-pointer shrink-0 rounded p-1 text-gray-400 opacity-0 max-md:opacity-100 hover:bg-gray-200 hover:text-gray-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
      >
        <Icon d={ICONS.restore} />
      </button>
      <button
        type="button"
        aria-label={
          confirming
            ? `Confirmar eliminación definitiva de ${page.title || 'Sin título'}`
            : `Eliminar definitivamente ${page.title || 'Sin título'}`
        }
        title={confirming ? 'Clic de nuevo para eliminar definitivamente' : 'Eliminar definitivamente'}
        onClick={(event) => {
          event.stopPropagation()
          if (confirming) {
            setConfirming(false)
            onDeleteForever(page.id)
          } else {
            setConfirming(true)
          }
        }}
        onMouseLeave={() => setConfirming(false)}
        className={`cursor-pointer shrink-0 rounded p-1 transition-colors ${
          confirming
            ? '!bg-red-600 !text-white !opacity-100'
            : 'text-gray-400 opacity-0 max-md:opacity-100 hover:bg-gray-200 hover:text-gray-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200'
        }`}
      >
        <Icon d={ICONS.trash} />
      </button>
    </div>
  )
}

// handle de arrastre en el borde derecho de la sidebar (mismo patrón que
// ColumnResizeHandle en DatabaseView.jsx): sigue el mouse con estado local
// y recién persiste a localStorage al soltar.
function SidebarResizeHandle({ width, onResize, onCommit }) {
  const dragRef = useRef(null)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Ajustar ancho de la sidebar"
      onMouseDown={(event) => {
        event.preventDefault()
        dragRef.current = { startX: event.clientX, startWidth: width }
        const onMove = (moveEvent) => {
          const delta = moveEvent.clientX - dragRef.current.startX
          onResize(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragRef.current.startWidth + delta)))
        }
        const onUp = (upEvent) => {
          const delta = upEvent.clientX - dragRef.current.startX
          onCommit(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragRef.current.startWidth + delta)))
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }}
      className="group absolute right-[-3px] top-0 z-10 h-full w-1.5 shrink-0 cursor-col-resize select-none"
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-blue-400/50 group-active:bg-blue-400/80" />
    </div>
  )
}

export default function Sidebar({
  pages,
  trashedRoots,
  currentId,
  onSelect,
  onCreate,
  onCreateDatabase,
  onRename,
  onDuplicate,
  onTrash,
  onRestore,
  onDeleteForever,
  onEmptyTrash,
  onMove,
  onCollapse,
  onSearch,
  onReload,
  onOpenHome,
  homeActive,
  onOpenCalendar,
  calendarActive,
  onOpenRecordings,
  recordingsActive,
  onOpenChat,
  chatActive,
  theme,
  onCycleTheme,
  mobile = false,
  open = true,
  pinned = false,
  onTogglePin,
}) {
  // este componente se monta con sidebarOpen (ver App.jsx: `{sidebarMounted
  // && <Sidebar/>}`) — sin el truco de "entered" aparecía de un salto en vez
  // de deslizar. Mismo patrón que PagePeek.jsx: arranca no-entered y en el
  // siguiente frame pasa a entered, así el navegador sí dispara la
  // transición de entrada. En desktop, App.jsx mantiene el componente
  // montado un rato más después de pedir el cierre (mismos 200ms que
  // duration-200 acá abajo) para que la salida también se vea deslizar en
  // vez de desaparecer de golpe — por eso la clase de translate no mira
  // `entered` solo, sino `entered && open`: una vez montado, sigue el prop
  // `open` en cada re-render (App.jsx lo baja a false ANTES de desmontar).
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  const isOpenVisual = entered && open

  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    return stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH
  })
  const [expanded, setExpanded] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'))
    } catch {
      return new Set()
    }
  })
  const [dragId, setDragId] = useState(null)
  const [dropHint, setDropHint] = useState(null)
  const [showTrash, setShowTrash] = useState(false)
  const [confirmingEmpty, setConfirmingEmpty] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  // Android no tiene menú nativo (a diferencia de Windows, donde "Buscar
  // actualizaciones" vive en el menú de la ventana — ver checkForUpdatesManually
  // en electron/main.js) — sin Play Store tampoco hay auto-update nativo, así
  // que esto compara contra el último release de GitHub a mano y abre esa
  // página para que el usuario baje el .apk nuevo (mismo firmante: se
  // instala encima sin desinstalar).
  const [updateStatus, setUpdateStatus] = useState('idle') // idle | checking | latest | error
  // Desktop: cuando electron-updater ya bajó una actualización en segundo
  // plano (ver setupAutoUpdater en electron/main.js), antes la ÚNICA forma de
  // instalarla era clickear la notificación nativa de Windows — si se
  // perdía, no quedaba ningún botón en la app para completarla, y bajar el
  // instalador de nuevo a mano chocaba con que la X solo esconde la app a la
  // bandeja (sigue "abierta" para el instalador). Este botón evita depender
  // del toast: llama al mismo autoUpdater.quitAndInstall() que sí cierra la
  // app de verdad antes de lanzar el instalador.
  const [updateReadyVersion, setUpdateReadyVersion] = useState(null)
  const [reloading, setReloading] = useState(false)

  // el mínimo de 400ms no es decorativo: sin él, una recarga que tarda 60ms
  // no alcanza a mostrar el spinner y el botón parece no haber hecho nada.
  const handleReload = async () => {
    if (reloading) return
    setReloading(true)
    try {
      await Promise.all([onReload?.(), new Promise((resolve) => setTimeout(resolve, 400))])
    } catch (err) {
      console.error('No se pudo recargar el contenido:', err)
    } finally {
      setReloading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    api.getAppVersion?.().then((v) => {
      if (!cancelled) setAppVersion(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isDesktop || !api.onUpdateReady) return undefined
    return api.onUpdateReady((info) => setUpdateReadyVersion(info.version))
  }, [])

  const checkForUpdates = async () => {
    setUpdateStatus('checking')
    try {
      const res = await fetch('https://api.github.com/repos/edwardgko/flashlab-releases/releases/latest')
      if (!res.ok) throw new Error(`GitHub respondió ${res.status}`)
      const data = await res.json()
      const latest = (data.tag_name || '').replace(/^v/, '')
      if (latest && latest !== appVersion) {
        await Browser.open({ url: data.html_url })
        setUpdateStatus('idle')
      } else {
        setUpdateStatus('latest')
        setTimeout(() => setUpdateStatus('idle'), 3000)
      }
    } catch (err) {
      console.error('Error buscando actualizaciones:', err)
      setUpdateStatus('error')
      setTimeout(() => setUpdateStatus('idle'), 3000)
    }
  }

  const session = useAuthSession()
  const myId = session?.user?.id ?? null

  const [chatUnread, setChatUnread] = useState(0)
  useEffect(() => {
    // el chat es Supabase puro (nada de Electron) — el candado real es
    // tener sesión, no la plataforma. Antes decía `!isDesktop || !myId`
    // porque fuera de Electron era la maqueta sin backend; ya no.
    if (!myId) return
    let cancelled = false
    // el badge/notificación de escritorio cubre 1:1 Y grupos (mismo botón
    // "Chat" del sidebar) — se llevan totales separados porque cada fuente
    // se refresca por su cuenta (llega mensaje nuevo de grupo no debería
    // esperar a que también responda el RPC de 1:1, y viceversa).
    let dmTotal = 0
    let groupTotal = 0
    const applyTotal = () => {
      if (cancelled) return
      const total = dmTotal + groupTotal
      setChatUnread(total)
      updateTaskbarBadge(total)
    }
    const refreshDm = () =>
      getUnreadCounts().then((counts) => {
        if (cancelled) return
        dmTotal = counts.reduce((sum, c) => sum + Number(c.unread_count), 0)
        applyTotal()
      })
    const refreshGroups = () =>
      getGroupUnreadCounts().then((counts) => {
        if (cancelled) return
        groupTotal = counts.reduce((sum, c) => sum + Number(c.unread_count), 0)
        applyTotal()
      })
    const refresh = () => Promise.all([refreshDm(), refreshGroups()])
    refresh()

    // dedupe entre el aviso en vivo (onInsert) y el catch-up (onSubscribed,
    // ver abajo) — los dos pueden terminar notificando el MISMO mensaje si
    // se solapan justo al reconectar. Más simple que perseguir el timestamp
    // exacto; el Set se resetea solo si crece demasiado, no hace falta que
    // sobreviva más que la sesión de este efecto.
    const notifiedIds = new Set()
    const notifyOnce = (id, title, body, chatKey = null) => {
      if (notifiedIds.has(id)) return
      if (notifiedIds.size > 200) notifiedIds.clear()
      notifiedIds.add(id)
      notifyNewMessage(title, body, chatKey, id)
    }

    // el aviso en vivo (postgres_changes INSERT) solo dispara si llega
    // justo con el canal arriba — cualquier hueco (reconexión, ventana sin
    // foco con la red suspendida, ver [[notion-clone-chat-realtime-gap]]) lo
    // pierde en silencio sin avisar nada. `Since` marca hasta dónde ya se
    // avisó, para que el catch-up de más abajo sepa qué le falta traer.
    let dmSince = new Date().toISOString()
    const notifyDmRow = (row) => {
      if (row.sender_id === myId) return
      if (row.created_at > dmSince) dmSince = row.created_at
      listConversationPartners().then((partners) => {
        const email = partners.find((p) => p.id === row.sender_id)?.email ?? 'Alguien'
        notifyOnce(row.id, email, previewForMessage(row), `dm-${row.sender_id}`)
      })
    }
    const catchUpDm = () => {
      refreshDm()
      listIncomingSince(dmSince)
        .then((rows) => {
          if (!cancelled) rows.forEach(notifyDmRow)
        })
        .catch(() => {})
    }

    let groupSince = new Date().toISOString()
    const notifyGroupRow = (row) => {
      if (row.sender_id === myId) return
      if (row.created_at > groupSince) groupSince = row.created_at
      listMyGroups().then((groups) => {
        const name = groups.find((g) => g.id === row.conversation_id)?.name ?? 'Grupo'
        listGroupMembers(row.conversation_id).then((members) => {
          const email = members.find((m) => m.user_id === row.sender_id)?.email ?? 'Alguien'
          notifyOnce(row.id, name, `${email}: ${previewForMessage(row)}`, `group-${row.conversation_id}`)
        })
      })
    }
    const catchUpGroups = () => {
      refreshGroups()
      listGroupIncomingSince(groupSince)
        .then((rows) => {
          if (!cancelled) rows.forEach(notifyGroupRow)
        })
        .catch(() => {})
    }

    const unsubscribeInbox = subscribeToInbox(
      myId,
      (row) => {
        refreshDm()
        notifyDmRow(row)
      },
      'sidebar',
      catchUpDm
    )
    const unsubscribeGroups = subscribeToAnyGroupMessage((row) => {
      refreshGroups()
      if (row.sender_id === myId) return
      notifyGroupRow(row)
    }, catchUpGroups)

    // Red de seguridad del "a veces las notificaciones caen y a veces no".
    // El catch-up de arriba solo corre cuando el canal avisa SUBSCRIBED, y
    // ese evento no siempre llega: un WebSocket que se muere sin cerrar
    // (suspensión de la PC, wifi que cambia, Android que congela la app en
    // segundo plano) deja el canal "conectado" del lado del cliente, mudo
    // para siempre y sin volver a emitir SUBSCRIBED al despertar. Ese es
    // exactamente el modo de fallar que se reportó, y ninguna cantidad de
    // arreglos DENTRO de Realtime lo cubre: hace falta una fuente que no
    // dependa del socket.
    // Los tres disparadores cubren los tres momentos en que puede haber un
    // hueco: cada tanto (por si el socket murió callado), al volver el foco
    // a la ventana, y al recuperar la red.
    const catchUpAll = () => {
      if (cancelled) return
      catchUpDm()
      catchUpGroups()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') catchUpAll()
    }
    const interval = setInterval(catchUpAll, CHAT_CATCHUP_INTERVAL_MS)
    window.addEventListener('focus', catchUpAll)
    window.addEventListener('online', catchUpAll)
    document.addEventListener('visibilitychange', onVisible)

    window.addEventListener('flashlab:chat-read', refresh)
    return () => {
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('focus', catchUpAll)
      window.removeEventListener('online', catchUpAll)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribeInbox()
      unsubscribeGroups()
      window.removeEventListener('flashlab:chat-read', refresh)
    }
  }, [myId])

  const pageMap = new Map(pages.map((p) => [p.id, p]))
  const byParent = new Map()
  for (const p of pages) {
    // el padre real puede no estar cargado (Fase C: una página compartida
    // directamente, cuyo ancestro no es visible para mí) — en ese caso se
    // muestra como raíz igual, si no quedaría huérfana y nunca se vería.
    const parentVisible = p.parentId != null && pageMap.has(p.parentId)
    const key = parentVisible ? p.parentId : null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(p)
  }
  byParent.forEach((arr) => arr.sort((a, b) => a.order - b.order))
  const allRoots = byParent.get(null) ?? []
  // separar "mías" de "compartidas conmigo" necesita sesión real, no
  // Electron — con Supabase real en web, ownerId también es real ahí.
  const isMine = (p) => !p.ownerId || !myId || p.ownerId === myId
  const roots = myId ? allRoots.filter(isMine) : allRoots
  const sharedRoots = myId ? allRoots.filter((p) => !isMine(p)) : []

  const persistExpanded = (next) => {
    setExpanded(next)
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]))
  }
  const toggleExpand = (id) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    persistExpanded(next)
  }
  const expandNode = (id) => {
    if (expanded.has(id)) return
    const next = new Set(expanded)
    next.add(id)
    persistExpanded(next)
  }

  // al navegar a una página profunda, expandir su cadena de ancestros
  useEffect(() => {
    let cursor = pageMap.get(currentId)
    const toExpand = []
    while (cursor && cursor.parentId != null) {
      // no expandir bases de datos acá: siempre quedan compactadas (ver isExpanded en TreeNode)
      if (!expanded.has(cursor.parentId) && !pageMap.get(cursor.parentId)?.isDatabase) toExpand.push(cursor.parentId)
      cursor = pageMap.get(cursor.parentId)
    }
    if (toExpand.length > 0) {
      const next = new Set(expanded)
      toExpand.forEach((id) => next.add(id))
      persistExpanded(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, pages])

  const ctx = {
    byParent,
    currentId,
    expanded,
    dropHint,
    toggleExpand,
    expandNode,
    onSelect,
    onRename,
    onDuplicate,
    onTrash,
    onCreateChild: onCreate,
    onDragStart: (event, id) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', id)
      // la foto por defecto de una fila del árbol sale transparente y con
      // los botones de hover a medio pintar — mejor la miniatura propia
      setDragPreview(event, event.currentTarget)
      setDragId(id)
    },
    onDragEnd: () => {
      setDragId(null)
      setDropHint(null)
    },
    onDragOverItem: (event, page) => {
      event.preventDefault()
      event.stopPropagation()
      if (!dragId || dragId === page.id || isDescendantLocal(pageMap, dragId, page.id)) {
        setDropHint(null)
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      const y = event.clientY - rect.top
      const pos = y < rect.height / 3 ? 'before' : y > (rect.height * 2) / 3 ? 'after' : 'inside'
      setDropHint({ id: page.id, pos })
    },
    onDragLeaveItem: (event) => {
      if (event.currentTarget === event.target) setDropHint(null)
    },
    onDropItem: (event, page) => {
      event.preventDefault()
      event.stopPropagation()
      const id = dragId ?? event.dataTransfer.getData('text/plain')
      const hint = dropHint
      setDragId(null)
      setDropHint(null)
      if (!id || !hint || hint.id !== page.id) return
      if (id === page.id || isDescendantLocal(pageMap, id, page.id)) return
      if (hint.pos === 'inside') {
        const kids = (byParent.get(page.id) ?? []).filter((p) => p.id !== id)
        expandNode(page.id)
        onMove(id, page.id, kids.length)
      } else {
        const parentKey = page.parentId ?? null
        const siblings = (byParent.get(parentKey) ?? []).filter((p) => p.id !== id)
        const base = siblings.findIndex((p) => p.id === page.id)
        onMove(id, parentKey, hint.pos === 'before' ? base : base + 1)
      }
    },
  }

  return (
    <aside
      // el ancho ajustable (`width`, con su drag-to-resize) solo aplica en
      // desktop — un style inline le gana a la clase w-full de mobile
      // (ver abajo) y le rompería el ancho completo si se pusiera siempre.
      style={
        mobile
          ? undefined
          : pinned
          ? { width, marginLeft: isOpenVisual ? 0 : -width }
          : { width }
      }
      className={
        mobile
          ? // cajón superpuesto, no panel en el flujo — por eso fixed en vez
            // de shrink-0/absolute. Ancho completo de la pantalla
            `fixed inset-0 z-30 flex w-full flex-col border-r border-gray-200 bg-gray-50 shadow-2xl transition-transform duration-200 ease-out dark:border-neutral-800 dark:bg-[#202020] ${
              isOpenVisual ? 'translate-x-0' : '-translate-x-full'
            }`
          : pinned
          ? // modo fijo (pinned): panel acoplado en el flujo del layout que no
            // se superpone sobre el contenido ni usa fondo oscuro
            `relative z-20 flex shrink-0 flex-col border-r border-gray-200 bg-gray-50 transition-[margin-left] duration-200 ease-out dark:border-neutral-800 dark:bg-[#202020]`
          : // modo flotante (unpinned): se superpone sobre el contenido con
            // fondo oscuro (SidebarBackdrop) y sombra
            `absolute inset-y-0 left-0 z-30 flex flex-col border-r border-gray-200 bg-gray-50 shadow-2xl transition-transform duration-200 ease-out dark:border-neutral-800 dark:bg-[#202020] ${
              isOpenVisual ? 'translate-x-0' : '-translate-x-full'
            }`
      }
    >
      <div className="flex items-center justify-between py-3 pl-4 pr-2">
        <span className="flex items-baseline gap-1.5 text-sm font-semibold text-gray-700 dark:text-neutral-200">
          FlashLab
          {appVersion && <span className="text-[10px] font-normal text-gray-400 dark:text-neutral-500">v{appVersion}</span>}
          {IS_CAPACITOR && (
            // antes era un "↻" suelto en gris de 10px — casi invisible y un
            // target de toque diminuto en un celular. Ahora pill con label,
            // ~28px de alto (mínimo cómodo para el dedo) y `active:` en vez
            // de depender de `hover:` (que en touch no existe).
            <button
              type="button"
              onClick={checkForUpdates}
              disabled={updateStatus === 'checking'}
              title="Buscar actualizaciones"
              className="flex h-7 items-center gap-1 rounded-full bg-gray-200 px-2.5 text-xs font-medium text-gray-600 active:bg-gray-300 disabled:opacity-50 dark:bg-neutral-700 dark:text-neutral-200 dark:active:bg-neutral-600"
            >
              <span className={updateStatus === 'checking' ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
              {updateStatus === 'checking' && 'Buscando…'}
              {updateStatus === 'latest' && 'Al día'}
              {updateStatus === 'error' && 'Error'}
              {updateStatus === 'idle' && 'Actualizar'}
            </button>
          )}
          {isDesktop && updateReadyVersion && (
            <button
              type="button"
              onClick={() => api.installUpdate?.()}
              title={`Instalar FlashLab ${updateReadyVersion} y reiniciar`}
              className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-blue-700"
            >
              Actualizar y reiniciar
            </button>
          )}
        </span>
        <div className="flex items-center gap-1">
          {!mobile && (
            <button
              type="button"
              aria-label={pinned ? 'Desanclar barra lateral' : 'Fijar barra lateral'}
              title={pinned ? 'Desanclar barra lateral (modo flotante)' : 'Fijar barra lateral (dejar fija)'}
              onClick={onTogglePin}
              className={`cursor-pointer rounded-md p-1.5 transition-colors ${
                pinned
                  ? 'bg-blue-50 text-blue-600 shadow-xs hover:bg-blue-100 hover:text-blue-700 dark:bg-blue-950/60 dark:text-blue-400 dark:hover:bg-blue-900/80 dark:hover:text-blue-300'
                  : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
              }`}
            >
              <Icon
                d={ICONS.pin}
                className={`h-4 w-4 transition-transform duration-150 ${pinned ? 'rotate-0' : '-rotate-45'}`}
              />
            </button>
          )}
          <button
            type="button"
            aria-label="Ocultar sidebar"
            title="Ocultar sidebar"
            onClick={onCollapse}
            className="cursor-pointer rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            <Icon d={mobile ? ICONS.x : ICONS.chevronsLeft} className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="px-2">
        <button
          type="button"
          onClick={onSearch}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <Icon d={ICONS.search} />
          Buscar
          <span className="ml-auto text-xs text-gray-400 dark:text-neutral-600">Ctrl+P</span>
        </button>
        {/* Recargar: vuelve a traer el árbol de páginas Y el contenido de la
            vista abierta. La sincronización automática (Realtime) cubre lo
            normal, pero depende de un WebSocket que puede caerse en silencio
            — este botón es la salida manual garantizada, sin cerrar y volver
            a abrir la app. */}
        <button
          type="button"
          onClick={handleReload}
          disabled={reloading}
          title="Volver a traer las páginas y el contenido desde el servidor"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-default disabled:opacity-60 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          {/* el tamaño va SIEMPRE en lo que se pasa: `className` de Icon es un
              parámetro por default, no se suma al que manda el caller — sin
              las clases de tamaño acá, el SVG se estira a llenar el sidebar */}
          <Icon d={ICONS.refresh} className={`h-3.5 w-3.5 shrink-0 ${reloading ? 'animate-spin' : ''}`} />
          {reloading ? 'Recargando…' : 'Recargar'}
        </button>
        <button
          type="button"
          onClick={onOpenHome}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
            homeActive
              ? 'bg-gray-200 text-gray-700 dark:bg-neutral-700 dark:text-neutral-200'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
          }`}
        >
          <Icon d={ICONS.home} />
          Inicio
        </button>
        <button
          type="button"
          onClick={onOpenCalendar}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
            calendarActive
              ? 'bg-gray-200 text-gray-700 dark:bg-neutral-700 dark:text-neutral-200'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
          }`}
        >
          <Icon d={ICONS.calendar} />
          Calendario
        </button>
        <button
          type="button"
          onClick={onOpenRecordings}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
            recordingsActive
              ? 'bg-gray-200 text-gray-700 dark:bg-neutral-700 dark:text-neutral-200'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
          }`}
        >
          <Icon d={ICONS.video} />
          Grabaciones
        </button>
        <button
          type="button"
          onClick={onOpenChat}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
            chatActive
              ? 'bg-gray-200 text-gray-700 dark:bg-neutral-700 dark:text-neutral-200'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
          }`}
        >
          <Icon d={ICONS.chat} />
          Chat
          {chatUnread > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {chatUnread}
            </span>
          )}
        </button>
      </div>
      <nav
        className={`min-h-0 flex-1 overflow-y-auto px-2 pb-2 ${
          dropHint?.root ? 'bg-blue-50/60 dark:bg-blue-950/30' : ''
        }`}
        onDragOver={(event) => {
          event.preventDefault()
          if (dragId) setDropHint({ root: true })
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropHint(null)
        }}
        onDrop={(event) => {
          event.preventDefault()
          const id = dragId ?? event.dataTransfer.getData('text/plain')
          setDragId(null)
          setDropHint(null)
          if (id) onMove(id, null, roots.filter((p) => p.id !== id).length)
        }}
      >
        {roots.map((page) => (
          <TreeNode key={page.id} page={page} depth={0} ctx={ctx} />
        ))}
        {sharedRoots.length > 0 && (
          <>
            <p className="mt-3 px-2 pb-1 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-600">
              Compartidas conmigo
            </p>
            {sharedRoots.map((page) => (
              <TreeNode key={page.id} page={page} depth={0} ctx={ctx} />
            ))}
          </>
        )}
      </nav>
      <div className="border-t border-gray-200 p-2 dark:border-neutral-800">
        <button
          type="button"
          aria-label={showTrash ? 'Ocultar papelera' : 'Mostrar papelera'}
          title={showTrash ? 'Ocultar papelera' : 'Mostrar papelera'}
          onClick={() => setShowTrash((s) => !s)}
          className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <Icon d={ICONS.trash} />
          Papelera {trashedRoots.length > 0 ? `(${trashedRoots.length})` : ''}
        </button>
        {showTrash && (
          <div className="mt-1 max-h-48 overflow-y-auto">
            {trashedRoots.length === 0 && (
              <p className="px-2 py-1 text-xs italic text-gray-400 dark:text-neutral-500">La papelera está vacía</p>
            )}
            {trashedRoots.map((page) => (
              <TrashRow
                key={page.id}
                page={page}
                onRestore={onRestore}
                onDeleteForever={onDeleteForever}
              />
            ))}
            {trashedRoots.length > 0 && (
              <button
                type="button"
                title={confirmingEmpty ? 'Clic de nuevo para vaciar definitivamente' : 'Vaciar papelera'}
                onClick={() => {
                  if (confirmingEmpty) {
                    setConfirmingEmpty(false)
                    onEmptyTrash()
                  } else {
                    setConfirmingEmpty(true)
                  }
                }}
                onMouseLeave={() => setConfirmingEmpty(false)}
                className={`cursor-pointer mt-1 w-full rounded-md px-2 py-1 text-left text-xs font-medium transition-colors ${
                  confirmingEmpty
                    ? '!bg-red-600 !text-white'
                    : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
                }`}
              >
                {confirmingEmpty ? '¿Vaciar definitivamente?' : 'Vaciar papelera'}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="border-t border-gray-200 p-2 dark:border-neutral-800">
        <button
          type="button"
          aria-label="Nueva página"
          title="Nueva página"
          onClick={() => onCreate(null)}
          className="cursor-pointer w-full rounded-md px-2 py-1.5 text-left text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          + Nueva página
        </button>
        <button
          type="button"
          aria-label="Nueva base de datos"
          title="Nueva base de datos"
          onClick={() => onCreateDatabase(null)}
          className="cursor-pointer flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <Icon d={ICONS.database} className="h-3.5 w-3.5" />
          Nueva base de datos
        </button>
      </div>
      <div className="border-t border-gray-200 p-2 dark:border-neutral-800">
        <AccountRow theme={theme} onCycleTheme={onCycleTheme} />
      </div>
      {!mobile && (
        <SidebarResizeHandle
          width={width}
          onResize={setWidth}
          onCommit={(next) => {
            setWidth(next)
            localStorage.setItem(WIDTH_KEY, String(next))
          }}
        />
      )}
    </aside>
  )
}
