import { supabase } from './supabaseClient.js'
import { uploadFileToDrive, shareDriveFileWithRecipients } from './driveAttachmentUpload.js'
import { MESSAGES_PAGE_SIZE, sendChatPush } from './chat.js'

// Chat grupal — tablas separadas de direct_messages (chat 1:1), no
// unificadas, para no arriesgar el 1:1 que ya está probado y funcionando.

const GROUP_MESSAGE_COLUMNS =
  'id, conversation_id, sender_id, content, created_at, message_type, attachment_url, attachment_drive_id, attachment_name, attachment_mime, deleted_at, edited_at'

async function currentUserId() {
  const { data } = await supabase.auth.getSession()
  const id = data.session?.user?.id
  if (!id) throw new Error('No hay sesión activa')
  return id
}

// devuelve el id del grupo recién creado
export async function createGroup(name, memberEmails) {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('Falta el nombre del grupo')
  const emails = memberEmails.map((e) => e.trim()).filter(Boolean)
  const { data, error } = await supabase.rpc('create_group_conversation', {
    group_name: trimmedName,
    member_emails: emails,
  })
  if (error) throw error
  return data
}

export async function updateGroupIcon(conversationId, icon) {
  const { error } = await supabase.from('conversations').update({ icon: icon || null }).eq('id', conversationId)
  if (error) throw error
}

export async function uploadGroupIconImage(conversationId, file) {
  const safeName = file.name.replace(/[^A-Za-z0-9_.-]/g, '_')
  const objectPath = `${conversationId}/icon-${crypto.randomUUID()}-${safeName}`
  const { error } = await supabase.storage.from('group-attachments').upload(objectPath, file, {
    contentType: file.type || undefined,
  })
  if (error) throw error
  const { data } = supabase.storage.from('group-attachments').getPublicUrl(objectPath)
  return data.publicUrl
}

export async function addGroupMember(conversationId, email) {
  const { data, error } = await supabase.rpc('add_group_member', {
    _conversation_id: conversationId,
    target_email: email.trim(),
  })
  if (error) throw error
  return Boolean(data) // false = ese email no tiene cuenta en FlashLab todavía
}

export async function leaveGroup(conversationId) {
  const myId = await currentUserId()
  const { error } = await supabase
    .from('conversation_members')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', myId)
  if (error) throw error
}

// solo el creador puede (lo hace cumplir la policy de conversation_members)
export async function removeGroupMember(conversationId, userId) {
  const { error } = await supabase
    .from('conversation_members')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
  if (error) throw error
}

// [{ id, name, icon, created_by, last_message_at }]
export async function listMyGroups() {
  const { data, error } = await supabase.rpc('get_my_groups')
  if (error) throw error
  return data ?? []
}

// [{ user_id, email }]
export async function listGroupMembers(conversationId) {
  const { data, error } = await supabase.rpc('get_group_member_emails', { _conversation_id: conversationId })
  if (error) throw error
  return data ?? []
}

// mismo paginado que listMessages (chat.js) — página más reciente por
// default, `before` para ir trayendo historial más viejo a medida que se
// scrollea hacia arriba.
export async function listGroupMessages(conversationId, { before = null, limit = MESSAGES_PAGE_SIZE } = {}) {
  let query = supabase
    .from('group_messages')
    .select(GROUP_MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (before) query = query.lt('created_at', before)
  const { data, error } = await query
  if (error) throw error
  return data.reverse()
}

// mismo diseño que direct_message_reads/markConversationRead, pero por
// (conversación, usuario) en vez de por par de usuarios — ver migración
// 0015. No existía ningún tracking de lectura para grupos hasta ahora.
export async function markGroupRead(conversationId) {
  const myId = await currentUserId()
  const { error } = await supabase
    .from('group_message_reads')
    .upsert({ conversation_id: conversationId, user_id: myId, last_read_at: new Date().toISOString() })
  if (error) throw error
}

// [{ conversation_id, unread_count }] — mismo criterio que getUnreadCounts
// (chat.js) pero por conversación de grupo en vez de por remitente. Ver
// migración 0026: no existía ninguna función para esto, así que el badge
// del sidebar y las notificaciones de escritorio solo contaban 1:1.
export async function getGroupUnreadCounts() {
  const { data, error } = await supabase.rpc('get_group_unread_counts')
  if (error) throw error
  return data ?? []
}

// [{ user_id, last_read_at }] de TODOS los miembros (para saber, por cada
// mensaje mío, si ya lo leyeron todos los demás)
export async function listGroupReads(conversationId) {
  const { data, error } = await supabase
    .from('group_message_reads')
    .select('user_id, last_read_at')
    .eq('conversation_id', conversationId)
  if (error) throw error
  return data ?? []
}

export function subscribeToGroupReads(conversationId, onChange) {
  const channel = supabase
    .channel(`group-reads-${conversationId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'group_message_reads', filter: `conversation_id=eq.${conversationId}` },
      (payload) => onChange(payload.new)
    )
    .subscribe()
  return () => supabase.removeChannel(channel)
}

// Reacciones — mismo esquema y misma semántica de toggle que las de DM (ver
// chat.js), tabla aparte (group_message_reactions).
export async function listGroupReactionsForMessages(messageIds) {
  if (!messageIds?.length) return []
  const { data, error } = await supabase
    .from('group_message_reactions')
    .select('message_id, user_id, emoji')
    .in('message_id', messageIds)
  if (error) throw error
  return data
}

export async function toggleGroupReaction(messageId, emoji) {
  const myId = await currentUserId()
  const { data: existing, error: readError } = await supabase
    .from('group_message_reactions')
    .select('emoji')
    .eq('message_id', messageId)
    .eq('user_id', myId)
    .maybeSingle()
  if (readError) throw readError

  if (existing?.emoji === emoji) {
    const { error } = await supabase
      .from('group_message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', myId)
    if (error) throw error
    return
  }
  const { error } = await supabase
    .from('group_message_reactions')
    .upsert({ message_id: messageId, user_id: myId, emoji })
  if (error) throw error
}

// sin filtro server-side, mismo motivo que subscribeToReactions de chat.js
export function subscribeToGroupReactions(onChange) {
  const channel = supabase
    .channel('group-reactions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'group_message_reactions' }, onChange)
    .subscribe()
  return () => supabase.removeChannel(channel)
}

export async function sendGroupMessage(conversationId, content) {
  const trimmed = content.trim()
  if (!trimmed) return
  const myId = await currentUserId()
  const { error } = await supabase
    .from('group_messages')
    .insert({ conversation_id: conversationId, sender_id: myId, content: trimmed, message_type: 'text' })
  if (error) throw error
  // el fan-out a los miembros lo hace la edge function (acá no se sabe quién
  // tiene qué dispositivo registrado, esa tabla es service-role)
  sendChatPush({ conversationId, preview: trimmed })
}

export async function sendGroupAttachment(conversationId, file, onProgress, signal) {
  const myId = await currentUserId()
  const { fileId, webViewLink } = await uploadFileToDrive(['Chat', conversationId], file, onProgress, signal)

  // se comparte con quien está en el grupo AHORA — quien se sume después
  // queda encolado en drive_pending_shares (ver add_group_member en la
  // migración 0020 y driveShareQueue.js, que lo procesa cuando esta cuenta
  // vuelve a abrir la app).
  const members = await listGroupMembers(conversationId)
  const recipientEmails = members.filter((m) => m.user_id !== myId).map((m) => m.email)
  if (recipientEmails.length) await shareDriveFileWithRecipients(fileId, recipientEmails)

  const { error } = await supabase.from('group_messages').insert({
    conversation_id: conversationId,
    sender_id: myId,
    content: '',
    message_type: 'attachment',
    attachment_url: webViewLink,
    attachment_drive_id: fileId,
    attachment_name: file.name,
    attachment_mime: file.type || null,
  })
  if (error) throw error
  const preview = file.type?.startsWith('image/')
    ? 'envió una foto'
    : file.type?.startsWith('video/')
      ? 'envió un video'
      : `envió un archivo: ${file.name}`
  sendChatPush({ conversationId, preview })
}

export async function hideGroupMessageForMe(messageId) {
  const { error } = await supabase.rpc('hide_group_message_for_me', { _message_id: messageId })
  if (error) throw error
}

export async function deleteGroupMessageForEveryone(messageId) {
  const { error } = await supabase.rpc('delete_group_message_for_everyone', { _message_id: messageId })
  if (error) throw error
}

export async function editGroupMessage(messageId, newContent) {
  const trimmed = newContent.trim()
  if (!trimmed) return
  const { error } = await supabase.rpc('edit_group_message', { _message_id: messageId, new_content: trimmed })
  if (error) throw error
}

// onSubscribed: mismo motivo que subscribeToConversation en chat.js — se
// dispara en cada SUBSCRIBED (primera vez y reconexiones) para que el caller
// re-fetchee y tape lo que se haya perdido mientras el canal estuvo caído.
export function subscribeToGroup(conversationId, onInsert, onUpdate, onSubscribed) {
  const channel = supabase
    .channel(`group-${conversationId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'group_messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => onInsert(payload.new)
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'group_messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => onUpdate?.(payload.new)
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onSubscribed?.()
    })
  return () => supabase.removeChannel(channel)
}

// para saber si llegó un mensaje nuevo a CUALQUIER grupo del que soy
// miembro, sin importar cuál tengo abierto (para notificaciones/lista) —
// postgres_changes no puede filtrar por "conversation_id in (mis grupos)"
// directo, así que se suscribe a todos los INSERT de la tabla (RLS igual
// solo entrega los de mis grupos) y se filtra en el callback si hace falta.
// onSubscribed: mismo motivo que en subscribeToInbox (chat.js) — se dispara
// en cada SUBSCRIBED (primera vez y reconexiones) para que el caller
// re-fetchee y tape lo que se haya perdido mientras el canal estuvo caído.
export function subscribeToAnyGroupMessage(onMessage, onSubscribed) {
  const channel = supabase
    .channel('group-messages-inbox')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_messages' }, (payload) =>
      onMessage(payload.new)
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onSubscribed?.()
    })
  return () => supabase.removeChannel(channel)
}

// catch-up para notificaciones — mismo motivo que listIncomingSince en
// chat.js: el INSERT en vivo solo notifica si llega con el canal arriba, así
// que esto trae lo que se haya perdido después de `since` (RLS ya restringe
// a mensajes de MIS grupos, no hace falta filtrar conversation_id acá).
export async function listGroupIncomingSince(sinceISO) {
  const myId = await currentUserId()
  const { data, error } = await supabase
    .from('group_messages')
    .select(GROUP_MESSAGE_COLUMNS)
    .neq('sender_id', myId)
    .gt('created_at', sinceISO)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}
