import { supabase } from './supabaseClient.js'
import { listGroupMembers } from './groupChat.js'
import { shareDriveFileWithRecipients } from './driveAttachmentUpload.js'

async function currentUserId() {
  const { data } = await supabase.auth.getSession()
  const id = data.session?.user?.id
  if (!id) throw new Error('No hay sesión activa')
  return id
}

// Reenvía un mensaje (texto, sticker o adjunto) a otro DM o grupo. Un
// adjunto NO se vuelve a subir — reusa el mismo archivo de Drive. Si quien
// reenvía es el dueño del archivo, lo comparte directo con el destino; si
// no, encola el share para cuando el dueño real vuelva a abrir la app (ver
// migración 0020, queue_drive_share + driveShareQueue.js) — mismo motivo
// que el share a nuevos miembros de grupo: solo el dueño tiene el token de
// Drive para dar el permiso.
export async function forwardMessage(msg, target) {
  const myId = await currentUserId()

  if (msg.message_type === 'attachment' && msg.attachment_drive_id) {
    const recipientEmails = await resolveRecipientEmails(target, myId)
    if (msg.sender_id === myId) {
      if (recipientEmails.length) await shareDriveFileWithRecipients(msg.attachment_drive_id, recipientEmails)
    } else {
      for (const email of recipientEmails) {
        const { error } = await supabase.rpc('queue_drive_share', {
          _drive_file_id: msg.attachment_drive_id,
          _share_email: email,
        })
        if (error) console.error(`no se pudo encolar el share de reenvío con ${email}:`, error)
      }
    }
  }

  const base = {
    content: msg.content ?? '',
    message_type: msg.message_type,
    attachment_url: msg.attachment_url ?? null,
    attachment_drive_id: msg.attachment_drive_id ?? null,
    attachment_name: msg.attachment_name ?? null,
    attachment_mime: msg.attachment_mime ?? null,
  }

  if (target.kind === 'group') {
    const { error } = await supabase
      .from('group_messages')
      .insert({ ...base, conversation_id: target.conversationId, sender_id: myId })
    if (error) throw error
  } else {
    const { error } = await supabase
      .from('direct_messages')
      .insert({ ...base, sender_id: myId, recipient_id: target.otherUserId })
    if (error) throw error
  }
}

async function resolveRecipientEmails(target, myId) {
  if (target.kind === 'group') {
    const members = await listGroupMembers(target.conversationId)
    return members.filter((m) => m.user_id !== myId).map((m) => m.email)
  }
  const { data: email, error } = await supabase.rpc('get_user_email', { target_id: target.otherUserId })
  if (error) throw error
  return email ? [email] : []
}
