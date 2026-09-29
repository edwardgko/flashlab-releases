import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { api } from './lib/api.js'
import { useAuthSession, IS_CAPACITOR } from './lib/supabaseClient.js'
import { setupPushNotifications } from './lib/pushNotifications.js'
import Sidebar from './components/Sidebar.jsx'
import { isMobileNow, useIsMobile } from './lib/useIsMobile.js'
import { emitReloadContent } from './lib/liveSync.js'
import PageView from './components/PageView.jsx'
import QuickSwitcher from './components/QuickSwitcher.jsx'
import HomeView from './components/HomeView.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import TabBar from './components/TabBar.jsx'

// vistas secundarias en carga diferida — no todas las sesiones abren Chat,
// Calendario o Grabaciones, y antes iban igual en el bundle inicial (junto
// con Editor.js y sus plugins) sin importar qué pestaña se abriera primero.
// Reportado como lentitud general en otra máquina; esto es lo de mayor
// impacto y menor riesgo: React.lazy + Suspense es una API estable, y estos
// componentes ya son mutuamente excluyentes entre sí en el render (una sola
// pestaña activa a la vez), así que un único Suspense alcanza.
const PagePeek = lazy(() => import('./components/PagePeek.jsx'))
const CalendarView = lazy(() => import('./components/CalendarView.jsx'))
const RecordingsView = lazy(() => import('./components/RecordingsView.jsx'))
const ChatView = lazy(() => import('./components/ChatView.jsx'))

function SuspenseFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-neutral-500">Cargando…</div>
  )
}

const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' }

// componente propio (no un div inline) para que el fade-in tenga su PROPIO
// mount por cada apertura — mismo truco de "entered" que ya usan Sidebar.jsx
// y PagePeek.jsx para la entrada del panel; sin este componente aparte, un
// useState viviendo directo en App no se resetearía solo al cerrar/abrir de
// nuevo (App nunca se desmonta).
// confined: en desktop el cajón se superpone solo al área de contenido, no a
// la barra de pestañas de arriba (esa no es "contenido") — así que el fondo
// oscuro también se limita ahí (absolute contra el div relative de más
// abajo) en vez de tapar toda la ventana (fixed, lo que sí hace en mobile,
// donde el cajón tapa todo a propósito).
function SidebarBackdrop({ onClick, confined, open = true }) {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  // mismo mecanismo que Sidebar.jsx: `entered` solo cubre el primer paint
  // (mount ya en la posición cerrada); de ahí en más sigue al prop `open` —
  // así en desktop, cuando App.jsx lo mantiene montado un rato más para
  // dejar salir la animación, el fondo se apaga en sincro con el cajón en
  // vez de desaparecer de un salto antes de que termine de deslizar.
  const isOpenVisual = entered && open
  return (
    <div
      className={`${confined ? 'absolute' : 'fixed'} inset-0 z-20 bg-black/30 backdrop-blur-sm transition-opacity duration-200 ${
        isOpenVisual ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={onClick}
      aria-hidden="true"
    />
  )
}

// mismo ícono que el botón de "Ocultar sidebar" (Sidebar.jsx ICONS.menu) —
// hamburguesa cuando está oculto, X ahí adentro cuando está visible, así el
// mismo símbolo siempre indica "así se ve/se abre el sidebar" sin cambiar de
// familia entre los dos estados.
// Tamaño y trazo subidos (era h-4 w-4 con stroke 1.8, en gris 400): a ese
// tamaño y con ese contraste el único acceso al sidebar cuando está cerrado
// pasaba desapercibido. Ahora arranca en 24px (el tamaño cómodo de mobile) y
// baja a 20px recién en pantallas grandes, donde el puntero es preciso.
function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6 md:h-5 md:w-5"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  )
}

const makeTab = (patch = {}) => ({ id: crypto.randomUUID(), kind: 'page', pageId: null, ...patch })

// por cuenta, no global — con una clave compartida, cambiar de cuenta
// intentaba restaurar las pestañas de la cuenta anterior contra las páginas
// de la nueva (que son otras por completo), no encontraba ninguna
// coincidencia y volvía a la pestaña única por defecto.
const tabsStorageKey = (userId) => `flashlab-tabs-${userId ?? 'local'}`

// cadena de ancestros (raíz → padre) para breadcrumbs, reusada tanto para la
// página de la pestaña activa como para la que está abierta en el peek
function ancestorPath(pages, page) {
  const path = []
  let cursor = page
  while (cursor && cursor.parentId != null) {
    const parent = pages.find((p) => p.id === cursor.parentId)
    if (!parent) break
    path.unshift(parent)
    cursor = parent
  }
  return path
}

// theme/setTheme vienen de main.jsx (useTheme() vive ahí, wrappeando también
// a LoginGate) — así la pantalla de login ya tiene la clase `dark` puesta
// antes de que <App/> llegue a montarse, en vez de quedar pegada en claro
// hasta el primer login.
export default function App({ theme, setTheme }) {
  const session = useAuthSession()
  const myId = session?.user?.id ?? null
  const [pages, setPages] = useState(null) // todas las páginas, incluida la papelera
  const [tabs, setTabs] = useState(null) // [{ id, kind: 'page'|'calendar', pageId }]
  const [activeTabId, setActiveTabId] = useState(null)
  const isMobile = useIsMobile()

  // precarga en segundo plano (sin Suspense, sin esperar el resultado) de los
  // chunks lazy más grandes de PageView.jsx (Editor/MobileEditor,
  // DatabaseView) — quedan lazy para que el bundle INICIAL sea más chico
  // (se nota en una PC menos potente), pero sin esto el usuario vería un
  // "Cargando…" la primera vez que abre cualquier página en la sesión.
  // requestIdleCallback: que no compita con el trabajo de montar la UI
  // recién arrancada; setTimeout es el fallback en navegadores/WebViews que
  // no lo tienen (Safari/algunos Android viejos).
  useEffect(() => {
    const prefetch = () => {
      import('./components/DatabaseView.jsx')
      import(isMobile ? './components/MobileEditor.jsx' : './components/Editor.jsx')
    }
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(prefetch)
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(prefetch, 1000)
    return () => clearTimeout(id)
  }, [isMobile])

  // arranca cerrado en mobile — un cajón que tapa toda la pantalla no debe
  // aparecer solo por abrir la app, a diferencia del panel fijo de desktop.
  // acá no se puede reusar el HOOK porque hace falta en el estado inicial,
  // antes del primer render — pero sí la misma función (isMobileNow), en vez
  // de la copia a mano de la fórmula que había antes: con escala de Windows
  // al 125% esa copia decía "es mobile" en una PC y el sidebar arrancaba
  // cerrado, en modo cajón a pantalla completa.
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobileNow())
  const [sidebarPinned, setSidebarPinned] = useState(() => {
    try {
      const saved = localStorage.getItem("flashlab:sidebar_pinned")
      return saved !== null ? saved === "true" : true
    } catch {
      return true
    }
  })
  const toggleSidebarPin = useCallback(() => {
    setSidebarPinned((prev) => {
      const next = !prev
      try {
        localStorage.setItem("flashlab:sidebar_pinned", String(next))
      } catch {}
      return next
    })
  }, [])
  // en desktop, sidebarMounted se queda en true 200ms después de que
  // sidebarOpen pasa a false (mismo duration-200 que el transition-transform
  // de Sidebar.jsx) para que el cajón y su fondo alcancen a deslizar/apagarse
  // hacia afuera en vez de desaparecer de golpe — Sidebar ya sigue el prop
  // `open` en cada re-render, así que basta con retrasar SOLO el desmontaje.
  // En mobile se mantiene el cierre instantáneo de siempre (no se pidió
  // cambiar eso, y ahí el cajón tapa toda la pantalla como un drawer nativo).
  const [sidebarMounted, setSidebarMounted] = useState(sidebarOpen)
  useEffect(() => {
    if (sidebarOpen) {
      setSidebarMounted(true)
      return undefined
    }
    if (isMobile) {
      setSidebarMounted(false)
      return undefined
    }
    const timeout = setTimeout(() => setSidebarMounted(false), 200)
    return () => clearTimeout(timeout)
  }, [sidebarOpen, isMobile])
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [peekPageId, setPeekPageId] = useState(null)
  // solo para la tarjeta "Seguí donde quedaste" de la home — la restauración
  // real de pestañas al abrir la app no depende de esto (ver init effect).
  const [lastOpenedId, setLastOpenedId] = useState(null)
  const didInit = useRef(false)

  useEffect(() => {
    if (!IS_CAPACITOR || !myId) return
    setupPushNotifications(myId)
  }, [myId])

  // Android: el sidebar en mobile es un cajón que tapa toda la pantalla (ver
  // comentario de sidebarOpen más arriba) — el botón de atrás del sistema
  // debe cerrarlo primero, como cualquier overlay, en vez de actuar sobre lo
  // que tiene tapado debajo. ChatView tiene su propio listener de
  // 'backButton' para su navegación interna (ver ese archivo); le pasamos
  // sidebarOpen para que se quede quieto mientras el cajón está abierto y no
  // se disparen los dos a la vez con un solo click de atrás.
  useEffect(() => {
    if (!IS_CAPACITOR) return undefined
    const subPromise = CapacitorApp.addListener('backButton', () => {
      if (sidebarOpen) setSidebarOpen(false)
    })
    return () => {
      subPromise.then((sub) => sub.remove())
    }
  }, [sidebarOpen])

  const patchTab = useCallback((tabId, patch) => {
    setTabs((prev) => prev?.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) ?? prev)
  }, [])
  const patchActiveTab = useCallback((patch) => patchTab(activeTabId, patch), [activeTabId, patchTab])

  const selectPage = useCallback(
    (id) => {
      patchActiveTab({ kind: 'page', pageId: id })
      api.setLastOpened(id)
      setLastOpenedId(id)
    },
    [patchActiveTab]
  )

  // Ctrl+P (o Cmd+P en mac) abre el quick switcher — el resto de los atajos
  // de pestañas (Ctrl+T/W/Tab/1-9) se agregan más abajo, una vez definidas
  // openNewTab/closeTab (ver el otro useEffect cerca de reorderTabs).
  useEffect(() => {
    const handler = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setSwitcherOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // El backend es la fuente de la verdad del árbol/orden: tras cada mutación
  // estructural se recarga el índice. Solo toca la pestaña activa, y solo si
  // está mostrando una página (una pestaña en modo Calendario no se pisa).
  const syncFromBackend = useCallback(
    async (preferredId = null, tabIdOverride = null) => {
      let index = await api.listPages()
      if (!index.pages.some((p) => !p.trashedAt)) {
        await api.createPage('', null)
        index = await api.listPages()
      }
      setPages(index.pages)
      const active = index.pages.filter((p) => !p.trashedAt)
      const isActive = (id) => id && active.some((p) => p.id === id)
      setTabs((prevTabs) => {
        if (!prevTabs) return prevTabs
        const targetId = tabIdOverride ?? activeTabId
        return prevTabs.map((t) => {
          if (t.id !== targetId || t.kind !== 'page') return t
          const next = isActive(preferredId) ? preferredId : isActive(t.pageId) ? t.pageId : active[0]?.id ?? null
          if (next !== t.pageId) {
            api.setLastOpened(next)
            setLastOpenedId(next)
          }
          return { ...t, pageId: next }
        })
      })
      return index
    },
    [activeTabId]
  )

  // "Recargar" del sidebar: el árbol lo vuelve a traer syncFromBackend, pero
  // el CONTENIDO de la vista abierta (bloques de la página, filas de la base)
  // lo carga cada vista por su cuenta y no se entera de nada — el evento es
  // la forma de avisarles sin tener que subir todo ese estado hasta acá.
  // Mismo patrón que ya usa 'flashlab:chat-read' entre ChatView y Sidebar.
  const reloadEverything = useCallback(async () => {
    await syncFromBackend()
    emitReloadContent()
  }, [syncFromBackend])

  useEffect(() => {
    // guard con ref: StrictMode ejecuta el efecto dos veces y crearía
    // dos páginas iniciales
    if (didInit.current) return
    // esperar a saber qué cuenta está logueada antes de decidir con qué
    // clave de localStorage restaurar las pestañas (ver tabsStorageKey) —
    // ANTES este guard era `isDesktop && session === undefined`, pero en
    // Android/web `session` también arranca undefined (useAuthSession es
    // async) y este efecto corría en el mismísimo primer render, antes de
    // que esa promesa resolviera — myId quedaba null, se leía/escribía
    // SIEMPRE bajo la clave 'flashlab-tabs-local' en vez de la de la cuenta
    // real. Resultado: la restauración de pestañas nunca encontraba nada
    // (lo guardado vive bajo la clave correcta) y caía siempre al fallback
    // de lastOpenedId del servidor — reportado como "siempre me aparece la
    // pestaña de reuniones, cerrarla a Inicio no queda guardado para la
    // próxima". Ahora se espera en todas las plataformas, no solo desktop.
    if (session === undefined) return
    didInit.current = true
    ;(async () => {
      const index = await api.listPages()
      const active = index.pages.filter((p) => !p.trashedAt)
      const isActive = (id) => id && active.some((p) => p.id === id)
      if (isActive(index.lastOpenedId)) setLastOpenedId(index.lastOpenedId)

      // valida un candidato {tabs, activeTabId} contra las páginas activas
      // — a las pestañas que apuntaban a una página ya borrada se les
      // reasigna la primera disponible, así no se pierde la pestaña entera
      const normalize = (candidate) => {
        if (!Array.isArray(candidate?.tabs) || candidate.tabs.length === 0) return null
        const validTabs = candidate.tabs
          .filter((t) => t?.id && t?.kind)
          .map((t) => (t.kind === 'page' && !isActive(t.pageId) ? { ...t, pageId: active[0]?.id ?? null } : t))
          .filter((t) => t.kind !== 'page' || t.pageId)
        if (validTabs.length === 0) return null
        const activeId = validTabs.some((t) => t.id === candidate.activeTabId) ? candidate.activeTabId : validTabs[0].id
        return { tabs: validTabs, activeTabId: activeId }
      }

      // pestañas sincronizadas desde otro dispositivo (ver 0024_tab_state.sql
      // y setTabState más abajo) — se intentan primero porque son la fuente
      // más al día ENTRE dispositivos; localStorage queda de respaldo si el
      // server todavía no tiene nada (primera vez que se usa esto) o falló
      // la red.
      let restored = null
      try {
        restored = normalize(await api.getTabState())
      } catch (err) {
        console.error('No se pudieron traer las pestañas sincronizadas:', err)
      }
      if (!restored) {
        try {
          restored = normalize(JSON.parse(localStorage.getItem(tabsStorageKey(myId)) || 'null'))
        } catch {
          // localStorage corrupto: seguir con el arranque de siempre
        }
      }

      if (restored) {
        setTabs(restored.tabs)
        setActiveTabId(restored.activeTabId)
        await syncFromBackend(null, restored.activeTabId)
        return
      }

      const openId = active.some((p) => p.id === index.lastOpenedId) ? index.lastOpenedId : active[0]?.id ?? null
      const initialTab = makeTab({ pageId: openId })
      setTabs([initialTab])
      setActiveTabId(initialTab.id)
      await syncFromBackend(openId, initialTab.id)
    })()
  }, [syncFromBackend, session, myId])

  // guardar las pestañas abiertas para restaurarlas en la próxima sesión —
  // por cuenta (ver tabsStorageKey). localStorage es instantáneo y sirve de
  // respaldo offline; setTabState (debounced 800ms — abrir 3 páginas
  // seguidas no debe mandar 3 requests) las sincroniza al server para que
  // el próximo dispositivo que abra la cuenta las encuentre.
  useEffect(() => {
    if (!tabs) return
    localStorage.setItem(tabsStorageKey(myId), JSON.stringify({ tabs, activeTabId }))
    const timer = setTimeout(() => {
      api.setTabState(tabs, activeTabId).catch((err) => console.error('No se pudieron sincronizar las pestañas:', err))
    }, 800)
    return () => clearTimeout(timer)
  }, [tabs, activeTabId, myId])

  // Menú nativo (Archivo): nueva página / guardar / exportar / importar.
  // "Guardar" y "Exportar" se resuelven dentro de Editor.jsx (necesita el
  // estado vivo del editor), así que solo reenviamos un evento de ventana.
  useEffect(() => {
    const offNewPage = api.onMenuNewPage(() => {
      patchActiveTab({ kind: 'page' })
      api.createPage('', null).then((page) => syncFromBackend(page.id))
    })
    const offSave = api.onMenuSave(() => window.dispatchEvent(new Event('app:force-save')))
    const offExportMd = api.onMenuExportMarkdown(() =>
      window.dispatchEvent(new CustomEvent('app:export', { detail: { format: 'markdown' } }))
    )
    const offExportHtml = api.onMenuExportHtml(() =>
      window.dispatchEvent(new CustomEvent('app:export', { detail: { format: 'html' } }))
    )
    const offImport = api.onMenuImportMarkdown(async () => {
      const picked = await api.importMarkdownFile()
      if (!picked) return
      const { parseMarkdown } = await import('./lib/exportBlocks.js')
      const blocks = parseMarkdown(picked.content)
      const page = await api.createPage(picked.name, null)
      await api.savePage(page.id, { time: Date.now(), version: '2.31.6', blocks })
      patchActiveTab({ kind: 'page' })
      await syncFromBackend(page.id)
    })
    return () => {
      offNewPage()
      offSave()
      offExportMd()
      offExportHtml()
      offImport()
    }
  }, [syncFromBackend, patchActiveTab])

  const createPage = async (parentId = null, title = '') => {
    const page = await api.createPage(title, parentId)
    patchActiveTab({ kind: 'page' })
    await syncFromBackend(page.id)
    return page
  }

  const createDatabase = async (parentId = null) => {
    const page = await api.createDatabase('', parentId)
    patchActiveTab({ kind: 'page' })
    await syncFromBackend(page.id)
  }

  // abre una fila/página en el panel lateral (peek) en vez de reemplazar la
  // pestaña activa — así se conserva el contexto de la tabla/tablero de atrás
  const openPeek = (id) => setPeekPageId(id)
  const closePeek = () => setPeekPageId(null)

  // crear una fila (página con propiedades) sin salir de la vista de la base de datos
  // sin resync completo — api.createPage ya devuelve la fila creada, alcanza
  // con sumarla al estado local (mismo motivo que updateRowProperty)
  const createRow = async (parentId, properties) => {
    const page = await api.createPage('', parentId, properties)
    setPages((prev) => [...prev, page])
  }

  // duplicar una fila sin salir de la vista de la base de datos (a diferencia
  // de duplicatePage, que enfoca la copia — acá conviene quedarse mirando la
  // tabla/tablero con la fila nueva ya agregada)
  const duplicateRow = async (id) => {
    await api.duplicatePage(id)
    await syncFromBackend()
  }

  // optimista, como renamePage/setPageIcon — antes esperaba el guardado y
  // recién ahí releía TODAS las páginas del workspace, para cambiar un solo
  // valor. Con una base de varias decenas de páginas eso se sentía lento en
  // cualquier edición de propiedad (tildar un checkbox, mover una tarjeta
  // de columna en el Tablero), reportado como lentitud general.
  const updateRowProperty = async (rowId, propId, value) => {
    setPages((prev) => prev.map((p) => (p.id === rowId ? { ...p, properties: { ...p.properties, [propId]: value } } : p)))
    await api.setPageProperties(rowId, { [propId]: value })
  }

  // optimista, mismo motivo que updateRowProperty — esto es lo que dispara
  // renombrar/borrar una columna del Tablero o una opción de un select,
  // no hace falta releer el workspace entero por eso.
  const updateDatabaseSchema = async (dbId, schema) => {
    setPages((prev) => prev.map((p) => (p.id === dbId ? { ...p, databaseSchema: schema } : p)))
    await api.setDatabaseSchema(dbId, schema)
  }

  const renamePage = useCallback((id, title) => {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, title } : p)))
    api.renamePage(id, title)
  }, [])

  const setPageIcon = useCallback((id, icon) => {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, icon } : p)))
    api.setPageIcon(id, icon)
  }, [])

  const movePage = async (id, newParentId, newIndex) => {
    try {
      await api.movePage(id, newParentId, newIndex)
    } catch (err) {
      console.error('Movimiento rechazado:', err)
    }
    await syncFromBackend()
  }

  // duplica una página (o una fila de base de datos, que también es una
  // página) junto con su subárbol activo; enfoca la copia en la pestaña actual
  const duplicatePage = async (id) => {
    try {
      const copy = await api.duplicatePage(id)
      if (!copy) return
      patchActiveTab({ kind: 'page' })
      await syncFromBackend(copy.id)
    } catch (err) {
      console.error('no se pudo duplicar la página:', err)
    }
  }

  const trashPage = async (id) => {
    await api.trashPage(id)
    await syncFromBackend()
  }

  // borrado múltiple desde la vista "Todas" de una base de datos: cada fila
  // es una página, así que reusa trashPage por id, pero sincroniza una sola
  // vez al final en vez de una vez por fila.
  const trashRows = async (ids) => {
    await Promise.all(ids.map((id) => api.trashPage(id)))
    await syncFromBackend()
  }

  const restorePage = async (id) => {
    await api.restorePage(id)
    patchActiveTab({ kind: 'page', pageId: id })
    await syncFromBackend(id)
  }

  const deleteForever = async (id) => {
    await api.deleteForever(id)
    await syncFromBackend()
  }

  const emptyTrash = async () => {
    await api.emptyTrash()
    await syncFromBackend()
  }

  const selectTab = (tabId) => setActiveTabId(tabId)

  // antes abría en "la primera página de la lista" — si esa primera página
  // resultaba ser una fila de una base de datos, el efecto de la sidebar
  // que expande la cadena de ancestros del tab activo terminaba
  // desplegando esa base de datos enterita sin que el usuario lo pidiera.
  // Inicio (ver HomeView.jsx) ya cumple el rol de "punto de partida neutral"
  // para una pestaña nueva, así que no hace falta elegir ninguna página.
  const openNewTab = () => {
    if (!pages) return
    const newTab = makeTab({ kind: 'home', pageId: null })
    setTabs((prev) => [...(prev ?? []), newTab])
    setActiveTabId(newTab.id)
  }

  const closeTab = (tabId) => {
    if (!tabs) return
    if (tabs.length <= 1) {
      // antes cerrar la única pestaña no hacía nada (no se podía quedar sin
      // ninguna abierta) — ahora en vez de bloquearlo, esa pestaña pasa a
      // Inicio, mismo "punto de partida neutral" que ya usa openNewTab.
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, kind: 'home', pageId: null } : t)))
      return
    }
    const idx = tabs.findIndex((t) => t.id === tabId)
    const next = tabs.filter((t) => t.id !== tabId)
    setTabs(next)
    if (activeTabId === tabId) {
      setActiveTabId((next[Math.max(0, idx - 1)] ?? next[0]).id)
    }
  }

  const reorderTabs = (fromId, targetId, side) => {
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === fromId)
      if (fromIdx === -1 || fromId === targetId) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      let targetIdx = next.findIndex((t) => t.id === targetId)
      if (targetIdx === -1) targetIdx = next.length
      if (side === 'after') targetIdx += 1
      next.splice(targetIdx, 0, moved)
      return next
    })
  }

  // atajos de pestañas al estilo Chrome: Ctrl+T nueva, Ctrl+W cerrar la
  // activa, Ctrl+Tab/Ctrl+Shift+Tab siguiente/anterior (cíclico), Ctrl+1..8
  // salta a esa posición, Ctrl+9 a la última.
  useEffect(() => {
    const handler = (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      const key = event.key.toLowerCase()
      if (key === 't') {
        event.preventDefault()
        openNewTab()
      } else if (key === 'w') {
        event.preventDefault()
        closeTab(activeTabId)
      } else if (event.key === 'Tab') {
        event.preventDefault()
        if (tabs.length < 2) return
        const idx = tabs.findIndex((t) => t.id === activeTabId)
        const delta = event.shiftKey ? -1 : 1
        const next = tabs[(idx + delta + tabs.length) % tabs.length]
        if (next) setActiveTabId(next.id)
      } else if (/^[1-9]$/.test(event.key)) {
        event.preventDefault()
        const idx = event.key === '9' ? tabs.length - 1 : Number(event.key) - 1
        const target = tabs[idx]
        if (target) setActiveTabId(target.id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [tabs, activeTabId, openNewTab, closeTab])

  const tabLabel = (tab) => {
    if (tab.kind === 'home') return 'Inicio'
    if (tab.kind === 'calendar') return 'Calendario'
    if (tab.kind === 'recordings') return 'Grabaciones'
    if (tab.kind === 'chat') return 'Chat'
    const page = pages?.find((p) => p.id === tab.pageId)
    return page ? page.title || 'Sin título' : 'Página'
  }

  const tabIcon = (tab) => {
    if (tab.kind !== 'page') return null
    return pages?.find((p) => p.id === tab.pageId)?.icon ?? null
  }

  if (!pages || !tabs) {
    // a diferencia de las otras pantallas "Cargando…" del proyecto (LoginGate.jsx),
    // a esta le faltaba directamente el dark: — quedaba blanca fija mientras
    // se cargan pages/tabs desde Supabase (reportado en Android: "siempre
    // blanca", no un flash breve, porque esta espera de red puede tardar).
    return (
      <div className="flex h-screen items-center justify-center bg-white text-sm text-gray-400 dark:bg-[#202020] dark:text-neutral-500">
        Cargando…
      </div>
    )
  }

  const activePages = pages.filter((p) => !p.trashedAt)
  const trashedRoots = pages.filter(
    (p) =>
      p.trashedAt &&
      (p.parentId == null || !pages.find((q) => q.id === p.parentId)?.trashedAt)
  )
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  const currentId = activeTab.kind === 'page' ? activeTab.pageId : null
  const current = activePages.find((p) => p.id === currentId)
  const currentRows = current?.isDatabase
    ? activePages.filter((p) => p.parentId === current.id).sort((a, b) => a.order - b.order)
    : []
  const path = ancestorPath(pages, current)

  const peekPage = peekPageId ? activePages.find((p) => p.id === peekPageId) : null
  const peekRows = peekPage?.isDatabase
    ? activePages.filter((p) => p.parentId === peekPage.id).sort((a, b) => a.order - b.order)
    : []
  const peekPath = peekPage ? ancestorPath(pages, peekPage) : []

  // elegir algo del sidebar (Inicio/Calendario/Grabaciones/Chat, una página,
  // crear página/base de datos) lo cierra, en mobile Y en desktop por igual
  // — antes esto era solo mobile (el cajón que tapa la pantalla), pero
  // pedido explícito del usuario para que el panel de desktop también se
  // corra de en medio al navegar. No es un useEffect a propósito — un
  // efecto que "cierra cuando cambia la navegación" tendría que vivir antes
  // del return temprano de arriba (!pages || !tabs) para no romper el orden
  // de hooks, y ahí todavía no existen currentId/activeTab. Envolver las
  // acciones acá es más simple y no necesita ningún hook nuevo.
  const withSidebarClose = (fn) => (...args) => {
    fn(...args)
    setSidebarOpen(false)
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white text-gray-900 dark:bg-[#202020] dark:text-neutral-100">
      <TabBar
        tabs={tabs}
        activeTabId={activeTab.id}
        labelFor={tabLabel}
        iconFor={tabIcon}
        onReorder={reorderTabs}
        onSelect={selectTab}
        onClose={closeTab}
        onNewTab={openNewTab}
        isMobile={isMobile}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* antes el backdrop oscuro solo aparecía en mobile — en desktop el
        sidebar era un panel DOCKED (relative shrink-0, empujaba <main> en
        vez de superponerse). Ahora se superpone en las dos plataformas, así
        que el backdrop también corre en las dos; `confined` en desktop lo
        recorta al área de contenido (no tapa la barra de pestañas). */}
        {sidebarMounted && (isMobile || !sidebarPinned) && <SidebarBackdrop onClick={() => setSidebarOpen(false)} confined={!isMobile} open={sidebarOpen} />}
        {sidebarMounted && (
          <Sidebar
            mobile={isMobile}
            open={sidebarOpen}
            pages={activePages}
            trashedRoots={trashedRoots}
            currentId={currentId}
            onSelect={withSidebarClose(selectPage)}
            onCreate={withSidebarClose(createPage)}
            onCreateDatabase={withSidebarClose(createDatabase)}
            onRename={renamePage}
            onDuplicate={duplicatePage}
            onTrash={trashPage}
            onRestore={restorePage}
            onDeleteForever={deleteForever}
            onEmptyTrash={emptyTrash}
            onMove={movePage}
            onCollapse={() => setSidebarOpen(false)}
            onSearch={withSidebarClose(() => setSwitcherOpen(true))}
            // sin withSidebarClose a propósito: recargar no navega a ningún
            // lado, cerrar el panel encima sería un efecto sorpresa
            onReload={reloadEverything}
            onOpenHome={withSidebarClose(() => patchActiveTab({ kind: 'home' }))}
            homeActive={activeTab.kind === 'home'}
            onOpenCalendar={withSidebarClose(() => patchActiveTab({ kind: 'calendar' }))}
            calendarActive={activeTab.kind === 'calendar'}
            onOpenRecordings={withSidebarClose(() => patchActiveTab({ kind: 'recordings' }))}
            recordingsActive={activeTab.kind === 'recordings'}
            onOpenChat={withSidebarClose(() => patchActiveTab({ kind: 'chat' }))}
            chatActive={activeTab.kind === 'chat'}
            theme={theme}
            onCycleTheme={() => setTheme(THEME_CYCLE[theme])}
          />
        )}
        <main className="relative flex min-w-0 flex-1 flex-col bg-white dark:bg-neutral-800">
          {!sidebarOpen && (
            <button
              type="button"
              aria-label="Mostrar sidebar"
              title="Mostrar sidebar"
              onClick={() => setSidebarOpen(true)}
              // el área táctil (p-2 + ícono de 24px = 40px) y el color
              // arrancan pensados para el dedo y para que se VEA: gris 600
              // sobre el fondo de la página, no el gris 400 casi invisible de
              // antes. En desktop se afina un poco (md:).
              className="absolute left-2 top-0 z-10 cursor-pointer rounded-lg p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 md:left-3 md:top-1.5 md:p-1.5 dark:text-neutral-300 dark:hover:bg-neutral-700 dark:hover:text-white"
            >
              <MenuIcon />
            </button>
          )}
          <ErrorBoundary resetKey={activeTab.id}>
            <Suspense fallback={<SuspenseFallback />}>
            {activeTab.kind === 'home' ? (
              <HomeView
                key={activeTab.id}
                insetLeft={!sidebarOpen}
                pages={activePages}
                lastOpenedId={lastOpenedId}
                onOpenPage={selectPage}
                onCreate={createPage}
                onCreateDatabase={createDatabase}
                onSearch={() => setSwitcherOpen(true)}
                onOpenRecordings={() => patchActiveTab({ kind: 'recordings' })}
              />
            ) : activeTab.kind === 'calendar' ? (
              <CalendarView
                key={activeTab.id}
                insetLeft={!sidebarOpen}
                onOpenPage={selectPage}
                onCreateMeetingNotes={(title) => createPage(null, title)}
              />
            ) : activeTab.kind === 'recordings' ? (
              <RecordingsView key={activeTab.id} insetLeft={!sidebarOpen} onOpenPage={selectPage} />
            ) : activeTab.kind === 'chat' ? (
              <ChatView key={activeTab.id} insetLeft={!sidebarOpen} sidebarOpen={sidebarOpen} />
            ) : current ? (
              <PageView
                key={`${activeTab.id}:${current.id}`}
                page={current}
                path={path}
                insetLeft={!sidebarOpen}
                onRename={renamePage}
                onSetIcon={setPageIcon}
                onNavigate={selectPage}
                onOpenRow={openPeek}
                rows={currentRows}
                onCreateRow={(properties) => createRow(current.id, properties)}
                onDuplicateRow={duplicateRow}
                onMoveRow={(rowId, newIndex) => movePage(rowId, current.id, newIndex)}
                onTrashRows={trashRows}
                onUpdateProperty={updateRowProperty}
                onUpdateSchema={(schema) => updateDatabaseSchema(current.id, schema)}
                onUpdateDatabaseSchema={updateDatabaseSchema}
                // las filas de una base compartida viven en este estado, no
                // adentro de PageView — cuando otra persona las toca, PageView
                // avisa por acá para volver a traer el índice
                onSyncRows={syncFromBackend}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                <p className="text-sm text-gray-500 dark:text-neutral-400">Esta página ya no existe.</p>
                <p className="text-xs text-gray-400 dark:text-neutral-500">
                  Puede haber sido eliminada, o el enlace que la abrió quedó desactualizado.
                </p>
              </div>
            )}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      {peekPage && (
        <Suspense fallback={null}>
          <PagePeek
            key={peekPage.id}
            page={peekPage}
            path={peekPath}
            onClose={closePeek}
            onOpenFullPage={() => {
              closePeek()
              selectPage(peekPage.id)
            }}
            onRename={renamePage}
            onSetIcon={setPageIcon}
            onNavigate={openPeek}
            onOpenRow={openPeek}
            rows={peekRows}
            onCreateRow={(properties) => createRow(peekPage.id, properties)}
            onDuplicateRow={duplicateRow}
            onMoveRow={(rowId, newIndex) => movePage(rowId, peekPage.id, newIndex)}
            onTrashRows={trashRows}
            onUpdateProperty={updateRowProperty}
            onUpdateSchema={(schema) => updateDatabaseSchema(peekPage.id, schema)}
            onUpdateDatabaseSchema={updateDatabaseSchema}
          />
        </Suspense>
      )}
      <QuickSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} onSelect={selectPage} />
    </div>
  )
}
