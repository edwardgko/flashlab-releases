import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useAuthSession, IS_CAPACITOR } from '../lib/supabaseClient.js'
import {
  deleteConversationForEveryone,
  deleteConversationForMe,
  deleteCustomWallpaper,
  deleteMessageForEveryone,
  editMessage,
  findUserIdByEmail,
  getPartnerLastRead,
  getReadReceiptsEnabled,
  getUnreadCounts,
  hideMessageForMe,
  listConversationPartners,
  listCustomWallpapers,
  listMessages,
  listReactionsForMessages,
  markConversationRead,
  MESSAGES_PAGE_SIZE,
  sendAttachment,
  sendMessage,
  setMyReadReceiptsEnabled,
  subscribeToConversation,
  subscribeToInbox,
  subscribeToPartnerRead,
  subscribeToReactions,
  subscribeToReadReceiptsSetting,
  toggleReaction,
  uploadChatWallpaper,
} from '../lib/chat.js'
import { chatBackgroundStyle, wallpaperStorageKey } from '../lib/chatWallpaper.js'
import { compressImageForUpload } from '../lib/imageCompress.js'
import {
  addGroupMember,
  createGroup,
  deleteGroupMessageForEveryone,
  editGroupMessage,
  hideGroupMessageForMe,
  leaveGroup,
  listGroupMembers,
  listGroupMessages,
  listGroupReactionsForMessages,
  listGroupReads,
  listMyGroups,
  markGroupRead,
  removeGroupMember,
  sendGroupAttachment,
  sendGroupMessage,
  subscribeToGroup,
  subscribeToGroupReactions,
  subscribeToGroupReads,
  toggleGroupReaction,
  updateGroupIcon,
  uploadGroupIconImage,
} from '../lib/groupChat.js'
import { EMOJI_CATEGORIES } from '../lib/emojiData.js'
import { isImageIcon } from '../lib/icon.js'
import { addCustomIcon, deleteCustomIcon, getCustomIcons } from '../lib/customIcons.js'
import { processPendingDriveShares } from '../lib/driveShareQueue.js'
import { useIsMobile } from '../lib/useIsMobile.js'
import { forwardMessage } from '../lib/forwardMessage.js'
import { driveFileIdFromStored, repairVideoAttachment, resolveDriveDisplayUrl } from '../lib/driveAttachmentUpload.js'
import { getDriveMediaProxyUrl } from '../lib/webDrive.js'
import { api, isDesktop } from '../lib/api.js'
import { cancelUpload, enqueueUpload, getSnapshot as getUploadsSnapshot, subscribe as subscribeUploads } from '../lib/backgroundUploads.js'

// menús flotantes (clic derecho, reacciones) se posicionan en el punto
// exacto del clic — cerca de un borde de la ventana eso los cortaba (ver
// captura del bug: la barra de reacciones pegada a la derecha quedaba con
// la mitad afuera). Recalcula left/top después de montar, cuando ya se
// sabe el ancho/alto real del menú, y los corre para adentro si no entran.
// extraDeps: por si el contenido cambia de tamaño después del primer
// render (ej. ReactionPicker al expandirse al picker completo).
// reconciliación tras reconectar un canal Realtime: postgres_changes no
// reproduce eventos perdidos mientras el canal estuvo caído, así que en cada
// SUBSCRIBED (incluída la primera vez) se re-fetchea la página más reciente y
// se mergea por id con lo que ya había en pantalla (agrega lo nuevo, pisa
// ediciones que también se hayan perdido; no toca mensajes más viejos que ya
// salieron de esa página).
function mergeMessagesById(prev, fresh) {
  const map = new Map((prev ?? []).map((m) => [m.id, m]))
  for (const m of fresh) map.set(m.id, m)
  return Array.from(map.values()).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
}

function useClampedXY(ref, x, y, extraDeps = []) {
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.min(Math.max(margin, x), window.innerWidth - w - margin)
    const top = Math.min(Math.max(margin, y), window.innerHeight - h - margin)
    setPos({ left, top })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, x, y, ...extraDeps])
  return pos
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('es-AR', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function formatElapsed(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function Spinner({ className = 'h-4 w-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-90" />
    </svg>
  )
}

function formatDateDivider(ts) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (dayKey(d) === dayKey(today)) return 'Hoy'
  if (dayKey(d) === dayKey(yesterday)) return 'Ayer'
  return d.toLocaleDateString('es-AR')
}

function formatRelative(ts) {
  if (!ts) return ''
  const diffMs = Date.now() - new Date(ts).getTime()
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'ahora'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'ayer'
  if (days < 7) return `${days}d`
  return new Date(ts).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
}

// mismo tratamiento visual para los dos tipos de conversación — antes los
// grupos tenían ícono/imagen y los DM eran solo texto plano, se sentían
// como dos cosas distintas en vez de una sola lista de chat.
function ConversationAvatar({ item }) {
  if (item.type === 'group') {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 text-base dark:bg-neutral-700">
        {item.icon ? (
          isImageIcon(item.icon) ? <img src={item.icon} alt="" className="h-full w-full object-cover" /> : item.icon
        ) : (
          '👥'
        )}
      </span>
    )
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600 dark:bg-neutral-700 dark:text-neutral-300">
      {item.name.charAt(0).toUpperCase()}
    </span>
  )
}

// Un adjunto en Drive (attachment_drive_id presente) solo se puede leer
// inline si esta cuenta es la dueña — con el scope drive.file el token
// propio no tiene forma de bajar bytes de un archivo ajeno aunque esté
// compartido como reader (ver driveasset:// en electron/main.js). Recibido
// de otro remitente: no hay inline, se abre en Drive con el navegador
// (sesión de Google de cada uno). Adjuntos viejos (sin attachment_drive_id,
// todavía en Supabase Storage) no tienen este problema, esa URL sí son
// bytes directos.
// fondo sólido (no solo un borde transparente) — con un wallpaper claro y
// una foto de fondo detallada, texto flotando sin relleno quedaba casi
// invisible (ver captura del usuario: nombres de archivo ilegibles sobre
// las montañas). Mismo lenguaje visual que los menús flotantes del chat.
const ATTACHMENT_CARD_CLASS =
  'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm hover:underline dark:border-neutral-700 dark:bg-neutral-900'

function AttachmentContent({ msg, mine, onPreview, onDownload, onRepairVideo, repairing }) {
  const isImage = msg.attachment_mime?.startsWith('image/')
  const isVideo = msg.attachment_mime?.startsWith('video/')
  const isAudio = msg.attachment_mime?.startsWith('audio/')
  const isPdf = msg.attachment_mime === 'application/pdf'
  const isDrive = Boolean(msg.attachment_drive_id)
  // audio/video de Drive: SIEMPRE reproducible inline (propio o ajeno,
  // cualquier plataforma) vía drive-media-proxy — ver getDriveMediaProxyUrl
  // en webDrive.js. El resto (imagen/pdf/otros) sigue atado a driveasset://,
  // que solo existe en Electron y solo lee archivos propios (scope
  // drive.file) — para esos, cae a la tarjeta "Ver en Drive" de siempre.
  const usesMediaProxy = isDrive && (isVideo || isAudio)
  const inlineBlocked = isDrive && !usesMediaProxy && (!mine || !isDesktop)

  // drive-media-proxy necesita el JWT de sesión en la URL (<video>/<audio>
  // no pueden mandar el header Authorization) — se arma async, arranca en
  // null y el <video>/<audio> recién monta su src cuando está listo.
  const [proxySrc, setProxySrc] = useState(null)
  useEffect(() => {
    if (!usesMediaProxy) return undefined
    let cancelled = false
    getDriveMediaProxyUrl(msg.attachment_drive_id).then((url) => {
      if (!cancelled) setProxySrc(url)
    })
    return () => {
      cancelled = true
    }
  }, [usesMediaProxy, msg.attachment_drive_id])

  if (inlineBlocked) {
    const icon = isImage ? '🖼️' : isVideo ? '🎬' : isAudio ? '🎵' : isPdf ? '📄' : '📎'
    return (
      <button
        type="button"
        onClick={() => api.openExternal(msg.attachment_url)}
        className={ATTACHMENT_CARD_CLASS}
      >
        {icon} <span className="truncate">{msg.attachment_name || 'Archivo'}</span>
        <span className="shrink-0 text-xs opacity-60">Ver en Drive ↗</span>
      </button>
    )
  }

  const src = usesMediaProxy ? proxySrc : isDrive ? `driveasset://file/${msg.attachment_drive_id}` : msg.attachment_url
  const downloadArgs = { url: msg.attachment_url, name: msg.attachment_name, driveId: msg.attachment_drive_id, mine }

  if (isAudio) {
    if (usesMediaProxy && !src) {
      return <p className="text-xs text-gray-400 dark:text-neutral-500">Cargando audio…</p>
    }
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio src={src} controls className="h-10 w-64 max-w-full" />
  }
  if (isImage) {
    return (
      <button
        type="button"
        onClick={() => onPreview({ type: 'image', url: src, name: msg.attachment_name, download: downloadArgs })}
        className="block cursor-pointer"
      >
        <img src={src} alt={msg.attachment_name || ''} className="max-w-[240px] rounded-lg" />
      </button>
    )
  }
  if (isVideo) {
    if (usesMediaProxy && !src) {
      return <p className="text-xs text-gray-400 dark:text-neutral-500">Cargando video…</p>
    }
    // un .webm de MediaRecorder no declara su duración, así que el
    // reproductor no puede avanzar/retroceder por más que el servidor
    // responda bien los Range — hay que reemplazar el archivo (ver
    // repairVideoAttachment). Los videos subidos desde v0.1.26 en adelante
    // ya salen convertidos a .mp4, esto es solo para los de antes.
    const needsRepair = isDrive && mine && msg.attachment_mime === 'video/webm'
    return (
      <div className="flex flex-col gap-1">
        {/* key por mime: al reparar, fuerza volver a montar el <video> para
            que no reuse el stream viejo ya bufferizado */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video key={msg.attachment_mime} src={src} controls className="max-w-[260px] rounded-lg" />
        {needsRepair && (
          <button
            type="button"
            onClick={() => onRepairVideo?.(msg)}
            disabled={repairing}
            className="w-fit cursor-pointer rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          >
            {repairing ? 'Reparando…' : '⚠ No se puede avanzar — Reparar video'}
          </button>
        )}
      </div>
    )
  }
  // PDF: vista previa in-app (visor nativo de Chromium en un iframe, ver
  // electron/main.js webPreferences.plugins). El resto de los archivos
  // (docx, xlsx, zip, etc.) no tienen visor propio, así que van directo a
  // descarga — no tiene sentido "previsualizar" algo que no se puede mostrar.
  if (isPdf) {
    return (
      <button
        type="button"
        onClick={() => onPreview({ type: 'pdf', url: src, name: msg.attachment_name, download: downloadArgs })}
        className={ATTACHMENT_CARD_CLASS}
      >
        📄 <span className="truncate">{msg.attachment_name || 'Archivo'}</span>
      </button>
    )
  }
  return (
    <button type="button" onClick={() => onDownload(downloadArgs)} className={ATTACHMENT_CARD_CLASS}>
      📎 <span className="truncate">{msg.attachment_name || 'Archivo'}</span>
    </button>
  )
}

// check de "leído" (Fase 0015): ✓ = enviado, ✓✓ celeste = leído (por la
// otra persona en un DM, o por TODOS los demás miembros en un grupo — mismo
// criterio que WhatsApp). Solo se llama con `mine`, nunca en mensajes ajenos.
function MessageTicks({ read, tone = 'bubble' }) {
  const colorClass =
    tone === 'bubble'
      ? read
        ? 'text-sky-300'
        : 'text-blue-100'
      : read
        ? 'text-blue-500 dark:text-blue-400'
        : 'text-gray-400 dark:text-neutral-500'
  return (
    <span className={`ml-0.5 ${colorClass}`} aria-label={read ? 'Leído' : 'Enviado'} title={read ? 'Leído' : 'Enviado'}>
      {read ? '✓✓' : '✓'}
    </span>
  )
}

// senderLabel: solo se usa en grupos, para saber quién mandó cada mensaje
// que no es propio (en 1:1 no hace falta, ya se sabe quién es el otro)
// los mensajes con deleted_at nunca llegan hasta acá — se filtran antes de
// renderizar (ver visibleMessages más abajo) para que "eliminar para todos"
// no deje ningún rastro visible de que hubo un mensaje ahí, ni para quien lo
// borró ni para el resto: privacidad primero, por sobre la convención de
// WhatsApp de mostrar un placeholder "se eliminó este mensaje".
function MessageBubble({
  msg,
  mine,
  read,
  senderLabel,
  onContextMenu,
  onPreviewAttachment,
  onDownloadAttachment,
  onRepairVideo,
  repairing,
  reactionsForMsg,
  myId,
  onToggleReaction,
}) {
  const label = !mine && senderLabel && (
    <p className="mb-0.5 px-1 text-[11px] font-medium text-gray-400 dark:text-neutral-500">{senderLabel}</p>
  )
  const pills = <ReactionPills list={reactionsForMsg} myId={myId} onToggle={onToggleReaction} />

  if (msg.message_type === 'attachment') {
    return (
      <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`} onContextMenu={(e) => onContextMenu(e, msg)}>
        {label}
        {/* max-w: las burbujas de texto ya se limitaban al 70%, pero las de
            adjunto no tenían tope y un nombre de archivo largo hacía la
            tarjeta más ancha que la pantalla (se salía por el costado en
            mobile). min-w-0 es lo que después habilita el truncate. */}
        <div
          className={`min-w-0 max-w-[85%] ${
            mine ? 'text-blue-700 dark:text-blue-300' : 'text-gray-800 dark:text-neutral-100'
          }`}
        >
          <AttachmentContent
            msg={msg}
            mine={mine}
            onPreview={onPreviewAttachment}
            onDownload={onDownloadAttachment}
            onRepairVideo={onRepairVideo}
            repairing={repairing}
          />
          <p className="mt-0.5 text-[10px] text-gray-400 dark:text-neutral-500">
            {formatTime(msg.created_at)}
            {mine && <MessageTicks read={read} tone="neutral" />}
          </p>
          {pills}
        </div>
      </div>
    )
  }
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`} onContextMenu={(e) => onContextMenu(e, msg)}>
      {label}
      <div
        className={`max-w-[70%] rounded-lg px-3 py-1.5 text-sm ${
          mine ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800 dark:bg-neutral-800 dark:text-neutral-100'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">
          {msg.content}
          {/* flota a la derecha del final del texto: si entra en la última
              línea queda a la par, si no hay lugar baja sola a la línea
              siguiente — mismo truco que usa WhatsApp Web */}
          {/* sin etiqueta "editado": una edición no debe dejar rastro de que
              el contenido cambió — mismo criterio de privacidad que con
              "eliminar para todos" arriba */}
          <span
            className={`float-right ml-2 mt-1 whitespace-nowrap text-[10px] ${
              mine ? 'text-blue-100' : 'text-gray-400 dark:text-neutral-500'
            }`}
          >
            {formatTime(msg.created_at)}
            {mine && <MessageTicks read={read} tone="bubble" />}
          </span>
        </p>
      </div>
      {pills}
    </div>
  )
}

// burbuja de un adjunto subiendo en segundo plano (ver startBackgroundUpload
// en ChatView): mismo lugar que ocuparía el mensaje real una vez que
// termine, con el thumbnail atenuado + % de subida encima y su propio ✕
// para cancelar solo esa subida (no bloquea el resto del chat).
function PendingUploadBubble({ upload, onCancel }) {
  const isImage = upload.file.type.startsWith('image/')
  const isVideo = upload.file.type.startsWith('video/')
  const isAudio = upload.file.type.startsWith('audio/')
  return (
    <div className="flex flex-col items-end">
      <div className="relative">
        {isImage ? (
          <img src={upload.previewUrl} alt="" className="max-w-[240px] rounded-lg opacity-50" />
        ) : isVideo ? (
          <video src={upload.previewUrl} className="max-w-[260px] rounded-lg opacity-50" />
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-current/20 px-3 py-2 text-sm text-blue-700 opacity-50 dark:text-blue-300">
            {isAudio ? '🎤' : '📎'} <span className="truncate">{isAudio ? 'Audio' : upload.file.name}</span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-xs font-semibold text-white">
            {upload.progress}%
          </div>
        </div>
        <button
          type="button"
          aria-label="Cancelar envío"
          title="Cancelar envío"
          onClick={onCancel}
          className="absolute -right-2 -top-2 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-gray-700 text-[10px] text-white hover:bg-gray-900"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

// menú de clic derecho — clic afuera cierra (mismo patrón que el resto del
// chat: sticker/ícono de grupo). Electron no muestra su menú nativo acá
// (solo lo hace sobre texto seleccionable/editable), así que el clic derecho
// queda libre para esto.
// mismos 6 de la barra rápida de WhatsApp — el "+" abre el picker completo
// (EmojiGrid, mismo de Stickers) para cualquier otro emoji. Vive arriba de
// todo el menú (no un ítem "Reaccionar" que abre otro popup aparte) — mismo
// lugar que WhatsApp Desktop.
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

function MessageActionsMenu({
  msg,
  x,
  y,
  mine,
  onEdit,
  onHideForMe,
  onDeleteForEveryone,
  onReact,
  onForward,
  onCopy,
  onSaveAs,
  onOpenWith,
  onClose,
}) {
  const [emojiExpanded, setEmojiExpanded] = useState(false)
  const ref = useRef(null)
  const pos = useClampedXY(ref, x, y, [emojiExpanded])
  useEffect(() => {
    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [onClose])

  const isAttachment = msg.message_type === 'attachment'
  const itemClass =
    'block w-full cursor-pointer px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-neutral-200 dark:hover:bg-neutral-800'

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      className="z-40 min-w-[160px] rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      {emojiExpanded ? (
        <div className="w-64">
          <EmojiGrid onPick={onReact} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-0.5 border-b border-gray-100 p-1 dark:border-neutral-800">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact(emoji)}
                className="cursor-pointer rounded-full p-1.5 text-lg hover:bg-gray-100 dark:hover:bg-neutral-800"
              >
                {emoji}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setEmojiExpanded(true)}
              title="Más emojis"
              className="cursor-pointer rounded-full p-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-neutral-800"
            >
              +
            </button>
          </div>
          <button type="button" onClick={onForward} className={itemClass}>
            Reenviar
          </button>
          <button type="button" onClick={onCopy} className={itemClass}>
            Copiar
          </button>
          {isAttachment && (
            <button type="button" onClick={onSaveAs} className={itemClass}>
              Guardar como
            </button>
          )}
          {isAttachment && (
            <button type="button" onClick={onOpenWith} className={itemClass}>
              Abrir con
            </button>
          )}
          {mine && msg.message_type === 'text' && (
            <button type="button" onClick={onEdit} className={itemClass}>
              Editar
            </button>
          )}
          <button type="button" onClick={onHideForMe} className={itemClass}>
            Eliminar para mí
          </button>
          {mine && (
            <button
              type="button"
              onClick={onDeleteForEveryone}
              className="block w-full cursor-pointer px-3 py-1.5 text-left text-red-600 hover:bg-gray-100 dark:text-red-400 dark:hover:bg-neutral-800"
            >
              Eliminar para todos
            </button>
          )}
        </>
      )}
    </div>
  )
}

// picker de "reenviar a": mismo listado que la barra lateral (DMs +
// grupos), sin buscador — no vale la pena para una lista que ya es corta.
function ForwardPicker({ partners, groups, onPick, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [onClose])

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={ref}
        className="flex max-h-[70vh] w-full max-w-sm flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-neutral-700">
          <p className="text-sm font-semibold text-gray-800 dark:text-neutral-100">Reenviar a…</p>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-full p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto py-1">
          {!partners.length && !groups.length && (
            <p className="px-4 py-3 text-sm text-gray-400">No tenés conversaciones todavía.</p>
          )}
          {groups.map((g) => (
            <button
              key={`group-${g.id}`}
              type="button"
              onClick={() => onPick({ kind: 'group', conversationId: g.id })}
              className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              <span>{isImageIcon(g.icon) ? '👥' : g.icon || '👥'}</span>
              <span className="truncate">{g.name}</span>
            </button>
          ))}
          {partners.map((p) => (
            <button
              key={`dm-${p.id}`}
              type="button"
              onClick={() => onPick({ kind: 'dm', otherUserId: p.id })}
              className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              <span className="truncate">{p.email}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// clic derecho sobre una conversación de la lista (solo 1:1 — los grupos ya
// tienen "Salir del grupo" en el panel de info como su equivalente) — mismo
// patrón que MessageActionsMenu: las dos opciones de Telegram siempre
// disponibles, "para mí" y "para los dos".
function ConversationActionsMenu({ x, y, onDeleteForMe, onDeleteForEveryone, onClose }) {
  const ref = useRef(null)
  const pos = useClampedXY(ref, x, y)
  useEffect(() => {
    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      className="z-40 min-w-[180px] rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      <button
        type="button"
        onClick={onDeleteForMe}
        className="block w-full cursor-pointer px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        Eliminar chat para mí
      </button>
      <button
        type="button"
        onClick={onDeleteForEveryone}
        className="block w-full cursor-pointer px-3 py-1.5 text-left text-red-600 hover:bg-gray-100 dark:text-red-400 dark:hover:bg-neutral-800"
      >
        Eliminar chat para los dos
      </button>
    </div>
  )
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// sin nombre de marca ni parseo real de PDF/Office (agregar pdf.js sería una
// dependencia nueva para esto solo) — un ícono genérico con la extensión
// alcanza para identificar el archivo antes de mandarlo.
function fileTypeBadge(file) {
  return (file.name.split('.').pop() || 'arch').toUpperCase().slice(0, 4)
}

// pantalla completa sobre el hilo de mensajes mientras hay adjuntos
// pendientes — mismo espíritu que WhatsApp Web: preview grande del que está
// seleccionado, tira de miniaturas de todos los pendientes, y el mensaje se
// escribe/envía desde acá mismo.
function AttachmentPreviewOverlay({
  pendingFiles,
  previewIndex,
  onSelectPreview,
  onRemove,
  onCancelAll,
  onAddMore,
  draft,
  setDraft,
  onSend,
}) {
  const current = pendingFiles[previewIndex]
  if (!current) return null
  const isImage = current.file.type.startsWith('image/')
  const isVideo = current.file.type.startsWith('video/')

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-neutral-900/97">
      <div className="flex shrink-0 items-center justify-between px-4 py-3 text-white">
        <button
          type="button"
          aria-label="Cancelar adjuntos"
          onClick={onCancelAll}
          className="cursor-pointer rounded-full p-1.5 hover:bg-white/10"
        >
          ✕
        </button>
        <div className="text-center">
          <p className="max-w-xs truncate text-sm font-medium">{current.file.name}</p>
          <p className="text-xs text-white/60">{formatBytes(current.file.size)}</p>
        </div>
        <span className="w-7" aria-hidden="true" />
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
        {isImage ? (
          <img src={current.previewUrl} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
        ) : isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={current.previewUrl} controls className="max-h-full max-w-full rounded-lg" />
        ) : (
          <div className="flex flex-col items-center gap-3 text-white">
            <div className="flex h-24 w-24 items-center justify-center rounded-xl bg-white/10 text-sm font-bold">
              {fileTypeBadge(current.file)}
            </div>
            <p className="max-w-xs truncate text-sm">{current.file.name}</p>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 overflow-x-auto px-4 pb-2">
        {pendingFiles.map((p, i) => (
          <div key={i} className="relative shrink-0">
            <button
              type="button"
              onClick={() => onSelectPreview(i)}
              className={`h-12 w-12 cursor-pointer overflow-hidden rounded-md ${
                i === previewIndex ? 'ring-2 ring-blue-500' : 'opacity-60 hover:opacity-100'
              }`}
            >
              {p.file.type.startsWith('image/') ? (
                <img src={p.previewUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-white/10 text-[9px] font-bold text-white">
                  {fileTypeBadge(p.file)}
                </div>
              )}
            </button>
            <button
              type="button"
              aria-label="Quitar adjunto"
              onClick={() => onRemove(i)}
              className="absolute -right-1.5 -top-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-gray-700 text-[10px] text-white hover:bg-gray-900"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="Agregar más adjuntos"
          onClick={onAddMore}
          className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-md border border-dashed border-white/30 text-lg text-white/60 hover:bg-white/10"
        >
          +
        </button>
      </div>

      <form onSubmit={onSend} className="flex shrink-0 items-center gap-2 p-3">
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Agregá un mensaje…"
          className="min-w-0 flex-1 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm text-white outline-none placeholder:text-white/40"
        />
        <button
          type="submit"
          className="relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-lg text-white hover:bg-blue-700"
        >
          ➤
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gray-800 text-[9px] font-semibold text-white">
            {pendingFiles.length}
          </span>
        </button>
      </form>
    </div>
  )
}

function EmojiGrid({ onPick }) {
  const [category, setCategory] = useState(0)

  return (
    <>
      <div className="flex items-center gap-1 overflow-x-auto px-2 pt-2">
        {EMOJI_CATEGORIES.map((c, i) => (
          <button
            key={c.name}
            type="button"
            title={c.name}
            onClick={() => setCategory(i)}
            className={`shrink-0 cursor-pointer rounded-md p-1.5 text-lg ${
              category === i ? 'bg-gray-200 dark:bg-neutral-700' : 'hover:bg-gray-100 dark:hover:bg-neutral-800'
            }`}
          >
            {c.icon}
          </button>
        ))}
      </div>
      <div className="grid max-h-40 grid-cols-8 gap-1 overflow-y-auto p-2">
        {EMOJI_CATEGORIES[category].emojis.map((emoji, i) => (
          <button
            key={`${emoji}-${i}`}
            type="button"
            onClick={() => onPick(emoji)}
            className="cursor-pointer rounded-md p-1 text-2xl hover:bg-gray-100 dark:hover:bg-neutral-800"
          >
            {emoji}
          </button>
        ))}
      </div>
    </>
  )
}

// pills agrupadas debajo de la burbuja — tocar una es lo mismo que elegirla
// del picker (toggle: mismo emoji tuyo la saca, uno distinto la reemplaza).
function ReactionPills({ list, myId, onToggle }) {
  if (!list?.length) return null
  const grouped = new Map()
  for (const r of list) {
    if (!grouped.has(r.emoji)) grouped.set(r.emoji, [])
    grouped.get(r.emoji).push(r.user_id)
  }
  return (
    <div className="mt-0.5 flex flex-wrap gap-1">
      {[...grouped.entries()].map(([emoji, userIds]) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onToggle(emoji)}
          className={`flex cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs ${
            userIds.includes(myId)
              ? 'border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950'
              : 'border-gray-200 bg-white dark:border-neutral-700 dark:bg-neutral-800'
          }`}
        >
          <span>{emoji}</span>
          <span className="text-gray-500 dark:text-neutral-400">{userIds.length}</span>
        </button>
      ))}
    </div>
  )
}

function StickerPicker({ onPick }) {
  return (
    <div className="flex shrink-0 flex-col border-t border-gray-100 dark:border-neutral-800">
      <EmojiGrid onPick={onPick} />
    </div>
  )
}

// picker del ícono del grupo — mismo grid de emoji que los stickers, más la
// opción de subir una imagen propia (mismo patrón que el ícono de página en
// PageView.jsx: emoji corto o imagen, isImageIcon() distingue cuál es)
function GroupIconPicker({ onPickEmoji, onUploadImage, uploading }) {
  const fileRef = useRef(null)
  const [customIcons, setCustomIcons] = useState([])
  useEffect(() => {
    getCustomIcons().then(setCustomIcons)
  }, [])
  return (
    <div className="w-72 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      <div className="border-b border-gray-100 p-2 dark:border-neutral-800">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) onUploadImage(file)
            event.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {uploading ? 'Subiendo…' : '🖼️ Subir una imagen como ícono'}
        </button>
        {customIcons.length > 0 && (
          <>
            <p className="mb-1 mt-2 px-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-500">
              Personalizados
            </p>
            <div className="grid grid-cols-8 gap-0.5">
              {customIcons.map((url) => (
                <div key={url} className="group relative">
                  <button
                    type="button"
                    onClick={() => onPickEmoji(url)}
                    className="flex w-full cursor-pointer items-center justify-center rounded p-1 hover:bg-gray-100 dark:hover:bg-white/10"
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
      </div>
      <EmojiGrid onPick={onPickEmoji} />
    </div>
  )
}

const URL_RE = /https?:\/\/[^\s]+/g

function EmptyTab({ text }) {
  return <p className="px-1 text-xs italic text-gray-400 dark:text-neutral-500">{text}</p>
}

// attachment_url de un adjunto de Drive es el webViewLink (página de Drive,
// no bytes de imagen) — no sirve como src de <img>. Mismo mecanismo que
// AttachmentContent: propio -> driveasset://(desktop)/blob URL(web) vía
// resolveDriveDisplayUrl; ajeno -> no hay forma de bajar los bytes (scope
// drive.file), tarjeta "Ver en Drive" en su lugar.
function ChatInfoImageThumb({ msg, mine }) {
  const isDrive = Boolean(msg.attachment_drive_id)
  const inlineBlocked = isDrive && !mine
  const [src, setSrc] = useState(isDrive ? null : msg.attachment_url)

  useEffect(() => {
    if (!isDrive || inlineBlocked) return undefined
    let cancelled = false
    let objectUrl = null
    resolveDriveDisplayUrl(msg.attachment_drive_id).then((url) => {
      if (cancelled) {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
        return
      }
      objectUrl = url
      setSrc(url)
    })
    return () => {
      cancelled = true
      if (objectUrl?.startsWith('blob:')) URL.revokeObjectURL(objectUrl)
    }
  }, [isDrive, inlineBlocked, msg.attachment_drive_id])

  if (inlineBlocked) {
    return (
      <a
        href={msg.attachment_url}
        target="_blank"
        rel="noreferrer"
        className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md bg-gray-100 text-center text-[10px] text-gray-400 dark:bg-neutral-800 dark:text-neutral-500"
      >
        <span className="text-lg">🖼️</span>
        Ver en Drive
      </a>
    )
  }

  return (
    <a href={msg.attachment_url} target="_blank" rel="noreferrer">
      {src ? (
        <img src={src} alt="" className="aspect-square w-full rounded-md object-cover" />
      ) : (
        <div className="aspect-square w-full animate-pulse rounded-md bg-gray-100 dark:bg-neutral-800" />
      )}
    </a>
  )
}

// video de Drive: siempre reproducible inline (propio o ajeno) vía
// drive-media-proxy, igual que AttachmentContent.
function ChatInfoVideoItem({ msg }) {
  const isDrive = Boolean(msg.attachment_drive_id)
  const [proxySrc, setProxySrc] = useState(null)
  useEffect(() => {
    if (!isDrive) return undefined
    let cancelled = false
    getDriveMediaProxyUrl(msg.attachment_drive_id).then((url) => {
      if (!cancelled) setProxySrc(url)
    })
    return () => {
      cancelled = true
    }
  }, [isDrive, msg.attachment_drive_id])

  const src = isDrive ? proxySrc : msg.attachment_url
  if (isDrive && !src) {
    return <p className="text-xs text-gray-400 dark:text-neutral-500">Cargando video…</p>
  }
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return <video src={src} controls className="w-full rounded-md" />
}

// info del grupo: miembros + lo que se compartió, separado en pestañas —
// todo derivado de `messages` que ya está en memoria (ChatView ya cargó el
// historial completo para mostrar el hilo), sin pedir nada nuevo al server.
function ChatInfoPanel({
  isGroup,
  chatName,
  members,
  messages,
  isCreator,
  myId,
  onRemoveMember,
  onLeave,
  onClose,
  onOpenAddMember,
  wallpaperUrl,
  uploadingWallpaper,
  onUploadWallpaper,
  onResetWallpaper,
  wallpaperGallery,
  onPickWallpaperFromGallery,
  onDeleteWallpaperFromGallery,
  deletingWallpaperId,
}) {
  const [tab, setTab] = useState(isGroup ? 'members' : 'wallpaper')
  const wallpaperInputRef = useRef(null)

  const images = messages.filter((m) => m.message_type === 'attachment' && m.attachment_mime?.startsWith('image/'))
  const videos = messages.filter((m) => m.message_type === 'attachment' && m.attachment_mime?.startsWith('video/'))
  const files = messages.filter(
    (m) => m.message_type === 'attachment' && !m.attachment_mime?.startsWith('image/') && !m.attachment_mime?.startsWith('video/')
  )
  const links = messages
    .filter((m) => m.message_type === 'text')
    .flatMap((m) => (m.content.match(URL_RE) ?? []).map((url, i) => ({ url, key: `${m.id}-${i}` })))

  const TABS = [
    ...(isGroup ? [{ key: 'members', label: 'Miembros' }] : []),
    { key: 'wallpaper', label: 'Fondo' },
    { key: 'files', label: 'Archivos' },
    { key: 'images', label: 'Imágenes' },
    { key: 'videos', label: 'Videos' },
    { key: 'links', label: 'Enlaces' },
  ]

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-white dark:bg-neutral-900">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-neutral-800">
        <p className="truncate text-sm font-semibold text-gray-800 dark:text-neutral-100">{chatName}</p>
        <button
          type="button"
          aria-label="Cerrar"
          onClick={onClose}
          className="shrink-0 cursor-pointer rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
        >
          ✕
        </button>
      </div>
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-100 px-2 pt-2 dark:border-neutral-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`shrink-0 cursor-pointer rounded-t-md px-3 py-1.5 text-xs font-medium ${
              tab === t.key
                ? 'border-b-2 border-blue-600 text-blue-600 dark:text-blue-400'
                : 'text-gray-400 hover:text-gray-600 dark:hover:text-neutral-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'members' && (
          <div className="flex flex-col gap-1">
            {isCreator && (
              <button
                type="button"
                onClick={onOpenAddMember}
                className="mb-1 w-fit cursor-pointer text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                + Agregar miembro
              </button>
            )}
            {members.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm">
                <span className="truncate text-gray-700 dark:text-neutral-200">
                  {m.email}
                  {m.user_id === myId ? ' (vos)' : ''}
                </span>
                {isCreator && m.user_id !== myId && (
                  <button
                    type="button"
                    onClick={() => onRemoveMember(m.user_id)}
                    className="shrink-0 cursor-pointer text-xs text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                  >
                    Quitar
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={onLeave}
              className="mt-3 w-fit cursor-pointer text-xs text-red-600 hover:underline dark:text-red-400"
            >
              Salir del grupo
            </button>
          </div>
        )}
        {tab === 'wallpaper' && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-400 dark:text-neutral-500">
              El fondo que elijas acá solo se aplica a esta conversación.
            </p>
            <input
              ref={wallpaperInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) onUploadWallpaper(file)
                event.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => wallpaperInputRef.current?.click()}
              disabled={uploadingWallpaper}
              className="w-fit cursor-pointer rounded-md px-2 py-1.5 text-left text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
            >
              {uploadingWallpaper ? 'Subiendo…' : '🖼️ Subir imagen propia'}
            </button>
            <button
              type="button"
              onClick={onResetWallpaper}
              disabled={!wallpaperUrl}
              className="w-fit cursor-pointer rounded-md px-2 py-1.5 text-left text-sm text-gray-500 hover:underline disabled:opacity-40 dark:text-neutral-400"
            >
              ↺ Usar el fondo por defecto
            </button>
            {wallpaperGallery.length > 0 && (
              <>
                <p className="mb-1 mt-2 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-500">
                  Ya usados
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {wallpaperGallery.map((wallpaper) => (
                    <div key={wallpaper.fileId} className="group relative aspect-square">
                      <button
                        type="button"
                        onClick={() => onPickWallpaperFromGallery(wallpaper)}
                        title="Usar este fondo"
                        className={`h-full w-full cursor-pointer overflow-hidden rounded-md border-2 ${
                          wallpaperUrl === wallpaper.url
                            ? 'border-blue-500'
                            : 'border-transparent hover:border-gray-300 dark:hover:border-neutral-600'
                        }`}
                      >
                        <img src={wallpaper.url} alt="" className="h-full w-full object-cover" />
                      </button>
                      {/* eliminar el fondo de la galería (y de Drive) — mismo
                          criterio que el resto de la app: hover-only en
                          desktop, siempre visible en mobile (no hay :hover
                          en touch) */}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onDeleteWallpaperFromGallery(wallpaper)
                        }}
                        disabled={deletingWallpaperId === wallpaper.fileId}
                        title="Eliminar este fondo"
                        aria-label="Eliminar este fondo"
                        className="absolute right-1 top-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-black/60 text-[10px] text-white opacity-70 hover:bg-black/80 hover:opacity-100 disabled:opacity-60"
                      >
                        {deletingWallpaperId === wallpaper.fileId ? '…' : '✕'}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {tab === 'files' &&
          (files.length === 0 ? (
            <EmptyTab text="Sin archivos todavía" />
          ) : (
            <div className="flex flex-col gap-1">
              {files.map((m) => (
                <a
                  key={m.id}
                  href={m.attachment_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-neutral-800"
                >
                  📎 <span className="truncate">{m.attachment_name}</span>
                </a>
              ))}
            </div>
          ))}
        {tab === 'images' &&
          (images.length === 0 ? (
            <EmptyTab text="Sin imágenes todavía" />
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {images.map((m) => (
                <ChatInfoImageThumb key={m.id} msg={m} mine={m.sender_id === myId} />
              ))}
            </div>
          ))}
        {tab === 'videos' &&
          (videos.length === 0 ? (
            <EmptyTab text="Sin videos todavía" />
          ) : (
            <div className="flex flex-col gap-2">
              {videos.map((m) => (
                <ChatInfoVideoItem key={m.id} msg={m} />
              ))}
            </div>
          ))}
        {tab === 'links' &&
          (links.length === 0 ? (
            <EmptyTab text="Sin enlaces todavía" />
          ) : (
            <div className="flex flex-col gap-1">
              {links.map((l) => (
                <a
                  key={l.key}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate rounded-md px-2 py-1.5 text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  {l.url}
                </a>
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}

const CHAT_SIDEBAR_WIDTH_KEY = 'flashlab-chat-sidebar-width'
const CHAT_SIDEBAR_DEFAULT_WIDTH = 256
const CHAT_SIDEBAR_MIN_WIDTH = 180
const CHAT_SIDEBAR_MAX_WIDTH = 480

// ---------- Apertura del micrófono ----------
// getUserMedia({ audio: true }) usa SIEMPRE el dispositivo predeterminado de
// Windows y no prueba ningún otro. Con unos auriculares Bluetooth conectados,
// Windows deja como predeterminado el endpoint "Headset" (el perfil manos
// libres del auricular); si esos auriculares están en modo A2DP —o apagados,
// pero con el endpoint todavía marcado como activo— abrirlo falla con
// NotReadableError "Could not start audio source". Resultado: el micrófono
// integrado anda perfecto pero la app nunca llega a probarlo y grabar queda
// roto de forma permanente. Por eso, si el predeterminado falla, recorremos
// el resto de los micrófonos hasta encontrar uno que abra de verdad.
const MIC_DEVICE_KEY = 'flashlab-chat-mic-device'

// deviceIds que Chromium expone como alias del predeterminado: no aportan un
// dispositivo nuevo para probar, apuntan al mismo que ya falló.
const MIC_ALIAS_IDS = new Set(['', 'default', 'communications'])

// Errores por los que vale la pena probar OTRO micrófono. Si el usuario negó
// el permiso, cambiar de dispositivo no arregla nada: cortamos ahí.
const MIC_RETRIABLE_ERRORS = new Set([
  'NotReadableError',
  'TrackStartError',
  'NotFoundError',
  'DevicesNotFoundError',
  'OverconstrainedError',
  'ConstraintNotSatisfiedError',
  'AbortError',
])

function rememberedMicId() {
  try {
    return localStorage.getItem(MIC_DEVICE_KEY) || null
  } catch {
    return null
  }
}

function rememberMicId(deviceId) {
  try {
    if (deviceId) localStorage.setItem(MIC_DEVICE_KEY, deviceId)
    else localStorage.removeItem(MIC_DEVICE_KEY)
  } catch {
    // localStorage lleno o bloqueado: perder la preferencia no es grave,
    // solo significa reintentar la cadena completa la próxima vez.
  }
}

// Abre el primer micrófono que realmente funcione. Devuelve el stream y el
// deviceId que anduvo (null si anduvo el predeterminado del sistema).
async function openMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este dispositivo no expone ningún micrófono.')
  }

  let lastError = null

  const attempt = async (deviceId, tuned) => {
    // sin procesamiento (segunda vuelta): algunos drivers rechazan abrir el
    // stream si Chromium les pide cancelación de eco / supresión de ruido.
    const audio = {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      ...(tuned ? {} : { echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: Object.keys(audio).length ? audio : true,
      })
    } catch (err) {
      lastError = err
      if (!MIC_RETRIABLE_ERRORS.has(err?.name)) throw err
      return null
    }
  }

  // 1) el que ya sabemos que funciona (se olvida al conectar/desconectar
  //    dispositivos), y si no hay, el predeterminado del sistema.
  const remembered = rememberedMicId()
  for (const deviceId of remembered ? [remembered, null] : [null]) {
    const stream = await attempt(deviceId, true)
    if (stream) return { stream, deviceId }
  }

  // 2) el predeterminado falló: recién ahora enumeramos y probamos uno por
  //    uno. enumerateDevices() solo devuelve deviceIds utilizables después de
  //    que se otorgó el permiso, y el intento de arriba ya lo otorgó (falló al
  //    ABRIR el dispositivo, no por permiso).
  let inputs = []
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    inputs = devices.filter(
      (d) => d.kind === 'audioinput' && !MIC_ALIAS_IDS.has(d.deviceId) && d.deviceId !== remembered
    )
  } catch {
    // si ni siquiera podemos enumerar, nos quedamos con lastError.
  }

  for (const tuned of [true, false]) {
    for (const device of inputs) {
      const stream = await attempt(device.deviceId, tuned)
      if (stream) return { stream, deviceId: device.deviceId }
    }
  }

  throw lastError ?? new Error('No se encontró ningún micrófono disponible.')
}

// El mensaje crudo de Chromium ("Could not start audio source") está en inglés
// y no dice qué hacer al respecto.
function micErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      if (IS_CAPACITOR) {
        return 'FlashLab no tiene permiso de micrófono. Activalo en Ajustes del celular › Apps › FlashLab › Permisos › Micrófono.'
      }
      if (isDesktop) {
        return 'Windows le está bloqueando el micrófono a FlashLab. Activalo en Configuración › Privacidad y seguridad › Micrófono.'
      }
      return 'El navegador está bloqueando el micrófono para esta página. Revisá los permisos del sitio.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No se detectó ningún micrófono conectado.'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'No se pudo abrir ningún micrófono. Suele pasar con auriculares Bluetooth: desconectalos y probá de nuevo.'
    default:
      return err?.message || 'No se pudo acceder al micrófono.'
  }
}

// mismo patrón que SidebarResizeHandle (Sidebar.jsx) y ColumnResizeHandle
// (DatabaseView.jsx): sigue el mouse con estado local y recién persiste a
// localStorage al soltar.
function ChatSidebarResizeHandle({ width, onResize, onCommit }) {
  const dragRef = useRef(null)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Ajustar ancho de la lista de conversaciones"
      onMouseDown={(event) => {
        event.preventDefault()
        dragRef.current = { startX: event.clientX, startWidth: width }
        const onMove = (moveEvent) => {
          const delta = moveEvent.clientX - dragRef.current.startX
          onResize(Math.min(CHAT_SIDEBAR_MAX_WIDTH, Math.max(CHAT_SIDEBAR_MIN_WIDTH, dragRef.current.startWidth + delta)))
        }
        const onUp = (upEvent) => {
          const delta = upEvent.clientX - dragRef.current.startX
          onCommit(Math.min(CHAT_SIDEBAR_MAX_WIDTH, Math.max(CHAT_SIDEBAR_MIN_WIDTH, dragRef.current.startWidth + delta)))
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

export default function ChatView({ insetLeft = false, sidebarOpen = false }) {
  const session = useAuthSession()
  const myId = session?.user?.id ?? null
  // en mobile los 2 paneles (lista + conversación) no entran lado a lado
  // como en desktop — pasan a ser una pantalla a la vez, estilo WhatsApp:
  // lista sola sin conversación activa, conversación sola con una activa,
  // con un botón "volver" para deshacer.
  const isMobile = useIsMobile()

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem(CHAT_SIDEBAR_WIDTH_KEY))
    return stored >= CHAT_SIDEBAR_MIN_WIDTH && stored <= CHAT_SIDEBAR_MAX_WIDTH ? stored : CHAT_SIDEBAR_DEFAULT_WIDTH
  })
  const [partners, setPartners] = useState(null)
  const [knownEmails, setKnownEmails] = useState(new Map())
  const [unread, setUnread] = useState(new Map())
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState(null)
  // los mensajes con deleted_at se quedan en `messages` (loadOlderMessages
  // usa messages[0].created_at como cursor de paginación, así que sacarlos
  // del state rompería eso) pero nunca deben renderizarse — "eliminar para
  // todos" no debe dejar ningún rastro visible en el chat.
  const visibleMessages = useMemo(() => messages?.filter((m) => !m.deleted_at) ?? null, [messages])
  const [messagesError, setMessagesError] = useState(null)
  const [reactions, setReactions] = useState(new Map()) // message_id -> [{ user_id, emoji }]
  const fetchedReactionIdsRef = useRef(new Set())
  const [reloadTick, setReloadTick] = useState(0)
  // paginado del historial: se carga la página más reciente al abrir el
  // chat, y páginas más viejas a medida que se scrollea hacia arriba (ver
  // loadOlderMessages) — evita traer una conversación entera de una
  const [hasMoreMessages, setHasMoreMessages] = useState(true)
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState(null) // { type: 'image'|'pdf', url, name } | null
  // check de leído (ver MessageBubble): hasta dónde leyó la otra persona
  // (DM) o cada miembro (grupo) — null/vacío = "sin leer todavía"
  const [partnerLastRead, setPartnerLastRead] = useState(null)
  const [groupReads, setGroupReads] = useState(new Map())
  // "confirmaciones de lectura" — preferencia MÍA, guardada en el server
  // (chat_settings) porque quien la necesita consultar es la OTRA persona,
  // no yo: solo así puede decidir si pintarme el doble check azul. Groups
  // siempre mandan confirmación (igual que WhatsApp: ese interruptor solo
  // existe para 1:1), así que partnerReadReceiptsEnabled solo aplica en DM.
  const [readReceiptsEnabled, setReadReceiptsEnabledState] = useState(true)
  const [partnerReadReceiptsEnabled, setPartnerReadReceiptsEnabled] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [stickersOpen, setStickersOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pendingFiles, setPendingFiles] = useState([]) // [{ file, previewUrl }]
  const [previewIndex, setPreviewIndex] = useState(0)
  const [sending, setSending] = useState(false)
  // adjuntos subiendo en segundo plano — estado externo (backgroundUploads.js,
  // no useState) para que sigan subiendo aunque este componente se
  // desmonte al cambiar de pestaña. [{ id, kind: 'dm'|'group', targetId,
  // file, previewUrl, progress, controller }]
  const backgroundUploads = useSyncExternalStore(subscribeUploads, getUploadsSnapshot)
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  // slide-to-lock (mismo gesto que WhatsApp): deslizar el dedo hacia arriba
  // mientras se mantiene presionado el 🎤 "bloquea" la grabación para poder
  // soltar sin cortarla — ver startRecording/updateMicDrag más abajo.
  const [micLocked, setMicLocked] = useState(false)
  const [micDragProgress, setMicDragProgress] = useState(0) // 0..1, para animar el candado
  const [wallpaperUrl, setWallpaperUrl] = useState(null)
  const [uploadingWallpaper, setUploadingWallpaper] = useState(false)
  const [wallpaperGallery, setWallpaperGallery] = useState([])
  const [deletingWallpaperId, setDeletingWallpaperId] = useState(null)
  const [repairingVideoId, setRepairingVideoId] = useState(null)
  const [menuState, setMenuState] = useState(null) // { msg, x, y } | null
  const [convMenuState, setConvMenuState] = useState(null) // { item, x, y } | null
  const [forwardState, setForwardState] = useState(null) // { msg } | null
  const [editingMessage, setEditingMessage] = useState(null) // msg | null

  // grupos — mutuamente excluyente con activeId (1:1)
  const [groups, setGroups] = useState(null)
  const [activeGroupId, setActiveGroupId] = useState(null)
  const [groupMembers, setGroupMembers] = useState(new Map()) // user_id -> email, del grupo abierto
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupEmails, setNewGroupEmails] = useState('')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupIconPickerOpen, setGroupIconPickerOpen] = useState(false)
  const [uploadingIcon, setUploadingIcon] = useState(false)
  const [chatInfoOpen, setChatInfoOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [addMemberEmail, setAddMemberEmail] = useState('')
  const [addingMember, setAddingMember] = useState(false)

  const bottomRef = useRef(null)
  const threadRef = useRef(null)
  const skipNextAutoScrollRef = useRef(false)
  const loadingMoreRef = useRef(false)
  const fileInputRef = useRef(null)
  const draftInputRef = useRef(null)
  const activeIdRef = useRef(null)
  const activeGroupIdRef = useRef(null)
  const stickerAreaRef = useRef(null)
  const groupIconAreaRef = useRef(null)
  const settingsAreaRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const recordStreamRef = useRef(null)
  const recordChunksRef = useRef([])
  const recordStartRef = useRef(0)
  const recordTimerIdRef = useRef(null)
  // arrancar una grabación es async (getUserMedia tarda en resolver) — el
  // estado `recording` de React recién se pone true al final de eso, así
  // que un segundo mousedown/touchstart que llegue MIENTRAS se está
  // esperando ese permiso (p. ej. el evento táctil y su "mousedown"
  // sintético de compatibilidad para el mismo toque) alcanzaba a pasar el
  // guard, crear un SEGUNDO MediaRecorder, y terminar mezclando los chunks
  // de dos grabaciones distintas en el mismo array — audio corrupto,
  // "Could not start audio source" al reproducirlo. Este ref se marca
  // sincrónicamente, sin esperar al re-render.
  const recordingRef = useRef(false)
  // posición Y donde arrancó el toque/click, y si ya se cruzó el umbral de
  // bloqueo — en refs porque el handler de arrastre corre en cada pixel de
  // movimiento y necesita leer/escribir sin esperar al re-render (mismo
  // motivo que recordingRef arriba).
  const micStartYRef = useRef(null)
  const micLockedRef = useRef(false)
  // últimas versiones de estas dos funciones (definidas más abajo) — el
  // efecto de mousemove/mouseup de documento (ver más abajo) las necesita
  // sin volver a suscribirse en cada re-render (recordSeconds cambia 4
  // veces por segundo mientras se graba, y ambas se recrean en cada render).
  const stopRecordingRef = useRef(null)
  const updateMicDragRef = useRef(null)
  // ver el comentario junto a la definición de startRecording más abajo.
  const startRecordingRef = useRef(null)
  activeIdRef.current = activeId
  activeGroupIdRef.current = activeGroupId

  // soltar el micrófono si se desmonta el chat con una grabación en curso
  useEffect(
    () => () => {
      clearInterval(recordTimerIdRef.current)
      recordStreamRef.current?.getTracks().forEach((t) => t.stop())
    },
    []
  )

  // arrastre del gesto slide-to-lock con MOUSE: a diferencia de touch (que
  // queda "capturado" en el elemento de origen aunque el dedo se mueva
  // afuera), un mousemove/mouseup deja de dispararse en el botón apenas el
  // puntero sale de su área — por eso corren en el documento entero mientras
  // se está grabando, no en el botón. Toque/mobile no usa este efecto (ver
  // onTouchMove/onTouchEnd en el JSX del botón).
  useEffect(() => {
    if (!recording) return undefined
    const onMove = (event) => updateMicDragRef.current?.(event.clientY)
    const onUp = (event) => stopRecordingRef.current?.(event)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [recording])

  // conectar o desconectar auriculares cambia cuál es el micrófono
  // predeterminado de Windows, así que el que habíamos elegido como respaldo
  // deja de ser necesariamente el correcto: lo olvidamos para que la próxima
  // grabación vuelva a arrancar por el predeterminado (ver openMicrophone).
  useEffect(() => {
    const devices = navigator.mediaDevices
    if (!devices?.addEventListener) return undefined
    const forget = () => rememberMicId(null)
    devices.addEventListener('devicechange', forget)
    return () => devices.removeEventListener('devicechange', forget)
  }, [])

  // shares de Drive que quedaron pendientes de cuando alguien se sumó a un
  // grupo mientras esta cuenta no tenía la app abierta (ver driveShareQueue.js)
  useEffect(() => {
    if (!myId) return
    processPendingDriveShares().catch((err) => console.error('no se pudo procesar la cola de shares de Drive:', err))
  }, [myId])

  // reacciones de los mensajes recién cargados (primera página o
  // loadOlderMessages) — se pide una sola vez por mensaje, fetchedReactionIdsRef
  // evita repetir la consulta para uno ya conocido.
  useEffect(() => {
    if (!messages?.length) return
    const idsToFetch = messages.map((m) => m.id).filter((id) => !fetchedReactionIdsRef.current.has(id))
    if (!idsToFetch.length) return
    idsToFetch.forEach((id) => fetchedReactionIdsRef.current.add(id))
    const loader = activeGroupId ? listGroupReactionsForMessages : listReactionsForMessages
    loader(idsToFetch)
      .then((rows) => {
        if (!rows.length) return
        setReactions((prev) => {
          const next = new Map(prev)
          for (const row of rows) {
            const list = (next.get(row.message_id) ?? []).filter((r) => r.user_id !== row.user_id)
            next.set(row.message_id, [...list, row])
          }
          return next
        })
      })
      .catch((err) => console.error('no se pudieron cargar las reacciones:', err))
  }, [messages, activeGroupId])

  // en vivo: acumula por message_id sin importar la conversación activa
  // (las tablas de reacciones no tienen sender/recipient para filtrar
  // server-side, ver subscribeToReactions/subscribeToGroupReactions) — así
  // no hace falta resuscribirse al cambiar de chat.
  useEffect(() => {
    if (!myId) return
    const applyEvent = (payload) => {
      setReactions((prev) => {
        const next = new Map(prev)
        if (payload.eventType === 'DELETE') {
          const old = payload.old
          next.set(
            old.message_id,
            (next.get(old.message_id) ?? []).filter((r) => r.user_id !== old.user_id)
          )
          return next
        }
        const row = payload.new
        const list = (next.get(row.message_id) ?? []).filter((r) => r.user_id !== row.user_id)
        next.set(row.message_id, [...list, row])
        return next
      })
    }
    const unsubDm = subscribeToReactions(applyEvent)
    const unsubGroup = subscribeToGroupReactions(applyEvent)
    return () => {
      unsubDm()
      unsubGroup()
    }
  }, [myId])

  // mi propia preferencia de "confirmaciones de lectura" (para mostrar el
  // estado correcto del interruptor en ⚙️ Configuración)
  useEffect(() => {
    if (!myId) return
    let cancelled = false
    getReadReceiptsEnabled(myId)
      .then((enabled) => {
        if (!cancelled) setReadReceiptsEnabledState(enabled)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [myId])

  // cerrar el picker de stickers al clickear afuera (del picker o del botón que lo abre)
  useEffect(() => {
    if (!stickersOpen) return
    const onPointerDown = (event) => {
      if (stickerAreaRef.current && !stickerAreaRef.current.contains(event.target)) setStickersOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [stickersOpen])

  // fondo del chat: exclusivo de la conversación abierta, guardado local
  // bajo una clave por chat (la URL ya subida, no la imagen en sí — así no
  // hay que resubirla cada sesión)
  const activeChatKey = activeGroupId ? `group-${activeGroupId}` : activeId ? `dm-${activeId}` : null

  // en localStorage se guarda el ID del archivo en Drive, no una URL: en la
  // web la URL mostrable es un blob temporal que no sobrevive a un reload
  // (y en Electron es driveasset://). Se resuelve en cada render.
  useEffect(() => {
    if (!myId || !activeChatKey) {
      setWallpaperUrl(null)
      return undefined
    }
    const stored = driveFileIdFromStored(localStorage.getItem(wallpaperStorageKey(myId, activeChatKey)))
    if (!stored) {
      setWallpaperUrl(null)
      return undefined
    }
    let cancelled = false
    let objectUrl = null
    resolveDriveDisplayUrl(stored).then((url) => {
      if (cancelled) {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
        return
      }
      objectUrl = url
      setWallpaperUrl(url)
    })
    return () => {
      cancelled = true
      if (objectUrl?.startsWith('blob:')) URL.revokeObjectURL(objectUrl)
    }
  }, [myId, activeChatKey])

  // galería de fondos ya subidos alguna vez (cualquier conversación) — se
  // carga una vez por sesión, no hace falta por conversación.
  useEffect(() => {
    if (!myId) return undefined
    let cancelled = false
    let resolved = []
    listCustomWallpapers()
      .then(async (fileIds) => {
        const urls = await Promise.all(fileIds.map((id) => resolveDriveDisplayUrl(id)))
        resolved = fileIds.map((fileId, i) => ({ fileId, url: urls[i] })).filter((w) => w.url)
        if (cancelled) {
          resolved.forEach((w) => w.url.startsWith('blob:') && URL.revokeObjectURL(w.url))
          return
        }
        setWallpaperGallery(resolved)
      })
      .catch((err) => console.error('no se pudo cargar la galería de fondos:', err))
    return () => {
      cancelled = true
      resolved.forEach((w) => w.url?.startsWith('blob:') && URL.revokeObjectURL(w.url))
    }
  }, [myId])

  const handleUploadWallpaper = async (file) => {
    if (!myId || !activeChatKey) return
    setUploadingWallpaper(true)
    try {
      // achicar ANTES de subir — no solo esta subida sube más rápido, cada
      // apertura futura de este chat (o de otro que reuse el mismo fondo
      // desde "Ya usados") también baja menos bytes de Drive.
      const compressed = await compressImageForUpload(file)
      const fileId = await uploadChatWallpaper(compressed)
      localStorage.setItem(wallpaperStorageKey(myId, activeChatKey), fileId)
      const url = await resolveDriveDisplayUrl(fileId)
      setWallpaperUrl(url)
      if (url) setWallpaperGallery((prev) => [{ fileId, url }, ...prev.filter((w) => w.fileId !== fileId)])
    } catch (err) {
      setError(err.message || 'no se pudo subir el fondo')
    } finally {
      setUploadingWallpaper(false)
    }
  }

  const handlePickWallpaperFromGallery = ({ fileId, url }) => {
    if (!myId || !activeChatKey) return
    localStorage.setItem(wallpaperStorageKey(myId, activeChatKey), fileId)
    setWallpaperUrl(url)
  }

  const handleResetWallpaper = () => {
    if (!myId || !activeChatKey) return
    localStorage.removeItem(wallpaperStorageKey(myId, activeChatKey))
    setWallpaperUrl(null)
  }

  // borra el archivo de Drive (deleteCustomWallpaper ya lo hace primero,
  // antes de tocar la galería — ver el comentario en chat.js) y limpia
  // cualquier rastro local: si era el fondo activo de ESTA conversación,
  // vuelve al default; y como el mismo fondo puede estar puesto en OTRAS
  // conversaciones (localStorage por chat, sin índice central), se barren
  // todas las claves de este usuario que apunten a ese fileId — si no,
  // esa otra conversación quedaría con una referencia a un archivo que ya
  // no existe.
  const handleDeleteWallpaperFromGallery = async ({ fileId, url }) => {
    setDeletingWallpaperId(fileId)
    try {
      await deleteCustomWallpaper(fileId)
      setWallpaperGallery((prev) => prev.filter((w) => w.fileId !== fileId))
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
      if (myId) {
        const prefix = wallpaperStorageKey(myId, '')
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i)
          if (key?.startsWith(prefix) && localStorage.getItem(key) === fileId) localStorage.removeItem(key)
        }
      }
      if (wallpaperUrl === url) setWallpaperUrl(null)
    } catch (err) {
      setError(err.message || 'no se pudo borrar el fondo')
    } finally {
      setDeletingWallpaperId(null)
    }
  }

  useEffect(() => {
    if (!groupIconPickerOpen) return
    const onPointerDown = (event) => {
      if (groupIconAreaRef.current && !groupIconAreaRef.current.contains(event.target)) setGroupIconPickerOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [groupIconPickerOpen])

  useEffect(() => {
    if (!settingsOpen) return
    const onPointerDown = (event) => {
      if (settingsAreaRef.current && !settingsAreaRef.current.contains(event.target)) setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [settingsOpen])

  const toggleReadReceipts = async () => {
    const next = !readReceiptsEnabled
    setReadReceiptsEnabledState(next) // optimista: se revierte si falla el guardado
    try {
      await setMyReadReceiptsEnabled(next)
    } catch (err) {
      setReadReceiptsEnabledState(!next)
      setError(err.message || 'No se pudo guardar la preferencia.')
    }
  }

  const loadPartners = async () => {
    const list = await listConversationPartners()
    setPartners(list)
    setKnownEmails((prev) => {
      const next = new Map(prev)
      list.forEach((p) => next.set(p.id, p.email))
      return next
    })
  }

  const loadUnread = async () => {
    const counts = await getUnreadCounts()
    setUnread(new Map(counts.map((c) => [c.other_user_id, Number(c.unread_count)])))
  }

  const loadGroups = async () => {
    const list = await listMyGroups()
    setGroups(list)
  }

  useEffect(() => {
    if (!myId) return
    loadPartners()
    loadUnread()
    loadGroups()
    const unsubscribe = subscribeToInbox(
      myId,
      (row) => {
        loadPartners()
        // el mensaje nuevo es de la conversación que ya tengo abierta: no
        // suma como "no leído", ya lo estoy viendo (y subscribeToConversation
        // ya lo agrega al hilo)
        if (row.sender_id !== activeIdRef.current) loadUnread()
      },
      'view'
    )
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId])

  const resetComposer = () => {
    setStickersOpen(false)
    setGroupIconPickerOpen(false)
    setChatInfoOpen(false)
    setAddMemberOpen(false)
    setMenuState(null)
    setEditingMessage(null)
    setPreviewAttachment(null)
    setDraft('')
    setPendingFiles((prev) => {
      prev.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
      return []
    })
    setPreviewIndex(0)
    recordingRef.current = false
    if (mediaRecorderRef.current) {
      clearInterval(recordTimerIdRef.current)
      mediaRecorderRef.current.stop()
      recordStreamRef.current?.getTracks().forEach((t) => t.stop())
      mediaRecorderRef.current = null
      recordStreamRef.current = null
      setRecording(false)
      setRecordSeconds(0)
    }
  }

  useEffect(() => {
    if (!activeId || !myId) return
    let cancelled = false
    setMessages(null)
    setMessagesError(null)
    setPartnerLastRead(null)
    setPartnerReadReceiptsEnabled(true)
    setHasMoreMessages(true)
    resetComposer()
    listMessages(activeId)
      .then((msgs) => {
        if (!cancelled) {
          setMessages(msgs)
          setHasMoreMessages(msgs.length === MESSAGES_PAGE_SIZE)
        }
      })
      .catch((err) => {
        if (!cancelled) setMessagesError(err.message || 'No se pudo cargar la conversación.')
      })
    markConversationRead(activeId)
      .then(() => {
        if (!cancelled) setUnread((prev) => new Map(prev).set(activeId, 0))
        window.dispatchEvent(new Event('flashlab:chat-read'))
      })
      .catch(() => {})
    // doble check azul en MIS mensajes: hasta dónde leyó la otra persona,
    // y si ella tiene las confirmaciones de lectura activadas
    getPartnerLastRead(activeId)
      .then((lastRead) => {
        if (!cancelled) setPartnerLastRead(lastRead)
      })
      .catch(() => {})
    getReadReceiptsEnabled(activeId)
      .then((enabled) => {
        if (!cancelled) setPartnerReadReceiptsEnabled(enabled)
      })
      .catch(() => {})
    const unsubscribeRead = subscribeToPartnerRead(myId, activeId, (lastRead) => {
      if (!cancelled) setPartnerLastRead(lastRead)
    })
    const unsubscribeReadSetting = subscribeToReadReceiptsSetting(activeId, (enabled) => {
      if (!cancelled) setPartnerReadReceiptsEnabled(enabled)
    })
    const unsubscribe = subscribeToConversation(
      myId,
      activeId,
      (msg) => {
        setMessages((prev) => (prev ? [...prev, msg] : [msg]))
        if (msg.sender_id === activeId) markConversationRead(activeId).catch(() => {})
      },
      (msg) => setMessages((prev) => prev?.map((m) => (m.id === msg.id ? msg : m)) ?? prev),
      // la otra persona eligió "eliminar para los dos": el hilo que estoy
      // mirando se vacía en vivo, no queda mostrando mensajes que ya no existen
      () => {
        setMessages([])
        setHasMoreMessages(false)
        setPartners((prev) => prev?.filter((p) => p.id !== activeId) ?? prev)
      },
      () => {
        listMessages(activeId)
          .then((fresh) => {
            if (!cancelled) setMessages((prev) => mergeMessagesById(prev, fresh))
          })
          .catch(() => {})
      }
    )
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeRead()
      unsubscribeReadSetting()
    }
  }, [activeId, myId, reloadTick])

  useEffect(() => {
    if (!activeGroupId || !myId) return
    let cancelled = false
    setMessages(null)
    setMessagesError(null)
    setGroupReads(new Map())
    setHasMoreMessages(true)
    resetComposer()
    listGroupMessages(activeGroupId)
      .then((msgs) => {
        if (!cancelled) {
          setMessages(msgs)
          setHasMoreMessages(msgs.length === MESSAGES_PAGE_SIZE)
        }
      })
      .catch((err) => {
        if (!cancelled) setMessagesError(err.message || 'No se pudo cargar la conversación.')
      })
    listGroupMembers(activeGroupId)
      .then((members) => {
        if (!cancelled) setGroupMembers(new Map(members.map((m) => [m.user_id, m.email])))
      })
      .catch(() => {})
    // doble check azul en MIS mensajes: recién cuando TODOS los demás
    // miembros leyeron (mismo criterio que WhatsApp en grupos)
    markGroupRead(activeGroupId)
      .then(() => window.dispatchEvent(new Event('flashlab:chat-read')))
      .catch(() => {})
    listGroupReads(activeGroupId)
      .then((rows) => {
        if (!cancelled) setGroupReads(new Map(rows.map((r) => [r.user_id, r.last_read_at])))
      })
      .catch(() => {})
    const unsubscribeReads = subscribeToGroupReads(activeGroupId, (row) => {
      if (!cancelled && row) setGroupReads((prev) => new Map(prev).set(row.user_id, row.last_read_at))
    })
    const unsubscribe = subscribeToGroup(
      activeGroupId,
      (msg) => {
        setMessages((prev) => (prev ? [...prev, msg] : [msg]))
        if (msg.sender_id !== myId) markGroupRead(activeGroupId).catch(() => {})
      },
      (msg) => setMessages((prev) => prev?.map((m) => (m.id === msg.id ? msg : m)) ?? prev),
      () => {
        listGroupMessages(activeGroupId)
          .then((fresh) => {
            if (!cancelled) setMessages((prev) => mergeMessagesById(prev, fresh))
          })
          .catch(() => {})
      }
    )
    return () => {
      cancelled = true
      unsubscribe()
      unsubscribeReads()
    }
  }, [activeGroupId, myId, reloadTick])

  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false
      return
    }
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, backgroundUploads])

  const selectDm = (id) => {
    setActiveGroupId(null)
    setActiveId(id)
  }

  const selectGroup = (id) => {
    setActiveId(null)
    setActiveGroupId(id)
  }

  const closeActiveConversation = () => {
    setActiveId(null)
    setActiveGroupId(null)
  }

  // Esc cierra la conversación abierta — si el input tiene texto, la primera
  // Esc solo lo vacía (y recién la segunda cierra, ya con el input vacío);
  // si ya estaba vacío, una sola Esc alcanza. Mismo patrón que Telegram
  // Desktop.
  const handleComposerKeyDown = (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (draft.trim()) setDraft('')
    else closeActiveConversation()
  }

  const handleStart = async (event) => {
    event.preventDefault()
    const email = newEmail.trim()
    if (!email) return
    setError('')
    setStarting(true)
    try {
      const id = await findUserIdByEmail(email)
      if (!id) {
        setError('Esa persona todavía no se logueó en FlashLab.')
        return
      }
      if (id === myId) {
        setError('Ese email sos vos.')
        return
      }
      setKnownEmails((prev) => new Map(prev).set(id, email.toLowerCase()))
      selectDm(id)
      setNewEmail('')
    } catch (err) {
      setError(err.message || 'no se pudo buscar ese email')
    } finally {
      setStarting(false)
    }
  }

  const handleCreateGroup = async (event) => {
    event.preventDefault()
    const name = newGroupName.trim()
    if (!name) return
    setError('')
    setCreatingGroup(true)
    try {
      const emails = newGroupEmails
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
      const id = await createGroup(name, emails)
      setNewGroupName('')
      setNewGroupEmails('')
      setNewGroupOpen(false)
      await loadGroups()
      selectGroup(id)
    } catch (err) {
      setError(err.message || 'no se pudo crear el grupo')
    } finally {
      setCreatingGroup(false)
    }
  }

  const handleLeaveGroup = async () => {
    if (!activeGroupId) return
    try {
      await leaveGroup(activeGroupId)
      setActiveGroupId(null)
      await loadGroups()
    } catch (err) {
      setError(err.message || 'no se pudo salir del grupo')
    }
  }

  const refreshGroupMembers = async () => {
    const members = await listGroupMembers(activeGroupId)
    setGroupMembers(new Map(members.map((m) => [m.user_id, m.email])))
    return members
  }

  const handleSubmitAddMember = async (event) => {
    event.preventDefault()
    const email = addMemberEmail.trim()
    if (!email || !activeGroupId) return
    setError('')
    setAddingMember(true)
    try {
      const added = await addGroupMember(activeGroupId, email)
      if (!added) {
        setError('Esa persona todavía no se logueó en FlashLab.')
        return
      }
      await refreshGroupMembers()
      setAddMemberEmail('')
      setAddMemberOpen(false)
    } catch (err) {
      setError(err.message || 'no se pudo agregar a esa persona')
    } finally {
      setAddingMember(false)
    }
  }

  const handleRemoveMember = async (userId) => {
    if (!activeGroupId) return
    try {
      await removeGroupMember(activeGroupId, userId)
      await refreshGroupMembers()
    } catch (err) {
      setError(err.message || 'no se pudo quitar a esa persona')
    }
  }

  const handlePickGroupIcon = async (emoji) => {
    if (!activeGroupId) return
    setGroupIconPickerOpen(false)
    try {
      await updateGroupIcon(activeGroupId, emoji)
      setGroups((prev) => prev?.map((g) => (g.id === activeGroupId ? { ...g, icon: emoji } : g)) ?? prev)
    } catch (err) {
      setError(err.message || 'no se pudo cambiar el ícono')
    }
  }

  const handleUploadGroupIcon = async (file) => {
    if (!activeGroupId) return
    setUploadingIcon(true)
    try {
      const url = await uploadGroupIconImage(activeGroupId, file)
      await updateGroupIcon(activeGroupId, url)
      addCustomIcon(url)
      setGroups((prev) => prev?.map((g) => (g.id === activeGroupId ? { ...g, icon: url } : g)) ?? prev)
      setGroupIconPickerOpen(false)
    } catch (err) {
      setError(err.message || 'no se pudo subir la imagen')
    } finally {
      setUploadingIcon(false)
    }
  }

  // sube un adjunto sin bloquear la UI (WhatsApp-style): aparece como
  // burbuja "subiendo…" al final del hilo de SU conversación hasta que
  // termina — recién ahí Realtime trae el mensaje real y esta entrada se
  // descarta. La cola vive en backgroundUploads.js (fuera de React) para
  // seguir corriendo aunque este componente se desmonte — cambiás a otra
  // pestaña con un video pesado subiendo y no se corta. Solo el ✕ de su
  // propia burbuja la cancela (aborta el XHR de verdad, ver uploadWithProgress.js).
  const startBackgroundUpload = (file, previewUrl, kind, targetId) => {
    enqueueUpload({
      kind,
      targetId,
      file,
      previewUrl,
      send: (onProgress, signal) =>
        kind === 'group'
          ? sendGroupAttachment(targetId, file, onProgress, signal)
          : sendAttachment(targetId, file, onProgress, signal),
      onDone: () => {
        // refresca last_message_at para que la lista se reordene con la
        // conversación recién usada
        if (kind === 'group') loadGroups()
        else loadPartners()
      },
      onError: (err) => setError(err.message || `no se pudo adjuntar ${file.name}`),
    })
  }

  const handleSend = async (event) => {
    event.preventDefault()
    const content = draft.trim()

    if (editingMessage) {
      if (!content) return
      setError('')
      setSending(true)
      try {
        if (activeGroupId) await editGroupMessage(editingMessage.id, content)
        else await editMessage(editingMessage.id, content)
        const editedAt = new Date().toISOString()
        setMessages((prev) => prev?.map((m) => (m.id === editingMessage.id ? { ...m, content, edited_at: editedAt } : m)) ?? prev)
      } catch (err) {
        setError(err.message || 'no se pudo editar el mensaje')
      } finally {
        setSending(false)
        setEditingMessage(null)
        setDraft('')
      }
      return
    }

    if ((!activeId && !activeGroupId) || (!content && pendingFiles.length === 0)) return
    setError('')

    // cerrar la vista previa YA y largar los adjuntos en segundo plano —
    // el compositor queda libre para seguir escribiendo/navegando de
    // inmediato, no hace falta esperar a que terminen de subir.
    const filesToSend = pendingFiles
    const kind = activeGroupId ? 'group' : 'dm'
    const targetId = activeGroupId ?? activeId
    setPendingFiles([])
    setPreviewIndex(0)
    filesToSend.forEach(({ file, previewUrl }) => startBackgroundUpload(file, previewUrl, kind, targetId))

    if (content) {
      setSending(true)
      try {
        if (activeGroupId) await sendGroupMessage(activeGroupId, content)
        else await sendMessage(activeId, content)
        if (activeGroupId) loadGroups()
        else loadPartners()
      } catch (err) {
        setError(err.message || 'no se pudo enviar el mensaje')
      } finally {
        setSending(false)
      }
    }
    setDraft('')
  }

  // más historial al scrollear cerca del techo del hilo (ver onScroll más
  // abajo) — antepone la página anterior y corrige scrollTop en el mismo
  // frame para que la vista no "salte" (el contenido nuevo se agrega ARRIBA
  // de lo que estás mirando). skipNextAutoScrollRef evita que el efecto de
  // scroll-al-fondo (pensado para mensajes nuevos) pise esta corrección.
  const loadOlderMessages = async () => {
    if (!messages || messages.length === 0 || loadingMoreRef.current || !hasMoreMessages) return
    loadingMoreRef.current = true
    setLoadingMoreMessages(true)
    const container = threadRef.current
    const prevScrollHeight = container?.scrollHeight ?? 0
    const prevScrollTop = container?.scrollTop ?? 0
    const kind = activeGroupId ? 'group' : 'dm'
    const targetId = activeGroupId ?? activeId
    try {
      const older =
        kind === 'group'
          ? await listGroupMessages(targetId, { before: messages[0].created_at, limit: MESSAGES_PAGE_SIZE })
          : await listMessages(targetId, { before: messages[0].created_at, limit: MESSAGES_PAGE_SIZE })
      // si cambiaste de conversación mientras esto cargaba, descartar — ya
      // no corresponde a lo que estás mirando (setMessages tomaría el
      // `prev` de la conversación NUEVA y le pegaría historial de la vieja)
      const stillSame = kind === 'group' ? activeGroupIdRef.current === targetId : activeIdRef.current === targetId
      if (!stillSame) return
      setHasMoreMessages(older.length === MESSAGES_PAGE_SIZE)
      if (older.length > 0) {
        skipNextAutoScrollRef.current = true
        setMessages((prev) => [...older, ...(prev ?? [])])
        requestAnimationFrame(() => {
          if (container) container.scrollTop = container.scrollHeight - prevScrollHeight + prevScrollTop
        })
      }
    } catch (err) {
      console.error('Error al cargar mensajes anteriores:', err)
    } finally {
      loadingMoreRef.current = false
      setLoadingMoreMessages(false)
    }
  }

  // no manda de una — solo lo agrega al campo de texto, para poder
  // combinarlo con más texto/emoji antes de enviar. El picker se queda
  // abierto (para poder sumar varios seguidos), pero el foco vuelve al
  // campo de texto: si no, quedaba en el botón del emoji recién tocado y
  // Enter no mandaba nada (un <button> no dispara el submit del form).
  const handlePickSticker = (emoji) => {
    setDraft((prev) => prev + emoji)
    draftInputRef.current?.focus()
  }

  const handleOpenMessageMenu = (event, msg) => {
    event.preventDefault()
    setMenuState({ msg, x: event.clientX, y: event.clientY })
  }

  const handleDownloadAttachment = async ({ url, name, driveId, mine }) => {
    try {
      if (driveId && mine) await api.saveAttachmentAs({ driveId, suggestedName: name })
      else if (driveId) await api.openExternal(url)
      else await api.downloadFileFromUrl(url, name)
    } catch (err) {
      setError(err.message || 'No se pudo descargar el archivo.')
    }
  }

  const handleEditStart = () => {
    if (!menuState) return
    setEditingMessage(menuState.msg)
    setDraft(menuState.msg.content)
    setMenuState(null)
  }

  // reemplaza en Drive el .webm crudo por un .mp4 con duración declarada —
  // los videos subidos antes de que el transcode fuera automático no se
  // podían recorrer con la línea de tiempo. Conserva el mismo archivo de
  // Drive, así que el link y los permisos ya repartidos siguen valiendo.
  const handleRepairVideo = async (msg) => {
    setRepairingVideoId(msg.id)
    try {
      await repairVideoAttachment(
        activeGroupId ? 'group_messages' : 'direct_messages',
        msg.id,
        msg.attachment_drive_id,
        msg.attachment_name
      )
      setMessages(
        (prev) =>
          prev?.map((m) =>
            m.id === msg.id
              ? { ...m, attachment_mime: 'video/mp4', attachment_name: String(m.attachment_name ?? 'video').replace(/\.\w+$/, '') + '.mp4' }
              : m
          ) ?? prev
      )
    } catch (err) {
      setError(err.message || 'no se pudo reparar el video')
    } finally {
      setRepairingVideoId(null)
    }
  }

  const handleToggleReactionOnMessage = async (msg, emoji) => {
    try {
      if (activeGroupId) await toggleGroupReaction(msg.id, emoji)
      else await toggleReaction(msg.id, emoji)
    } catch (err) {
      setError(err.message || 'no se pudo reaccionar')
    }
  }

  // la barra de reacciones vive arriba del mismo MessageActionsMenu (no un
  // popup aparte, ver captura del usuario) — elegir un emoji ahí cierra el
  // menú entero, no solo la barra.
  const handleReactFromMenu = (emoji) => {
    if (!menuState) return
    const { msg } = menuState
    setMenuState(null)
    handleToggleReactionOnMessage(msg, emoji)
  }

  const handleForwardStart = () => {
    if (!menuState) return
    setForwardState({ msg: menuState.msg })
    setMenuState(null)
  }

  const handlePickForwardTarget = async (target) => {
    if (!forwardState) return
    const { msg } = forwardState
    setForwardState(null)
    try {
      await forwardMessage(msg, target)
      if (target.kind === 'group') loadGroups()
      else loadPartners()
    } catch (err) {
      setError(err.message || 'no se pudo reenviar el mensaje')
    }
  }

  const handleCopyMessage = () => {
    if (!menuState) return
    const { msg } = menuState
    setMenuState(null)
    if (msg.message_type !== 'attachment') {
      navigator.clipboard.writeText(msg.content || '').catch(() => {})
      return
    }
    const mine = msg.sender_id === myId
    const isImage = msg.attachment_mime?.startsWith('image/')
    if (isImage) {
      api
        .copyAttachmentImage({ driveId: msg.attachment_drive_id && mine ? msg.attachment_drive_id : null, url: msg.attachment_url })
        .catch((err) => setError(err.message || 'no se pudo copiar la imagen'))
    } else {
      navigator.clipboard.writeText(msg.attachment_name || msg.attachment_url || '').catch(() => {})
    }
  }

  const handleSaveAsFromMenu = () => {
    if (!menuState) return
    const { msg } = menuState
    setMenuState(null)
    handleDownloadAttachment({
      url: msg.attachment_url,
      name: msg.attachment_name,
      driveId: msg.attachment_drive_id,
      mine: msg.sender_id === myId,
    })
  }

  const handleOpenWithFromMenu = () => {
    if (!menuState) return
    const { msg } = menuState
    setMenuState(null)
    const mine = msg.sender_id === myId
    if (msg.attachment_drive_id && !mine) {
      api.openExternal(msg.attachment_url).catch(() => {})
      return
    }
    api
      .openAttachmentWith({
        driveId: msg.attachment_drive_id && mine ? msg.attachment_drive_id : null,
        url: msg.attachment_url,
        suggestedName: msg.attachment_name,
      })
      .catch((err) => setError(err.message || 'no se pudo abrir el archivo'))
  }

  const handleHideForMe = async () => {
    if (!menuState) return
    const { msg } = menuState
    setMenuState(null)
    try {
      if (activeGroupId) await hideGroupMessageForMe(msg.id)
      else await hideMessageForMe(msg.id)
      setMessages((prev) => prev?.filter((m) => m.id !== msg.id) ?? prev)
    } catch (err) {
      setError(err.message || 'no se pudo eliminar el mensaje')
    }
  }

  const handleDeleteForEveryone = async () => {
    if (!menuState) return
    const { msg } = menuState
    setMenuState(null)
    try {
      if (activeGroupId) await deleteGroupMessageForEveryone(msg.id)
      else await deleteMessageForEveryone(msg.id)
      setMessages(
        (prev) => prev?.map((m) => (m.id === msg.id ? { ...m, deleted_at: new Date().toISOString(), content: '' } : m)) ?? prev
      )
    } catch (err) {
      setError(err.message || 'no se pudo eliminar el mensaje')
    }
  }

  // cierra la conversación borrada si es la que estoy mirando, y la saca de
  // la lista sin esperar el próximo refresh — en los dos casos (para mí / para
  // los dos) el resultado en MI pantalla es el mismo: el chat desaparece.
  const removeConversationLocally = (otherUserId) => {
    setPartners((prev) => prev?.filter((p) => p.id !== otherUserId) ?? prev)
    if (activeId === otherUserId) closeActiveConversation()
  }

  const handleDeleteConversationForMe = async (item) => {
    setConvMenuState(null)
    try {
      await deleteConversationForMe(item.id)
      removeConversationLocally(item.id)
    } catch (err) {
      setError(err.message || 'no se pudo eliminar el chat')
    }
  }

  const handleDeleteConversationForEveryone = async (item) => {
    setConvMenuState(null)
    try {
      await deleteConversationForEveryone(item.id)
      removeConversationLocally(item.id)
    } catch (err) {
      setError(err.message || 'no se pudo eliminar el chat')
    }
  }

  const handleFiles = (files) => {
    if (!files?.length) return
    const additions = Array.from(files).map((file) => ({
      file,
      previewUrl:
        file.type.startsWith('image/') || file.type.startsWith('video/') ? URL.createObjectURL(file) : null,
    }))
    setPendingFiles((prev) => {
      setPreviewIndex(prev.length) // enfocar el primero de los recién agregados
      return [...prev, ...additions]
    })
  }

  const removePendingFile = (index) => {
    setPendingFiles((prev) => {
      const removed = prev[index]
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      const next = prev.filter((_, i) => i !== index)
      setPreviewIndex((current) => Math.min(current, next.length - 1))
      return next
    })
  }

  const cancelAllPendingFiles = () => {
    pendingFiles.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
    setPendingFiles([])
    setPreviewIndex(0)
  }

  // mantener presionado el 🎤 para grabar, soltar para mandar — mismo patrón
  // que WhatsApp. Un toque accidental (menos de 400ms) se descarta en vez de
  // mandar un audio casi vacío. Deslizar hacia arriba antes de soltar
  // "bloquea" la grabación (ver updateMicDrag) — también mismo patrón.
  const startRecording = async (event) => {
    event.preventDefault()
    if (recordingRef.current || !hasActiveConversation) return
    recordingRef.current = true
    micStartYRef.current = event.touches?.[0]?.clientY ?? event.clientY ?? null
    micLockedRef.current = false
    setMicLocked(false)
    setMicDragProgress(0)
    try {
      const { stream, deviceId } = await openMicrophone()
      // recordar cuál anduvo para no volver a pagar el timeout del
      // dispositivo roto en cada grabación (ver openMicrophone).
      rememberMicId(deviceId)
      // si en el ratito que tardó getUserMedia en resolver ya se soltó el
      // botón (toque rapidísimo) o se cambió de conversación, no arrancar
      // una grabación que nadie va a parar nunca — soltar el micrófono ya.
      if (!recordingRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      recordStreamRef.current = stream
      recordChunksRef.current = []
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined // dejar que el navegador elija un formato soportado
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordChunksRef.current.push(e.data)
      }
      recorder.onerror = (e) => {
        console.error('Error del MediaRecorder:', e.error)
      }
      recorder.start()
      mediaRecorderRef.current = recorder
      recordStartRef.current = Date.now()
      setRecordSeconds(0)
      recordTimerIdRef.current = setInterval(
        () => setRecordSeconds(Math.floor((Date.now() - recordStartRef.current) / 1000)),
        250
      )
      setRecording(true)
    } catch (err) {
      recordingRef.current = false
      console.error('No se pudo abrir el micrófono:', err)
      setError(micErrorMessage(err))
    }
  }
  // React adjunta onTouchStart de JSX como listener PASIVO por defecto (para
  // no bloquear el scroll) — dentro de uno pasivo, el event.preventDefault()
  // de arriba no hace nada, y el WebView interpreta el mantener-presionado
  // como long-press nativo: selección de texto + menú Copiar/Cortar/Pegar (a
  // veces con teclado incluido), tapando el gesto de "mantené para grabar".
  // Por eso el botón NO usa onTouchStart de JSX: este ref registra el mismo
  // listener a mano con {passive:false} apenas el botón se monta, así el
  // preventDefault sí cancela el comportamiento nativo. startRecordingRef
  // evita que ese listener (registrado una sola vez) quede con una closure
  // vieja de startRecording.
  startRecordingRef.current = startRecording

  // 80px de deslizamiento hacia arriba sin soltar = bloqueada (mismo orden
  // de magnitud que WhatsApp, no hay un estándar exacto). micDragProgress
  // (0..1) es solo para animar el candado mientras se arrastra.
  const MIC_LOCK_DISTANCE = 80

  const updateMicDrag = (clientY) => {
    if (micStartYRef.current == null || micLockedRef.current || clientY == null) return
    const delta = Math.max(0, micStartYRef.current - clientY) // solo cuenta hacia arriba
    setMicDragProgress(Math.min(1, delta / MIC_LOCK_DISTANCE))
    if (delta >= MIC_LOCK_DISTANCE) {
      micLockedRef.current = true
      setMicLocked(true)
    }
  }

  const endMicDrag = () => {
    micStartYRef.current = null
    setMicDragProgress(0)
  }

  // force=true: viene del botón "Enviar" explícito que aparece con la
  // grabación bloqueada — ahí SÍ hay que cortar pase lo que pase, a
  // diferencia de soltar el dedo/mouse (mouseup/touchend), que con el
  // gesto bloqueado no debe cortar nada todavía.
  const stopRecordingAndSend = async (event, { force = false } = {}) => {
    event?.preventDefault()
    if (micLockedRef.current && !force) {
      endMicDrag()
      return
    }
    micLockedRef.current = false
    setMicLocked(false)
    endMicDrag()
    // sin condición: aunque todavía no haya recorder (soltaste el botón
    // mientras getUserMedia seguía esperando el permiso), esto tiene que
    // avisarle a startRecording que ya no siga — si no, recordingRef queda
    // en true para siempre y ninguna grabación futura vuelve a arrancar.
    recordingRef.current = false
    const recorder = mediaRecorderRef.current
    if (!recorder) return
    // cortar la referencia YA, antes de cualquier await: si dos llamadas
    // (p. ej. touchend y el mouseup sintético del mismo toque) llegan para
    // la misma grabación, una segunda concurrente tiene que ver
    // mediaRecorderRef.current === null y abortar por el guard de arriba —
    // si no, las dos terminan compartiendo el mismo recorder.onstop y se
    // pisan, dando un audio vacío/roto.
    mediaRecorderRef.current = null
    const stream = recordStreamRef.current
    recordStreamRef.current = null
    const elapsed = Date.now() - recordStartRef.current
    clearInterval(recordTimerIdRef.current)
    const blob = await new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(recordChunksRef.current, { type: 'audio/webm' }))
      recorder.stop()
    })
    stream?.getTracks().forEach((t) => t.stop())
    setRecording(false)
    setRecordSeconds(0)
    if (elapsed < 400) return // toque accidental
    // grabación vacía/corrupta (mismo síntoma que el bug de arriba, o el
    // micrófono se desconectó a mitad de grabación): mejor avisar que
    // mandar un audio de 0:00 que después no reproduce.
    if (blob.size < 1024) {
      setError('La grabación quedó vacía, probá de nuevo.')
      return
    }

    const file = new File([blob], `audio-${Date.now()}.webm`, { type: 'audio/webm' })
    setError('')
    if (activeGroupId) {
      startBackgroundUpload(file, null, 'group', activeGroupId)
    } else {
      startBackgroundUpload(file, null, 'dm', activeId)
    }
  }
  stopRecordingRef.current = stopRecordingAndSend
  updateMicDragRef.current = updateMicDrag

  const cancelRecording = (event) => {
    event?.preventDefault()
    micLockedRef.current = false
    setMicLocked(false)
    endMicDrag()
    recordingRef.current = false
    const recorder = mediaRecorderRef.current
    if (!recorder) return
    mediaRecorderRef.current = null
    const stream = recordStreamRef.current
    recordStreamRef.current = null
    clearInterval(recordTimerIdRef.current)
    recorder.stop()
    stream?.getTracks().forEach((t) => t.stop())
    setRecording(false)
    setRecordSeconds(0)
  }

  // callback ref: se dispara con el nodo al montar el botón y (React 19)
  // con null al desmontar, así el listener nativo se registra/limpia justo
  // cuando el botón de mic aparece/desaparece (alterna con el de "Enviar"
  // según haya texto en el draft — ver el JSX más abajo).
  const micButtonRef = useCallback((node) => {
    if (!node) return
    const onTouchStart = (event) => startRecordingRef.current?.(event)
    node.addEventListener('touchstart', onTouchStart, { passive: false })
    return () => node.removeEventListener('touchstart', onTouchStart)
  }, [])

  const totalUnread = (id) => unread.get(id) ?? 0
  const hasActiveConversation = Boolean(activeId || activeGroupId)

  // Android: el botón de atrás del sistema, sin un listener propio, minimiza
  // la app directo (no hay historial de navegación real, es un SPA) — acá
  // se le da el mismo comportamiento de "un nivel a la vez" que el botón ←
  // de arriba: primero cierra el panel de info (ChatInfoPanel, chatInfoOpen)
  // si está abierto, si no cierra la conversación activa y vuelve a la
  // lista. Si no hay nada de eso abierto, se deja el comportamiento nativo
  // de siempre (atrás/minimizar). OJO: NO es `settingsOpen` — ese es un
  // popover chiquito aparte (confirmaciones de lectura), no el panel de
  // información del chat.
  // sidebarOpen: el cajón del sidebar tapa el chat por completo cuando está
  // abierto (ver App.jsx) — ahí el back debe cerrar SOLO el cajón, no
  // también un nivel de acá abajo de un mismo click (App.jsx tiene su
  // propio listener de 'backButton' para el cajón; Capacitor llama a TODOS
  // los listeners registrados en cada click, no hay forma de "cancelar" los
  // demás, así que la única manera de que no se disparen los dos a la vez
  // es que este se quede quieto mientras el cajón está abierto).
  useEffect(() => {
    if (!IS_CAPACITOR) return undefined
    const subPromise = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      if (sidebarOpen) return
      if (chatInfoOpen) {
        setChatInfoOpen(false)
        return
      }
      if (hasActiveConversation) {
        closeActiveConversation()
        return
      }
      if (canGoBack) window.history.back()
      else CapacitorApp.exitApp()
    })
    return () => {
      subPromise.then((sub) => sub.remove())
    }
  }, [chatInfoOpen, hasActiveConversation, sidebarOpen])
  const activeGroup = activeGroupId ? groups?.find((g) => g.id === activeGroupId) : null
  const isGroupCreator = activeGroup?.created_by === myId
  // solo las de ESTA conversación — el resto sigue subiendo en segundo
  // plano igual, simplemente no se muestran hasta volver a esa conversación
  const activeUploads = backgroundUploads.filter((u) =>
    activeGroupId ? u.kind === 'group' && u.targetId === activeGroupId : u.kind === 'dm' && u.targetId === activeId
  )

  // doble check azul: en DM, que la otra persona haya leído hasta después
  // de este mensaje; en grupo, que TODOS los demás miembros lo hayan hecho
  // (mismo criterio que WhatsApp) — msg.created_at es un timestamp de
  // Postgres, comparar como Date así da igual el formato exacto de string.
  const isMessageRead = (msg) => {
    const sentAt = new Date(msg.created_at).getTime()
    if (activeGroupId) {
      const others = [...groupMembers.keys()].filter((id) => id !== msg.sender_id)
      if (others.length === 0) return false
      return others.every((id) => {
        const lastRead = groupReads.get(id)
        return lastRead && new Date(lastRead).getTime() >= sentAt
      })
    }
    return (
      partnerReadReceiptsEnabled && Boolean(partnerLastRead) && new Date(partnerLastRead).getTime() >= sentAt
    )
  }

  // DMs y grupos, en una sola lista ordenada por el mensaje más reciente —
  // antes eran dos secciones separadas ("Grupos" aparte) que se sentían
  // como si el chat tuviera dos sistemas distintos en vez de uno solo.
  const conversationItems =
    partners && groups
      ? [
          ...partners.map((p) => ({ type: 'dm', id: p.id, name: p.email, lastMessageAt: p.last_message_at })),
          ...groups.map((g) => ({ type: 'group', id: g.id, name: g.name, icon: g.icon, lastMessageAt: g.last_message_at })),
        ].sort((a, b) => new Date(b.lastMessageAt ?? 0) - new Date(a.lastMessageAt ?? 0))
      : null

  if (!myId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-neutral-500">Cargando…</div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex h-10 shrink-0 items-center justify-between px-6 ${insetLeft ? 'pl-14' : ''}`}>
        <span className="text-sm font-medium text-gray-700 dark:text-neutral-200">Chat</span>
        <div ref={settingsAreaRef} className="relative">
          {settingsOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              <label className="flex cursor-pointer items-start justify-between gap-3">
                <span>
                  <span className="block text-sm text-gray-700 dark:text-neutral-200">Confirmaciones de lectura</span>
                  <span className="mt-0.5 block text-xs text-gray-400 dark:text-neutral-500">
                    Si la apagás, nadie ve el doble check azul cuando abrís sus mensajes. Solo aplica a chats 1:1 — en
                    grupos siempre se confirma la lectura.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={readReceiptsEnabled}
                  onChange={toggleReadReceipts}
                  className="mt-0.5 shrink-0 cursor-pointer"
                />
              </label>
            </div>
          )}
          <button
            type="button"
            aria-label="Configuración del chat"
            title="Configuración del chat"
            onClick={() => setSettingsOpen((v) => !v)}
            className="cursor-pointer rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            ⚙️
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          style={isMobile ? undefined : { width: sidebarWidth }}
          className={
            isMobile
              ? `flex-col border-gray-200 bg-gray-50 dark:border-neutral-800 dark:bg-[#202020] ${
                  hasActiveConversation ? 'hidden' : 'flex w-full'
                }`
              : 'relative flex shrink-0 flex-col border-r border-gray-200 bg-gray-50 dark:border-neutral-800 dark:bg-[#202020]'
          }
        >
          <div className="flex items-center gap-1.5 p-2">
            <form onSubmit={handleStart} className="flex min-w-0 flex-1 gap-1.5">
              <input
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                placeholder="Nueva conversación (email)"
                className="min-w-0 flex-1 rounded-md border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none dark:border-neutral-700"
              />
              <button
                type="submit"
                disabled={starting || !newEmail.trim()}
                className="shrink-0 cursor-pointer rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              >
                Ir
              </button>
            </form>
            <button
              type="button"
              aria-label="Nuevo grupo"
              title="Nuevo grupo"
              onClick={() => setNewGroupOpen((v) => !v)}
              className={`shrink-0 cursor-pointer rounded-md p-1.5 text-sm hover:bg-gray-100 dark:hover:bg-neutral-800 ${
                newGroupOpen ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-neutral-300'
              }`}
            >
              👥+
            </button>
          </div>
          {newGroupOpen && (
            <form onSubmit={handleCreateGroup} className="mx-2 mb-2 flex flex-col gap-1.5 rounded-md border border-gray-200 p-2 dark:border-neutral-700">
              <input
                autoFocus
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                placeholder="Nombre del grupo"
                className="rounded-md border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none dark:border-neutral-700"
              />
              <input
                value={newGroupEmails}
                onChange={(event) => setNewGroupEmails(event.target.value)}
                placeholder="Emails separados por coma"
                className="rounded-md border border-gray-200 bg-transparent px-2 py-1 text-xs outline-none dark:border-neutral-700"
              />
              <button
                type="submit"
                disabled={creatingGroup || !newGroupName.trim()}
                className="cursor-pointer rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
              >
                Crear grupo
              </button>
            </form>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {conversationItems === null && <p className="px-2 py-1 text-xs text-gray-400 dark:text-neutral-500">Cargando…</p>}
            {conversationItems?.length === 0 && (
              <p className="px-2 py-1 text-xs italic text-gray-400 dark:text-neutral-500">
                Todavía no tenés conversaciones.
              </p>
            )}
            {conversationItems?.map((item) => {
              const active = item.type === 'group' ? activeGroupId === item.id : activeId === item.id
              return (
                <button
                  key={`${item.type}-${item.id}`}
                  type="button"
                  onClick={() => (item.type === 'group' ? selectGroup(item.id) : selectDm(item.id))}
                  onContextMenu={(event) => {
                    if (item.type !== 'dm') return
                    event.preventDefault()
                    setConvMenuState({ item, x: event.clientX, y: event.clientY })
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                    active
                      ? 'bg-gray-200 text-gray-800 dark:bg-neutral-700 dark:text-neutral-100'
                      : 'text-gray-600 hover:bg-gray-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                  }`}
                >
                  <ConversationAvatar item={item} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.type === 'dm' && totalUnread(item.id) > 0 && (
                    <span className="shrink-0 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      {totalUnread(item.id)}
                    </span>
                  )}
                  {item.lastMessageAt && (
                    <span className="shrink-0 text-[10px] text-gray-400 dark:text-neutral-500">
                      {formatRelative(item.lastMessageAt)}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {convMenuState && (
            <ConversationActionsMenu
              x={convMenuState.x}
              y={convMenuState.y}
              onDeleteForMe={() => handleDeleteConversationForMe(convMenuState.item)}
              onDeleteForEveryone={() => handleDeleteConversationForEveryone(convMenuState.item)}
              onClose={() => setConvMenuState(null)}
            />
          )}
          {!isMobile && (
            <ChatSidebarResizeHandle
              width={sidebarWidth}
              onResize={setSidebarWidth}
              onCommit={(next) => {
                setSidebarWidth(next)
                localStorage.setItem(CHAT_SIDEBAR_WIDTH_KEY, String(next))
              }}
            />
          )}
        </div>

        <div
          className={`relative min-w-0 flex-1 flex-col ${isMobile && !hasActiveConversation ? 'hidden' : 'flex'}`}
          onDragOver={(event) => {
            if (!hasActiveConversation) return
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragging(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            if (hasActiveConversation) handleFiles(event.dataTransfer.files)
          }}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-blue-400 bg-blue-50/80 text-sm font-medium text-blue-600 dark:bg-blue-950/60 dark:text-blue-300">
              Soltá para adjuntar
            </div>
          )}
          {!hasActiveConversation ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-gray-400 dark:text-neutral-500">
              <span className="text-4xl">💬</span>
              <p className="text-sm">Elegí una conversación de la lista</p>
              <p className="text-xs">o escribí un email arriba para empezar una nueva</p>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-4 py-2.5 dark:border-neutral-700">
                <div className="flex min-w-0 items-center gap-2">
                  {isMobile && (
                    <button
                      type="button"
                      aria-label="Volver a la lista de conversaciones"
                      onClick={closeActiveConversation}
                      className="-ml-1 shrink-0 cursor-pointer rounded-full p-1.5 text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                    >
                      ←
                    </button>
                  )}
                  {activeGroupId ? (
                    <div ref={groupIconAreaRef} className="relative shrink-0">
                      {groupIconPickerOpen && (
                        <div className="absolute left-0 top-full z-30 mt-1">
                          <GroupIconPicker
                            onPickEmoji={handlePickGroupIcon}
                            onUploadImage={handleUploadGroupIcon}
                            uploading={uploadingIcon}
                          />
                        </div>
                      )}
                      <button
                        type="button"
                        aria-label="Cambiar ícono del grupo"
                        title="Cambiar ícono del grupo"
                        onClick={() => setGroupIconPickerOpen((v) => !v)}
                        className="flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-gray-100 text-lg hover:ring-2 hover:ring-gray-300 dark:bg-neutral-800 dark:hover:ring-neutral-600"
                      >
                        {activeGroup?.icon ? (
                          isImageIcon(activeGroup.icon) ? (
                            <img src={activeGroup.icon} alt="" className="h-full w-full object-cover" />
                          ) : (
                            activeGroup.icon
                          )
                        ) : (
                          '👥'
                        )}
                      </button>
                    </div>
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-sm font-semibold text-gray-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {(knownEmails.get(activeId) ?? '?').charAt(0).toUpperCase()}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setChatInfoOpen(true)}
                    className="min-w-0 cursor-pointer truncate text-left text-sm font-semibold text-gray-800 hover:underline dark:text-neutral-100"
                  >
                    {activeGroupId ? activeGroup?.name : knownEmails.get(activeId) ?? activeId}
                  </button>
                </div>
                <button
                  type="button"
                  aria-label={activeGroupId ? 'Información del grupo' : 'Información del chat'}
                  title={activeGroupId ? 'Información del grupo' : 'Información del chat'}
                  onClick={() => setChatInfoOpen(true)}
                  className="shrink-0 cursor-pointer rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                >
                  ℹ️
                </button>
              </div>
              <div
                ref={threadRef}
                onScroll={(event) => {
                  if (event.currentTarget.scrollTop < 100) loadOlderMessages()
                }}
                className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
                style={chatBackgroundStyle(wallpaperUrl)}
              >
                {loadingMoreMessages && (
                  <div className="flex justify-center pb-2">
                    <Spinner className="h-3.5 w-3.5 text-gray-400 dark:text-neutral-500" />
                  </div>
                )}
                {messages === null && !messagesError && (
                  <div className="flex justify-center py-6">
                    <span className="flex items-center gap-2 rounded-full bg-black/10 px-3 py-1.5 text-xs font-medium text-gray-600 dark:bg-white/10 dark:text-neutral-300">
                      <Spinner className="h-3.5 w-3.5" />
                      Cargando mensajes…
                    </span>
                  </div>
                )}
                {messagesError && (
                  <div className="flex justify-center py-6">
                    <div className="flex flex-col items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-center text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
                      <span>{messagesError}</span>
                      <button
                        type="button"
                        onClick={() => setReloadTick((t) => t + 1)}
                        className="cursor-pointer rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
                      >
                        Reintentar
                      </button>
                    </div>
                  </div>
                )}
                {visibleMessages?.length === 0 && (
                  <p className="text-xs italic text-gray-400 dark:text-neutral-500">
                    Todavía no hay mensajes. Escribí el primero.
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  {visibleMessages?.map((m, i, arr) => {
                    const prev = arr[i - 1]
                    const showDivider = !prev || dayKey(prev.created_at) !== dayKey(m.created_at)
                    return (
                      <div key={m.id}>
                        {showDivider && (
                          <div className="my-2 flex justify-center">
                            <span className="rounded-full bg-black/10 px-2.5 py-1 text-[11px] font-medium text-gray-500 dark:bg-white/10 dark:text-neutral-400">
                              {formatDateDivider(m.created_at)}
                            </span>
                          </div>
                        )}
                        <MessageBubble
                          msg={m}
                          mine={m.sender_id === myId}
                          read={m.sender_id === myId && isMessageRead(m)}
                          senderLabel={activeGroupId ? groupMembers.get(m.sender_id) ?? m.sender_id : null}
                          onContextMenu={handleOpenMessageMenu}
                          onPreviewAttachment={setPreviewAttachment}
                          onDownloadAttachment={handleDownloadAttachment}
                          onRepairVideo={handleRepairVideo}
                          repairing={repairingVideoId === m.id}
                          reactionsForMsg={reactions.get(m.id)}
                          myId={myId}
                          onToggleReaction={(emoji) => handleToggleReactionOnMessage(m, emoji)}
                        />
                      </div>
                    )
                  })}
                  {activeUploads.map((upload) => (
                    <PendingUploadBubble key={upload.id} upload={upload} onCancel={() => cancelUpload(upload.id)} />
                  ))}
                </div>
                <div ref={bottomRef} />
                {menuState && (
                  <MessageActionsMenu
                    msg={menuState.msg}
                    x={menuState.x}
                    y={menuState.y}
                    mine={menuState.msg.sender_id === myId}
                    onEdit={handleEditStart}
                    onHideForMe={handleHideForMe}
                    onDeleteForEveryone={handleDeleteForEveryone}
                    onReact={handleReactFromMenu}
                    onForward={handleForwardStart}
                    onCopy={handleCopyMessage}
                    onSaveAs={handleSaveAsFromMenu}
                    onOpenWith={handleOpenWithFromMenu}
                    onClose={() => setMenuState(null)}
                  />
                )}
                {forwardState && (
                  <ForwardPicker
                    partners={partners ?? []}
                    groups={groups ?? []}
                    onPick={handlePickForwardTarget}
                    onClose={() => setForwardState(null)}
                  />
                )}
              </div>
              {previewAttachment && (
                <div className="absolute inset-0 z-30 flex flex-col bg-neutral-900/97">
                  <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3 text-white">
                    <button
                      type="button"
                      aria-label="Cerrar vista previa"
                      onClick={() => setPreviewAttachment(null)}
                      className="shrink-0 cursor-pointer rounded-full p-1.5 hover:bg-white/10"
                    >
                      ✕
                    </button>
                    <p className="min-w-0 flex-1 truncate text-center text-sm font-medium">{previewAttachment.name}</p>
                    <button
                      type="button"
                      aria-label="Descargar"
                      title="Descargar"
                      onClick={() => handleDownloadAttachment(previewAttachment.download)}
                      className="shrink-0 cursor-pointer rounded-full p-1.5 hover:bg-white/10"
                    >
                      ⬇️
                    </button>
                  </div>
                  <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
                    {previewAttachment.type === 'image' ? (
                      <img src={previewAttachment.url} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
                    ) : (
                      <iframe
                        src={previewAttachment.url}
                        title={previewAttachment.name || 'Documento'}
                        className="h-full w-full rounded-lg bg-white"
                      />
                    )}
                  </div>
                </div>
              )}
              {pendingFiles.length > 0 && (
                <AttachmentPreviewOverlay
                  pendingFiles={pendingFiles}
                  previewIndex={previewIndex}
                  onSelectPreview={setPreviewIndex}
                  onRemove={removePendingFile}
                  onCancelAll={cancelAllPendingFiles}
                  onAddMore={() => fileInputRef.current?.click()}
                  draft={draft}
                  setDraft={setDraft}
                  onSend={handleSend}
                />
              )}
              {chatInfoOpen && (
                <ChatInfoPanel
                  isGroup={Boolean(activeGroupId)}
                  chatName={activeGroupId ? activeGroup?.name ?? '' : knownEmails.get(activeId) ?? activeId ?? ''}
                  members={[...groupMembers.entries()].map(([user_id, email]) => ({ user_id, email }))}
                  messages={visibleMessages ?? []}
                  isCreator={isGroupCreator}
                  myId={myId}
                  onRemoveMember={handleRemoveMember}
                  onLeave={handleLeaveGroup}
                  onClose={() => setChatInfoOpen(false)}
                  onOpenAddMember={() => {
                    setChatInfoOpen(false)
                    setAddMemberOpen(true)
                  }}
                  wallpaperUrl={wallpaperUrl}
                  uploadingWallpaper={uploadingWallpaper}
                  onUploadWallpaper={handleUploadWallpaper}
                  onResetWallpaper={handleResetWallpaper}
                  wallpaperGallery={wallpaperGallery}
                  onPickWallpaperFromGallery={handlePickWallpaperFromGallery}
                  onDeleteWallpaperFromGallery={handleDeleteWallpaperFromGallery}
                  deletingWallpaperId={deletingWallpaperId}
                />
              )}
              {addMemberOpen && (
                <>
                  <div className="absolute inset-0 z-30 bg-black/20" onClick={() => setAddMemberOpen(false)} />
                  <div className="absolute left-1/2 top-1/3 z-40 w-full max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
                    <p className="mb-3 text-sm font-semibold text-gray-800 dark:text-neutral-100">Agregar miembro</p>
                    <form onSubmit={handleSubmitAddMember} className="flex flex-col gap-2">
                      <input
                        autoFocus
                        type="email"
                        value={addMemberEmail}
                        onChange={(event) => setAddMemberEmail(event.target.value)}
                        placeholder="email@ejemplo.com"
                        className="rounded-md border border-gray-200 bg-transparent px-2 py-1.5 text-sm outline-none dark:border-neutral-700"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setAddMemberOpen(false)}
                          className="cursor-pointer rounded-md px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                        >
                          Cancelar
                        </button>
                        <button
                          type="submit"
                          disabled={addingMember || !addMemberEmail.trim()}
                          className="cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                        >
                          Agregar
                        </button>
                      </div>
                    </form>
                  </div>
                </>
              )}
              {editingMessage && (
                <div className="flex shrink-0 items-center justify-between border-t border-gray-100 bg-blue-50 px-4 py-1.5 text-xs text-blue-700 dark:border-neutral-800 dark:bg-blue-950/40 dark:text-blue-300">
                  <span>✏️ Editando mensaje</span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingMessage(null)
                      setDraft('')
                    }}
                    className="cursor-pointer hover:underline"
                  >
                    Cancelar
                  </button>
                </div>
              )}
              <form
                onSubmit={handleSend}
                className="flex shrink-0 items-center gap-2 border-t border-gray-100 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    handleFiles(event.target.files)
                    event.target.value = ''
                  }}
                />
                <button
                  type="button"
                  aria-label="Adjuntar archivo"
                  title="Adjuntar archivo"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={Boolean(editingMessage)}
                  className="shrink-0 cursor-pointer rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-default disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                >
                  📎
                </button>
                <div ref={stickerAreaRef} className="relative shrink-0">
                  {stickersOpen && (
                    <div className="absolute bottom-full left-0 mb-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                      <StickerPicker onPick={handlePickSticker} />
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label="Stickers"
                    title="Stickers"
                    onClick={() => setStickersOpen((v) => !v)}
                    disabled={Boolean(editingMessage)}
                    className={`cursor-pointer rounded-md p-1.5 hover:bg-gray-100 disabled:cursor-default disabled:opacity-30 dark:hover:bg-neutral-800 ${
                      stickersOpen ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-neutral-300'
                    }`}
                  >
                    🙂
                  </button>
                </div>
                {recording ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-600" aria-hidden="true" />
                    <span className="tabular-nums">Grabando… {formatElapsed(recordSeconds)}</span>
                    {/* candado del slide-to-lock (mismo gesto que WhatsApp):
                        tenue al arrancar, se va intensificando con el
                        arrastre hacia arriba, opaco del todo una vez
                        bloqueada — mismo indicador sirve para dar la pista
                        ("hay algo acá arriba") y para confirmar el estado. */}
                    <span
                      className="ml-auto shrink-0 text-sm transition-opacity"
                      style={{ opacity: micLocked ? 1 : 0.35 + micDragProgress * 0.65 }}
                      title={micLocked ? 'Grabación bloqueada' : 'Deslizá el 🎤 hacia arriba para bloquear'}
                      aria-hidden="true"
                    >
                      🔒
                    </span>
                    <button
                      type="button"
                      onClick={cancelRecording}
                      className="shrink-0 cursor-pointer text-xs text-red-500 hover:underline dark:text-red-400"
                    >
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <input
                    ref={draftInputRef}
                    // en mobile, autoFocus dispara el teclado en pantalla apenas
                    // se entra a la conversación, tapando media pantalla sin que
                    // el usuario haya tocado nada todavía (mismo criterio que
                    // autoFocus={!isMobile} en SelectCellPopover, DatabaseView.jsx)
                    autoFocus={!isMobile}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="Escribí un mensaje…"
                    className="min-w-0 flex-1 rounded-md border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-800"
                  />
                )}
                {editingMessage || draft.trim() || pendingFiles.length > 0 ? (
                  <button
                    type="submit"
                    disabled={sending || (editingMessage && !draft.trim())}
                    className="shrink-0 cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                  >
                    Enviar
                  </button>
                ) : recording && micLocked ? (
                  // grabación bloqueada: el dedo/mouse ya se soltó, no hay
                  // nada que "mantener presionado" — el corte ahora es un
                  // click explícito (force:true, ver stopRecordingAndSend).
                  <button
                    type="button"
                    aria-label="Enviar audio"
                    title="Enviar audio"
                    onClick={() => stopRecordingAndSend(null, { force: true })}
                    disabled={sending}
                    className="shrink-0 cursor-pointer rounded-full bg-blue-600 p-2 text-white hover:bg-blue-700 disabled:opacity-40"
                  >
                    ➤
                  </button>
                ) : (
                  <button
                    ref={micButtonRef}
                    type="button"
                    aria-label="Mantené presionado para grabar un audio (deslizá hacia arriba para bloquear)"
                    title="Mantené presionado para grabar un audio (deslizá hacia arriba para bloquear)"
                    onMouseDown={startRecording}
                    // red de seguridad para soltar el mouse ANTES de que
                    // `recording` llegue a true (mientras openMicrophone
                    // todavía resuelve) — el listener de documento de más
                    // arriba recién se registra cuando recording ya es true,
                    // así que ese primer instante solo lo cubre este handler
                    // (inofensivo si se duplica con el de documento: mismo
                    // guard mediaRecorderRef.current===null de siempre).
                    onMouseUp={stopRecordingAndSend}
                    onTouchMove={(event) => updateMicDrag(event.touches?.[0]?.clientY)}
                    onTouchEnd={stopRecordingAndSend}
                    onContextMenu={(event) => event.preventDefault()}
                    disabled={sending}
                    className={`shrink-0 cursor-pointer select-none touch-none rounded-full p-2 text-white [-webkit-touch-callout:none] disabled:opacity-40 ${
                      recording ? 'bg-red-600' : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    🎤
                  </button>
                )}
              </form>
            </>
          )}
        </div>
      </div>
      {error && <p className="shrink-0 px-4 py-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
