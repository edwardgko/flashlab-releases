import { App as CapacitorApp } from '@capacitor/app'
import { extractPageText, renameLinksInBlocks } from './textExtract.js'
import { createSupabasePagesAPI } from './supabasePages.js'
import { supabase, IS_CAPACITOR } from './supabaseClient.js'
import { getDriveMediaProxyUrl } from './webDrive.js'

// En Electron, window.notionAPI viene del preload. En un navegador normal
// (vite dev suelto) usamos un backend en memoria con la misma interfaz para
// poder desarrollar y probar la UI sin persistencia.
function createMemoryAPI() {
  const store = new Map()
  const index = { pages: [], lastOpenedId: null }
  const find = (id) => index.pages.find((p) => p.id === id)

  const childrenOf = (parentId) =>
    index.pages
      .filter((p) => (p.parentId ?? null) === (parentId ?? null) && !p.trashedAt)
      .sort((a, b) => a.order - b.order)

  const reindex = (parentId) =>
    childrenOf(parentId).forEach((p, i) => {
      p.order = i
    })

  const subtreeIds = (rootId) => {
    const ids = [rootId]
    for (let i = 0; i < ids.length; i++) {
      for (const p of index.pages) if (p.parentId === ids[i]) ids.push(p.id)
    }
    return ids
  }

  const isDescendant = (ancestorId, pageId) => {
    let current = find(pageId)
    while (current && current.parentId != null) {
      if (current.parentId === ancestorId) return true
      current = find(current.parentId)
    }
    return false
  }

  const sharesByPage = new Map()

  const calendarState = { connected: false, events: [], eventPages: {} }
  const driveState = { connected: false }
  const recordingsByPage = new Map()
  const recordingChunks = new Map()

  const themeListeners = new Set()
  const getTheme = async () => {
    const source = localStorage.getItem('nc-theme') ?? 'system'
    const shouldUseDarkColors =
      source === 'dark' || (source === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    return { source, shouldUseDarkColors }
  }

  // sesión simulada: en modo navegador (vite dev suelto) no hay OAuth real,
  // igual que calendarState.connected arriba se comporta como "ya conectado"
  const fakeSession = {
    access_token: 'dev-fake-token',
    refresh_token: 'dev-fake-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'dev-user', email: 'dev@localhost' },
  }

  return {
    getAppVersion: async () => 'dev',
    getAuthSession: async () => fakeSession,
    login: async () => fakeSession,
    cancelGoogleAuth: async () => {},
    logout: async () => {},
    persistAuthSession: async () => {},
    loadPage: async (id) => store.get(id) ?? null,
    savePage: async (id, data) => {
      store.set(id, data)
      const page = find(id)
      if (page) page.updatedAt = Date.now()
    },
    listPages: async () => ({
      pages: index.pages.map((p) => ({ ...p })),
      lastOpenedId: index.lastOpenedId,
    }),
    createPage: async (title = '', parentId = null, properties = null) => {
      const now = Date.now()
      const page = {
        id: crypto.randomUUID(),
        title: String(title),
        parentId: parentId ?? null,
        order: childrenOf(parentId).length,
        ownerId: fakeSession.user.id,
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
        isDatabase: false,
        icon: '📄',
      }
      if (properties && typeof properties === 'object') page.properties = { ...properties }
      index.pages.push(page)
      index.lastOpenedId = page.id
      return { ...page }
    },
    createDatabase: async (title = '', parentId = null) => {
      const now = Date.now()
      const page = {
        id: crypto.randomUUID(),
        title: String(title),
        parentId: parentId ?? null,
        order: childrenOf(parentId).length,
        ownerId: fakeSession.user.id,
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
        isDatabase: true,
        databaseSchema: [
          { id: 'title', name: 'Título', type: 'title', hidden: false },
          {
            id: crypto.randomUUID(),
            name: 'Estado',
            type: 'select',
            options: [
              { id: crypto.randomUUID(), name: 'Pendientes', color: '#9ca3af' },
              { id: crypto.randomUUID(), name: 'En progreso', color: '#38bdf8' },
              { id: crypto.randomUUID(), name: 'Realizadas', color: '#fb923c' },
              { id: crypto.randomUUID(), name: 'Finalizadas', color: '#34d399' },
            ],
          },
        ],
      }
      index.pages.push(page)
      index.lastOpenedId = page.id
      return { ...page }
    },
    setDatabaseSchema: async (id, schema) => {
      const page = find(id)
      if (!page || !page.isDatabase) return
      page.databaseSchema = schema
      page.updatedAt = Date.now()
    },
    setPageProperties: async (id, properties) => {
      const page = find(id)
      if (!page) return
      page.properties = { ...(page.properties ?? {}), ...properties }
      page.updatedAt = Date.now()
    },
    renamePage: async (id, title) => {
      const page = find(id)
      if (!page) return
      page.title = String(title)
      page.updatedAt = Date.now()
      // reflejar el nuevo título en el texto visible de los enlaces entrantes
      for (const [sourceId, data] of store) {
        if (!data?.blocks) continue
        const { blocks, changed } = renameLinksInBlocks(data.blocks, id, page.title)
        if (changed) store.set(sourceId, { ...data, blocks })
      }
    },
    setPageIcon: async (id, icon) => {
      const page = find(id)
      if (!page) return
      page.icon = icon || null
      page.updatedAt = Date.now()
    },
    // mismo comportamiento que pages:duplicate en electron/main.js: copia el
    // subárbol activo entero (subpáginas, o filas si es una base de datos)
    // como hermano justo después del original.
    duplicatePage: async (id) => {
      const root = find(id)
      if (!root || root.trashedAt) return null
      const originals = subtreeIds(id)
        .map((pid) => find(pid))
        .filter((p) => p && !p.trashedAt)
      const idMap = new Map(originals.map((p) => [p.id, crypto.randomUUID()]))
      const now = Date.now()
      const newPages = originals.map((orig) => {
        const isRoot = orig.id === id
        const copy = {
          ...orig,
          id: idMap.get(orig.id),
          parentId: isRoot ? (root.parentId ?? null) : idMap.get(orig.parentId),
          title: isRoot ? `${orig.title || 'Sin título'} (copia)` : orig.title,
          createdAt: now,
          updatedAt: now,
          trashedAt: null,
        }
        if (orig.properties) copy.properties = { ...orig.properties }
        if (orig.databaseSchema) {
          copy.databaseSchema = orig.databaseSchema.map((prop) => ({
            ...prop,
            ...(prop.options ? { options: prop.options.map((o) => ({ ...o })) } : {}),
          }))
        }
        return copy
      })
      index.pages.push(...newPages)

      const rootCopy = newPages[0]
      const parentSiblings = childrenOf(root.parentId ?? null).filter((p) => p.id !== rootCopy.id)
      const rootIdx = parentSiblings.findIndex((p) => p.id === id)
      parentSiblings.splice(rootIdx + 1, 0, rootCopy)
      parentSiblings.forEach((p, i) => {
        p.order = i
      })

      const touchedParents = new Set(newPages.slice(1).map((p) => p.parentId))
      for (const parentId of touchedParents) reindex(parentId)

      newPages.forEach((copy, i) => {
        const data = store.get(originals[i].id)
        if (data) store.set(copy.id, data)
      })

      return { ...rootCopy }
    },
    movePage: async (id, newParentId = null, newIndex = null) => {
      const page = find(id)
      if (!page) return
      if (newParentId === id || (newParentId && isDescendant(id, newParentId))) return
      const oldParent = page.parentId ?? null
      page.parentId = newParentId ?? null
      const siblings = childrenOf(newParentId).filter((p) => p.id !== id)
      const clamped = Math.max(0, Math.min(newIndex ?? siblings.length, siblings.length))
      siblings.splice(clamped, 0, page)
      siblings.forEach((p, i) => {
        p.order = i
      })
      if (oldParent !== (newParentId ?? null)) reindex(oldParent)
      page.updatedAt = Date.now()
    },
    trashPage: async (id) => {
      const page = find(id)
      if (!page) return
      const now = Date.now()
      const ids = new Set(subtreeIds(id))
      for (const p of index.pages) if (ids.has(p.id)) p.trashedAt = now
      reindex(page.parentId ?? null)
      if (ids.has(index.lastOpenedId)) index.lastOpenedId = childrenOf(null)[0]?.id ?? null
    },
    restorePage: async (id) => {
      const page = find(id)
      if (!page) return
      const ids = new Set(subtreeIds(id))
      for (const p of index.pages) if (ids.has(p.id)) p.trashedAt = null
      const parent = page.parentId ? find(page.parentId) : null
      if (page.parentId && (!parent || parent.trashedAt)) page.parentId = null
      page.order = Number.MAX_SAFE_INTEGER
      reindex(page.parentId ?? null)
    },
    deleteForever: async (id) => {
      const ids = new Set(subtreeIds(id))
      index.pages = index.pages.filter((p) => !ids.has(p.id))
      ids.forEach((pid) => store.delete(pid))
      if (ids.has(index.lastOpenedId)) index.lastOpenedId = childrenOf(null)[0]?.id ?? null
    },
    emptyTrash: async () => {
      const removed = index.pages.filter((p) => p.trashedAt).map((p) => p.id)
      index.pages = index.pages.filter((p) => !p.trashedAt)
      removed.forEach((pid) => store.delete(pid))
      if (removed.includes(index.lastOpenedId)) index.lastOpenedId = childrenOf(null)[0]?.id ?? null
    },
    setLastOpened: async (id) => {
      index.lastOpenedId = id
    },
    // Sin disco en el navegador: objectURL efímero (vale para desarrollo, no sobrevive un F5)
    saveImage: async (bytes, filename, mime) => {
      const blob = new Blob([bytes], { type: mime || 'application/octet-stream' })
      return { success: 1, file: { url: URL.createObjectURL(blob) } }
    },
    saveImageFromUrl: async (sourceUrl) => ({ success: 1, file: { url: sourceUrl } }),
    // Sin MiniSearch aquí: escaneo lineal, de sobra para los datasets de desarrollo.
    search: async (query) => {
      const q = String(query ?? '').trim().toLowerCase()
      if (!q) return []
      return index.pages
        .filter((p) => !p.trashedAt)
        .map((p) => {
          const { text } = extractPageText(store.get(p.id)?.blocks ?? [])
          const titleHit = p.title.toLowerCase().includes(q)
          const textIdx = text.toLowerCase().indexOf(q)
          if (!titleHit && textIdx === -1) return null
          return { id: p.id, title: p.title, snippet: text.slice(0, 140), score: titleHit ? 1 : 0 }
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
    },
    backlinks: async (id) => {
      const results = []
      for (const p of index.pages) {
        if (p.trashedAt || p.id === id) continue
        const { linkedPageIds } = extractPageText(store.get(p.id)?.blocks ?? [])
        if (linkedPageIds.includes(id)) results.push({ id: p.id, title: p.title })
      }
      return results
    },
    // Compartir (Fase C) simulado en memoria — no hay otros usuarios reales
    // en modo navegador, solo alcanza para poder probar la UI del diálogo.
    listShares: async (id) => sharesByPage.get(id)?.map((s) => ({ ...s })) ?? [],
    sharePage: async (id, email, role) => {
      const invitedEmail = String(email ?? '').trim().toLowerCase()
      const list = sharesByPage.get(id) ?? []
      const existing = list.find((s) => s.email === invitedEmail)
      if (existing) existing.role = role
      else list.push({ id: crypto.randomUUID(), email: invitedEmail, role, claimed: false, createdAt: Date.now() })
      sharesByPage.set(id, list)
    },
    updateShareRole: async (shareId, role) => {
      for (const list of sharesByPage.values()) {
        const share = list.find((s) => s.id === shareId)
        if (share) share.role = role
      }
    },
    removeShare: async (shareId) => {
      for (const [pageId, list] of sharesByPage) {
        sharesByPage.set(pageId, list.filter((s) => s.id !== shareId))
      }
    },
    // Sin nativeTheme aquí: seguimos matchMedia y avisamos a los suscriptores.
    getTheme,
    setTheme: async (source) => {
      localStorage.setItem('nc-theme', source)
      themeListeners.forEach((cb) => cb())
    },
    onThemeUpdated: (callback) => {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      const wrapped = async () => callback(await getTheme())
      themeListeners.add(wrapped)
      media.addEventListener('change', wrapped)
      return () => {
        themeListeners.delete(wrapped)
        media.removeEventListener('change', wrapped)
      }
    },
    // Sin menú nativo en el navegador: estos eventos nunca disparan.
    onMenuNewPage: () => () => {},
    onMenuSave: () => () => {},
    onMenuExportMarkdown: () => () => {},
    onMenuExportHtml: () => () => {},
    onMenuImportMarkdown: () => () => {},
    // Sin diálogo nativo: descarga vía <a download> (equivalente razonable en dev)
    exportFile: async (content, suggestedName) => {
      const blob = new Blob([content], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      a.click()
      URL.revokeObjectURL(url)
      return { saved: true }
    },
    // Sin diálogo nativo tampoco acá: mismo truco de <a download>, best-effort
    // (el navegador puede ignorar `download` en URLs cross-origin sin
    // Content-Disposition; en Electron esto pasa por IPC y sí fuerza un
    // diálogo real de "Guardar como", ver electron/main.js).
    downloadFileFromUrl: async (url, suggestedName) => {
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName || 'archivo'
      a.target = '_blank'
      a.rel = 'noreferrer'
      a.click()
      return { saved: true }
    },
    importMarkdownFile: () =>
      new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.md,.markdown,.txt'
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          if (!file) return resolve(null)
          const reader = new FileReader()
          reader.onload = () => resolve({ content: String(reader.result), name: file.name.replace(/\.[^.]+$/, '') })
          reader.readAsText(file)
        })
        input.click()
      }),
    onBeforeClose: () => () => {},
    confirmClose: () => {},
    // Sin OAuth real en el navegador: simulamos conexión + eventos en memoria
    // para poder probar la UI del calendario sin credenciales de Google.
    getCalendarAuthStatus: async () => ({ connected: calendarState.connected }),
    ensureCalendarConnected: async () => ({ connected: calendarState.connected }),
    connectCalendarUnified: async () => {
      calendarState.connected = true
      return { connected: true }
    },
    listCalendarEvents: async (timeMinIso, timeMaxIso) => {
      const min = new Date(timeMinIso).getTime()
      const max = new Date(timeMaxIso).getTime()
      return calendarState.events.filter((ev) => {
        const t = new Date(ev.start).getTime()
        return t >= min && t < max
      })
    },
    createCalendarEvent: async (eventData) => {
      const id = crypto.randomUUID()
      calendarState.events.push({ id, ...eventData })
      return { id }
    },
    updateCalendarEvent: async (id, eventData) => {
      const idx = calendarState.events.findIndex((e) => e.id === id)
      if (idx !== -1) calendarState.events[idx] = { id, ...eventData }
    },
    deleteCalendarEvent: async (id) => {
      calendarState.events = calendarState.events.filter((e) => e.id !== id)
    },
    getEventPage: async (eventId) => calendarState.eventPages[eventId] ?? null,
    linkEventPage: async (eventId, pageId) => {
      calendarState.eventPages[eventId] = pageId
    },
    // Sin OAuth real acá tampoco — mismo patrón que Calendar arriba, alcanza
    // para probar el checkbox "Guardar también en Drive" sin Electron.
    getDriveAuthStatus: async () => ({ connected: driveState.connected }),
    connectDriveUnified: async () => {
      driveState.connected = true
      return { connected: true }
    },
    disconnectDrive: async () => {
      driveState.connected = false
    },
    uploadRecordingToDrive: async (pageId, recordingId) => {
      const list = recordingsByPage.get(pageId) ?? []
      const idx = list.findIndex((r) => r.id === recordingId)
      if (idx === -1) return
      list[idx] = { ...list[idx], driveStatus: 'done', driveUrl: 'https://drive.google.com/', driveError: null }
    },
    cancelDriveUpload: async (pageId, recordingId) => {
      const list = recordingsByPage.get(pageId) ?? []
      const idx = list.findIndex((r) => r.id === recordingId)
      if (idx === -1) return
      list[idx] = { ...list[idx], driveStatus: null, driveError: null, driveProgress: null }
    },
    shareRecordingOnDrive: async (pageId, recordingId, shareEmails) => ({
      shared: (shareEmails ?? []).length,
      failed: [],
    }),
    // sin Supabase en el navegador no hay grabaciones publicadas que ver
    publishRecording: async () => {},
    unpublishRecording: async () => {},
    listPageRecordings: async () => [],
    listSharedRecordings: async () => [],
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    // Sin disco en el navegador: los chunks se juntan en memoria por nombre y
    // recién se arma el Blob final al terminar (alcanza para probar la UI).
    beginRecording: async () => `${crypto.randomUUID()}.webm`,
    appendRecordingChunk: async (filename, bytes) => {
      const list = recordingChunks.get(filename) ?? []
      list.push(bytes)
      recordingChunks.set(filename, list)
    },
    finishRecording: async (filename) => {
      const chunks = recordingChunks.get(filename) ?? []
      recordingChunks.delete(filename)
      const blob = new Blob(chunks, { type: 'video/webm' })
      return URL.createObjectURL(blob)
    },
    listRecordings: async (pageId) => recordingsByPage.get(pageId) ?? [],
    addRecording: async (pageId, recording) => {
      const entry = { id: crypto.randomUUID(), createdAt: Date.now(), ...recording }
      const list = recordingsByPage.get(pageId) ?? []
      list.push(entry)
      recordingsByPage.set(pageId, list)
      return entry
    },
    listAllRecordings: async () => {
      const result = []
      for (const [pageId, list] of recordingsByPage) {
        const page = find(pageId)
        for (const rec of list) result.push({ ...rec, pageId, pageTitle: page?.title || 'Sin título' })
      }
      result.sort((a, b) => b.createdAt - a.createdAt)
      return result
    },
    deleteRecording: async (pageId, recordingId) => {
      const list = recordingsByPage.get(pageId) ?? []
      recordingsByPage.set(pageId, list.filter((r) => r.id !== recordingId))
    },
    // editar grabaciones necesita ffmpeg en el proceso main — sin Electron no
    // hay nada real para hacer acá, el botón "Editar" ya queda oculto por isDesktop
    pickAudioFile: async () => null,
    importAudioAsset: async (sourcePath) => ({
      path: sourcePath,
      url: sourcePath,
      name: sourcePath.split(/[/\\]/).pop(),
      duration: 0,
    }),
    // 0 = "no sé" — el caller cae al método del <video> (ver resolveDuration)
    probeAssetDuration: async () => 0,
    trimRecording: async (pageId, recordingId) => (recordingsByPage.get(pageId) ?? []).find((r) => r.id === recordingId) ?? null,
    replaceRecordingAudio: async (pageId, recordingId) =>
      (recordingsByPage.get(pageId) ?? []).find((r) => r.id === recordingId) ?? null,
    removeRecordingAudio: async (pageId, recordingId) =>
      (recordingsByPage.get(pageId) ?? []).find((r) => r.id === recordingId) ?? null,
    applyRecordingEdits: async (pageId, recordingId) =>
      (recordingsByPage.get(pageId) ?? []).find((r) => r.id === recordingId) ?? null,
    onRecordingEditProgress: () => () => {},
    onRecordingsUpdated: () => () => {},
  }
}

export const isDesktop = Boolean(window.notionAPI)

// Autenticación fuera de Electron (navegador y Android): no hay proceso main
// que guarde la sesión cifrada, así que la persistencia queda en manos de
// supabase-js (ver persistSession en supabaseClient.js) y el login es un
// redirect, no una llamada que devuelve la sesión — por eso `login` no vive
// acá sino en LoginGate, que llama a signInWithOAuth directamente.
function createWebAuthAPI() {
  return {
    // En Android, "web" no dice nada útil (ni sirve para comparar contra la
    // última versión publicada) — la real es el versionName nativo, que el
    // build de Gradle saca de package.json (ver android/app/build.gradle).
    getAppVersion: IS_CAPACITOR
      ? async () => (await CapacitorApp.getInfo()).version
      : async () => 'web',
    getAuthSession: async () => (await supabase.auth.getSession()).data.session ?? null,
    // supabase-js ya persiste solo en web; este método existe para que
    // watchAuthSession() pueda llamarlo sin ramificar por plataforma.
    persistAuthSession: async () => {},
    logout: async () => {
      await supabase.auth.signOut()
    },
    cancelGoogleAuth: async () => {},
  }
}

// El CRUD de páginas vive en Supabase desde la Fase B (src/lib/supabasePages.js).
//
// En Electron, el resto (calendario, grabaciones, tema, menú nativo,
// export/import de archivos) sigue siendo local vía IPC.
//
// Fuera de Electron —`vite dev` suelto, y la build web que envuelve
// Capacitor para Android— se arma en tres capas, y el orden importa porque
// cada una pisa a la anterior:
//   1. createMemoryAPI(): cubre TODOS los métodos del puente para que nada
//      explote por estar indefinido. Lo que no tiene sentido fuera de
//      Electron (grabar pantalla, ffmpeg, diálogos nativos) queda como no-op.
//   2. createWebAuthAPI(): sesión real de Supabase en vez de la simulada.
//   3. createSupabasePagesAPI(): páginas, bases y compartir reales.
//   4. createWebRecordingsAPI(): las grabaciones YA subidas a Drive, que
//      viven en Supabase (page_recordings) y por lo tanto sí se pueden
//      listar en la web. Grabar sigue siendo imposible acá (necesita
//      ffmpeg y disco), pero ver lo ya grabado no.
// Lo que queda de createMemoryAPI después de todo eso son justamente los
// no-ops de las funciones que Android no va a tener.
function createWebRecordingsAPI(pagesApi) {
  return {
    // en la web no hay archivos locales: TODO lo que se puede mostrar es lo
    // que está publicado en Drive, propio o compartido. Por eso la lista
    // "local" queda vacía y las de Drive traen también las propias.
    listAllRecordings: async () => [],
    listRecordings: async () => [],
    listSharedRecordings: pagesApi.listAllDriveRecordings,
    listPageRecordings: pagesApi.listPageDriveRecordings,
  }
}

// "Guardar como"/"Abrir con" en Electron abren diálogos NATIVOS de Windows
// (ver attachment:save-as/attachment:open-with en electron/main.js) — no hay
// equivalente 1:1 en Android/web sin un plugin nativo propio (Capacitor
// Filesystem/Share, no instalado). createMemoryAPI() ya cubre "lo que no
// tiene sentido fuera de Electron" con no-ops, pero estas dos quedaron
// afuera (el puente ni las tenía) — de ahí el "is not a function" reportado
// al tocarlas desde el chat en Android.
//
// Lo que SÍ funciona con lo que ya hay: abrir la URL de descarga en el
// navegador del sistema. Android maneja la descarga con su propio flujo
// (notificación "Descarga completa" → tocarla ofrece elegir con qué app
// abrirlo) — es lo más parecido a un "Abrir con" que hay sin ese plugin, así
// que las dos acciones terminan siendo la misma acá: una vez que el archivo
// está en el navegador de sistema, no hay forma de distinguir "guardalo" de
// "abrilo con algo".
async function downloadAttachmentInSystemBrowser({ driveId, url, suggestedName }) {
  if (driveId) {
    const proxyUrl = await getDriveMediaProxyUrl(driveId, { download: true, name: suggestedName })
    if (!proxyUrl) throw new Error('no se pudo generar el link de descarga (¿hay sesión activa?)')
    window.open(proxyUrl, '_blank', 'noopener,noreferrer')
    return { saved: true }
  }
  if (!url) throw new Error('este archivo no tiene una URL de descarga')
  window.open(url, '_blank', 'noopener,noreferrer')
  return { saved: true }
}

function createWebAttachmentAPI() {
  return {
    saveAttachmentAs: downloadAttachmentInSystemBrowser,
    openAttachmentWith: downloadAttachmentInSystemBrowser,
  }
}

const webPagesAPI = isDesktop ? null : createSupabasePagesAPI()

export const api = isDesktop
  ? { ...window.notionAPI, ...createSupabasePagesAPI() }
  : {
      ...createMemoryAPI(),
      ...createWebAuthAPI(),
      ...createWebAttachmentAPI(),
      ...webPagesAPI,
      ...createWebRecordingsAPI(webPagesAPI),
    }
