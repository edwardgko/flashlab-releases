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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ error: 'falta el header Authorization' }, 401)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: userData, error: userError } = await admin.auth.getUser(jwt)
  if (userError || !userData?.user) return json({ error: 'sesión inválida' }, 401)

  // dos formas de llamarla:
  //   { recipientId, preview }     -> 1:1 (direct_messages)
  //   { conversationId, preview }  -> grupo: se reparte a todos los miembros
  //                                  menos el que lo mandó
  // El chat grupal quedó sin push hasta 2026-08-13, y esa era la mitad del
  // "a veces me llegan las notificaciones y a veces no" que se reportó: en
  // 1:1 llegaban, en grupo no llegaba ninguna nunca.
  let body: {
    action?: string
    token?: string
    platform?: string
    recipientId?: string
    conversationId?: string
    preview?: string
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'JSON inválido' }, 400)
  }

  // 1. Registro directo de token con service_role (bypasea RLS cuando cambia de usuario en el mismo celular)
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

  // título de la notificación: en 1:1 es el email del que escribe; en grupo,
  // el nombre del grupo (con el email adentro del cuerpo, igual que la
  // notificación de escritorio — ver notifyGroupRow en Sidebar.jsx).
  let title = userData.user.email ?? 'Alguien'
  let recipientIds: string[] = recipientId ? [recipientId] : []

  if (conversationId) {
    // el JWT ya identifica a quien manda; verificar que sea miembro es lo que
    // impide que un tercero use esta función para spamear un grupo ajeno.
    const { data: members, error: membersError } = await admin
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', conversationId)
    if (membersError) return json({ error: membersError.message }, 500)
    if (!members?.some((m) => m.user_id === userData.user.id)) {
      return json({ error: 'no sos miembro de esa conversación' }, 403)
    }
    recipientIds = members.filter((m) => m.user_id !== userData.user.id).map((m) => m.user_id)

    const { data: conversation } = await admin
      .from('conversations')
      .select('name')
      .eq('id', conversationId)
      .maybeSingle()
    title = conversation?.name || 'Grupo'
  }

  if (!recipientIds.length) return json({ sent: 0, reason: 'sin destinatarios' })

  const { data: tokens, error: tokensError } = await admin
    .from('push_tokens')
    .select('token')
    .in('user_id', recipientIds)
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
  let sent = 0
  await Promise.all(
    tokens.map(async ({ token }) => {
      const res = await fetch(fcmUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body: preview },
            data: {
              title,
              body: preview,
              senderId: userData.user.id,
              ...(conversationId ? { conversationId } : {}),
            },
            android: {
              priority: 'HIGH',
              notification: {
                channel_id: 'flashlab_messages',
                sound: 'default',
                default_sound: true,
                default_vibrate_timings: true,
                default_light_settings: true,
                notification_priority: 'PRIORITY_MAX',
                visibility: 'PUBLIC',
                icon: 'ic_launcher',
              },
            },
          },
        }),
      })
      if (res.ok) {
        sent++
        return
      }
      const errData = await res.json().catch(() => null)
      // token de un dispositivo desinstalado/deslogueado hace rato — FCM
      // avisa así, es el momento de limpiarlo (si no, cada mensaje futuro
      // vuelve a pegarle a un token muerto para siempre).
      const status = errData?.error?.status
      if (status === 'UNREGISTERED' || status === 'NOT_FOUND') staleTokens.push(token)
    })
  )

  if (staleTokens.length) await admin.from('push_tokens').delete().in('token', staleTokens)

  return json({ sent, total: tokens.length })
})
