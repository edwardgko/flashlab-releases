import { api, isDesktop } from './api.js'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient.js'

// Adjuntos de chat -> Google Drive del que los manda (no Supabase Storage).
// El archivo ya está en memoria del renderer como File (input o
// drag&drop) — subirlo por IPC a main implicaría pasar sus bytes enteros
// por ahí (nada bueno con un archivo de varios GB). Así que el PUT del
// archivo lo hace el navegador mismo, directo contra la API de Drive,
// mismo patrón que uploadWithProgress.js usa con Supabase. En desktop,
// main.js presta lo liviano (el access token y las llamadas de gestión:
// carpeta, share) porque ahí vive el refresh_token cifrado. En mobile/web no
// hay proceso main — esas mismas llamadas (token, carpeta, share) se hacen
// directo desde acá abajo, sin nada Electron-specific: el token se consigue
// pegándole al mismo edge function que ya usa el desktop
// (drive-google-token, acción 'refresh'), que solo necesita el JWT de la
// sesión — y ese ya funciona en cualquier plataforma porque solo depende de
// que la cuenta haya conectado Drive ALGUNA VEZ (en cualquier plataforma),
// no de que la conexión se haya hecho desde ESTE dispositivo.
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_FOLDER_NAME = 'FlashLab'

// cache en memoria nomás (no localStorage): un access_token vivo ahí sería
// un secreto persistido sin necesidad — se vuelve a pedir gratis cuando
// expira o al reabrir la app.
let mobileTokenCache = null // { accessToken, expiry } | null

async function getMobileDriveAccessToken() {
  if (mobileTokenCache && Date.now() < mobileTokenCache.expiry - 60_000) return mobileTokenCache.accessToken
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new Error('no hay sesión activa')
  const res = await fetch(`${SUPABASE_URL}/functions/v1/drive-google-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ action: 'refresh' }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (body?.error === 'not_connected') {
      // OJO: este texto nombra una ruta REAL de la UI. Antes decía
      // "Ajustes → Drive", una pantalla que nunca existió — el usuario la
      // buscó y no la encontró, dos veces. Si el lugar para conectar Drive
      // cambia, actualizar esta línea también (ver AccountRow en Sidebar.jsx).
      throw new Error(
        'Tu cuenta todavía no tiene Google Drive conectado. Abrí FlashLab en una computadora, tocá tu email abajo del todo en el panel lateral y elegí "Conectar Google Drive". Después ya podés mandar audios y archivos desde el celular.'
      )
    }
    throw new Error(body?.error || `drive-google-token respondió ${res.status}`)
  }
  mobileTokenCache = { accessToken: body.access_token, expiry: Date.now() + body.expires_in * 1000 }
  return mobileTokenCache.accessToken
}

// ¿la CUENTA logueada tiene Drive conectado? Es una pregunta DISTINTA de
// "¿esta computadora tiene Drive conectado?", y confundirlas fue un bug real
// (2026-08-12): `drive:auth-status` de Electron mira un archivo local
// (drive-auth.enc) que es único por MÁQUINA, así que con dos cuentas usando
// la misma PC, la segunda veía "Google Drive conectado" gracias al archivo
// que dejó la primera — mientras el celular, que sí consulta el servidor, le
// decía correctamente que no. El estado real vive en drive_google_tokens,
// indexado por user_id, y la única forma de preguntarlo desde el cliente es
// esta función (la tabla es service-role, el renderer no la puede leer
// directo). Sirve igual en escritorio, web y Android.
export async function isDriveConnectedForAccount() {
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) return false
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/drive-google-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ action: 'refresh' }),
    })
    return res.ok // 404 not_connected = esta cuenta nunca conectó Drive
  } catch {
    return false // sin red no se puede afirmar que esté conectado
  }
}

// mismo query+create-si-no-existe que ensureDriveChildFolderId en
// electron/main.js, calcado — la única diferencia es net.fetch (Electron) vs
// fetch (browser/WebView), que para un pedido JSON simple como este se
// comportan igual.
async function ensureDriveChildFolderIdWeb(accessToken, name, parentId) {
  const escapedName = name.replace(/'/g, "\\'")
  const parentClause = parentId ? ` and '${parentId}' in parents` : ''
  const query = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`
  const listRes = await fetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const listData = await listRes.json()
  if (listRes.ok && listData.files?.length) return listData.files[0].id

  const createRes = await fetch(DRIVE_FILES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined }),
  })
  const createData = await createRes.json()
  if (!createRes.ok) throw new Error(createData?.error?.message || 'no se pudo crear la carpeta de Drive')
  return createData.id
}

async function ensureNestedDriveFolderIdWeb(accessToken, segments) {
  let parentId = await ensureDriveChildFolderIdWeb(accessToken, DRIVE_FOLDER_NAME, null)
  for (const segment of segments) {
    parentId = await ensureDriveChildFolderIdWeb(accessToken, segment, parentId)
  }
  return parentId
}

// mismo mecanismo que shareDriveFileWithEmails en electron/main.js
async function shareDriveFileWithEmailsWeb(accessToken, fileId, emails) {
  const failed = []
  for (const email of emails) {
    try {
      const res = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=false`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: email }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error?.message || `Drive respondió ${res.status}`)
      }
    } catch (err) {
      failed.push({ email, message: err.message || 'no se pudo compartir' })
    }
  }
  return { shared: emails.length - failed.length, failed }
}

// url para <img>/<video>/CSS background-image de un archivo de Drive
// PROPIO — ver driveasset:// en electron/main.js (proxea con el token del
// dueño, no sirve para archivos ajenos).
export function driveAssetUrl(fileId) {
  return `driveasset://file/${fileId}`
}

// Un id de Drive no se puede meter directo en un <img>/<video>: hay que
// convertirlo a algo que la plataforma sepa cargar. En Electron eso es el
// protocolo driveasset:// (streaming, soporta Range); en la web hay que
// bajar los bytes y armar un blob URL (ver webDrive.js) — bien para
// imágenes, no para videos pesados.
// Devuelve null si no se pudo (Drive sin conectar, sin permiso, etc.).
// El caller debe revokeObjectURL cuando ya no lo use, en web.
export async function resolveDriveDisplayUrl(fileId) {
  if (!fileId) return null
  if (isDesktop) return driveAssetUrl(fileId)
  const { fetchDriveBlobUrl } = await import('./webDrive.js')
  return fetchDriveBlobUrl(fileId)
}

// los fondos se guardaban antes como la URL entera 'driveasset://file/<id>';
// ahora se guarda solo el id. Esto acepta las dos formas para que a nadie se
// le pierda un fondo ya elegido.
export function driveFileIdFromStored(stored) {
  if (!stored) return null
  const match = String(stored).match(/^driveasset:\/\/file\/(.+)$/)
  return match ? match[1] : String(stored)
}

// Un .webm grabado con MediaRecorder (screen recording exportada, lo que
// sea) no trae índice de seek propio — Drive lo sirve igual, pero mover la
// línea de tiempo desincroniza audio y video (ya nos había pasado con las
// grabaciones, ver transcodeForExternalPlayer en main.js). Ese único caso
// necesita ffmpeg (main-only) así que rompe la regla de "todo el PUT desde
// el renderer": se manda el path real del archivo (webUtils.getPathForFile,
// sin copiar bytes por IPC) y main reencodea + sube. Sin progreso
// incremental ni cancelación en este camino — es una desprolijidad conocida,
// no vale la pena la complejidad de streamear el % de un ffmpeg + upload
// encadenados solo para este caso.
function isWebmVideo(file) {
  return file.type === 'video/webm' || (!file.type && /\.webm$/i.test(file.name))
}

// folderSegments ej. ['Chat', conversationId] -> FlashLab/Chat/{conversationId}
export async function uploadFileToDrive(folderSegments, file, onProgress, signal) {
  if (isWebmVideo(file)) {
    // el reencode a mp4 corre en main con ffmpeg — no hay equivalente en
    // mobile/web todavía (bit un poco distinto: esto solo afecta VIDEO, un
    // audio de chat es audio/webm y no cae en esta rama, ver isWebmVideo).
    if (!isDesktop) throw new Error('los videos necesitan la app de escritorio para procesarse')
    onProgress?.(0)
    const filePath = api.getPathForFile(file)
    const result = await api.uploadVideoAttachmentToDrive(filePath, folderSegments)
    onProgress?.(100)
    return result
  }

  const [accessToken, folderId] = isDesktop
    ? await Promise.all([api.getDriveAccessToken(), api.ensureDriveFolder(folderSegments)])
    : await (async () => {
        const token = await getMobileDriveAccessToken()
        const folder = await ensureNestedDriveFolderIdWeb(token, folderSegments)
        return [token, folder]
      })()
  if (signal?.aborted) throw makeAbortError()

  const initRes = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,webViewLink`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': file.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(file.size),
    },
    body: JSON.stringify({ name: file.name, parents: [folderId] }),
  })
  if (!initRes.ok) {
    const body = await initRes.json().catch(() => null)
    throw new Error(body?.error?.message || `Drive respondió ${initRes.status} al iniciar la subida`)
  }
  const uploadUrl = initRes.headers.get('location')
  if (!uploadUrl) throw new Error('Drive no devolvió una URL de subida')

  const uploaded = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl)
    if (file.type) xhr.setRequestHeader('Content-Type', file.type)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('Drive devolvió una respuesta inválida al subir el archivo'))
        }
      } else {
        reject(new Error(`no se pudo subir el archivo a Drive (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('error de red al subir el archivo a Drive'))
    xhr.onabort = () => reject(makeAbortError())
    if (signal) {
      if (signal.aborted) {
        xhr.abort()
        return
      }
      signal.addEventListener('abort', () => xhr.abort())
    }
    xhr.send(file)
  })

  return { fileId: uploaded.id, webViewLink: uploaded.webViewLink }
}

function makeAbortError() {
  const err = new Error('Subida cancelada')
  err.name = 'AbortError'
  return err
}

// borra un archivo propio de Drive por id — mismo par de caminos que
// uploadFileToDrive (token por IPC en desktop porque ahí vive el
// refresh_token cifrado; directo desde acá en mobile/web), pero el DELETE en
// sí es un fetch simple, no necesita nada Electron-specific de por medio.
// 404 (ya no existe) se trata como éxito: llamar esto dos veces, o borrar
// algo que el usuario ya había borrado a mano desde drive.google.com, no
// tiene por qué ser un error.
export async function deleteDriveFile(fileId) {
  const accessToken = isDesktop ? await api.getDriveAccessToken() : await getMobileDriveAccessToken()
  const res = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message || `no se pudo borrar el archivo de Drive (${res.status})`)
  }
}

// Repara un video subido antes de que existiera el transcode automático:
// sigue siendo un .webm crudo en Drive, sin duración declarada, así que el
// reproductor no puede avanzar/retroceder. Reemplaza el contenido del mismo
// archivo en Drive por un .mp4 (conserva id, link y permisos) y actualiza la
// fila del mensaje. `table`: 'direct_messages' | 'group_messages'.
export async function repairVideoAttachment(table, messageId, driveFileId, name) {
  if (!isDesktop) throw new Error('reparar el video necesita la app de escritorio')
  await api.repairDriveVideo(driveFileId)
  const { error } = await supabase
    .from(table)
    .update({
      attachment_mime: 'video/mp4',
      attachment_name: String(name ?? 'video').replace(/\.\w+$/, '') + '.mp4',
    })
    .eq('id', messageId)
  if (error) throw error
}

// best-effort: un email que falla no debe romper el envío del mensaje, el
// archivo ya está en Drive igual — ver shareDriveFileWithEmails en main.js
export async function shareDriveFileWithRecipients(fileId, emails) {
  if (!emails.length) return
  const { failed } = isDesktop
    ? await api.shareDriveFile(fileId, emails)
    : await shareDriveFileWithEmailsWeb(await getMobileDriveAccessToken(), fileId, emails)
  for (const { email, message } of failed) {
    console.error(`no se pudo compartir el adjunto en Drive con ${email}:`, message)
  }
}
