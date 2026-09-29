// FlashLab — email de aviso cuando compartís una página.
//
// Usa Resend (https://resend.com) — cuenta gratis, no hace falta verificar
// dominio propio para probar (el remitente por defecto de abajo,
// onboarding@resend.dev, ya viene verificado por Resend para pruebas; para
// producción real conviene verificar tu propio dominio ahí y cambiar
// RESEND_FROM_EMAIL). El secret RESEND_API_KEY hay que cargarlo a mano
// (Edge Functions → Secrets), igual que ya se hizo con las credenciales de
// Calendar.

import { createClient } from 'jsr:@supabase/supabase-js@2'

// ver el comentario de CORS en drive-google-token/index.ts — esta función se
// llama desde el renderer (supabasePages.js), así que en la versión web
// necesita lo mismo para no morir en el preflight.
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

  let body: { pageId?: string; recipientEmail?: string; role?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'JSON inválido' }, 400)
  }
  const { pageId, recipientEmail, role } = body
  if (!pageId || !recipientEmail || !role) return json({ error: 'faltan parámetros' }, 400)

  // el título se trae del server (no se confía en lo que mande el cliente),
  // y de paso confirma que quien llama es el dueño de la página
  const { data: page, error: pageError } = await admin.from('pages').select('title, owner_id').eq('id', pageId).single()
  if (pageError || !page) return json({ error: 'página no encontrada' }, 404)
  if (page.owner_id !== userData.user.id) return json({ error: 'no sos el dueño de esta página' }, 403)

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return json({ error: 'RESEND_API_KEY no configurada' }, 500)

  const roleLabel = role === 'editor' ? 'editar' : 'ver'
  const senderEmail = userData.user.email ?? 'alguien'
  const title = page.title || 'Sin título'
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') || 'FlashLab <onboarding@resend.dev>'

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromEmail,
      to: [recipientEmail],
      subject: `${senderEmail} compartió "${title}" contigo en FlashLab`,
      html: `<p><strong>${senderEmail}</strong> te compartió la página <strong>${title}</strong> en FlashLab, con permiso para <strong>${roleLabel}</strong>.</p><p>Abrí FlashLab y logueate con este mismo email (${recipientEmail}) para verla en "Compartidas conmigo".</p>`,
    }),
  })

  if (!emailRes.ok) {
    const errText = await emailRes.text()
    return json({ error: `resend respondió ${emailRes.status}: ${errText}` }, 502)
  }

  return json({ sent: true })
})
