import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient.js'
import { uploadFileToDrive, shareDriveFileWithRecipients, deleteDriveFile } from './driveAttachmentUpload.js'

// Chat 1:1 (v1 — sin grupos todavía). Mensajes van directo a Supabase,
// igual que las páginas desde la Fase B — sendAttachment y
// uploadChatWallpaper pasan por Electron (Drive necesita el proceso main,
// ver driveAttachmentUpload.js).

const MESSAGE_COLUMNS =
  'id, sender_id, recipient_id, content, created_at, message_type, attachment_url, attachment_drive_id, attachment_name, attachment_mime, deleted_at, edited_at'

// mensajes por página al abrir un chat / al cargar más scrolleando hacia
// arriba — evita traer una conversación entera de una sola vez.
export const MESSAGES_PAGE_SIZE = 40

// mismo orden siempre para los dos participantes — se usa como carpeta en
// Storage (chat-attachments) y como nombre del canal de Realtime
function pairKey(a, b) {
  return [a, b].sort().join('_')
}

async function currentUserId() {
  const { data } = await supabase.auth.getSession()
  const id = data.session?.user?.id
  if (!id) throw new Error('No hay sesión activa')
  return id
}

// fondo de chat propio — QUÉ fondo va en cada conversación sigue siendo
// exclusivo de esa conversación (la clave por chat vive en chatWallpaper.js,
// en localStorage, eso no cambia). El archivo en sí ahora va a Drive
// (carpeta FlashLab/Wallpapers) en vez de Supabase Storage, y cada subida
// se guarda en custom_wallpapers — así se puede ofrecer como opción
// reusable al elegir el fondo de OTRA conversación (ver listCustomWallpapers).
// devuelve el ID del archivo en Drive, no una URL: cómo se muestra depende
// de la plataforma (driveasset:// en Electron, blob URL en la web), así que
// resolverlo es responsabilidad de quien lo renderiza —
// resolveDriveDisplayUrl() en driveAttachmentUpload.js.
export async function uploadChatWallpaper(file) {
  const { fileId } = await uploadFileToDrive(['Wallpapers'], file)
  const myId = await currentUserId()
  const { error } = await supabase
    .from('custom_wallpapers')
    .upsert({ user_id: myId, drive_file_id: fileId }, { onConflict: 'user_id,drive_file_id' })
  if (error) console.error('no se pudo guardar el fondo en la galería:', error)
  return fileId
}

// fondos ya subidos alguna vez, más reciente primero — para la galería que
// se ofrece al elegir el fondo de una conversación. Devuelve IDs de Drive.
export async function listCustomWallpapers() {
  const myId = await currentUserId()
  const { data, error } = await supabase
    .from('custom_wallpapers')
    .select('drive_file_id')
    .eq('user_id', myId)
    .order('created_at', { ascending: false })
    .limit(40)
  if (error) throw error
  return data.map((row) => row.drive_file_id)
}

// borra el archivo real de Drive primero (más propenso a fallar por red/
// permisos) y solo si eso funcionó saca la fila de la galería — al revés,
// una falla de red en el borrado de Drive dejaría la galería "olvidando" un
// fondo cuyo archivo en realidad sigue ocupando espacio, sin que el usuario
// se entere.
export async function deleteCustomWallpaper(fileId) {
  const myId = await currentUserId()
  await deleteDriveFile(fileId)
  const { error } = await supabase.from('custom_wallpapers').delete().eq('user_id', myId).eq('drive_file_id', fileId)
  if (error) throw error
}

export async function findUserIdByEmail(email) {
  const { data, error } = await supabase.rpc('find_user_id_by_email', { target_email: email.trim().toLowerCase() })
  if (error) throw error
  return data ?? null
}

// [{ id, email, last_message_at }] — gente con la que ya hay al menos un mensaje cruzado
export async function listConversationPartners() {
  const { data, error } = await supabase.rpc('get_conversation_partner_emails')
  if (error) throw error
  return data ?? []
}

// [{ other_user_id, unread_count }]
export async function getUnreadCounts() {
  const { data, error } = await supabase.rpc('get_unread_counts')
  if (error) throw error
  return data ?? []
}

export async function markConversationRead(otherUserId) {
  const myId = await currentUserId()
  const { error } = await supabase
    .from('direct_message_reads')
    .upsert({ user_id: myId, other_user_id: otherUserId, last_read_at: new Date().toISOString() })
  if (error) throw error
}

// hasta dónde leyó la OTRA persona lo que yo le mandé — para pintar el
// doble check azul en mis propios mensajes (ver migración 0015: sin ese
// relax de policy esto siempre devolvía null, RLS solo dejaba ver la fila
// propia).
export async function getPartnerLastRead(otherUserId) {
  const myId = await currentUserId()
  const { data, error } = await supabase
    .from('direct_message_reads')
    .select('last_read_at')
    .eq('user_id', otherUserId)
    .eq('other_user_id', myId)
    .maybeSingle()
  if (error) throw error
  return data?.last_read_at ?? null
}

// filtra por user_id nomás (postgres_changes no soporta un AND compuesto en
// `filter`) y se descarta client-side si no es el par de conversación que
// nos importa — mismo patrón que subscribeToConversation.
export function subscribeToPartnerRead(myId, otherUserId, onChange) {
  const channel = supabase
    .channel(`dm-read-${pairKey(myId, otherUserId)}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'direct_message_reads', filter: `user_id=eq.${otherUserId}` },
      (payload) => {
        if (payload.new?.other_user_id === myId) onChange(payload.new.last_read_at)
      }
    )
    .subscribe()
  return () => supabase.removeChannel(channel)
}

// interruptor de "confirmaciones de lectura" (ver migración 0016) — solo
// aplica a 1:1, los grupos siempre confirman lectura (igual que WhatsApp).
// Sin fila todavía = nunca lo tocaste = default true, igual que la columna.
export async function getReadReceiptsEnabled(userId) {
  const { data, error } = await supabase
    .from('chat_settings')
    .select('read_receipts_enabled')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data?.read_receipts_enabled ?? true
}

export async function setMyReadReceiptsEnabled(enabled) {
  const myId = await currentUserId()
  const { error } = await supabase
    .from('chat_settings')
    .upsert({ user_id: myId, read_receipts_enabled: enabled, updated_at: new Date().toISOString() })
  if (error) throw error
}

export function subscribeToReadReceiptsSetting(userId, onChange) {
  const channel = supabase
    .channel(`chat-settings-${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'chat_settings', filter: `user_id=eq.${userId}` },
      (payload) => onChange(payload.new?.read_receipts_enabled ?? true)
    )
    .subscribe()
  return () => supabase.removeChannel(channel)
}

// trae la página más RECIENTE por default (para no cargar una conversación
// entera de una, ver Editor.jsx/página grande — mismo problema). `before`
// pagina hacia atrás en el tiempo; se pide en orden descendente y se da
// vuelta acá mismo para devolver siempre ascendente (como espera el caller).
export async function listMessages(otherUserId, { before = null, limit = MESSAGES_PAGE_SIZE } = {}) {
  const myId = await currentUserId()
  let query = supabase
    .from('direct_messages')
    .select(MESSAGE_COLUMNS)
    .or(`and(sender_id.eq.${myId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${myId})`)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (before) query = query.lt('created_at', before)
  const { data, error } = await query
  if (error) throw error
  return data.reverse()
}

// mejor esfuerzo: si el push falla (sin tokens registrados, Firebase caído,
// etc.) no hace que el envío del mensaje falle — el mensaje ya se guardó
// bien, esto es solo el aviso al celular del otro.
// `payload` es { recipientId, preview } para 1:1 o { conversationId, preview }
// para un grupo (ver send-chat-push/index.ts). Lo exporta para groupChat.js:
// hasta 2026-08-13 el chat grupal no mandaba ningún push, y eso era la mitad
// del "a veces llegan las notificaciones y a veces no" que se reportó.
export async function sendChatPush(payload) {
  try {
    const { data } = await supabase.auth.getSession()
    const accessToken = data.session?.access_token
    if (!accessToken) return
    const response = await fetch(`${SUPABASE_URL}/functions/v1/send-chat-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) console.error('No se pudo mandar el push:', await response.text())
  } catch (err) {
    console.error('No se pudo mandar el push:', err)
  }
}

const notifyPush = (recipientId, preview) => sendChatPush({ recipientId, preview })

export async function sendMessage(otherUserId, content) {
  const trimmed = content.trim()
  if (!trimmed) return
  const myId = await currentUserId()
  const { error } = await supabase
    .from('direct_messages')
    .insert({ sender_id: myId, recipient_id: otherUserId, content: trimmed, message_type: 'text' })
  if (error) throw error
  notifyPush(otherUserId, trimmed)
}

export async function sendAttachment(otherUserId, file, onProgress, signal) {
  const myId = await currentUserId()
  const { fileId, webViewLink } = await uploadFileToDrive(['Chat', pairKey(myId, otherUserId)], file, onProgress, signal)

  const { data: recipientEmail, error: emailError } = await supabase.rpc('get_user_email', { target_id: otherUserId })
  if (emailError) throw emailError
  if (recipientEmail) await shareDriveFileWithRecipients(fileId, [recipientEmail])

  const { error } = await supabase.from('direct_messages').insert({
    sender_id: myId,
    recipient_id: otherUserId,
    content: '',
    message_type: 'attachment',
    attachment_url: webViewLink,
    attachment_drive_id: fileId,
    attachment_name: file.name,
    attachment_mime: file.type || null,
  })
  if (error) throw error
  notifyPush(otherUserId, file.type?.startsWith('image/') ? 'envió una foto' : file.type?.startsWith('video/') ? 'envió un video' : `envió un archivo: ${file.name}`)
}

export async function hideMessageForMe(messageId) {
  const { error } = await supabase.rpc('hide_dm_for_me', { _message_id: messageId })
  if (error) throw error
}

export async function deleteMessageForEveryone(messageId) {
  const { error } = await supabase.rpc('delete_dm_for_everyone', { _message_id: messageId })
  if (error) throw error
}

export async function editMessage(messageId, newContent) {
  const trimmed = newContent.trim()
  if (!trimmed) return
  const { error } = await supabase.rpc('edit_dm', { _message_id: messageId, new_content: trimmed })
  if (error) throw error
}

// eliminar el CHAT entero con esa persona — no un mensaje suelto (ver
// hideMessageForMe/deleteMessageForEveryone arriba). "Para mí" deja de
// mostrártelo a vos nomás (mismo mecanismo que ocultar un mensaje, aplicado
// a todos a la vez); "para los dos" borra el historial completo, de ambos
// lados, sin dejar rastro.
export async function deleteConversationForMe(otherUserId) {
  const { error } = await supabase.rpc('delete_dm_conversation_for_me', { _other_user_id: otherUserId })
  if (error) throw error
}

export async function deleteConversationForEveryone(otherUserId) {
  const { error } = await supabase.rpc('delete_dm_conversation_for_everyone', { _other_user_id: otherUserId })
  if (error) throw error
}

// sin filtro compuesto en el canal (postgres_changes no soporta OR en
// `filter`) — se suscribe a todos los INSERT/UPDATE/DELETE que RLS deje
// pasar (o sea, los propios) y se filtra acá si son de esta conversación
// puntual. onUpdate cubre tanto ediciones como "eliminar para todos" (que en
// la base es un UPDATE con deleted_at seteado, no un DELETE real). onDelete
// es distinto: se dispara cuando la OTRA persona elige "eliminar para los
// dos" (borrado real de fila, ver delete_dm_conversation_for_everyone) — así
// el chat abierto en este momento se vacía en vivo en vez de quedar
// mostrando mensajes que ya no existen.
// onSubscribed (opcional) se dispara cada vez que el canal llega a
// SUBSCRIBED, incluída la primera vez Y cualquier reconexión — postgres_changes
// no reproduce eventos perdidos mientras el canal estuvo caído (el Sidebar se
// desmonta al cerrar el drawer en mobile/ventana angosta, cualquier hiccup de
// red, etc.), así que el caller lo usa para re-fetchear y tapar ese hueco en
// vez de quedarse mostrando una conversación desactualizada sin avisar.
export function subscribeToConversation(myId, otherUserId, onInsert, onUpdate, onDelete, onSubscribed) {
  const isThisConversation = (row) =>
    (row.sender_id === myId && row.recipient_id === otherUserId) ||
    (row.sender_id === otherUserId && row.recipient_id === myId)
  const channel = supabase
    .channel(`dm-${pairKey(myId, otherUserId)}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages' }, (payload) => {
      if (isThisConversation(payload.new)) onInsert(payload.new)
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'direct_messages' }, (payload) => {
      if (isThisConversation(payload.new)) onUpdate?.(payload.new)
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'direct_messages' }, (payload) => {
      if (payload.old && isThisConversation(payload.old)) onDelete?.(payload.old)
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onSubscribed?.()
    })
  return () => supabase.removeChannel(channel)
}

// para el contador del sidebar y la lista de conversaciones: cualquier
// mensaje nuevo donde soy destinatario, sin importar qué conversación tengo
// abierta (o si tengo alguna abierta). `tag` evita que dos suscriptores
// distintos (Sidebar y ChatView, montados a la vez) choquen con el mismo
// nombre de canal.
// onSubscribed: ver comentario en subscribeToConversation — mismo motivo.
export function subscribeToInbox(myId, onInsert, tag = 'default', onSubscribed) {
  const channel = supabase
    .channel(`dm-inbox-${tag}-${myId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'direct_messages', filter: `recipient_id=eq.${myId}` },
      (payload) => onInsert(payload.new)
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onSubscribed?.()
    })
  return () => supabase.removeChannel(channel)
}

// catch-up para notificaciones de escritorio: subscribeToInbox solo avisa de
// un mensaje si el INSERT en vivo llega justo con el canal arriba — cualquier
// hueco (reconexión, ventana sin foco con la red suspendida) lo pierde en
// silencio, sin lanzar la notificación nativa. Esto trae lo que haya llegado
// después de `since` para que el caller (Sidebar.jsx) pueda notificar por lo
// que se haya perdido, no solo reconciliar el badge.
export async function listIncomingSince(sinceISO) {
  const myId = await currentUserId()
  const { data, error } = await supabase
    .from('direct_messages')
    .select(MESSAGE_COLUMNS)
    .eq('recipient_id', myId)
    .gt('created_at', sinceISO)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

// Reacciones (0021_message_reactions.sql) — 1 por persona por mensaje,
// cualquier emoji. Tocar tu propia reacción existente con el MISMO emoji la
// saca (toggle); con uno distinto, la reemplaza — mismo comportamiento que
// WhatsApp.
export async function listReactionsForMessages(messageIds) {
  if (!messageIds?.length) return []
  const { data, error } = await supabase
    .from('direct_message_reactions')
    .select('message_id, user_id, emoji')
    .in('message_id', messageIds)
  if (error) throw error
  return data
}

export async function toggleReaction(messageId, emoji) {
  const myId = await currentUserId()
  const { data: existing, error: readError } = await supabase
    .from('direct_message_reactions')
    .select('emoji')
    .eq('message_id', messageId)
    .eq('user_id', myId)
    .maybeSingle()
  if (readError) throw readError

  if (existing?.emoji === emoji) {
    const { error } = await supabase
      .from('direct_message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', myId)
    if (error) throw error
    return
  }
  const { error } = await supabase
    .from('direct_message_reactions')
    .upsert({ message_id: messageId, user_id: myId, emoji })
  if (error) throw error
}

// sin filtro server-side a propósito (igual que subscribeToConversation de
// arriba, pero acá ni siquiera hay sender/recipient en la fila para armar
// uno) — el caller (ChatView) acumula todo en un Map por message_id, no le
// importa de qué conversación viene cada evento.
export function subscribeToReactions(onChange) {
  const channel = supabase
    .channel('dm-reactions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'direct_message_reactions' }, onChange)
    .subscribe()
  return () => supabase.removeChannel(channel)
}
