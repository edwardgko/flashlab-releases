// FlashLab — push notification nativa de Android cuando llega un mensaje de
// chat y la app está minimizada O CERRADA del todo (a diferencia de la
// notificación de escritorio de Windows, ver desktopNotify.js: en desktop el
// proceso de Electron sigue vivo en bandeja y puede mantener la conexión de
// Supabase Realtime abierta; en Android, una vez que el sistema mata la app
// no queda ningún proceso nuestro corriendo — la única forma de llegar ahí
// es que un servidor externo (FCM) le entregue el mensaje directo al
// sistema operativo).
//
// La llama el cliente (chat.js) justo después de insertar el mensaje en
// direct_messages, autenticado con el JWT del que lo mandó — mismo patrón
// que send-share-notification/index.ts, no un trigger/webhook de base de
// datos (evita depender de configuración extra en el Dashboard que no
// quedaría documentada en un archivo de este repo).
//
// FCM HTTP v1 (la API vieja "legacy" con server key fue dada de baja por
// Google) exige un access_token de OAuth2 de una cuenta de servicio, no una
// API key simple — por eso el bloque de abajo firma un JWT con la private
// key de la cuenta de servicio y lo cambia por un access_token, a mano, sin
// librerías (Deno no tiene el SDK de firebase-admin para este runtime).

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let str = ''
  for (const b of arr) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// intercambia la cuenta de servicio de Firebase por un access_token de
// Google válido ~1h (scope acotado a mandar mensajes de FCM nomás).
async function getFcmAccessToken(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const unsigned = `${base64url(new TextEncoder().encode(JSON.stringify(header)))}.${base64url(new TextEncoder().encode(JSON.stringify(claims)))}`

  // la private_key viene en el JSON con \n literales (no saltos de línea
  // reales) — hay que despejarlos antes de sacar el PEM.
  const pem = serviceAccount.private_key
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const keyBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const jwt = `${unsigned}.${base64url(signature)}`

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  })
  const tokenData = await tokenRes.json()
  if (!tokenRes.ok) throw new Error(tokenData.error_description || tokenData.error || 'no se pudo obtener access_token de Google')
  return tokenData.access_token as string
}

type PushResult = { status: number; error?: string }
type Admin = ReturnType<typeof createClient>
type SenderUser = { id: string; email?: string; user_metadata?: Record<string, unknown> }

// --- token de acción de la notificación -------------------------------------
// "Responder" y "Marcar como leído" se ejecutan desde la notificación de
// Android, muchas veces con la app CERRADA: ahí no hay sesión de Supabase
// (vive en el WebView) y refrescarla desde código nativo rompería la del
// WebView (los refresh tokens rotan). En su lugar cada push lleva un token
// firmado por este servidor que autoriza SOLO acciones de ese usuario en ese
// chat, por 30 días. Clave HMAC = la service role key del entorno (nunca
// sale de acá).
const ACTION_TOKEN_TTL_SECONDS = 30 * 24 * 3600

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
}

async function signActionToken(userId: string, chatKey: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ACTION_TOKEN_TTL_SECONDS
  return `${exp}.${await hmac(`${userId}|${chatKey}|${exp}`)}`
}

async function verifyActionToken(token: string, userId: string, chatKey: string): Promise<boolean> {
  const [expStr, sig] = String(token).split('.')
  const exp = Number(expStr)
  if (!sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return false
  const expected = await hmac(`${userId}|${chatKey}|${exp}`)
  if (expected.length !== sig.length) return false
  let diff = 0
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

// la service role key del ENTORNO de la función no es necesariamente la
// misma cadena que la que tiene el dueño del proyecto (formato legacy vs
// nuevo), así que comparar strings no alcanza: se valida usándola.
async function isServiceRoleKey(key: string): Promise<boolean> {
  if (key === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return true
  if (!key.startsWith('eyJ') && !key.startsWith('sb_secret_')) return false
  const probe = createClient(Deno.env.get('SUPABASE_URL')!, key)
  const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 })
  return !error
}

// foto de la cuenta de Google con la que inició sesión (si tiene)
function avatarOf(user: SenderUser): string {
  const meta = user.user_metadata ?? {}
  const url = (meta.avatar_url ?? meta.picture ?? '') as string
  return typeof url === 'string' && url.startsWith('https://') ? url : ''
}

// manda el push a todos los dispositivos registrados de esos usuarios y
// devuelve el resultado de FCM POR TOKEN. Antes cualquier rechazo de FCM que
// no fuera UNREGISTERED/NOT_FOUND se tragaba en silencio y la función
// respondía 200 igual — no había forma de saber si Google había aceptado el
// mensaje o no (así quedó sin diagnosticar "en Android no llega nada").
//
// Mensaje SOLO-DATA (sin `notification`): así la notificación la arma siempre
// FlashLabMessagingService (foto del remitente, Responder / Marcar como
// leído / Silenciar), también con la app cerrada. Con `notification` la
// dibujaba el SDK de Firebase por su cuenta, sin foto ni botones.
async function pushToUsers(admin: Admin, userIds: string[], data: Record<string, string>) {
  const { data: tokens, error: tokensError } = await admin
    .from('push_tokens')
    .select('token, user_id')
    .in('user_id', userIds)
  if (tokensError) return json({ error: tokensError.message }, 500)
  if (!tokens?.length) return json({ sent: 0, reason: 'sin dispositivos registrados' })

  const saJson = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON')
  if (!saJson) return json({ error: 'FIREBASE_SERVICE_ACCOUNT_JSON no configurada' }, 500)
  const serviceAccount = JSON.parse(saJson)

  let accessToken: string
  try {
    accessToken = await getFcmAccessToken(serviceAccount)
  } catch (err) {
    return json({ error: `token de Google: ${err instanceof Error ? err.message : String(err)}` }, 502)
  }

  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`

  const staleTokens: string[] = []
  const results: PushResult[] = await Promise.all(
    tokens.map(async ({ token, user_id }): Promise<PushResult> => {
      const actionToken = data.chatKey ? await signActionToken(user_id, data.chatKey) : ''
      const res = await fetch(fcmUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            data: { ...data, recipientId: user_id, actionToken },
            android: { priority: 'HIGH' },
          },
        }),
      })
      if (res.ok) return { status: res.status }
      const errData = await res.json().catch(() => null)
      const status = errData?.error?.status
      console.error('FCM rechazó el push:', res.status, JSON.stringify(errData))
      // token de un dispositivo desinstalado/deslogueado hace rato — FCM
      // avisa así, es el momento de limpiarlo (si no, cada mensaje futuro
      // vuelve a pegarle a un token muerto para siempre).
      if (status === 'UNREGISTERED' || status === 'NOT_FOUND') staleTokens.push(token)
      return { status: res.status, error: `${status ?? ''} ${errData?.error?.message ?? ''}`.trim() }
    })
  )

  if (staleTokens.length) await admin.from('push_tokens').delete().in('token', staleTokens)

  const sent = results.filter((r) => r.status === 200).length
  return json({ sent, total: tokens.length, results })
}

// push de un mensaje nuevo de `sender` a un 1:1 (recipientId) o a un grupo
// (conversationId: se reparte a todos los miembros menos el que lo mandó).
// El chatKey es el del lado de quien RECIBE (dm-<quien manda> / group-<id>),
// el mismo formato que usa la app (ver activeChatKey en ChatView.jsx).
async function notifyChat(
  admin: Admin,
  sender: SenderUser,
  preview: string,
  { recipientId, conversationId }: { recipientId?: string; conversationId?: string }
) {
  const senderName = sender.email ?? 'Alguien'
  if (conversationId) {
    // el JWT ya identifica a quien manda; verificar que sea miembro es lo que
    // impide que un tercero use esta función para spamear un grupo ajeno.
    const { data: members, error: membersError } = await admin
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', conversationId)
    if (membersError) return json({ error: membersError.message }, 500)
    if (!members?.some((m) => m.user_id === sender.id)) {
      return json({ error: 'no sos miembro de esa conversación' }, 403)
    }
    const recipientIds = members.filter((m) => m.user_id !== sender.id).map((m) => m.user_id)
    if (!recipientIds.length) return json({ sent: 0, reason: 'sin destinatarios' })

    const { data: conversation } = await admin
      .from('conversations')
      .select('name, icon')
      .eq('id', conversationId)
      .maybeSingle()
    // foto del grupo: su imagen si tiene una; si el ícono es un emoji, lo
    // dibuja la app. Sin ícono va 👥 (el mismo que muestra la app para grupos
    // sin ícono, ver ConversationAvatar en ChatView.jsx) y NO el logo de
    // FlashLab: ese ya sale de insignia en la notificación y quedaba repetido.
    // El emoji viaja siempre: es también el respaldo si la imagen no baja.
    const icon = (conversation?.icon ?? '') as string
    const emojiIcon = icon && !icon.includes('://') && !icon.startsWith('data:') ? icon : ''
    return pushToUsers(admin, recipientIds, {
      title: conversation?.name || 'Grupo',
      body: preview,
      senderId: sender.id,
      senderName,
      chatKey: `group-${conversationId}`,
      conversationId,
      isGroup: '1',
      avatarUrl: icon.startsWith('https://') ? icon : '',
      avatarEmoji: emojiIcon || '👥',
    })
  }

  return pushToUsers(admin, [recipientId!], {
    title: senderName,
    body: preview,
    senderId: sender.id,
    senderName,
    chatKey: `dm-${sender.id}`,
    isGroup: '0',
    avatarUrl: avatarOf(sender),
    avatarEmoji: '',
  })
}

async function markChatRead(admin: Admin, userId: string, chatKey: string) {
  const now = new Date().toISOString()
  if (chatKey.startsWith('dm-')) {
    return admin
      .from('direct_message_reads')
      .upsert({ user_id: userId, other_user_id: chatKey.slice(3), last_read_at: now })
  }
  return admin
    .from('group_message_reads')
    .upsert({ conversation_id: chatKey.slice(6), user_id: userId, last_read_at: now })
}

// Responder / Marcar como leído desde la notificación de Android (ver
// NotificationActionReceiver.java). Autorizado por el token de acción del
// push, no por una sesión (ver signActionToken).
async function handleNotificationAction(
  admin: Admin,
  body: { type?: string; userId?: string; chatKey?: string; token?: string; text?: string }
) {
  const { type, userId, chatKey, token } = body
  if (!userId || !chatKey || !token || !/^(dm|group)-[0-9a-f-]{36}$/.test(chatKey)) {
    return json({ error: 'faltan parámetros' }, 400)
  }
  if (!(await verifyActionToken(token, userId, chatKey))) return json({ error: 'token de acción inválido' }, 401)

  if (type === 'mark_read') {
    const { error } = await markChatRead(admin, userId, chatKey)
    if (error) return json({ error: error.message }, 500)
    return json({ ok: true })
  }

  if (type !== 'reply') return json({ error: 'acción desconocida' }, 400)
  const text = (body.text ?? '').trim()
  if (!text) return json({ error: 'respuesta vacía' }, 400)

  const { data: userData, error: userError } = await admin.auth.admin.getUserById(userId)
  if (userError || !userData?.user) return json({ error: 'usuario inexistente' }, 404)

  if (chatKey.startsWith('dm-')) {
    const otherId = chatKey.slice(3)
    const { error } = await admin
      .from('direct_messages')
      .insert({ sender_id: userId, recipient_id: otherId, content: text, message_type: 'text' })
    if (error) return json({ error: error.message }, 500)
    await markChatRead(admin, userId, chatKey)
    return notifyChat(admin, userData.user, text, { recipientId: otherId })
  }

  const conversationId = chatKey.slice(6)
  const { data: membership } = await admin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!membership) return json({ error: 'no sos miembro de esa conversación' }, 403)
  const { error } = await admin
    .from('group_messages')
    .insert({ conversation_id: conversationId, sender_id: userId, content: text, message_type: 'text' })
  if (error) return json({ error: error.message }, 500)
  await markChatRead(admin, userId, chatKey)
  return notifyChat(admin, userData.user, text, { conversationId })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ error: 'falta el header Authorization' }, 401)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // formas de llamarla:
  //   { recipientId, preview }        -> 1:1 (direct_messages), con JWT de usuario
  //   { conversationId, preview }     -> grupo, con JWT de usuario
  //   { action: 'register_token' }    -> registrar el FCM token de este celular
  //   { action: 'notification_action' } -> botón de la notificación de Android
  //   { action: 'test_push', userId } -> solo service_role, diagnóstico
  let body: {
    action?: string
    token?: string
    platform?: string
    recipientId?: string
    conversationId?: string
    preview?: string
    type?: string
    userId?: string
    chatKey?: string
    text?: string
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'JSON inválido' }, 400)
  }

  // la notificación no tiene sesión de usuario: viene con la publishable key
  // y se autoriza con el token de acción
  if (body?.action === 'notification_action') return handleNotificationAction(admin, body)

  // push de prueba a un usuario, SOLO con la service_role key (o sea, solo
  // el dueño del proyecto) — para verificar FCM -> dispositivo sin depender
  // de que otra cuenta mande un mensaje de chat de verdad.
  if (body?.action === 'test_push') {
    if (!(await isServiceRoleKey(jwt))) return json({ error: 'solo service_role' }, 401)
    if (!body.userId) return json({ error: 'faltan parámetros' }, 400)
    return pushToUsers(admin, [body.userId], {
      title: 'FlashLab',
      body: body.preview || 'Notificación de prueba',
      senderId: '',
      senderName: 'FlashLab',
      chatKey: '',
      isGroup: '0',
      avatarUrl: '',
      avatarEmoji: '',
    })
  }

  const { data: userData, error: userError } = await admin.auth.getUser(jwt)
  if (userError || !userData?.user) return json({ error: 'sesión inválida' }, 401)

  // Registro directo de token con service_role (bypasea RLS cuando cambia de
  // usuario en el mismo celular: la fila del token queda a nombre de la
  // cuenta anterior y la política de update no deja reasignarla — así quedó
  // un celular sin recibir nada hasta el 2026-10-13)
  if (body?.action === 'register_token' && body?.token) {
    const { error: upsertErr } = await admin.from('push_tokens').upsert(
      {
        token: body.token,
        user_id: userData.user.id,
        platform: body.platform || 'android',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' }
    )
    if (upsertErr) return json({ error: upsertErr.message }, 500)
    return json({ ok: true })
  }

  const { recipientId, conversationId, preview } = body
  if (!preview || (!recipientId && !conversationId)) return json({ error: 'faltan parámetros' }, 400)

  return notifyChat(admin, userData.user, preview, { recipientId, conversationId })
})
