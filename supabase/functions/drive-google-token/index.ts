// FlashLab — refresh de Google Drive para el login unificado.
//
// Calco de calendar-google-token/index.ts: mismo client OAuth "Web
// application" compartido (Authentication → Providers → Google), así que
// reusa los mismos secrets GOOGLE_CALENDAR_CLIENT_ID/SECRET — a pesar del
// nombre, esas son las credenciales del client compartido en general, no
// algo específico de Calendar. No hace falta cargar secrets nuevos para
// esta función.
//   - action "store": guarda el provider_refresh_token que Google entregó al
//     conectar Drive (solo se entrega una vez, hay que capturarlo ahí).
//   - action "refresh": cambia ese refresh_token por un access_token de
//     Google fresco.
//   - action "disconnect": borra el refresh_token guardado.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// CORS: hasta ahora esta función solo la llamaba el proceso main de Electron
// (net.fetch, que no pasa por CORS), así que no hacía falta. La versión web
// (navegador y Android) la llama desde el propio navegador, y ahí sin estos
// headers el pedido ni siquiera sale: falla en el preflight OPTIONS.
// El '*' es seguro acá porque la función no hace nada sin un JWT válido en
// Authorization, y no se usan cookies — además Capacitor sirve la app desde
// un origen propio que no se puede enumerar de antemano.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ error: 'falta el header Authorization' }, 401)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: userData, error: userError } = await admin.auth.getUser(jwt)
  if (userError || !userData?.user) return json({ error: 'sesión inválida' }, 401)
  const userId = userData.user.id

  let body: { action?: string; refreshToken?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'JSON inválido' }, 400)
  }

  if (body.action === 'store') {
    if (!body.refreshToken || typeof body.refreshToken !== 'string') {
      return json({ error: 'falta refreshToken' }, 400)
    }
    const { error } = await admin
      .from('drive_google_tokens')
      .upsert({ user_id: userId, refresh_token: body.refreshToken, updated_at: new Date().toISOString() })
    if (error) return json({ error: error.message }, 500)
    return json({ stored: true })
  }

  if (body.action === 'refresh') {
    const { data: row, error } = await admin
      .from('drive_google_tokens')
      .select('refresh_token')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) return json({ error: error.message }, 500)
    if (!row) return json({ error: 'not_connected' }, 404)

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
    if (!tokenRes.ok) {
      return json({ error: tokenData.error_description || tokenData.error || 'refresh falló' }, 502)
    }
    return json({ access_token: tokenData.access_token, expires_in: tokenData.expires_in })
  }

  if (body.action === 'disconnect') {
    const { error } = await admin.from('drive_google_tokens').delete().eq('user_id', userId)
    if (error) return json({ error: error.message }, 500)
    return json({ disconnected: true })
  }

  return json({ error: 'acción desconocida' }, 400)
})
