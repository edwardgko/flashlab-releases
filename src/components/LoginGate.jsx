import { useEffect, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { api, isDesktop } from '../lib/api.js'
import {
  supabase,
  useAuthSession,
  IS_CAPACITOR,
  CAPACITOR_AUTH_REDIRECT,
  completeCapacitorAuth,
} from '../lib/supabaseClient.js'
import { hasLocalPagesToImport, importLocalPagesToSupabase } from '../lib/importLocalPages.js'

const IMPORT_SKIPPED_KEY = 'flashlab-import-skipped'

// Pantalla de importación única: si detecta páginas del JSON local que
// todavía no están en esta cuenta de Supabase, ofrece subirlas antes de
// entrar a <App/> — evita que App.jsx cree una página en blanco de arranque
// (ver syncFromBackend en App.jsx) antes de que el usuario llegue a importar.
function ImportPrompt({ onDone }) {
  const [status, setStatus] = useState('idle') // idle | importing | error
  const [progress, setProgress] = useState({ done: 0, total: 0, title: '' })
  const [error, setError] = useState('')

  const runImport = async () => {
    setStatus('importing')
    setError('')
    try {
      await importLocalPagesToSupabase((p) => setProgress(p))
      onDone()
    } catch (err) {
      console.error('Error importando páginas locales:', err)
      setError(err.message || 'No se pudo importar.')
      setStatus('error')
    }
  }

  const skip = () => {
    localStorage.setItem(IMPORT_SKIPPED_KEY, '1')
    onDone()
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-white text-center dark:bg-[#202020]">
      <p className="text-lg font-semibold text-gray-800 dark:text-neutral-100">Encontramos páginas locales</p>
      <p className="max-w-sm text-sm text-gray-500 dark:text-neutral-400">
        Tenés páginas guardadas en esta computadora de antes de tener cuenta. ¿Las subimos a tu cuenta de Google
        para que queden disponibles en la nube?
      </p>
      {status === 'importing' && (
        <p className="text-xs text-gray-400 dark:text-neutral-500">
          Importando{progress.total ? ` ${progress.done}/${progress.total}` : '…'}
          {progress.title ? ` — ${progress.title}` : ''}
        </p>
      )}
      {status !== 'importing' && (
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            onClick={runImport}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Importar mis páginas
          </button>
          <button
            type="button"
            onClick={skip}
            className="rounded-md px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            Omitir
          </button>
        </div>
      )}
      {error && <p className="max-w-sm text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}

// Puerta de acceso de nivel superior: mientras no haya sesión, no se monta
// <App/> — el gate primero intenta restaurar la sesión guardada (cifrada vía
// safeStorage en el proceso main, ver electron/main.js auth-session.enc), y
// si no hay ninguna, muestra "Continuar con Google".
//
// Fuera de Electron (`vite dev` suelto, sin backend real) NO pasa por el
// cliente real de Supabase: api.login()/getAuthSession() ya devuelven una
// sesión falsa (ver createMemoryAPI en lib/api.js), y acá alcanza con
// guardarla en estado local para destrabar la UI — llamar
// supabase.auth.setSession() con un token falso fallaría (no es un JWT
// válido) sin aportar nada, igual que CalendarView.jsx no intenta un OAuth
// real en su modo simulado.
export default function LoginGate({ children }) {
  // una sola fuente de sesión en las dos plataformas: fuera de Electron la
  // maneja supabase-js (la restaura de localStorage y procesa el redirect
  // del OAuth por sí solo, ver detectSessionInUrl en supabaseClient.js).
  const session = useAuthSession()
  const [bootstrapped, setBootstrapped] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [importCheck, setImportCheck] = useState('pending') // pending | offer | clear

  useEffect(() => {
    // fuera de Electron no hay nada que restaurar a mano: supabase-js ya lo
    // hizo antes de que este efecto corra.
    if (!isDesktop) {
      setBootstrapped(true)
      return undefined
    }
    let cancelled = false
    ;(async () => {
      try {
        const stored = await api.getAuthSession()
        if (cancelled || !stored?.access_token) return
        // setSession de supabase-js no lanza excepción en fallas de API —
        // devuelve { data, error }, hay que chequearlo a mano.
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: stored.access_token,
          refresh_token: stored.refresh_token,
        })
        if (sessionError) console.error('Sesión guardada inválida, se pide login de nuevo:', sessionError)
      } catch (err) {
        console.error('No se pudo restaurar la sesión guardada:', err)
      } finally {
        if (!cancelled) setBootstrapped(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Android: escuchar el deep link de vuelta del login de Google (ver
  // completeCapacitorAuth/CAPACITOR_AUTH_REDIRECT en supabaseClient.js) y
  // cerrar la pestaña de Chrome Custom Tabs que abrió handleLogin. Antes, si
  // completeCapacitorAuth se colgaba (ver el timeout agregado ahí), acá no
  // había ni loading ni error: la pantalla quedaba pegada sin ninguna salida
  // más que forzar el cierre de la app (bug reportado por usuarios reales).
  useEffect(() => {
    if (!IS_CAPACITOR) return undefined
    const sub = CapacitorApp.addListener('appUrlOpen', async ({ url }) => {
      setError('')
      setLoading(true)
      try {
        await completeCapacitorAuth(url)
      } catch (err) {
        console.error('Error completando login de Google:', err)
        setError(err.message || 'No se pudo completar el login. Probá de nuevo.')
      } finally {
        setLoading(false)
        Browser.close().catch(() => {})
      }
    })
    return () => {
      sub.then((s) => s.remove())
    }
  }, [])

  // en cada login, resolver invitaciones pendientes que apuntan al email de
  // esta cuenta (Fase C — compartir) antes de que la app pida las páginas,
  // para que lo que te compartieron ya aparezca desde el primer render.
  useEffect(() => {
    if (!session) return
    supabase.rpc('claim_pending_shares').then(({ error }) => {
      if (error) console.error('No se pudieron reclamar invitaciones pendientes:', error)
    })
  }, [session])

  // solo una vez por sesión de login: ¿hay páginas en el JSON local de esta
  // instalación que todavía no están en la cuenta de Supabase recién logueada?
  useEffect(() => {
    if (!isDesktop || !session) return
    if (localStorage.getItem(IMPORT_SKIPPED_KEY) === '1') {
      setImportCheck('clear')
      return
    }
    let cancelled = false
    ;(async () => {
      const available = await hasLocalPagesToImport().catch(() => false)
      if (!cancelled) setImportCheck(available ? 'offer' : 'clear')
    })()
    return () => {
      cancelled = true
    }
  }, [session])

  const handleLogin = async () => {
    setError('')
    setLoading(true)
    try {
      // Android: Google bloquea el login dentro de un WebView embebido (policy
      // "disallow_webview_signin"), así que hay que abrirlo en Chrome Custom
      // Tabs (@capacitor/browser) con skipBrowserRedirect, y la vuelta la
      // agarra el listener de appUrlOpen de arriba, no esta función.
      if (IS_CAPACITOR) {
        const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: CAPACITOR_AUTH_REDIRECT, skipBrowserRedirect: true },
        })
        if (oauthError) throw oauthError
        await Browser.open({ url: data.url })
        return
      }
      // Web: el login es un redirect a Google y la vuelta trae los tokens en
      // la URL, que supabase-js procesa solo (detectSessionInUrl). Nada de lo
      // que va después de esta llamada llega a ejecutarse: la página se va.
      if (!isDesktop) {
        const { error: oauthError } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: window.location.origin },
        })
        if (oauthError) throw oauthError
        return
      }
      // el login pide de una sola vez los permisos de Google Calendar Y de
      // Drive (antes Calendar era un checkbox acá, y Drive había que
      // conectarlo aparte después): con lo que se otorga en esta misma
      // pantalla de consentimiento quedan conectadas la vista de Calendario
      // y los adjuntos/audios del chat — ver 'auth:login' en
      // electron/main.js, que guarda el refresh_token en las dos tablas.
      // Conectar desde cualquier escritorio habilita la CUENTA entera,
      // incluido el celular (ver isDriveConnectedForAccount).
      const newSession = await api.login()
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: newSession.access_token,
        refresh_token: newSession.refresh_token,
      })
      if (sessionError) throw sessionError
    } catch (err) {
      // el error "cancelado" (ver handleCancelLogin) no es una falla real,
      // no hace falta mostrarlo en rojo
      if (err.message !== 'cancelado') {
        console.error('Error al iniciar sesión:', err)
        setError(err.message || 'No se pudo iniciar sesión.')
      }
    } finally {
      setLoading(false)
    }
  }

  // antes, si cerrabas la pestaña del navegador sin terminar (o cancelar) el
  // consentimiento de Google, el botón quedaba "Esperando autorización…"
  // colgado hasta el timeout de 5 min del server local (ver
  // pendingLoopbackCancel en electron/main.js) sin forma de reintentar antes.
  const handleCancelLogin = () => {
    api.cancelGoogleAuth()
  }

  // `session === undefined` = todavía no se sabe (getSession en curso), null =
  // no hay. Antes esa espera estaba gateada por isDesktop, así que en Android
  // y web se caía derecho al `if (!session)` de abajo mientras la sesión se
  // leía: la pantalla de "Continuar con Google" aparecía en CADA arranque por
  // un rato y después desaparecía sola al resolverse — molesto de más si usás
  // la app seguido desde el celular (reportado). Ahora esperamos en las tres
  // plataformas; el timeout de useAuthSession garantiza que esta espera no
  // pueda quedar colgada para siempre.
  if (!bootstrapped || session === undefined) {
    return (
      <div className="flex h-screen items-center justify-center bg-white text-sm text-gray-400 dark:bg-[#202020] dark:text-neutral-500">
        Cargando…
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-white text-center dark:bg-[#202020]">
        <p className="text-lg font-semibold text-gray-800 dark:text-neutral-100">FlashLab</p>
        <p className="max-w-sm text-sm text-gray-500 dark:text-neutral-400">
          Iniciá sesión con tu cuenta de Google para continuar.
        </p>
        <button
          type="button"
          onClick={handleLogin}
          disabled={loading}
          className="mt-1 flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <GoogleIcon />
          Continuar con Google
        </button>
        {loading && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-400 dark:text-neutral-500">Esperando autorización en tu navegador…</p>
            {isDesktop && (
              <button
                type="button"
                onClick={handleCancelLogin}
                className="text-xs text-gray-400 underline hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300"
              >
                Cancelar
              </button>
            )}
          </div>
        )}
        {error && <p className="max-w-sm text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    )
  }

  if (isDesktop && importCheck === 'pending') {
    return (
      <div className="flex h-screen items-center justify-center bg-white text-sm text-gray-400 dark:bg-[#202020] dark:text-neutral-500">
        Cargando…
      </div>
    )
  }

  if (isDesktop && importCheck === 'offer') {
    return <ImportPrompt onDone={() => setImportCheck('clear')} />
  }

  return children
}
