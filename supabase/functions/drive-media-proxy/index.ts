// FlashLab — reproducir inline (video/audio) un adjunto de Drive aunque sea
// de OTRO remitente, dentro de la propia FlashLab (no abrir Drive externo).
//
// Por qué hace falta: con scope drive.file, el token de cada cuenta SOLO
// puede leer bytes de archivos que ESA cuenta creó — un archivo compartido
// por otro usuario no es legible vía API aunque Drive lo muestre como
// "reader" (mismo motivo por el que driveasset://, en electron/main.js, solo
// sirve archivos propios — ver el comentario ahí). Acá en cambio: se valida
// que quien pide el archivo participa de la conversación donde se mandó
// (direct_messages o group_messages + conversation_members), y se usa el
// refresh_token del REMITENTE (guardado en drive_google_tokens, mismo
// mecanismo que drive-google-token/index.ts) para pedirlo a Drive en su
// nombre — el receptor nunca necesita su propio acceso a ese archivo.
//
// GET, no POST: lo llama un <video>/<audio src="..."> del navegador, que no
// puede mandar headers Authorization — por eso el JWT de sesión viaja como
// query param (?jwt=) en vez de header. IMPORTANTE al desplegar: esta
// función tiene que crearse con "Enforce JWT Verification" DESACTIVADO en el
// Dashboard de Supabase — si no, el gateway rechaza el pedido antes de que
// este código corra (no hay header Authorization que verificar). La validez
// de la sesión se chequea acá adentro a mano, con el mismo
// admin.auth.getUser() que ya usan el resto de las Edge Functions — así que
// sigue siendo tan seguro como esas, el JWT solo viaja en otro lugar.
//
// Range / slicing: mismo algoritmo ya probado en handleDriveAssetRequest
// (electron/main.js) — incluye el bug ya resuelto ahí: si Drive ignora el
// Range pedido y manda el archivo entero, hay que recortar el stream acá
// mismo (sliceWebStream) en vez de reenviar esa respuesta tal cual, o el
// reproductor recibe bytes de otro offset del que pidió y se desincroniza
// (ver memoria notion-clone-webm-no-duration).

import { createClient } from 'jsr:@supabase/supabase-js@2'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'range, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
}

function err(message: string, status: number) {
  return new Response(message, { status, headers: corsHeaders })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAccessTokenForOwner(admin: any, ownerId: string): Promise<string> {
  const { data: row, error } = await admin
    .from('drive_google_tokens')
    .select('refresh_token')
    .eq('user_id', ownerId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!row) throw new Error('el remitente no tiene Drive conectado')

  const clientId = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') ?? ''
  const clientSecret = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET') ?? ''
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  })
  const tokenData = await tokenRes.json()
  if (!tokenRes.ok) throw new Error(tokenData.error_description || tokenData.error || 'refresh de Drive falló')
  return tokenData.access_token as string
}

// tamaño/mime reales de un archivo de Drive — cacheado un rato porque el
// reproductor puede pedir varios Range distintos seguidos al hacer seek, y
// el tamaño de un archivo ya subido no cambia (mismo TTL que driveasset://).
const metaCache = new Map<string, { size: number; mimeType: string; expiry: number }>()
const META_TTL_MS = 5 * 60 * 1000

async function getDriveAssetMeta(accessToken: string, fileId: string) {
  const cached = metaCache.get(fileId)
  if (cached && cached.expiry > Date.now()) return cached
  const res = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=size,mimeType`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`no se pudo leer metadata del archivo de Drive (${res.status})`)
  const data = await res.json()
  const meta = {
    size: Number(data.size),
    mimeType: data.mimeType || 'application/octet-stream',
    expiry: Date.now() + META_TTL_MS,
  }
  metaCache.set(fileId, meta)
  return meta
}

// recorta un stream a [start, end] sin bufferear el archivo entero — se usa
// cuando Drive ignora el header Range y manda el archivo completo.
function sliceWebStream(source: ReadableStream<Uint8Array>, start: number, end: number) {
  const reader = source.getReader()
  const wanted = end - start + 1
  let skipped = 0
  let sent = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        let chunk = value
        if (skipped < start) {
          const skipNow = Math.min(start - skipped, chunk.length)
          skipped += skipNow
          chunk = chunk.subarray(skipNow)
          if (chunk.length === 0) continue
        }
        if (chunk.length > wanted - sent) chunk = chunk.subarray(0, wanted - sent)
        sent += chunk.length
        controller.enqueue(chunk)
        if (sent >= wanted) {
          controller.close()
          reader.cancel().catch(() => {})
        }
        return
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
    },
  })
}

// dueño real del archivo: el remitente del mensaje (DM o grupo) que lo
// referencia — validando de paso que quien pide el archivo participa de esa
// conversación. Ninguna de las dos tablas listadas: sin acceso, sin vueltas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveOwner(admin: any, fileId: string, myId: string): Promise<string | null> {
  const { data: dms } = await admin
    .from('direct_messages')
    .select('sender_id, recipient_id')
    .eq('attachment_drive_id', fileId)
    .limit(1)
  const dm = dms?.[0]
  if (dm && (dm.sender_id === myId || dm.recipient_id === myId)) return dm.sender_id

  const { data: gms } = await admin
    .from('group_messages')
    .select('sender_id, conversation_id')
    .eq('attachment_drive_id', fileId)
    .limit(1)
  const gm = gms?.[0]
  if (!gm) return null

  const { data: membership } = await admin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', gm.conversation_id)
    .eq('user_id', myId)
    .maybeSingle()
  return membership ? gm.sender_id : null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return err('method not allowed', 405)

  const url = new URL(req.url)
  const fileId = url.searchParams.get('fileId') ?? ''
  const jwt = url.searchParams.get('jwt') ?? ''
  // download=1: "Guardar como"/"Abrir con" en mobile/web (sin diálogo nativo
  // ahí, a diferencia de Electron) — abrir esta URL en el navegador del
  // sistema con Content-Disposition:attachment fuerza la descarga en vez de
  // que el navegador intente reproducir/mostrar el archivo inline.
  const forceDownload = url.searchParams.get('download') === '1'
  const downloadName = url.searchParams.get('name') ?? 'archivo'
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) return err('fileId inválido', 400)
  if (!jwt) return err('falta jwt', 401)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: userData, error: userError } = await admin.auth.getUser(jwt)
  if (userError || !userData?.user) return err('sesión inválida', 401)
  const myId = userData.user.id

  const ownerId = await resolveOwner(admin, fileId, myId)
  if (!ownerId) return err('no tenés acceso a este archivo', 403)

  let accessToken: string
  try {
    accessToken = await getAccessTokenForOwner(admin, ownerId)
  } catch (e) {
    return err((e as Error).message, 502)
  }

  let meta: { size: number; mimeType: string }
  try {
    meta = await getDriveAssetMeta(accessToken, fileId)
  } catch (e) {
    return err((e as Error).message, 502)
  }
  const total = meta.size
  const mediaUrl = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`
  const baseHeaders: Record<string, string> = {
    ...corsHeaders,
    'Content-Type': meta.mimeType,
    'Accept-Ranges': 'bytes',
    // privado (no 'public'): a diferencia de driveasset://, este proxy
    // decide el acceso por conversación — nada de dejar que un cache
    // compartido (proxy intermedio) le sirva la respuesta a otro usuario.
    'Cache-Control': 'private, max-age=31536000, immutable',
  }
  if (forceDownload) {
    // nombre entre comillas + fallback ASCII (filename*) por si trae
    // caracteres fuera de latin1, que un Content-Disposition sin eso corta o
    // rompe en algunos navegadores.
    const safeName = downloadName.replace(/["\r\n]/g, '_')
    baseHeaders['Content-Disposition'] =
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  }

  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get('Range') ?? '').trim())
  if (!rangeMatch || !Number.isFinite(total) || total === 0) {
    const driveRes = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!driveRes.ok) return err('no se pudo leer el archivo de Drive', driveRes.status)
    const headers: Record<string, string> = { ...baseHeaders }
    if (Number.isFinite(total)) headers['Content-Length'] = String(total)
    return new Response(driveRes.body, { status: 200, headers })
  }

  // el rango se calcula SIEMPRE contra el total real, no contra lo que
  // conteste Drive — incluye el caso "bytes=-N" (sufijo: los últimos N
  // bytes), que el navegador usa para leer la cola de un contenedor.
  const [, rawStart, rawEnd] = rangeMatch
  let start: number
  let end: number
  if (rawStart === '') {
    const suffixLength = rawEnd === '' ? 0 : Number(rawEnd)
    start = Math.max(0, total - suffixLength)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return new Response(null, { status: 416, headers: { ...corsHeaders, 'Content-Range': `bytes */${total}` } })
  }

  const driveRes = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Range: `bytes=${start}-${end}` },
  })
  if (!driveRes.ok && driveRes.status !== 206) {
    return err('no se pudo leer el archivo de Drive', driveRes.status)
  }

  const headers = {
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': String(end - start + 1),
  }
  // si Drive ignora el Range y manda el archivo entero (200), no se puede
  // pasar ese body tal cual: el reproductor pidió desde `start` y recibiría
  // bytes desde el 0 — se recorta acá y se responde igual un 206 correcto.
  const body = driveRes.status === 206 ? driveRes.body! : sliceWebStream(driveRes.body!, start, end)
  return new Response(body, { status: 206, headers })
})
