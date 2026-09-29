import { supabase } from './supabaseClient.js'
import { api, isDesktop } from './api.js'

// Un adjunto de grupo se comparte una sola vez, al subirlo, con quien esté
// en el grupo EN ESE MOMENTO (ver sendGroupAttachment en groupChat.js).
// Quien se suma después queda encolado en drive_pending_shares (lo hace
// add_group_member, migración 0020) porque solo el dueño del archivo —
// quien lo subió — tiene el token de Drive para volver a compartirlo. Esto
// procesa "mis" pendientes con mi propio token; se llama al abrir el chat,
// así que se termina resolviendo la próxima vez que esta cuenta esté
// online, sin que nadie tenga que acordarse de nada.
export async function processPendingDriveShares() {
  if (!isDesktop) return
  const { data: rows, error } = await supabase.from('drive_pending_shares').select('id, drive_file_id, share_email')
  if (error) {
    console.error('no se pudo revisar los shares de Drive pendientes:', error)
    return
  }
  if (!rows?.length) return

  const byFile = new Map()
  for (const row of rows) {
    if (!byFile.has(row.drive_file_id)) byFile.set(row.drive_file_id, [])
    byFile.get(row.drive_file_id).push(row)
  }

  for (const [fileId, fileRows] of byFile) {
    let failedEmails
    try {
      const { failed } = await api.shareDriveFile(
        fileId,
        fileRows.map((r) => r.share_email)
      )
      failedEmails = new Set(failed.map((f) => f.email))
    } catch (err) {
      // typo de red, token vencido, lo que sea: se reintenta la próxima vez
      // que se abra el chat, las filas quedan tal cual
      console.error(`no se pudo procesar los shares pendientes del archivo ${fileId}:`, err)
      continue
    }
    const doneIds = fileRows.filter((r) => !failedEmails.has(r.share_email)).map((r) => r.id)
    if (!doneIds.length) continue
    const { error: delError } = await supabase.from('drive_pending_shares').delete().in('id', doneIds)
    if (delError) console.error('no se pudo limpiar la cola de shares de Drive ya procesados:', delError)
  }
}
