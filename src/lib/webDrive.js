import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from './supabaseClient.js'

// Acceso a Google Drive desde el NAVEGADOR (y por lo tanto desde Android),
// sin pasar por Electron.
//
// Durante mucho tiempo esto se creyó imposible fuera de la app de
// escritorio, pero no lo es: el refresh_token vive server-side y la Edge
// Function `drive-google-token` lo cambia por un access_token pidiendo
// solamente un JWT de Supabase — que la web tiene igual que Electron. Lo
// único que de verdad es exclusivo de Electron es el protocolo
// `driveasset://` (un proxy con streaming y soporte de Range) — pero ver
// getDriveMediaProxyUrl más abajo, que cubre el mismo caso (audio/video, con
// streaming y Range) para cualquier plataforma, e incluso adjuntos que no
// son propios.
//
// fetchDriveBlobUrl, en cambio, baja el archivo entero y arma un blob URL.
// Sirve perfecto para imágenes (fondos de chat, adjuntos chicos); para un
// video pesado NO conviene — se cargaría entero en memoria.

const DRIVE_TOKEN_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/drive-google-token`
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'

let cachedToken = null // { accessToken, expiry }

export async function getWebDriveAccessToken() {
  if (cachedToken && cachedToken.expiry > Date.now() + 60_000) return cachedToken.accessToken

  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new Error('No hay sesión activa')

  const res = await fetch(DRIVE_TOKEN_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ action: 'refresh' }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || `drive-google-token respondió ${res.status}`)

  cachedToken = { accessToken: body.access_token, expiry: Date.now() + body.expires_in * 1000 }
  return cachedToken.accessToken
}

// fileId -> Blob ya bajado esta sesión (ej. el fondo de un chat que se
// vuelve a abrir) — sin esto, cada vez que se abre la misma conversación se
// vuelve a pedir el archivo entero a la API de Drive, y en Android eso se
// nota como "el fondo tarda unos segundos en aparecer" cada vez, no solo la
// primera. Se cachea el Blob (los BYTES), no el object URL: cada caller
// sigue creando y revocando el suyo propio (ver comentario de abajo), así
// que compartir los bytes de origen no rompe ese contrato.
const blobCache = new Map()

// blob URL de un archivo PROPIO de Drive. Devuelve null (en vez de tirar) si
// Drive no está conectado en esta cuenta o el archivo no es accesible — el
// caller decide qué mostrar en su lugar, sin romper el render.
// OJO: el caller es responsable de hacer URL.revokeObjectURL() al
// desmontar, si no el blob queda retenido en memoria.
export async function fetchDriveBlobUrl(fileId) {
  try {
    let blob = blobCache.get(fileId)
    if (!blob) {
      const accessToken = await getWebDriveAccessToken()
      const res = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return null
      blob = await res.blob()
      blobCache.set(fileId, blob)
    }
    return URL.createObjectURL(blob)
  } catch (err) {
    console.error(`no se pudo leer el archivo ${fileId} de Drive:`, err)
    return null
  }
}

// URL de la Edge Function drive-media-proxy para reproducir un adjunto de
// audio/video de Drive con <video>/<audio src>, con streaming real y Range
// (soporta seek) — a diferencia de fetchDriveBlobUrl, sirve tanto archivos
// propios como los de OTRO remitente (valida acceso por conversación en el
// propio proxy, ver ese archivo). El JWT va en la URL como query param
// porque <video>/<audio> no pueden mandar el header Authorization — por eso
// esa función tiene que estar desplegada con "Enforce JWT Verification"
// apagado. Devuelve null (en vez de tirar) si no hay sesión activa; el
// caller decide qué mostrar en su lugar.
// { download, name }: pide la Content-Disposition:attachment del proxy en
// vez de servir el archivo para reproducir/mostrar inline — usado por
// "Guardar como"/"Abrir con" en mobile/web (ver createWebAttachmentAPI en
// api.js), no por el reproductor.
export async function getDriveMediaProxyUrl(fileId, { download, name } = {}) {
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) return null
  const params = new URLSearchParams({ fileId, jwt })
  if (download) params.set('download', '1')
  if (name) params.set('name', name)
  return `${SUPABASE_URL}/functions/v1/drive-media-proxy?${params.toString()}`
}
