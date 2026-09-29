import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Capacitor } from '@capacitor/core'
import { api } from './api.js'

// true solo dentro del APK empaquetado con Capacitor (no en navegador ni Electron).
export const IS_CAPACITOR = Capacitor.isNativePlatform()

// Esquema propio registrado en android/app/src/main/AndroidManifest.xml
// (intent-filter de MainActivity) — Google no redirige un OAuth de vuelta a
// un WebView embebido (lo bloquea por policy), así que en Android el login
// se abre en Chrome Custom Tabs (@capacitor/browser) y vuelve acá por este
// deep link en vez de por window.location, ver handleLogin en LoginGate.jsx.
export const CAPACITOR_AUTH_REDIRECT = 'flashlab://auth-callback'

// Mismos valores que electron/main.js (no son secretos — la publishable
// key es pública por diseño en Supabase, la seguridad la da Row Level
// Security).
export const SUPABASE_URL = 'https://egwyllgnludowtpnfgdi.supabase.co'
export const SUPABASE_ANON_KEY = 'sb_publishable_hvRCGxIIcWnzQbzBGimWTA_vU4gT1S5'

// Se calcula acá en vez de importar isDesktop de api.js a propósito: este
// módulo ya está en un ciclo de imports con api.js (api.js -> supabasePages.js
// -> este archivo -> api.js) y ese ciclo solo funciona porque `api` se usa
// dentro de funciones, nunca al evaluar el módulo. La config de abajo sí se
// evalúa al importar, así que no puede depender de un import del ciclo.
const IS_ELECTRON = Boolean(globalThis.window?.notionAPI)

// En Electron: persistSession:false porque la persistencia real la hace
// safeStorage vía el proceso main (auth-session.enc), no el localStorage sin
// cifrar del renderer; y detectSessionInUrl:false porque ahí nunca llegamos
// por una URL con tokens — el login es 100% por IPC (LoginGate.jsx), con el
// flujo loopback + PKCE de main.js.
//
// En navegador/Android es exactamente al revés: no hay proceso main que
// guarde nada, así que supabase-js tiene que persistir la sesión él mismo, y
// el login vuelve por un redirect con los tokens en la URL
// (signInWithOAuth), que es justo lo que detectSessionInUrl procesa.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: !IS_ELECTRON,
    autoRefreshToken: true,
    detectSessionInUrl: !IS_ELECTRON,
    flowType: 'pkce',
  },
})

// Supabase rota el refresh_token en cada uso: si no volvemos a persistir acá
// en cada TOKEN_REFRESHED (no solo en el login inicial), la próxima vez que
// se abra la app el token guardado ya puede estar quemado y fuerza un
// re-login sin motivo aparente para el usuario.
export function watchAuthSession(onSessionChange) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      api.persistAuthSession(session)
    } else if (event === 'SIGNED_OUT') {
      api.persistAuthSession(null)
    }
    onSessionChange?.(session)
  })
  return () => data.subscription.unsubscribe()
}

// exchangeCodeForSession puede quedar colgada para siempre en Android: si un
// refresh automático anterior se congeló a mitad de un fetch (WebView en
// pausa mientras Chrome Custom Tabs está al frente), el lock interno de
// auth-js (_acquireLock en GoTrueClient) queda tomado y cualquier llamada
// posterior se encola detrás de una promesa que nunca resuelve ni rechaza —
// sin este timeout, LoginGate se queda en "Cargando…" sin salida y la única
// forma de destrabarlo es forzar el cierre de la app (bug reportado).
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}

// Solo Android: el redirect de Google vuelve como intent (CAPACITOR_AUTH_REDIRECT),
// no como navegación de página, así que detectSessionInUrl no lo agarra —
// hay que escuchar el deep link a mano y canjear el "code" de PKCE por la
// sesión. Se registra una sola vez desde LoginGate.jsx.
export async function completeCapacitorAuth(url) {
  if (!url.startsWith(CAPACITOR_AUTH_REDIRECT)) return
  const code = new URL(url).searchParams.get('code')
  if (!code) return
  const { error } = await withTimeout(
    supabase.auth.exchangeCodeForSession(code),
    15000,
    'No se pudo completar el login (tiempo de espera agotado). Probá de nuevo.'
  )
  if (error) throw error
}

// sesión actual, reactiva — la usan tanto LoginGate (para decidir si mostrar
// la pantalla de login) como cualquier otro componente que necesite el
// email del usuario o poder cerrar sesión (ej. Sidebar). undefined mientras
// todavía no se sabe, null si no hay sesión.
export function useAuthSession() {
  const [session, setSession] = useState(undefined)
  useEffect(() => {
    let cancelled = false
    // getSession() puede colgarse por el MISMO lock de auth-js que ya obligó a
    // poner un timeout en completeCapacitorAuth (ver withTimeout arriba): si
    // un refresh anterior se congeló con el WebView en pausa, esta llamada se
    // encola detrás de una promesa que nunca resuelve. Sin el timeout,
    // `session` se queda en undefined para siempre y la app entera queda en
    // "Cargando…" sin salida (reportado en Android). Al vencer se asume "no
    // hay sesión" para que al menos aparezca el botón de login; si en
    // realidad sí había, el onAuthStateChange de watchAuthSession la entrega
    // igual cuando el lock se libera y la pantalla se corrige sola.
    withTimeout(supabase.auth.getSession(), 8000, 'timeout leyendo la sesión guardada')
      .then(({ data }) => {
        if (!cancelled) setSession(data.session ?? null)
      })
      .catch((err) => {
        console.error('No se pudo leer la sesión guardada:', err)
        if (!cancelled) setSession(null)
      })
    const unwatch = watchAuthSession((next) => setSession(next ?? null))
    return () => {
      cancelled = true
      unwatch()
    }
  }, [])
  return session
}
