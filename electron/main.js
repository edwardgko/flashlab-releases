import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ffmpegPathRaw from 'ffmpeg-static'
import electronUpdaterPkg from 'electron-updater'
import MiniSearch from 'minisearch'
import { extractPageText, renameLinksInBlocks } from '../src/lib/textExtract.js'

// import por default a propósito (electron-updater es CJS puro, con
// `autoUpdater` expuesto vía Object.defineProperty en vez de una asignación
// simple — el interop ESM de Node no siempre lo detecta como named export
// estático, así que se desestructura del default, que siempre funciona).
const { autoUpdater } = electronUpdaterPkg

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// Sin esto, Windows no asocia las notificaciones (`new Notification()` del
// renderer, ver src/lib/desktopNotify.js) con FlashLab de forma confiable:
// sin un AppUserModelID coincidiendo con el del acceso directo instalado
// (electron-builder + NSIS lo genera en el .lnk, pero no lo setea en el
// proceso), el Centro de actividades de Windows puede simplemente no
// mostrar el toast — el código del renderer nunca ve un error, la
// notificación "se crea" pero no aparece en pantalla.
if (process.platform === 'win32') app.setAppUserModelId('com.flashlab.app')
// ffmpeg-static no puede ejecutarse desde dentro del .asar empaquetado
// (asarUnpack en package.json lo extrae a app.asar.unpacked/ en build)
const ffmpegPath = app.isPackaged ? ffmpegPathRaw.replace('app.asar', 'app.asar.unpacked') : ffmpegPathRaw

// Sin esto, cada apertura (doble clic al acceso directo, etc.) mientras ya
// hay una instancia corriendo (p. ej. escondida en la bandeja tras cerrar
// con la X — ver win.on('close') más abajo) crea una ventana Electron
// COMPLETAMENTE NUEVA en vez de traer al frente la que ya existe. Esa
// ventana nueva arranca con su propio proceso (varios segundos en negro
// mientras carga) y, si la original sigue viva de fondo, compiten por
// CPU/GPU — todo esto sin que el usuario vea más que "una ventana" en
// pantalla. Si justo se acaba de editar una grabación en la instancia
// vieja (que borra el archivo original al terminar), la instancia nueva
// puede tardar mucho en pintar o directamente no reflejar ese cambio a
// tiempo. app.requestSingleInstanceLock() hace que una segunda apertura no
// cree nada: solo le avisa a la primera instancia (evento 'second-instance'
// más abajo), que reenfoca su propia ventana ya viva.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  })
}

// Debe registrarse antes de app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'appasset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  {
    scheme: 'driveasset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
])

// ---------- Utilidades de disco ----------

const pagesDir = () => path.join(app.getPath('userData'), 'pages')
const indexFile = () => path.join(app.getPath('userData'), 'index.json')
const assetsDir = () => path.join(app.getPath('userData'), 'assets')
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const calendarAuthFile = () => path.join(app.getPath('userData'), 'calendar-auth.enc')
const driveAuthFile = () => path.join(app.getPath('userData'), 'drive-auth.enc')

// ids tipo slug/uuid: evita path traversal aunque todo sea local
function sanitizeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

// escritura atómica: el archivo real nunca queda a medias.
// En Windows, renombrar sobre un archivo existente puede quedarse colgado
// (no lanza EPERM/EBUSY, simplemente no resuelve) si el antivirus tiene el
// destino bloqueado momentáneamente mientras lo escanea; sin un timeout esto
// bloquearía la cola de escritura para siempre. Tras varios intentos, cae a
// una escritura directa (no atómica, pero nunca cuelga) como último recurso.
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`
  const json = JSON.stringify(data)
  await fs.writeFile(tmp, json, 'utf8')
  const attempts = 2
  for (let i = 0; i < attempts; i++) {
    try {
      await withTimeout(fs.rename(tmp, file), 400)
      return
    } catch {
      if (i === attempts - 1) {
        await fs.writeFile(file, json, 'utf8')
        await fs.unlink(tmp).catch(() => {})
        return
      }
      await delay(100)
    }
  }
}

async function readJsonSafe(file) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch {
    // JSON corrupto: apartarlo y seguir, en vez de romper la app
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
    return null
  }
}

// ---------- Índice de páginas ----------
// Cache en memoria + cola de escritura: los handlers IPC se intercalan entre
// awaits y un read-modify-write concurrente sobre index.json perdería cambios.

let indexCache = null
let indexQueue = Promise.resolve()

async function loadIndex() {
  if (indexCache) return indexCache
  const stored = await readJsonSafe(indexFile())
  const index =
    stored && Array.isArray(stored.pages)
      ? { pages: stored.pages, lastOpenedId: stored.lastOpenedId ?? null }
      : { pages: [], lastOpenedId: null }

  // recuperar páginas huérfanas (p. ej. la "default" de la Fase 2, o un índice apartado por corrupto)
  try {
    const files = await fs.readdir(pagesDir())
    const now = Date.now()
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -5)
      if (sanitizeId(id) && !index.pages.some((p) => p.id === id)) {
        index.pages.push({ id, title: 'Página recuperada', createdAt: now, updatedAt: now })
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  // normalizar campos de jerarquía (migración desde Fase 3)
  index.pages.forEach((p, i) => {
    p.parentId = p.parentId ?? null
    p.order = typeof p.order === 'number' ? p.order : i
    p.trashedAt = p.trashedAt ?? null
    p.icon = p.icon ?? null
    // Fase 9: bases de datos — páginas normales no llevan estos campos
    p.isDatabase = p.isDatabase ?? false
    if (p.isDatabase) {
      p.databaseSchema = p.databaseSchema ?? []
      // migración: bases de datos creadas antes de que "Título" fuera una
      // columna más del esquema (movible/reordenable) — se la agregamos al principio
      if (!p.databaseSchema.some((s) => s.type === 'title')) {
        p.databaseSchema = [{ id: TITLE_PROP_ID, name: 'Título', type: 'title', hidden: false }, ...p.databaseSchema]
      }
    }
  })

  indexCache = index
  return index
}

// ---------- Helpers de árbol ----------

function childrenOf(index, parentId) {
  return index.pages
    .filter((p) => (p.parentId ?? null) === (parentId ?? null) && !p.trashedAt)
    .sort((a, b) => a.order - b.order)
}

function reindexSiblings(index, parentId) {
  childrenOf(index, parentId).forEach((p, i) => {
    p.order = i
  })
}

function subtreeIds(index, rootId) {
  const ids = [rootId]
  for (let i = 0; i < ids.length; i++) {
    for (const p of index.pages) {
      if (p.parentId === ids[i]) ids.push(p.id)
    }
  }
  return ids
}

// ¿pageId desciende de ancestorId?
function isDescendant(index, ancestorId, pageId) {
  let current = index.pages.find((p) => p.id === pageId)
  const seen = new Set()
  while (current && current.parentId != null && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.parentId === ancestorId) return true
    current = index.pages.find((p) => p.id === current.parentId)
  }
  return false
}

function firstActiveRootId(index) {
  return childrenOf(index, null)[0]?.id ?? null
}

function withIndex(mutate) {
  const run = indexQueue.then(async () => {
    const index = await loadIndex()
    const result = await mutate(index)
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await writeJsonAtomic(indexFile(), index)
    return result
  })
  indexQueue = run.catch(() => {})
  return run
}

// ---------- Configuración (tema, ventana) ----------

let settingsCache = null

async function loadSettings() {
  if (settingsCache) return settingsCache
  const stored = await readJsonSafe(settingsFile())
  settingsCache = {
    themeSource: ['system', 'light', 'dark'].includes(stored?.themeSource) ? stored.themeSource : 'system',
    windowBounds: stored?.windowBounds ?? null,
    // eventId (de Google Calendar) -> id de la página de notas vinculada
    calendarEventPages:
      stored?.calendarEventPages && typeof stored.calendarEventPages === 'object' ? stored.calendarEventPages : {},
    menuBarVisible: Boolean(stored?.menuBarVisible),
    perMachineWarningShown: Boolean(stored?.perMachineWarningShown),
    // hasta qué versión de la pasada de "solo lectura" en Drive ya se corrigió
    // lo que había subido de antes — ver relockSharedDriveRecordings()
    driveLockPassVersion: Number.isInteger(stored?.driveLockPassVersion) ? stored.driveLockPassVersion : 0,
  }
  return settingsCache
}

async function saveSettings(partial) {
  const current = await loadSettings()
  Object.assign(current, partial)
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(settingsFile(), current)
}

ipcMain.handle('theme:get', () => {
  console.log('[TRACE theme:get] source=', nativeTheme.themeSource, 'shouldUseDarkColors=', nativeTheme.shouldUseDarkColors)
  return {
    source: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
  }
})

// Versión síncrona del mismo dato — la usa preload.cjs para aplicar la clase
// `dark` en <html> ANTES del primer paint (ver ahí). El handle() de arriba
// es async (ipcRenderer.invoke), así que useTheme.js siempre arrancaba con
// shouldUseDarkColors:false hasta que esa promesa resolvía — con el SO en
// oscuro, esa ventana era modo claro en cada arranque (reportado: "el login
// siempre sale en modo claro aunque después se ajusta al tema oscuro").
ipcMain.on('theme:get-sync', (event) => {
  event.returnValue = {
    source: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
  }
})

ipcMain.handle('theme:set', async (_event, source) => {
  console.log('[TRACE theme:set] pedido source=', source)
  if (!['system', 'light', 'dark'].includes(source)) throw new Error(`tema inválido: ${source}`)
  nativeTheme.themeSource = source
  console.log('[TRACE theme:set] aplicado, ahora shouldUseDarkColors=', nativeTheme.shouldUseDarkColors)
  await saveSettings({ themeSource: source })
  console.log('[TRACE theme:set] guardado en settings.json')
})

// ---------- Búsqueda y backlinks ----------
// searchIndex: título+texto plano por página, para el quick switcher.
// linksIndex: targetPageId -> Set<sourcePageId>, para el panel de backlinks.
// Ambos viven solo en memoria del main y se reconstruyen al arrancar; se
// actualizan de forma incremental en cada save/rename/trash/restore/delete.

const searchIndex = new MiniSearch({
  idField: 'id',
  fields: ['title', 'text'],
  storeFields: ['title', 'text'],
  searchOptions: { boost: { title: 3 }, fuzzy: 0.2, prefix: true },
})
const linksIndex = new Map()

function indexPageContent(id, title, blocks) {
  const { text, linkedPageIds } = extractPageText(blocks)
  const doc = { id, title, text }
  if (searchIndex.has(id)) searchIndex.replace(doc)
  else searchIndex.add(doc)

  for (const sources of linksIndex.values()) sources.delete(id)
  for (const targetId of linkedPageIds) {
    if (targetId === id) continue
    if (!linksIndex.has(targetId)) linksIndex.set(targetId, new Set())
    linksIndex.get(targetId).add(id)
  }
}

// papelera: solo se retira de búsqueda; los enlaces salientes se refrescan al restaurar
function discardFromSearch(ids) {
  for (const id of ids) {
    if (searchIndex.has(id)) searchIndex.discard(id)
  }
}

// borrado definitivo: limpieza completa, incluidos los enlaces salientes/entrantes
function dropFromIndexes(ids) {
  discardFromSearch(ids)
  for (const id of ids) {
    linksIndex.delete(id)
    for (const sources of linksIndex.values()) sources.delete(id)
  }
}

// al renombrar una página, actualiza el texto visible de sus enlaces entrantes
// en el contenido guardado de cada página que la menciona
async function renameIncomingLinks(pageId, newTitle) {
  const sources = linksIndex.get(pageId)
  if (!sources || sources.size === 0) return
  // snapshot: indexPageContent() reescribe los enlaces salientes de cada
  // fuente más abajo, y si esa fuente también es enlazada por pageId, eso
  // muta (delete+add) este mismo Set en vivo — iterar la referencia original
  // hace que el iterador de Set vuelva a visitar el elemento re-agregado,
  // un loop infinito.
  const sourceIds = [...sources]
  const index = await loadIndex()
  for (const sourceId of sourceIds) {
    const data = await loadPageData(sourceId)
    if (!data?.blocks) continue
    const { blocks, changed } = renameLinksInBlocks(data.blocks, pageId, newTitle)
    if (!changed) continue
    await savePageData(sourceId, { ...data, blocks })
    const sourcePage = index.pages.find((p) => p.id === sourceId)
    indexPageContent(sourceId, sourcePage?.title ?? '', blocks)
  }
}

async function buildIndexes() {
  const index = await loadIndex()
  for (const page of index.pages) {
    if (page.trashedAt) continue
    const data = await loadPageData(page.id)
    indexPageContent(page.id, page.title, data?.blocks ?? [])
  }
}

ipcMain.handle('search:query', (_event, query) => {
  const q = String(query ?? '').trim()
  if (!q) return []
  return searchIndex.search(q).slice(0, 20).map((r) => ({
    id: r.id,
    title: r.title,
    snippet: r.text ? r.text.slice(0, 140) : '',
  }))
})

ipcMain.handle('pages:backlinks', async (_event, id) => {
  const safeId = requireId(id)
  const index = await loadIndex()
  const sources = linksIndex.get(safeId)
  if (!sources) return []
  return [...sources]
    .map((sourceId) => index.pages.find((p) => p.id === sourceId && !p.trashedAt))
    .filter(Boolean)
    .map((p) => ({ id: p.id, title: p.title }))
})

// ---------- Páginas ----------

async function savePageData(id, data) {
  await fs.mkdir(pagesDir(), { recursive: true })
  await writeJsonAtomic(path.join(pagesDir(), `${id}.json`), data)
}

const loadPageData = (id) => readJsonSafe(path.join(pagesDir(), `${id}.json`))

function requireId(id) {
  const safeId = sanitizeId(id)
  if (!safeId) throw new Error(`id de página inválido: ${id}`)
  return safeId
}

ipcMain.handle('page:save', async (_event, id, data) => {
  const safeId = requireId(id)
  await savePageData(safeId, data)
  const title = await withIndex((index) => {
    const page = index.pages.find((p) => p.id === safeId)
    if (page) page.updatedAt = Date.now()
    return page?.title ?? ''
  })
  indexPageContent(safeId, title, data?.blocks ?? [])
})

ipcMain.handle('page:load', (_event, id) => loadPageData(requireId(id)))

ipcMain.handle('pages:list', () => loadIndex())

ipcMain.handle('pages:create', async (_event, title = '', parentId = null, properties = null) => {
  const page = await withIndex((index) => {
    const safeParent = parentId == null ? null : requireId(parentId)
    if (safeParent && !index.pages.some((p) => p.id === safeParent && !p.trashedAt)) {
      throw new Error(`página padre inexistente: ${safeParent}`)
    }
    const now = Date.now()
    const newPage = {
      id: randomUUID(),
      title: String(title ?? ''),
      parentId: safeParent,
      order: childrenOf(index, safeParent).length,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      isDatabase: false,
    }
    if (properties && typeof properties === 'object') newPage.properties = { ...properties }
    index.pages.push(newPage)
    index.lastOpenedId = newPage.id
    return newPage
  })
  indexPageContent(page.id, page.title, [])
  return page
})

// 'title' es un tipo especial: no es una propiedad real (el valor vive en
// page.title, no en row.properties), pero participa del mismo array de
// esquema para que se pueda reordenar/mover como cualquier otra columna.
const PROPERTY_TYPES = ['title', 'text', 'number', 'select', 'checkbox', 'date']
const TITLE_PROP_ID = 'title'

function sanitizeSchema(schema) {
  if (!Array.isArray(schema)) throw new Error('esquema inválido')
  const sanitized = schema.map((prop) => {
    if (!PROPERTY_TYPES.includes(prop.type)) throw new Error(`tipo de propiedad inválido: ${prop.type}`)
    const base = { id: prop.id || randomUUID(), name: String(prop.name ?? ''), type: prop.type, hidden: Boolean(prop.hidden) }
    if (Number.isFinite(prop.width) && prop.width > 0) base.width = Math.round(prop.width)
    if (prop.type === 'select') {
      base.options = (prop.options ?? []).map((opt) => ({
        id: opt.id || randomUUID(),
        name: String(opt.name ?? ''),
        color: String(opt.color ?? '#94a3b8'),
      }))
    }
    return base
  })
  const titleCount = sanitized.filter((p) => p.type === 'title').length
  if (titleCount !== 1) throw new Error('el esquema debe tener exactamente una columna de título')
  return sanitized
}

// convierte una página común en una base de datos (o actualiza su esquema)
ipcMain.handle('pages:create-database', async (_event, title = '', parentId = null) => {
  const defaultSchema = [
    { id: TITLE_PROP_ID, name: 'Título', type: 'title', hidden: false },
    {
      id: randomUUID(),
      name: 'Estado',
      type: 'select',
      options: [
        { id: randomUUID(), name: 'Pendientes', color: '#9ca3af' },
        { id: randomUUID(), name: 'En progreso', color: '#38bdf8' },
        { id: randomUUID(), name: 'Realizadas', color: '#fb923c' },
        { id: randomUUID(), name: 'Finalizadas', color: '#34d399' },
      ],
    },
  ]
  const page = await withIndex((index) => {
    const safeParent = parentId == null ? null : requireId(parentId)
    if (safeParent && !index.pages.some((p) => p.id === safeParent && !p.trashedAt)) {
      throw new Error(`página padre inexistente: ${safeParent}`)
    }
    const now = Date.now()
    const newPage = {
      id: randomUUID(),
      title: String(title ?? ''),
      parentId: safeParent,
      order: childrenOf(index, safeParent).length,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      isDatabase: true,
      databaseSchema: defaultSchema,
    }
    index.pages.push(newPage)
    index.lastOpenedId = newPage.id
    return newPage
  })
  indexPageContent(page.id, page.title, [])
  return page
})

ipcMain.handle('pages:set-schema', async (_event, id, schema) => {
  const safeId = requireId(id)
  const safeSchema = sanitizeSchema(schema)
  return withIndex((index) => {
    const page = index.pages.find((p) => p.id === safeId)
    if (!page) throw new Error(`página inexistente: ${safeId}`)
    if (!page.isDatabase) throw new Error(`la página no es una base de datos: ${safeId}`)
    page.databaseSchema = safeSchema
    page.updatedAt = Date.now()
  })
})

// mezcla (no reemplaza) las propiedades de una fila — usado por el drag&drop
// del Tablero y la edición en línea de la Tabla
ipcMain.handle('pages:set-properties', async (_event, id, properties) => {
  const safeId = requireId(id)
  if (!properties || typeof properties !== 'object') throw new Error('propiedades inválidas')
  return withIndex((index) => {
    const page = index.pages.find((p) => p.id === safeId)
    if (!page) throw new Error(`página inexistente: ${safeId}`)
    page.properties = { ...(page.properties ?? {}), ...properties }
    page.updatedAt = Date.now()
  })
})

ipcMain.handle('pages:move', (_event, id, newParentId = null, newIndex = null) => {
  const safeId = requireId(id)
  return withIndex((index) => {
    const page = index.pages.find((p) => p.id === safeId)
    if (!page) throw new Error(`página inexistente: ${safeId}`)
    const target = newParentId == null ? null : requireId(newParentId)
    if (target === safeId || (target && isDescendant(index, safeId, target))) {
      throw new Error('movimiento cíclico: no se puede mover una página dentro de sí misma')
    }
    if (target && !index.pages.some((p) => p.id === target && !p.trashedAt)) {
      throw new Error(`página destino inexistente: ${target}`)
    }
    const oldParent = page.parentId ?? null
    page.parentId = target
    const siblings = childrenOf(index, target).filter((p) => p.id !== safeId)
    const clamped = Math.max(0, Math.min(newIndex ?? siblings.length, siblings.length))
    siblings.splice(clamped, 0, page)
    siblings.forEach((p, i) => {
      p.order = i
    })
    if (oldParent !== target) reindexSiblings(index, oldParent)
    page.updatedAt = Date.now()
  })
})

// Duplica una página y todo su subárbol activo (subpáginas, o filas si es
// una base de datos) como hermano del original, justo después. El schema
// de una base de datos se copia tal cual (mismos ids de opción que sus
// filas ya referencian, sin necesidad de remapear). Los <a data-page-id>
// dentro del contenido copiado siguen apuntando a las páginas originales —
// no se remapean entre copias (caso raro: un link interno *dentro* del
// mismo subárbol duplicado); cubre el caso común sin esa complejidad.
ipcMain.handle('pages:duplicate', async (_event, id) => {
  const safeId = requireId(id)
  const { pairs, rootCopy } = await withIndex((index) => {
    const root = index.pages.find((p) => p.id === safeId)
    if (!root || root.trashedAt) throw new Error(`página inexistente: ${safeId}`)
    const originals = subtreeIds(index, safeId)
      .map((pid) => index.pages.find((p) => p.id === pid))
      .filter((p) => p && !p.trashedAt)
    const idMap = new Map(originals.map((p) => [p.id, randomUUID()]))
    const now = Date.now()
    const newPages = originals.map((orig) => {
      const isRoot = orig.id === safeId
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
    const parentSiblings = childrenOf(index, root.parentId ?? null).filter((p) => p.id !== rootCopy.id)
    const rootIdx = parentSiblings.findIndex((p) => p.id === safeId)
    parentSiblings.splice(rootIdx + 1, 0, rootCopy)
    parentSiblings.forEach((p, i) => {
      p.order = i
    })

    const touchedParents = new Set(newPages.slice(1).map((p) => p.parentId))
    for (const parentId of touchedParents) reindexSiblings(index, parentId)

    const pairs = newPages.map((copy, i) => ({ oldId: originals[i].id, newId: copy.id, title: copy.title }))
    return { pairs, rootCopy }
  })

  for (const { oldId, newId, title } of pairs) {
    const data = await loadPageData(oldId)
    if (data) await savePageData(newId, data)
    indexPageContent(newId, title, data?.blocks ?? [])
  }

  return rootCopy
})

ipcMain.handle('pages:trash', async (_event, id) => {
  const safeId = requireId(id)
  const ids = await withIndex((index) => {
    const page = index.pages.find((p) => p.id === safeId)
    if (!page) throw new Error(`página inexistente: ${safeId}`)
    const now = Date.now()
    const trashedIds = new Set(subtreeIds(index, safeId))
    for (const p of index.pages) {
      if (trashedIds.has(p.id)) p.trashedAt = now
    }
    reindexSiblings(index, page.parentId ?? null)
    if (trashedIds.has(index.lastOpenedId)) index.lastOpenedId = firstActiveRootId(index)
    return [...trashedIds]
  })
  discardFromSearch(ids)
})

ipcMain.handle('pages:restore', async (_event, id) => {
  const safeId = requireId(id)
  const ids = await withIndex((index) => {
    const page = index.pages.find((p) => p.id === safeId)
    if (!page) throw new Error(`página inexistente: ${safeId}`)
    const restoredIds = new Set(subtreeIds(index, safeId))
    for (const p of index.pages) {
      if (restoredIds.has(p.id)) p.trashedAt = null
    }
    // si el padre original ya no existe o sigue en la papelera, restaurar a la raíz
    const parent = page.parentId ? index.pages.find((p) => p.id === page.parentId) : null
    if (page.parentId && (!parent || parent.trashedAt)) page.parentId = null
    page.order = Number.MAX_SAFE_INTEGER
    reindexSiblings(index, page.parentId ?? null)
    page.updatedAt = Date.now()
    return [...restoredIds]
  })
  const index = await loadIndex()
  await Promise.all(
    ids.map(async (pid) => {
      const p = index.pages.find((page) => page.id === pid)
      const data = await loadPageData(pid)
      indexPageContent(pid, p?.title ?? '', data?.blocks ?? [])
    })
  )
})

ipcMain.handle('pages:empty-trash', async () => {
  const removedIds = await withIndex((index) => {
    const removed = index.pages.filter((p) => p.trashedAt).map((p) => p.id)
    index.pages = index.pages.filter((p) => !p.trashedAt)
    if (removed.includes(index.lastOpenedId)) index.lastOpenedId = firstActiveRootId(index)
    return removed
  })
  dropFromIndexes(removedIds)
  await Promise.all(
    removedIds.map((id) => fs.rm(path.join(pagesDir(), `${id}.json`), { force: true }))
  )
})

ipcMain.handle('pages:rename', async (_event, id, title) => {
  const safeId = requireId(id)
  const newTitle = String(title ?? '')
  await withIndex((index) => {
    const page = index.pages.find((p) => p.id === safeId)
    if (!page) throw new Error(`página inexistente: ${safeId}`)
    page.title = newTitle
    page.updatedAt = Date.now()
  })
  const data = await loadPageData(safeId)
  indexPageContent(safeId, newTitle, data?.blocks ?? [])
  await renameIncomingLinks(safeId, newTitle)
})

// page.icon es un emoji corto o la URL appasset:// de una imagen subida
// (ver writeAsset) — solo el emoji se trunca, la URL se guarda entera.
const ICON_IMAGE_RE = /^appasset:\/\/local\/[A-Za-z0-9_-]+\.[a-z0-9]{1,5}$/

ipcMain.handle('pages:set-icon', async (_event, id, icon) => {
  const safeId = requireId(id)
  return withIndex((index) => {
    const page = index.pages.find((p) => p.id === safeId)
    if (!page) throw new Error(`página inexistente: ${safeId}`)
    const value = icon ? String(icon) : null
    page.icon = value && !ICON_IMAGE_RE.test(value) ? value.slice(0, 8) : value
    page.updatedAt = Date.now()
  })
})

// eliminación definitiva (desde la papelera): borra el subárbol completo
ipcMain.handle('pages:delete', async (_event, id) => {
  const safeId = requireId(id)
  const removedIds = await withIndex((index) => {
    const ids = new Set(subtreeIds(index, safeId))
    index.pages = index.pages.filter((p) => !ids.has(p.id))
    if (ids.has(index.lastOpenedId)) index.lastOpenedId = firstActiveRootId(index)
    return [...ids]
  })
  dropFromIndexes(removedIds)
  await Promise.all(
    removedIds.map((pid) => fs.rm(path.join(pagesDir(), `${pid}.json`), { force: true }))
  )
})

ipcMain.handle('pages:set-last-opened', (_event, id) =>
  withIndex((index) => {
    index.lastOpenedId = typeof id === 'string' ? id : null
  })
)

// ---------- Imágenes ----------

const SAFE_EXT = /^\.[a-z0-9]{1,5}$/
const EXT_FROM_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}

function extFor(filename, mime) {
  const fromName = path.extname(String(filename ?? '')).toLowerCase()
  if (SAFE_EXT.test(fromName)) return fromName
  return EXT_FROM_MIME[mime] ?? '.png'
}

// nombre único por timestamp+random: evita colisiones y caché obsoleta en el protocolo custom
function uniqueAssetName(ext) {
  return `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`
}

async function writeAsset(buffer, filename, mime) {
  await fs.mkdir(assetsDir(), { recursive: true })
  const name = uniqueAssetName(extFor(filename, mime))
  await fs.writeFile(path.join(assetsDir(), name), buffer)
  return `appasset://local/${name}`
}

ipcMain.handle('image:save', async (_event, bytes, filename, mime) => {
  const buffer = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)
  const url = await writeAsset(buffer, filename, mime)
  return { success: 1, file: { url } }
})

ipcMain.handle('image:save-from-url', async (_event, sourceUrl) => {
  if (typeof sourceUrl !== 'string' || !/^https?:\/\//.test(sourceUrl)) {
    throw new Error('URL de imagen inválida')
  }
  // algunos hosts (p. ej. Wikimedia) rechazan peticiones sin un User-Agent descriptivo
  const response = await net.fetch(sourceUrl, {
    headers: { 'User-Agent': 'notion-clone/1.0 (Electron)' },
  })
  if (!response.ok) throw new Error(`no se pudo descargar la imagen (${response.status})`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const url = await writeAsset(buffer, new URL(sourceUrl).pathname, response.headers.get('content-type'))
  return { success: 1, file: { url } }
})

// descarga los bytes de una URL externa sin escribirlos a disco local — lo
// usa el renderer (src/lib/supabasePages.js) para subir imágenes pegadas por
// URL directo a Supabase Storage. Hace falta pasar por main porque `fetch`
// desde el renderer está sujeto a CORS; net.fetch en el proceso main no.
ipcMain.handle('image:fetch-bytes', async (_event, sourceUrl) => {
  if (typeof sourceUrl !== 'string' || !/^https?:\/\//.test(sourceUrl)) {
    throw new Error('URL de imagen inválida')
  }
  const response = await net.fetch(sourceUrl, {
    headers: { 'User-Agent': 'notion-clone/1.0 (Electron)' },
  })
  if (!response.ok) throw new Error(`no se pudo descargar la imagen (${response.status})`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    bytes: new Uint8Array(buffer),
    filename: path.basename(new URL(sourceUrl).pathname) || 'image',
    mime: response.headers.get('content-type') || null,
  }
})

// lee un asset ya guardado localmente (appasset://local/<name>) — lo usa el
// importador de Fase B para subir a Supabase Storage las imágenes de páginas
// creadas antes de tener backend.
ipcMain.handle('image:read-local-asset', async (_event, filename) => {
  const safeName = typeof filename === 'string' ? path.basename(filename) : null
  if (!safeName) throw new Error('nombre de archivo inválido')
  const buffer = await fs.readFile(path.join(assetsDir(), safeName))
  return { bytes: new Uint8Array(buffer), mime: null }
})

// ---------- Google Calendar ----------
// Siempre la cuenta del login: el permiso se pide junto con el de la sesión
// (ver performGoogleAuth / 'auth:login') y el refresh_token queda del lado de
// Supabase, nunca acá. Lo único que se guarda en esta máquina es el
// access_token de turno, cifrado con safeStorage (a diferencia de
// settings.json/index.json, es una credencial real, no metadata local).

const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'
const GOOGLE_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
// solo archivos que esta app crea (no todo el Drive) — scope "no sensible",
// no pide una revisión de Google aparte de la que ya hizo falta para el de Calendar.
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

let calendarTokens = null

async function loadCalendarTokens() {
  if (calendarTokens) return calendarTokens
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const encrypted = await fs.readFile(calendarAuthFile())
    calendarTokens = JSON.parse(safeStorage.decryptString(encrypted))
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('no se pudo leer el token de Google Calendar:', err)
    calendarTokens = null
  }
  return calendarTokens
}

async function saveCalendarTokens(tokens) {
  calendarTokens = tokens
  if (!tokens) {
    await fs.rm(calendarAuthFile(), { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('el cifrado del sistema operativo no está disponible')
  const encrypted = safeStorage.encryptString(JSON.stringify(tokens))
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(calendarAuthFile(), encrypted)
}

// El calendario es SIEMPRE el de la cuenta de Google del login: un solo
// camino, el "unified" (el refresh_token vive en Supabase, ver
// calendar-google-token). La ruta vieja de pegar Client ID/Secret propios ya
// no existe — un token guardado de esa época se ignora y se reemplaza por el
// del login la primera vez que se abre el calendario (ver
// 'calendar:ensure-connected').
async function ensureAccessToken() {
  const tokens = await loadCalendarTokens()
  if (tokens?.source !== 'unified') throw new Error('Google Calendar no está conectado')
  if (tokens.expiry && Date.now() < tokens.expiry - 60_000) return tokens.access_token

  const { access_token, expires_in } = await callCalendarTokenFunction({ action: 'refresh' })
  const next = { source: 'unified', access_token, expiry: Date.now() + expires_in * 1000 }
  await saveCalendarTokens(next)
  return next.access_token
}

// ---------- Google Drive (subir grabaciones) ----------
// Mismo esquema que Calendar arriba, pero solo el camino "unified" — no
// tiene sentido ofrecer credenciales propias acá, Drive siempre se conecta
// desde el checkbox de grabación con el client compartido del login.

let driveTokens = null

async function loadDriveTokens() {
  if (driveTokens) return driveTokens
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const encrypted = await fs.readFile(driveAuthFile())
    driveTokens = JSON.parse(safeStorage.decryptString(encrypted))
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('no se pudo leer el token de Google Drive:', err)
    driveTokens = null
  }
  return driveTokens
}

async function saveDriveTokens(tokens) {
  driveTokens = tokens
  if (!tokens) {
    await fs.rm(driveAuthFile(), { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('el cifrado del sistema operativo no está disponible')
  const encrypted = safeStorage.encryptString(JSON.stringify(tokens))
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(driveAuthFile(), encrypted)
}

// el `sub` de un JWT de Supabase es el user_id. Se saca de acá en vez de
// pasarlo desde el renderer porque este proceso ya tiene el token a mano y
// así no hay forma de que las dos partes se desincronicen.
function userIdFromJwt(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8')).sub ?? null
  } catch {
    return null
  }
}

// UN SOLO camino para pedirle permisos a Google, y siempre pidiendo LOS DOS
// scopes juntos (Calendar + Drive) y guardando LAS DOS tablas.
//
// Esto arregla el bug que hacía "reconectar Drive a cada rato" (encontrado
// 2026-08-13 comparando `updated_at` de drive_google_tokens contra
// calendar_google_tokens: en 2 de 4 cuentas estaban separadas por DÍAS).
// Antes había dos caminos, cada uno pidiendo un solo scope:
//   drive:connect-unified    -> performGoogleAuth({ drive: true })
//   calendar:connect-unified -> performGoogleAuth({ calendar: true })
// Como el authorize de Google no lleva `include_granted_scopes`, cada uno
// re-consentía con un conjunto de permisos MÁS ANGOSTO que el anterior y
// dejaba al otro token viejo y desalineado: reconectabas Drive y rompías
// Calendar, reconectabas Calendar y rompías Drive, para siempre.
//
// Pedir los dos scopes de más no cuesta nada (el usuario ya los aceptó en el
// login) y elimina la clase entera de bug: nunca puede haber un token con
// menos permisos que el anterior.
async function runGoogleReconsent() {
  const { session, providerRefreshToken } = await performGoogleAuth({
    calendar: true,
    drive: true,
    forceConsent: true,
  })
  await saveAuthSession(session)
  if (!providerRefreshToken) {
    throw new Error(
      'Google no devolvió el permiso. Revocá el acceso en myaccount.google.com/permissions (buscar FlashLab) y volvé a intentar.'
    )
  }
  await storeGoogleRefreshToken(session, providerRefreshToken)
}

// Un solo re-consentimiento a la vez: si tres subidas fallan juntas, las tres
// esperan el MISMO baile de OAuth en vez de abrir tres pestañas de Google.
let driveReconnectPromise = null

// Renueva el permiso de Drive sin que el usuario tenga que buscar nada en
// ningún menú (ese ítem ya no existe, ver AccountRow en Sidebar.jsx). Se
// dispara sola cuando el refresh_token guardado dejó de servir — el caso
// típico es que Google lo haya vencido, algo que pasa CADA 7 DÍAS mientras
// la pantalla de consentimiento del proyecto de Google Cloud esté en estado
// "Testing" en vez de "In production".
async function reconnectDriveInteractively() {
  if (driveReconnectPromise) return driveReconnectPromise
  driveReconnectPromise = (async () => {
    // avisar ANTES de abrir el navegador: si no, aparece una pestaña de
    // Google de la nada en medio de una subida y parece un secuestro.
    if (Notification.isSupported()) {
      new Notification({
        title: 'FlashLab',
        body: 'El permiso de Google Drive venció. Abrimos tu navegador para renovarlo; no hace falta que hagas nada más.',
      }).show()
    }
    await runGoogleReconsent()
  })()
  try {
    return await driveReconnectPromise
  } finally {
    driveReconnectPromise = null
  }
}

async function ensureDriveAccessToken({ allowReconnect = true } = {}) {
  const tokens = await loadDriveTokens()
  // La caché del access_token vive en un archivo por MÁQUINA, pero el token
  // es por CUENTA. Sin comparar el dueño, dos cuentas en la misma PC se
  // pisaban: si A subía algo y B entraba dentro de la hora de vida del
  // token, los archivos de B terminaban en el Drive de A (fuga real entre
  // cuentas, encontrada 2026-08-12). Un token sin `userId` es de una versión
  // vieja: no se puede atribuir a nadie, así que se descarta y se pide uno
  // nuevo — barato, y del lado correcto ante la duda.
  const currentUserId = userIdFromJwt(await ensureFreshSupabaseAccessToken())
  const cacheEsDeEstaCuenta = tokens && Boolean(currentUserId) && tokens.userId === currentUserId
  if (cacheEsDeEstaCuenta && tokens.expiry && Date.now() < tokens.expiry - 60_000) {
    return tokens.access_token
  }
  try {
    const { access_token, expires_in } = await callDriveTokenFunction({ action: 'refresh' })
    const next = {
      source: 'unified',
      userId: currentUserId,
      access_token,
      expiry: Date.now() + expires_in * 1000,
    }
    await saveDriveTokens(next)
    return next.access_token
  } catch (err) {
    // Acá caen los dos sabores de "la cuenta no tiene Drive": 404
    // not_connected (nunca se conectó, o se desconectó) y 502 invalid_grant
    // /"Token has been expired or revoked" (Google lo mató). Antes los dos
    // terminaban en un error que el usuario tenía que resolver a mano
    // volviendo al menú; ahora se renueva solo y se reintenta una vez.
    if (!allowReconnect) throw err
    console.warn('[drive] el permiso guardado no sirve, reconectando:', err?.message || err)
    await reconnectDriveInteractively()
    return ensureDriveAccessToken({ allowReconnect: false })
  }
}

ipcMain.handle('drive:auth-status', async () => {
  const tokens = await loadDriveTokens()
  return { connected: Boolean(tokens?.source === 'unified') }
})

// Ya no existe el ítem de menú "Conectar Google Drive" (ver AccountRow en
// Sidebar.jsx), pero este handler sigue vivo porque lo usan el checkbox
// "Guardar en Drive" de PageView y "Subir a Drive" de RecordingsView.
// IMPORTANTE: pide LOS DOS scopes vía runGoogleReconsent, no solo el de
// Drive — pedir uno solo era lo que rompía Calendar en cada reconexión.
ipcMain.handle('drive:connect-unified', async () => {
  await runGoogleReconsent()
  return { connected: true }
})

ipcMain.handle('drive:disconnect', async () => {
  await callDriveTokenFunction({ action: 'disconnect' }).catch((err) =>
    console.error('No se pudo desconectar Drive del lado del servidor:', err)
  )
  await saveDriveTokens(null)
})

// ---------- Google Drive (adjuntos de chat) ----------
// A diferencia de las grabaciones (que suben desde main, porque el archivo
// vive en disco y hace falta ffmpeg), un adjunto de chat ya está en memoria
// del renderer como File — subirlo por acá implicaría pasar sus bytes
// enteros por IPC (nada bueno con un archivo de varios GB). En cambio el
// renderer hace el PUT del archivo directo contra la API de Drive (mismo
// patrón que ya usa con Supabase Storage en uploadWithProgress.js); main
// solo presta lo que sí tiene que vivir acá: el token y las llamadas de
// gestión (carpeta, share) que son livianas.

ipcMain.handle('drive:get-access-token', () => ensureDriveAccessToken())

// pathSegments: ej. ['Chat', conversationId] -> FlashLab/Chat/{conversationId}
ipcMain.handle('drive:ensure-folder', async (_event, pathSegments) => {
  const accessToken = await ensureDriveAccessToken()
  const segments = Array.isArray(pathSegments) ? pathSegments : []
  return ensureNestedDriveFolderId(accessToken, segments)
})

ipcMain.handle('drive:share-file', async (_event, fileId, emails) => {
  const accessToken = await ensureDriveAccessToken()
  return shareDriveFileWithEmails(accessToken, fileId, Array.isArray(emails) ? emails : [])
})

// Bytes reales de un adjunto: si es de Drive (driveId) hace falta el access
// token propio — un fetch anónimo del webViewLink solo trae la página HTML
// del visor, no el archivo (por eso los tres handlers de abajo, y no un
// fetch directo en el renderer). Si es un adjunto viejo de Supabase Storage
// (sin driveId), `url` ya son bytes directos, alcanza con un fetch normal.
// El caller (ChatView.jsx) solo pasa driveId cuando el mensaje es MÍO — un
// adjunto ajeno en Drive no se puede leer así, cae a shell.openExternal.
async function fetchAttachmentBuffer({ driveId, url }) {
  if (driveId) {
    const accessToken = await ensureDriveAccessToken()
    const res = await net.fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(driveId)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`no se pudo leer el archivo de Drive (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`no se pudo leer el archivo (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

ipcMain.handle('attachment:save-as', async (_event, { driveId, url, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: suggestedName || 'archivo' })
  if (canceled || !filePath) return { saved: false }
  const buffer = await fetchAttachmentBuffer({ driveId, url })
  await fs.writeFile(filePath, buffer)
  return { saved: true, filePath }
})

ipcMain.handle('attachment:copy-image', async (_event, { driveId, url }) => {
  const buffer = await fetchAttachmentBuffer({ driveId, url })
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) throw new Error('no se pudo leer la imagen')
  clipboard.writeImage(image)
})

// "Abrir con": Electron no tiene un picker nativo de "abrir con" — el truco
// estándar en Windows es invocar rundll32 con OpenAs_RunDLL sobre un
// archivo que ya esté en disco, así que primero hace falta bajar los bytes
// a un temporal.
// OJO con { detached: true }: probado a mano, con esa opción el diálogo
// "Abrir con" de Windows NUNCA aparece (ni error, ni excepción — el proceso
// se lanza y no pasa nada, exactamente el síntoma reportado). Sin
// `detached` sí funciona. `stdio: 'ignore'` solo, sin detached, alcanza
// para no bloquear ni heredar los pipes de este proceso.
ipcMain.handle('attachment:open-with', async (_event, { driveId, url, suggestedName }) => {
  const buffer = await fetchAttachmentBuffer({ driveId, url })
  const safeName = String(suggestedName ?? 'archivo').replace(/[/\\:*?"<>|]/g, '-')
  const tempPath = path.join(app.getPath('temp'), `flashlab-openwith-${randomUUID()}-${safeName}`)
  await fs.writeFile(tempPath, buffer)
  const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', tempPath], { stdio: 'ignore' })
  child.on('error', (err) => console.error('no se pudo abrir el picker de "Abrir con":', err))
  child.unref()
})

// Un adjunto de chat que es video/webm (grabado con MediaRecorder — captura
// de pantalla exportada, lo que sea) no trae índice de seek propio (Cues):
// Drive lo sirve igual, pero mover la línea de tiempo desincroniza audio y
// video, porque sin ese índice el reproductor tiene que adivinar a qué
// frame corresponde cada byte (mismo motivo ya documentado en
// transcodeForExternalPlayer, que arregla esto mismo para grabaciones
// reencodeando a mp4 con +faststart antes de subir). Por eso este único
// caso pasa por acá (hace falta ffmpeg) en vez del PUT directo del renderer
// que usan el resto de los adjuntos — ver driveAttachmentUpload.js, que le
// pasa el path real del archivo (webUtils.getPathForFile, sin copiar bytes
// por IPC) en vez de subir el .webm crudo.
ipcMain.handle('drive:upload-video-attachment', async (_event, filePath, folderSegments) => {
  const accessToken = await ensureDriveAccessToken()
  const mp4Path = await transcodeForExternalPlayer(filePath, () => {})
  try {
    const stat = await fs.stat(mp4Path)
    const folderId = await ensureNestedDriveFolderId(accessToken, Array.isArray(folderSegments) ? folderSegments : [])
    const name = path.basename(filePath).replace(/\.\w+$/, '.mp4')
    const initRes = await net.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,webViewLink`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(stat.size),
      },
      body: JSON.stringify({ name, parents: [folderId] }),
    })
    if (!initRes.ok) {
      const body = await initRes.json().catch(() => null)
      throw new Error(body?.error?.message || `Drive respondió ${initRes.status} al iniciar la subida`)
    }
    const uploadUrl = initRes.headers.get('location')
    if (!uploadUrl) throw new Error('Drive no devolvió una URL de subida')
    const uploaded = await putFileToDriveUrl(uploadUrl, mp4Path, stat.size, 'video/mp4', () => {})
    return { fileId: uploaded.id, webViewLink: uploaded.webViewLink }
  } finally {
    await fs.rm(mp4Path, { force: true }).catch(() => {})
  }
})

// Repara un video que YA está en Drive como .webm crudo — los subidos antes
// de que existiera 'drive:upload-video-attachment'. Un .webm de
// MediaRecorder no declara su duración (comprobado: ffmpeg reporta
// "Duration: N/A"), así que el reproductor no puede ubicarse en la línea de
// tiempo por más que el servidor responda los Range perfecto: hay que
// reemplazar el archivo en sí.
// Se hace PATCH sobre el MISMO fileId (no un archivo nuevo): conserva el
// id, el webViewLink y los permisos ya repartidos a los destinatarios.
ipcMain.handle('drive:repair-video', async (_event, fileId) => {
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(fileId)) throw new Error('id de archivo inválido')
  const accessToken = await ensureDriveAccessToken()

  const res = await net.fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`no se pudo descargar el video de Drive (${res.status})`)
  const srcPath = path.join(app.getPath('temp'), `flashlab-repair-${randomUUID()}.webm`)
  await fs.writeFile(srcPath, Buffer.from(await res.arrayBuffer()))

  let mp4Path = null
  try {
    mp4Path = await transcodeForExternalPlayer(srcPath, () => {})
    const stat = await fs.stat(mp4Path)
    const initRes = await net.fetch(
      `${DRIVE_UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=resumable&fields=id,webViewLink`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(stat.size),
        },
        body: JSON.stringify({ mimeType: 'video/mp4' }),
      }
    )
    if (!initRes.ok) {
      const body = await initRes.json().catch(() => null)
      throw new Error(body?.error?.message || `Drive respondió ${initRes.status} al reemplazar el video`)
    }
    const uploadUrl = initRes.headers.get('location')
    if (!uploadUrl) throw new Error('Drive no devolvió una URL de subida')
    await putFileToDriveUrl(uploadUrl, mp4Path, stat.size, 'video/mp4', () => {})
    // el tamaño cambió: el metadata cacheado de driveasset:// quedó viejo
    driveAssetMetaCache.delete(fileId)
    return { repaired: true }
  } finally {
    await fs.rm(srcPath, { force: true }).catch(() => {})
    if (mp4Path) await fs.rm(mp4Path, { force: true }).catch(() => {})
  }
})

ipcMain.handle('calendar:auth-status', async () => {
  const tokens = await loadCalendarTokens()
  return { connected: tokens?.source === 'unified' }
})

// Lo que consulta la vista de Calendario al abrirse. Igual que 'auth-status',
// pero además recupera la conexión sin pedir nada al usuario cuando esta
// instalación no tiene el token local (reinstalación, otra máquina, o una
// sesión iniciada antes de que el login pidiera el scope de Calendar): el
// refresh_token del login unificado vive en Supabase, así que si la Edge
// Function devuelve un access_token es que la cuenta ya otorgó el permiso y
// alcanza con volver a guardarlo acá.
ipcMain.handle('calendar:ensure-connected', async () => {
  const tokens = await loadCalendarTokens()
  if (tokens?.source === 'unified') return { connected: true }
  try {
    const { access_token, expires_in } = await callCalendarTokenFunction({ action: 'refresh' })
    await saveCalendarTokens({ source: 'unified', access_token, expiry: Date.now() + expires_in * 1000 })
    return { connected: true }
  } catch (err) {
    // 'not_connected' es el caso normal (esta cuenta nunca dio el permiso):
    // el renderer arranca el consentimiento de Google por su cuenta.
    console.log('Calendar todavía sin conectar:', err.message)
    return { connected: false }
  }
})

async function calendarFetch(pathAndQuery, options = {}) {
  const accessToken = await ensureAccessToken()
  const response = await net.fetch(`${GOOGLE_EVENTS_URL}${pathAndQuery}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...options.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error?.message || `Google Calendar respondió ${response.status}`)
  }
  return response.status === 204 ? null : response.json()
}

function toGoogleEventBody({ title, description, start, end, allDay }) {
  const dateKey = allDay ? 'date' : 'dateTime'
  return {
    summary: title,
    description: description || undefined,
    start: { [dateKey]: start },
    end: { [dateKey]: end },
  }
}

ipcMain.handle('calendar:list-events', async (_event, timeMinIso, timeMaxIso) => {
  const query = new URLSearchParams({
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  })
  const data = await calendarFetch(`?${query}`)
  return (data.items ?? [])
    .filter((ev) => ev.status !== 'cancelled')
    .map((ev) => ({
      id: ev.id,
      title: ev.summary ?? '(sin título)',
      description: ev.description ?? '',
      start: ev.start?.dateTime ?? ev.start?.date,
      end: ev.end?.dateTime ?? ev.end?.date,
      allDay: Boolean(ev.start?.date && !ev.start?.dateTime),
    }))
})

ipcMain.handle('calendar:create-event', async (_event, eventData) => {
  const data = await calendarFetch('', { method: 'POST', body: JSON.stringify(toGoogleEventBody(eventData)) })
  return { id: data.id }
})

ipcMain.handle('calendar:update-event', async (_event, id, eventData) => {
  await calendarFetch(`/${encodeURIComponent(String(id))}`, {
    method: 'PATCH',
    body: JSON.stringify(toGoogleEventBody(eventData)),
  })
})

ipcMain.handle('calendar:delete-event', async (_event, id) => {
  await calendarFetch(`/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
})

// notas de reunión vinculadas a un evento de Google Calendar — mapeo local,
// no se guarda en el evento de Google (nada que sincronizar más allá del propio calendario)
ipcMain.handle('calendar:get-event-page', async (_event, eventId) => {
  const settings = await loadSettings()
  return settings.calendarEventPages[eventId] ?? null
})

ipcMain.handle('calendar:link-event-page', async (_event, eventId, pageId) => {
  const settings = await loadSettings()
  await saveSettings({ calendarEventPages: { ...settings.calendarEventPages, [eventId]: pageId } })
})

// ---------- Autenticación (Supabase Auth con Google) ----------
// Mismo patrón que Calendar arriba (loopback + shell.openExternal +
// safeStorage), pero acá el intermediario es GoTrue (el servidor de auth de
// Supabase) — Google redirige primero al callback de Supabase, no al nuestro,
// y recién Supabase (que tiene el client secret de Google, nunca esta app)
// redirige de vuelta a nuestro loopback. La app nunca ve ni necesita el
// client secret de Google para este flujo.
//
// A diferencia de Calendar (que prueba el puerto 0 — el SO elige uno libre
// al azar, válido porque Google no exige una allowlist de redirect_uri por
// client_id de tipo Desktop), Supabase sí exige que las URLs de retorno
// estén permitidas de antemano en su dashboard, así que acá probamos una
// lista fija corta de puertos candidatos hasta encontrar uno libre.
//
// PKCE en vez de flujo implícito: el flujo implícito devuelve los tokens en
// el fragmento de la URL (#access_token=...), que nunca llega a un server
// HTTP — nuestro loopback (http.createServer plano) solo ve el query string.
// Con PKCE viaja un `code` de un solo uso, inútil sin el code_verifier que
// nunca sale de este proceso.

// Project URL y publishable key de Supabase (Project Settings → API Keys).
// No son secretos — Supabase asume que son públicas, la seguridad la da
// Row Level Security en la base.
const SUPABASE_URL = 'https://egwyllgnludowtpnfgdi.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_hvRCGxIIcWnzQbzBGimWTA_vU4gT1S5'

// deben coincidir exactamente con las Redirect URLs permitidas en Supabase
// Dashboard → Authentication → URL Configuration
const LOOPBACK_PORTS = [53682, 53683, 53684, 53685, 53686]

const authSessionFile = () => path.join(app.getPath('userData'), 'auth-session.enc')

let authSession = null

async function loadAuthSession() {
  if (authSession) return authSession
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const encrypted = await fs.readFile(authSessionFile())
    authSession = JSON.parse(safeStorage.decryptString(encrypted))
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('no se pudo leer la sesión guardada:', err)
    authSession = null
  }
  return authSession
}

async function saveAuthSession(session) {
  authSession = session
  if (!session) {
    await fs.rm(authSessionFile(), { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('el cifrado del sistema operativo no está disponible')
  const encrypted = safeStorage.encryptString(JSON.stringify(session))
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(authSessionFile(), encrypted)
}

// Login unificado con Google Calendar: si el checkbox de la pantalla de
// login estaba tildado, auth:login pide también el scope de Calendar en la
// misma pantalla de consentimiento de Google. El refresh_token que Google
// devuelve queda guardado del lado de Supabase (Edge Function
// calendar-google-token + tabla calendar_google_tokens), nunca en esta app —
// el client "Web application" del login es compartido por todos los
// usuarios y su client_secret vive únicamente en Supabase.

const CALENDAR_TOKEN_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/calendar-google-token`

// se asegura de tener un access_token de Supabase vigente antes de llamar a
// la Edge Function — si el que está guardado ya venció, lo renueva primero
// (mismo endpoint que usa la rotación normal del login).
async function ensureFreshSupabaseAccessToken() {
  const session = await loadAuthSession()
  if (!session) throw new Error('No hay sesión activa')
  if (session.expires_at && Date.now() / 1000 < session.expires_at - 60) return session.access_token

  const response = await net.fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error_description || data.msg || `no se pudo renovar la sesión (${response.status})`)

  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    token_type: data.token_type,
    user: data.user ?? session.user,
  }
  await saveAuthSession(next)
  return next.access_token
}

async function callCalendarTokenFunction(body) {
  const accessToken = await ensureFreshSupabaseAccessToken()
  const response = await net.fetch(CALENDAR_TOKEN_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `calendar-google-token respondió ${response.status}`)
  return data
}

const DRIVE_TOKEN_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/drive-google-token`

async function callDriveTokenFunction(body) {
  const accessToken = await ensureFreshSupabaseAccessToken()
  const response = await net.fetch(DRIVE_TOKEN_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `drive-google-token respondió ${response.status}`)
  return data
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function createPkcePair() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// referencia al login/conexión OAuth pendiente (a lo sumo uno a la vez —
// alcanza porque la UI solo deja disparar un intento por vez) — permite
// cortarlo desde 'auth:cancel-login' si el usuario se arrepiente o abandona
// la pestaña del navegador sin completar ni cancelar el consentimiento de
// Google (sin esto quedaba colgado hasta el timeout de 5 min, sin forma de
// reintentar antes).
let pendingLoopbackCancel = null

// página que ve el usuario en SU navegador (no en la app) al volver del
// consentimiento de Google — antes era un <p> suelto sin estilos, de ahí
// que se viera tan pobre comparado con el resto de la app. Intenta
// cerrarse sola (window.close() funciona si el navegador lo permite; la
// mayoría lo bloquea para una pestaña que no abrió un script, por eso el
// mensaje de abajo siempre queda como respaldo).
function loopbackResponseHtml(ok) {
  const title = ok ? 'Listo' : 'Autorización cancelada'
  const message = ok
    ? 'Ya podés cerrar esta pestaña y volver a FlashLab.'
    : 'No se completó la autorización. Podés cerrar esta pestaña y volver a intentar desde FlashLab.'
  const icon = ok
    ? '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="12" fill="#2563eb"/><path d="M7 12.5l3 3 7-7" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="12" fill="#9ca3af"/><path d="M8 8l8 8M16 8l-8 8" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>FlashLab</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f4f5f7; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) { body { background: #18181b; } }
  .card {
    background: #fff; border-radius: 16px; padding: 40px 48px; text-align: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06); max-width: 360px;
  }
  @media (prefers-color-scheme: dark) { .card { background: #27272a; box-shadow: none; } }
  .card h1 { margin: 16px 0 6px; font-size: 18px; color: #18181b; }
  @media (prefers-color-scheme: dark) { .card h1 { color: #f4f4f5; } }
  .card p { margin: 0; font-size: 14px; line-height: 1.5; color: #71717a; }
  .brand { margin-top: 22px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: #a1a1aa; text-transform: uppercase; }
</style>
</head>
<body>
  <div class="card">
    ${icon}
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="brand">FlashLab</div>
  </div>
  <script>setTimeout(() => window.close(), 1200)</script>
</body>
</html>`
}

// levanta un server temporal en `port`: `ready` resuelve/rechaza apenas se
// sabe si el bind funcionó, `codePromise` resuelve más tarde cuando llega el
// redirect con ?code= (o rechaza con ?error= / timeout de 5 min / cancelación manual)
function createLoopbackServer(port) {
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const codePromise = new Promise((resolveCode, rejectCode) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(loopbackResponseHtml(!error))
      settle()
      if (error) rejectCode(new Error(error))
      else if (code) resolveCode(code)
      else rejectCode(new Error('respuesta sin código de autorización'))
    })
    const timeoutId = setTimeout(
      () => {
        settle()
        rejectCode(new Error('tiempo de espera agotado autorizando'))
      },
      5 * 60 * 1000
    )
    // se llama una sola vez, desde cualquiera de las 3 formas de terminar
    // (código recibido, error de Google, timeout) o desde la cancelación
    // manual — limpia el timer y la referencia global para que no quede
    // apuntando a un intento que ya terminó.
    function settle() {
      clearTimeout(timeoutId)
      server.close()
      if (pendingLoopbackCancel === cancel) pendingLoopbackCancel = null
    }
    function cancel() {
      settle()
      rejectCode(new Error('cancelado'))
    }
    pendingLoopbackCancel = cancel
    server.once('error', (err) => {
      settle()
      rejectReady(err)
      rejectCode(err)
    })
    server.listen(port, '127.0.0.1', () => resolveReady())
  })
  return { ready, codePromise }
}

async function startLoopbackListener(candidatePorts) {
  for (const port of candidatePorts) {
    const { ready, codePromise } = createLoopbackServer(port)
    try {
      await ready
      return { port, codePromise }
    } catch {
      // puerto ocupado, probar el siguiente candidato
    }
  }
  throw new Error(`no se encontró un puerto local libre para el login (probados: ${candidatePorts.join(', ')})`)
}

ipcMain.handle('auth:get-session', async () => loadAuthSession())

ipcMain.handle('auth:persist-session', async (_event, session) => {
  await saveAuthSession(session)
})

// hace el baile de OAuth completo (loopback + Supabase authorize + PKCE) y
// devuelve la sesión + el provider_refresh_token de Google si se pidió algún
// scope extra (Calendar y/o Drive). La usan auth:login (primer login),
// calendar:connect-unified y drive:connect-unified (conectar/reconectar sin
// desloguearse — ver más abajo) porque son exactamente el mismo intercambio,
// la única diferencia es qué scopes piden y cuándo se disparan.
async function performGoogleAuth({ calendar = false, drive = false, forceConsent = true } = {}) {
  const { port, codePromise } = await startLoopbackListener(LOOPBACK_PORTS)
  const redirectTo = `http://127.0.0.1:${port}`
  const { verifier, challenge } = createPkcePair()

  const authUrl = new URL(`${SUPABASE_URL}/auth/v1/authorize`)
  authUrl.searchParams.set('provider', 'google')
  authUrl.searchParams.set('redirect_to', redirectTo)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 's256')
  const scopes = [calendar && GOOGLE_CALENDAR_SCOPE, drive && GOOGLE_DRIVE_SCOPE].filter(Boolean).join(' ')
  if (scopes) {
    authUrl.searchParams.set('scopes', scopes)
    authUrl.searchParams.set('access_type', 'offline')
    // prompt=consent obliga a Google a mostrar la pantalla de permisos y a
    // reemitir el refresh_token — hace falta la primera vez (sin él Google
    // solo lo entrega en el consentimiento original) pero es exactamente lo
    // que hace que la pantalla "Google no verificó esta app" reaparezca en
    // CADA login. Con el permiso ya otorgado y el refresh_token guardado no
    // hay nada que volver a pedir: sin prompt, Google pasa de largo.
    if (forceConsent) authUrl.searchParams.set('prompt', 'consent')
  }

  await shell.openExternal(authUrl.toString())
  const code = await codePromise

  const response = await net.fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error_description || data.msg || `login falló (${response.status})`)

  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    token_type: data.token_type,
    user: data.user,
  }
  return { session, providerRefreshToken: data.provider_refresh_token ?? null }
}

// corta un login/conexión OAuth pendiente (botón "Cancelar" mientras dice
// "Esperando autorización…") — la usan LoginGate, CalendarView y el
// checkbox de Drive de PageView, los tres consumidores de performGoogleAuth.
// Ver pendingLoopbackCancel arriba.
ipcMain.handle('auth:cancel-google-auth', () => {
  pendingLoopbackCancel?.()
})

// Es UN solo refresh_token por consentimiento, con todos los scopes
// otorgados adentro — el mismo sirve para Calendar y para Drive, y cada
// feature lo consulta por su lado (tablas distintas). Se guardan en dos
// try/catch separados a propósito: que falle uno no puede dejar al otro sin
// conectar.
async function storeGoogleRefreshToken(session, providerRefreshToken) {
  try {
    await callCalendarTokenFunction({ action: 'store', refreshToken: providerRefreshToken })
    // sin access_token/expiry todavía: la próxima llamada a Calendar lo pide
    // fresco solo con source:'unified' seteado
    await saveCalendarTokens({ source: 'unified', access_token: null, expiry: 0 })
  } catch (err) {
    console.error('No se pudo guardar el acceso a Calendar del login unificado:', err)
  }
  try {
    await callDriveTokenFunction({ action: 'store', refreshToken: providerRefreshToken })
    // userId: la caché del token de Drive es por cuenta, no por máquina (ver
    // ensureDriveAccessToken) — sin esto, dos cuentas en la misma PC se
    // pisaban los archivos.
    await saveDriveTokens({
      source: 'unified',
      userId: userIdFromJwt(session.access_token),
      access_token: null,
      expiry: 0,
    })
  } catch (err) {
    console.error('No se pudo guardar el acceso a Drive del login unificado:', err)
  }
}

// ¿la CUENTA logueada tiene un refresh_token de Drive VIVO del lado del
// servidor? Es una pregunta distinta de "¿este archivo local dice que
// alguna vez se conectó?" (loadDriveTokens), y confundirlas era el corazón
// del bug reportado: el archivo local decía "conectado", así que el login
// no volvía a pedir consentimiento, mientras que en drive_google_tokens el
// refresh_token ya estaba vencido o revocado por Google. Resultado: la
// cuenta quedaba trabada sin Drive y sin ninguna forma automática de
// recuperarlo.
async function isDriveConnectedServerSide() {
  try {
    await callDriveTokenFunction({ action: 'refresh' })
    return true
  } catch {
    return false
  }
}

// Idem para Calendar. Se chequean los DOS porque el bug del ping-pong dejó
// cuentas con un token bueno y el otro viejo/angosto (medido: 2 de 4 cuentas
// con `updated_at` separado por días entre las dos tablas). Si se mirara solo
// Drive, un re-login repararía Drive y dejaría Calendar roto para siempre.
async function isCalendarConnectedServerSide() {
  try {
    await callCalendarTokenFunction({ action: 'refresh' })
    return true
  } catch {
    return false
  }
}

// el login siempre pide el scope de Calendar y el de Drive (antes dependía
// de un checkbox en la pantalla de login): entrar con Google alcanza para que
// la vista de Calendario y los adjuntos de chat queden conectados solos, sin
// un segundo consentimiento aparte — ya no existe el ítem "Conectar Google
// Drive" en el menú de la cuenta, este es el ÚNICO lugar donde se otorga.
ipcMain.handle('auth:login', async () => {
  // Si esta instalación ya tiene los permisos otorgados, no hay nada nuevo
  // que consentir: sin prompt=consent, Google no vuelve a mostrar la
  // pantalla de permisos (ni el cartel de "app no verificada") y el login
  // pasa derecho.
  const calendarGranted = (await loadCalendarTokens())?.source === 'unified'
  const driveGranted = (await loadDriveTokens())?.source === 'unified'
  let { session, providerRefreshToken } = await performGoogleAuth({
    calendar: true,
    drive: true,
    forceConsent: !(calendarGranted && driveGranted),
  })
  await saveAuthSession(session)

  // Google solo manda provider_refresh_token en el intercambio donde se
  // otorgó el permiso (no en re-logueos silenciosos posteriores) — guardarlo
  // server-side ahora es la única oportunidad.
  if (providerRefreshToken) await storeGoogleRefreshToken(session, providerRefreshToken)

  // Red de seguridad para el caso que rompía todo: los archivos locales
  // decían "ya otorgado" (así que se salteó prompt=consent y Google no
  // mandó refresh_token), pero la cuenta NO tiene uno vivo del lado del
  // servidor. Antes eso dejaba la sesión iniciada y Drive muerto, y la única
  // salida era el ítem del menú. Ahora se repite el intercambio forzando el
  // consentimiento — un clic más, pero solo cuando de verdad hace falta.
  const [driveOk, calendarOk] = await Promise.all([isDriveConnectedServerSide(), isCalendarConnectedServerSide()])
  if (!driveOk || !calendarOk) {
    console.warn(`[google] permisos incompletos (drive=${driveOk} calendar=${calendarOk}) — repitiendo el consentimiento`)
    try {
      await runGoogleReconsent()
      session = await loadAuthSession()
    } catch (err) {
      // que falle esto no puede tumbar el login: la sesión de arriba ya es
      // válida y todo lo que no es Drive/Calendar funciona igual.
      console.error('No se pudieron reconectar los permisos de Google durante el login:', err)
    }
  }

  return session
})

ipcMain.handle('auth:logout', async () => {
  await saveAuthSession(null)
})

// conectar (o reconectar) Calendar sin tener que desloguearse — mismo client
// compartido que el checkbox del login, para quien ya inició sesión sin
// tildarlo (o lo desconectó y quiere volver a activarlo). Repite el mismo
// intercambio OAuth y de paso refresca la sesión de Supabase (inofensivo, es
// el mismo usuario).
// Espejo exacto de drive:connect-unified — pide los dos scopes y guarda las
// dos tablas. Antes pedía solo el de Calendar, que era la otra mitad del
// ping-pong que dejaba a Drive desconectado (ver runGoogleReconsent).
ipcMain.handle('calendar:connect-unified', async () => {
  await runGoogleReconsent()
  return { connected: true }
})

// ---------- Grabaciones ----------
// Metadata aparte de index.json/pages/<id>.json a propósito: así no compite
// con el autosave del editor (que sobreescribe blocks/time/version enteros).

const recordingsDir = () => path.join(app.getPath('userData'), 'recordings')
const recordingsFile = (pageId) => path.join(recordingsDir(), `${pageId}.json`)

ipcMain.handle('recordings:list', async (_event, pageId) => {
  const stored = await readJsonSafe(recordingsFile(requireId(pageId)))
  return Array.isArray(stored) ? stored : []
})

ipcMain.handle('recordings:add', async (_event, pageId, recording) => {
  const safeId = requireId(pageId)
  const stored = await readJsonSafe(recordingsFile(safeId))
  const list = Array.isArray(stored) ? stored : []
  const entry = {
    id: randomUUID(),
    url: String(recording?.url ?? ''),
    name: String(recording?.name ?? 'Grabación'),
    createdAt: Date.now(),
  }
  list.push(entry)
  await fs.mkdir(recordingsDir(), { recursive: true })
  await writeJsonAtomic(recordingsFile(safeId), list)
  return entry
})

// todas las grabaciones de todas las páginas, para la sección del sidebar
ipcMain.handle('recordings:list-all', async () => {
  await fs.mkdir(recordingsDir(), { recursive: true })
  const files = await fs.readdir(recordingsDir())
  const index = await loadIndex()
  const result = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const pageId = file.slice(0, -5)
    const stored = await readJsonSafe(path.join(recordingsDir(), file))
    if (!Array.isArray(stored)) continue
    const page = index.pages.find((p) => p.id === pageId)
    for (const rec of stored) {
      result.push({ ...rec, pageId, pageTitle: page?.title || 'Sin título' })
    }
  }
  result.sort((a, b) => b.createdAt - a.createdAt)
  return result
})

ipcMain.handle('recordings:delete', async (_event, pageId, recordingId) => {
  const safeId = requireId(pageId)
  const stored = await readJsonSafe(recordingsFile(safeId))
  const list = Array.isArray(stored) ? stored : []
  const entry = list.find((r) => r.id === recordingId)
  await writeJsonAtomic(recordingsFile(safeId), list.filter((r) => r.id !== recordingId))
  const match = entry?.url?.match(/^appasset:\/\/local\/([A-Za-z0-9_-]+\.[a-z0-9]{1,5})$/)
  if (match) await fs.rm(path.join(assetsDir(), match[1]), { force: true })
})

// "Copiar" al lado de "Eliminar" en la lista de grabaciones: diálogo nativo
// "Guardar como" + una copia lista para abrir en cualquier reproductor de
// escritorio. No mueve ni borra el original (recordingFilePath está más
// abajo, se puede usar acá igual por hoisting).
//
// Se remuxa a .mp4 en vez de copiar el .webm crudo tal cual: ese .webm es el
// contenedor "streaming" sin índice de seek que arma MediaRecorder a los
// golpes (ver transcodeForExternalPlayer) — copiado tal cual, VLC y otros
// reproductores de escritorio lo mostraban distorsionado y no dejaban
// moverse en el tiempo.
ipcMain.handle('recordings:copy-to-folder', async (_event, pageId, recordingId) => {
  const safeId = requireId(pageId)
  const stored = await readJsonSafe(recordingsFile(safeId))
  const list = Array.isArray(stored) ? stored : []
  const entry = list.find((r) => r.id === recordingId)
  if (!entry) throw new Error('grabación no encontrada')
  const sourcePath = recordingFilePath(entry)

  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `${sanitizeFilename(entry.name)}.mp4`,
    filters: [{ name: 'Video', extensions: ['mp4'] }],
  })
  if (canceled || !filePath) return { copied: false }

  const tempPath = await transcodeForExternalPlayer(sourcePath)
  try {
    await fs.copyFile(tempPath, filePath)
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
  return { copied: true, filePath }
})

// avisa a todas las ventanas por 'recordings:updated' sin tocar disco — la
// usa el progreso de subida a Drive (puede dispararse decenas de veces por
// archivo) para no hacer un writeJsonAtomic por cada % de avance.
function broadcastRecordingPatch(pageId, recordingId, patch) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recordings:updated', { pageId, recordingId, patch })
  }
}

// mergea `patch` en la entry, lo persiste, y avisa a todas las ventanas —
// generalizado para llevar cualquier campo que haya cambiado (antes solo
// `url`), así los consumidores (PageView.jsx, RecordingsView.jsx) mergean
// el patch entero en vez de asumir que siempre es `url`.
async function patchRecordingEntry(pageId, recordingId, patch) {
  const safeId = requireId(pageId)
  const stored = await readJsonSafe(recordingsFile(safeId))
  const list = Array.isArray(stored) ? stored : []
  const updatedList = list.map((r) => (r.id === recordingId ? { ...r, ...patch } : r))
  await writeJsonAtomic(recordingsFile(safeId), updatedList)
  broadcastRecordingPatch(safeId, recordingId, patch)
  return updatedList.find((r) => r.id === recordingId)
}

// ---------- Subir grabación a Google Drive + auto-compartir ----------
// Best-effort, en segundo plano: la grabación local ya está guardada antes
// de que esto arranque (ver screenRecording.js), así que si algo acá falla
// (sin cuota, sin red, token revocado) la grabación sigue intacta — solo
// queda marcada `driveStatus: 'error'` para poder reintentar.

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'

function recordingFilePath(entry) {
  const match = entry?.url?.match(/^appasset:\/\/local\/([A-Za-z0-9_-]+\.[a-z0-9]{1,5})$/)
  if (!match) throw new Error('grabación inválida')
  return path.join(assetsDir(), match[1])
}

// busca la carpeta fija 'FlashLab' en Drive y la crea si no existe. Se busca
// de nuevo en cada subida en vez de cachear el id — así se autocorrige sola
// si alguien la borró o renombró desde Drive, al costo de una consulta extra
// (barata) por subida. Con el scope drive.file la app solo puede "ver"
// carpetas que ella misma creó, así que crearla de entrada (en vez de
// asumir una ya existente del usuario) es justamente lo que hace que esto
// funcione bajo ese scope.
const DRIVE_FOLDER_NAME = 'FlashLab'

// busca una carpeta por nombre (opcionalmente dentro de parentId) y la crea
// si no existe. Generalización de lo que antes era solo para 'FlashLab' —
// ahora también arma subcarpetas (FlashLab/Chat/{conversationId} para
// adjuntos de chat, ver ensureNestedDriveFolderId).
async function ensureDriveChildFolderId(accessToken, name, parentId, signal) {
  const escapedName = name.replace(/'/g, "\\'")
  const parentClause = parentId ? ` and '${parentId}' in parents` : ''
  const query = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`
  const listRes = await net.fetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  })
  const listData = await listRes.json()
  if (listRes.ok && listData.files?.length) return listData.files[0].id

  const createRes = await net.fetch(DRIVE_FILES_URL, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    }),
  })
  const createData = await createRes.json()
  if (!createRes.ok) throw new Error(createData?.error?.message || 'no se pudo crear la carpeta de Drive')
  return createData.id
}

async function ensureDriveFolderId(accessToken, signal) {
  return ensureDriveChildFolderId(accessToken, DRIVE_FOLDER_NAME, null, signal)
}

// FlashLab/segments[0]/segments[1]/... — la usan los adjuntos de chat para
// terminar en FlashLab/Chat/{conversationId}. Cada nivel es una consulta +
// eventual creación, pero son pocos niveles y baratos.
async function ensureNestedDriveFolderId(accessToken, segments, signal) {
  let parentId = await ensureDriveFolderId(accessToken, signal)
  for (const segment of segments) {
    parentId = await ensureDriveChildFolderId(accessToken, segment, parentId, signal)
  }
  return parentId
}

// comparte un archivo ya subido con una lista de emails (reader, sin mail de
// Drive — ver por qué en los callers). Un email que falla no aborta el
// resto; se devuelve para que el caller decida qué hacer (reintentar,
// avisar, etc).
async function shareDriveFileWithEmails(accessToken, fileId, emails, signal) {
  const failed = []
  for (const email of emails) {
    try {
      const res = await net.fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=false`, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: email }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error?.message || `Drive respondió ${res.status}`)
      }
    } catch (err) {
      failed.push({ email, message: err.message || 'no se pudo compartir' })
    }
  }
  return { shared: emails.length - failed.length, failed }
}

// PUT del archivo entero a la sesión resumable, vía https.request (no
// net.fetch) porque fetch no expone progreso de subida — acá se mide leyendo
// el stream de disco a medida que se manda (con backpressure de por medio,
// lo que se lee del disco va prácticamente a la par de lo que sale por la
// red). onProgress se llama solo cuando cambia el % entero, para no saturar
// de broadcasts IPC en archivos grandes.
function putFileToDriveUrl(uploadUrl, filePath, size, mimeType, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, search } = new URL(uploadUrl)
    const req = https.request(
      { hostname, path: pathname + search, method: 'PUT', headers: { 'Content-Type': mimeType, 'Content-Length': size } },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let message = `Drive respondió ${res.statusCode} al subir el archivo`
            try {
              message = JSON.parse(body)?.error?.message || message
            } catch {
              // body no era JSON, se queda el mensaje genérico
            }
            reject(new Error(message))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('Drive devolvió una respuesta inválida al subir el archivo'))
          }
        })
      }
    )
    req.on('error', reject)

    let sent = 0
    let lastPct = -1
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      sent += chunk.length
      const pct = size ? Math.min(100, Math.floor((sent / size) * 100)) : 0
      if (pct !== lastPct) {
        lastPct = pct
        onProgress(pct)
      }
    })
    stream.on('error', reject)

    if (signal) {
      if (signal.aborted) {
        stream.destroy()
        req.destroy()
        reject(new Error('cancelado'))
        return
      }
      signal.addEventListener(
        'abort',
        () => {
          stream.destroy()
          req.destroy(new Error('cancelado'))
        },
        { once: true }
      )
    }

    stream.pipe(req)
  })
}

// El .webm que graba MediaRecorder se va armando a los golpes: cada chunk de
// `recording:append-chunk` se pega tal cual al archivo (ver más abajo,
// "Grabaciones largas"), así que nunca queda un índice de seek (Cues) ni un
// tamaño de Segment conocido — es un contenedor "streaming", pensado para que
// lo reproduzca ese mismo navegador, no para abrirlo en otro reproductor.
// Chromium es permisivo con eso; reproductores de escritorio como VLC no
// tanto — de ahí "se ve distorsionado" y "no puedo moverme en el tiempo" al
// abrir la copia. Y por separado: el reproductor de Google Drive no toca el
// audio Opus de un .webm en absoluto — "sale sin audio".
//
// La solución a las dos cosas es la misma: no repartir el .webm crudo, sino
// remuxarlo (o re-encodear si hace falta) a un .mp4 con audio AAC y
// `+faststart` — un contenedor con índice de verdad, que cualquier
// reproductor sabe recorrer. La usan tanto la subida a Drive como el botón
// "Copiar" (guardar afuera para ver con otro programa).
//
// El video se copia tal cual si YA es H.264 (MediaRecorder lo elige cuando
// la PC tiene encoder por hardware, ver screenRecording.js): eso hace la
// conversión casi instantánea y sin pérdida — igual arregla el contenedor,
// que es lo que hacía falta. Si la grabación salió en VP9 (el fallback de
// MediaRecorder) hay que re-encodear de verdad — un VP9 metido adentro de un
// .mp4 es un archivo válido que ffmpeg arma sin chistar, pero que ni Drive ni
// buena parte de los reproductores de escritorio saben mostrar.
function probeVideoCodec(filePath) {
  return runFfmpegForDuration(['-hide_banner', '-i', filePath], (stderr) => {
    const match = stderr.match(/Stream #\d+:\d+.*: Video: (\w+)/)
    return match ? match[1] : ''
  })
}

async function transcodeForExternalPlayer(sourcePath, onProgress) {
  const outPath = path.join(app.getPath('temp'), `flashlab-mp4-${randomUUID()}.mp4`)
  const tail = ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath]
  const encodeH264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']
  const totalSeconds = await probeMediaDuration(sourcePath).catch(() => 0)
  const codec = await probeVideoCodec(sourcePath)
  const videoArgs = codec === 'h264' ? ['-c:v', 'copy'] : encodeH264
  try {
    await runFfmpeg(['-y', '-i', sourcePath, ...videoArgs, ...tail], { onProgress, totalSeconds })
  } catch (err) {
    if (videoArgs[1] !== 'copy') throw err
    console.log('copiar el video sin re-encodear no funcionó, se encodea a H.264:', err.message)
    await runFfmpeg(['-y', '-i', sourcePath, ...encodeH264, ...tail], { onProgress, totalSeconds })
  }
  return outPath
}

// nombre de grabación -> nombre de archivo: el nombre que se muestra en la
// UI ("Grabación 6/8/2026, 10:53:00 a. m.") tiene "/" y ":" — válidos para
// mostrar, pero "/" es separador de carpetas en una ruta y ":" es inválido en
// Windows. Sin sanitizar, el diálogo "Guardar como" interpreta la fecha como
// subcarpetas inexistentes y termina ofreciendo cualquier cosa menos el
// nombre esperado. Se usa solo al tocar el disco (Guardar como) — el nombre
// que se ve en las listas de grabaciones no cambia.
function sanitizeFilename(name) {
  return String(name ?? '').replace(/[/\\:*?"<>|]/g, '-').trim() || 'Grabación'
}

// Una grabación compartida es SOLO para ver. Compartirla como 'reader' no
// alcanza: por defecto un lector de Drive puede descargar el .webm (y hacer
// una copia editable), así que además se marca el archivo con
// copyRequiresWriterPermission — que en Drive apaga descargar/copiar/imprimir
// para quien no tiene permiso de escritura — y writersCanShare en false, para
// que nadie más que el dueño pueda repartir el acceso.
async function lockDriveFileAsViewOnly(accessToken, fileId, signal) {
  const res = await net.fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=id`, {
    method: 'PATCH',
    signal,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ copyRequiresWriterPermission: true, writersCanShare: false }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message || `Drive respondió ${res.status} al bloquear la descarga`)
  }
}

// baja a 'reader' cualquier permiso de escritura que tenga el archivo (los
// 'owner' quedan como están, son el dueño de la grabación). Sirve para los
// archivos que ya estaban en Drive de antes — los nuevos se comparten
// directamente como lectores.
async function enforceDriveReaderOnly(accessToken, fileId, signal) {
  const res = await net.fetch(
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/permissions?fields=permissions(id,role,type)`,
    { signal, headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message || `Drive respondió ${res.status} al leer los permisos`)
  for (const perm of data.permissions ?? []) {
    if (perm.role === 'owner' || perm.role === 'reader') continue
    const patch = await net.fetch(
      `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(perm.id)}`,
      {
        method: 'PATCH',
        signal,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader' }),
      }
    )
    if (!patch.ok) {
      const body = await patch.json().catch(() => null)
      console.error(
        `no se pudo bajar a solo lectura el permiso ${perm.id} de ${fileId}:`,
        body?.error?.message || patch.status
      )
    }
  }
}

// las grabaciones subidas antes de que existiera driveFileId solo guardaron
// el webViewLink (https://drive.google.com/file/d/<id>/view?…)
function driveFileIdFromEntry(entry) {
  if (entry?.driveFileId) return entry.driveFileId
  const match = String(entry?.driveUrl ?? '').match(/\/d\/([A-Za-z0-9_-]+)/)
  return match ? match[1] : null
}

// Repara de una sola vez las grabaciones que ya estaban en Drive antes de
// esto: las compartidas de antes podían quedar descargables (y por lo tanto
// editables en una copia). Corre una vez por instalación — lo nuevo ya sale
// bloqueado desde uploadRecordingToDrive — y nunca tira: si no hay red o
// Drive no está conectado, se reintenta en el próximo arranque.
const DRIVE_LOCK_PASS_VERSION = 1

async function relockSharedDriveRecordings() {
  const settings = await loadSettings()
  if (settings.driveLockPassVersion >= DRIVE_LOCK_PASS_VERSION) return
  if (!(await loadDriveTokens())) return

  let accessToken
  try {
    accessToken = await ensureDriveAccessToken()
  } catch (err) {
    console.error('no se pudo revisar los permisos de las grabaciones en Drive:', err)
    return
  }

  let files
  try {
    files = await fs.readdir(recordingsDir())
  } catch {
    files = []
  }

  let failed = false
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const stored = await readJsonSafe(path.join(recordingsDir(), file))
    for (const entry of Array.isArray(stored) ? stored : []) {
      if (entry?.driveStatus !== 'done') continue
      const fileId = driveFileIdFromEntry(entry)
      if (!fileId) continue
      try {
        await lockDriveFileAsViewOnly(accessToken, fileId)
        await enforceDriveReaderOnly(accessToken, fileId)
      } catch (err) {
        failed = true
        console.error(`no se pudo dejar en solo lectura la grabación ${fileId} en Drive:`, err)
      }
    }
  }

  // si alguna falló, no se marca la pasada como hecha: se reintenta al
  // próximo arranque (volver a bloquear una ya bloqueada es inofensivo)
  if (!failed) await saveSettings({ driveLockPassVersion: DRIVE_LOCK_PASS_VERSION })
}

// recordingId -> AbortController de la subida en curso — permite cancelarla
// desde 'recording:cancel-drive-upload' (botón "Cancelar" en la UI mientras
// dice "Subiendo…"). También es lo que usa una entry que quedó trabada en
// 'uploading' de una corrida vieja (la app se cerró a mitad de subida, no
// hay ningún AbortController para ese id porque nada hay corriendo ya):
// cancelar ahí no aborta nada real, pero igual limpia el estado para poder
// reintentar — ver el IPC handler.
const activeDriveUploads = new Map()

async function uploadRecordingToDrive(pageId, recordingId, shareEmails) {
  const safeId = requireId(pageId)
  const controller = new AbortController()
  activeDriveUploads.set(recordingId, controller)
  let mp4Path = null
  try {
    await patchRecordingEntry(safeId, recordingId, { driveStatus: 'uploading', driveError: null, driveProgress: 0 })

    const stored = await readJsonSafe(recordingsFile(safeId))
    const list = Array.isArray(stored) ? stored : []
    const entry = list.find((r) => r.id === recordingId)
    if (!entry) throw new Error('grabación no encontrada')
    const filePath = recordingFilePath(entry)

    const accessToken = await ensureDriveAccessToken()
    if (controller.signal.aborted) throw new Error('cancelado')

    // a Drive va un .mp4, no el .webm original (ver transcodeForExternalPlayer)
    await patchRecordingEntry(safeId, recordingId, { driveStatus: 'converting', driveProgress: 0 })
    mp4Path = await transcodeForExternalPlayer(filePath, (ratio) =>
      broadcastRecordingPatch(safeId, recordingId, {
        driveStatus: 'converting',
        driveProgress: Math.round(ratio * 100),
      })
    )
    if (controller.signal.aborted) throw new Error('cancelado')
    const stat = await fs.stat(mp4Path)
    await patchRecordingEntry(safeId, recordingId, { driveStatus: 'uploading', driveProgress: 0 })

    const baseName = (entry.name || 'Grabación').replace(/\.(webm|mp4)$/i, '')
    // Si esta grabación ya estaba en Drive, se reemplaza el CONTENIDO del
    // mismo archivo en vez de subir uno nuevo: conserva el id, el link y los
    // permisos ya repartidos (y no deja un .webm mudo dando vueltas al lado).
    const existingFileId = driveFileIdFromEntry(entry)
    const initRes = existingFileId
      ? await net.fetch(
          `${DRIVE_UPLOAD_URL}/${encodeURIComponent(existingFileId)}?uploadType=resumable&fields=id,webViewLink`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'X-Upload-Content-Type': 'video/mp4',
              'X-Upload-Content-Length': String(stat.size),
            },
            body: JSON.stringify({ name: `${baseName}.mp4` }),
            signal: controller.signal,
          }
        )
      : // subida resumable: primero se declara metadata + tamaño, Google
        // devuelve una URL de sesión (header Location) a la que se manda el
        // archivo entero en un único PUT (no hace falta trocearlo — resumable
        // solo importa para poder retomar si se corta, que acá no implementamos).
        await net.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,webViewLink`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': 'video/mp4',
            'X-Upload-Content-Length': String(stat.size),
          },
          body: JSON.stringify({
            name: `${baseName}.mp4`,
            parents: [await ensureDriveFolderId(accessToken, controller.signal)],
          }),
          signal: controller.signal,
        })
    if (!initRes.ok) {
      const body = await initRes.json().catch(() => null)
      throw new Error(body?.error?.message || `Drive respondió ${initRes.status} al iniciar la subida`)
    }
    const uploadUrl = initRes.headers.get('location')
    if (!uploadUrl) throw new Error('Drive no devolvió una URL de subida')

    const uploaded = await putFileToDriveUrl(
      uploadUrl,
      mp4Path,
      stat.size,
      'video/mp4',
      (pct) => broadcastRecordingPatch(safeId, recordingId, { driveStatus: 'uploading', driveProgress: pct }),
      controller.signal
    )

    // antes de repartir el acceso: el archivo se comparte solo para ver, sin
    // descarga ni copia (ver lockDriveFileAsViewOnly)
    try {
      await lockDriveFileAsViewOnly(accessToken, uploaded.id, controller.signal)
    } catch (err) {
      console.error('no se pudo dejar la grabación en solo lectura en Drive:', err)
    }

    // sendNotificationEmail=false: el permiso queda dado igual (el archivo
    // les aparece en "Compartido conmigo" y el link les abre) — ya aceptaron
    // la invitación a la página, no hace falta un mail más de Drive. Un email
    // que falla (typo, cuenta sin Google, etc.) no debe tirar abajo la
    // subida entera — la grabación ya quedó en Drive igual.
    const { failed: shareFailed } = await shareDriveFileWithEmails(accessToken, uploaded.id, shareEmails, controller.signal)
    for (const { email, message } of shareFailed) {
      console.error(`no se pudo compartir la grabación en Drive con ${email}:`, message)
    }

    await patchRecordingEntry(safeId, recordingId, {
      driveStatus: 'done',
      driveUrl: uploaded.webViewLink,
      driveFileId: uploaded.id,
      driveError: null,
      driveProgress: null,
    })
  } catch (err) {
    if (controller.signal.aborted) {
      // 'recording:cancel-drive-upload' ya dejó la entry limpia — no pisarla
      // acá con un estado de error.
      console.log('subida a Drive cancelada:', recordingId)
      return
    }
    console.error('no se pudo subir la grabación a Drive:', err)
    await patchRecordingEntry(safeId, recordingId, {
      driveStatus: 'error',
      driveError: err.message || 'no se pudo subir a Drive',
      driveProgress: null,
    })
  } finally {
    activeDriveUploads.delete(recordingId)
    // el .mp4 es solo para subir: el original queda intacto en assets/
    if (mp4Path) await fs.rm(mp4Path, { force: true }).catch(() => {})
  }
}

// no se espera la promesa a propósito: el renderer no debe bloquearse
// esperando la subida, el progreso se seguía por los broadcasts de
// 'recordings:updated' de arriba (uploadRecordingToDrive ya atrapa sus
// propios errores, así que no queda una promesa rechazada sin manejar)
ipcMain.handle('recording:upload-to-drive', async (_event, pageId, recordingId, shareEmails) => {
  uploadRecordingToDrive(pageId, recordingId, Array.isArray(shareEmails) ? shareEmails : [])
})

// Vuelve a repartir el acceso de Drive de una grabación YA subida, en
// silencio (sin mail de Drive). Hace falta porque el archivo se comparte una
// sola vez, al terminar la subida, con los emails que estaban compartidos en
// ese momento: quien se sume a la página después no queda con permiso sobre
// el video. Volver a dárselo a alguien que ya lo tiene es inofensivo (Drive
// responde con el permiso existente), así que se puede llamar de más.
ipcMain.handle('recording:share-drive', async (_event, pageId, recordingId, shareEmails) => {
  const safeId = requireId(pageId)
  const stored = await readJsonSafe(recordingsFile(safeId))
  const entry = (Array.isArray(stored) ? stored : []).find((r) => r.id === recordingId)
  if (!entry) throw new Error('grabación no encontrada')
  const fileId = driveFileIdFromEntry(entry)
  if (!fileId) throw new Error('esta grabación todavía no está en Drive')

  const accessToken = await ensureDriveAccessToken()
  // por las dudas: las subidas viejas pueden no tener la descarga bloqueada
  await lockDriveFileAsViewOnly(accessToken, fileId).catch((err) =>
    console.error('no se pudo dejar la grabación en solo lectura en Drive:', err)
  )

  const emails = Array.isArray(shareEmails) ? shareEmails : []
  const { shared, failed } = await shareDriveFileWithEmails(accessToken, fileId, emails)

  // las subidas anteriores a driveFileId solo guardaron el webViewLink
  if (!entry.driveFileId) await patchRecordingEntry(safeId, recordingId, { driveFileId: fileId })
  return { shared, failed }
})

ipcMain.handle('recording:cancel-drive-upload', async (_event, pageId, recordingId) => {
  activeDriveUploads.get(recordingId)?.abort()
  // deja la entry como si nunca se hubiera intentado subir (en vez de
  // 'error') — así el botón "Subir a Drive" vuelve a aparecer en la UI. Pasa
  // igual aunque no hubiera ningún AbortController activo para este id (una
  // entry vieja trabada en 'uploading' de una corrida que ya no existe,
  // p.ej. la app se cerró a mitad de subida) — es la única forma de
  // destrabarla desde la UI.
  await patchRecordingEntry(requireId(pageId), recordingId, {
    driveStatus: null,
    driveError: null,
    driveProgress: null,
  })
})

ipcMain.handle('shell:open-external', async (_event, url) => {
  if (!/^https?:\/\//i.test(String(url ?? ''))) throw new Error('URL inválida')
  await shell.openExternal(url)
})

// ---------- Edición de grabaciones (recortar / reemplazar audio) ----------

const activeFfmpegProcesses = new Set()

// corre ffmpeg y reporta progreso parseando las líneas "time=HH:MM:SS.ss" que
// imprime en stderr, comparadas contra la duración total esperada del output
function runFfmpeg(args, { onProgress, totalSeconds } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    activeFfmpegProcesses.add(child)
    let stderrTail = ''
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-4000)
      const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (match && onProgress && totalSeconds) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
        onProgress(Math.min(1, seconds / totalSeconds))
      }
    })
    child.on('error', (err) => {
      activeFfmpegProcesses.delete(child)
      reject(err)
    })
    child.on('close', (code) => {
      activeFfmpegProcesses.delete(child)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg salió con código ${code}: ${stderrTail.slice(-500)}`))
    })
  })
}

// lógica compartida por recortar/reemplazar audio: genera un archivo nuevo y
// solo si sale bien pisa la metadata y borra el viejo — si algo falla en el
// medio (ffmpeg, cierre de la app, lo que sea) la grabación original queda
// intacta, igual que garantiza writeJsonAtomic para el resto de la metadata
async function replaceRecordingAsset(pageId, recordingId, produceNewFile) {
  const safeId = requireId(pageId)
  const stored = await readJsonSafe(recordingsFile(safeId))
  const list = Array.isArray(stored) ? stored : []
  const entry = list.find((r) => r.id === recordingId)
  if (!entry) throw new Error('grabación no encontrada')
  const match = entry.url.match(/^appasset:\/\/local\/([A-Za-z0-9_-]+\.webm)$/)
  if (!match) throw new Error('grabación inválida')
  const sourcePath = path.join(assetsDir(), match[1])

  const newName = uniqueAssetName('.webm')
  const newPath = path.join(assetsDir(), newName)
  try {
    await produceNewFile(sourcePath, newPath)
  } catch (err) {
    await fs.rm(newPath, { force: true }).catch(() => {})
    throw err
  }

  const newUrl = `appasset://local/${newName}`
  const updatedList = list.map((r) => (r.id === recordingId ? { ...r, url: newUrl } : r))
  await writeJsonAtomic(recordingsFile(safeId), updatedList)
  // la metadata ya apunta al archivo nuevo — si borrar el viejo falla (p.ej.
  // Windows todavía lo tiene abierto desde el <video> que se acaba de
  // cerrar), no hay que tirar abajo una edición que ya terminó bien; el
  // archivo viejo queda huérfano en vez de bloquear/mentir un error
  await fs.rm(sourcePath, { force: true }).catch(() => {})

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('recordings:updated', { pageId: safeId, recordingId, patch: { url: newUrl } })
  }
  return updatedList.find((r) => r.id === recordingId)
}

ipcMain.handle('dialog:pick-audio-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac'] }],
    properties: ['openFile'],
  })
  if (canceled || filePaths.length === 0) return null
  return { path: filePaths[0], name: path.basename(filePaths[0]) }
})

// ffmpeg imprime "Duration: HH:MM:SS.ss" en stderr con solo leer el header
// (sale con código 1 porque no se le pasó ningún output, no importa).
// Medir la duración acá y no en el renderer con un <audio> es a propósito:
// el elemento de audio devuelve 0 en silencio para formatos que Chromium no
// sabe decodificar, y una pista con duración 0 quedaba de ancho cero, muda e
// imposible de estirar (el tope del handle derecho es la duración de origen).
function runFfmpegForDuration(args, extractSeconds) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', () => resolve(0))
    child.on('close', () => resolve(extractSeconds(stderr)))
  })
}

const hms = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s)

function probeMediaDuration(filePath) {
  // 1) el header: instantáneo, y alcanza para cualquier archivo "normal"
  //    (audio importado, o una grabación ya editada — ffmpeg le escribe una
  //    duración real al remuxear).
  return runFfmpegForDuration(['-hide_banner', '-i', filePath], (stderr) => {
    const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
    return match ? hms(match[1], match[2], match[3]) : 0
  }).then((fromHeader) => {
    if (fromHeader > 0) return fromHeader
    // 2) "Duration: N/A" — es el caso de los .webm crudos de MediaRecorder,
    //    escritos en vivo sin saber de antemano cuánto iban a durar. Se
    //    recorren los paquetes SIN decodificarlos (-c copy) y se toma el
    //    timestamp del último: es la duración real. Verificado a ~7700x
    //    tiempo real (una grabación de 2hs se mide en ~1s), así que se puede
    //    hacer sin bloquear nada perceptible.
    return runFfmpegForDuration(['-hide_banner', '-i', filePath, '-c', 'copy', '-f', 'null', '-'], (stderr) => {
      const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)]
      const last = matches.at(-1)
      return last ? hms(last[1], last[2], last[3]) : 0
    })
  })
}

// duración de un asset local ya guardado, a partir de su URL appasset://.
// Mismo criterio (y misma función) que para el audio importado: medirla con
// ffmpeg en vez de con el elemento <video> del renderer. Los .webm que graba
// MediaRecorder no traen la duración en el header, y el workaround del
// renderer (saltar a un currentTime absurdo y esperar 'durationchange') puede
// tardar muchísimo o no disparar nunca en grabaciones largas sin índice de
// búsqueda — dejaba el editor colgado en "Duración 0:00.0" hasta cerrarlo y
// volver a abrirlo. ffmpeg lee el header y contesta al instante.
ipcMain.handle('asset:probe-duration', async (_event, assetUrl) => {
  const match = typeof assetUrl === 'string' && assetUrl.match(/^appasset:\/\/local\/([A-Za-z0-9_-]+\.[a-z0-9]{1,5})$/)
  if (!match) return 0
  return probeMediaDuration(path.join(assetsDir(), match[1]))
})

// copia un audio elegido por el usuario a assetsDir() — el renderer no puede
// leer paths arbitrarios del filesystem (contextIsolation), así que en vez de
// mandar los bytes por IPC (grande, lento) se copia una vez acá y de ahí en
// más se usa como cualquier otro asset (appasset:// para decodeAudioData en
// el renderer, path absoluto para pasarle a ffmpeg al aplicar la mezcla)
ipcMain.handle('asset:import-audio', async (_event, sourcePath) => {
  if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('archivo de audio inválido')
  await fs.mkdir(assetsDir(), { recursive: true })
  const name = uniqueAssetName(path.extname(sourcePath) || '.mp3')
  const destPath = path.join(assetsDir(), name)
  await fs.copyFile(sourcePath, destPath)
  const duration = await probeMediaDuration(destPath)
  return { path: destPath, url: `appasset://local/${name}`, name: path.basename(sourcePath), duration }
})

ipcMain.handle('recording:trim', async (event, pageId, recordingId, { start, end }) => {
  const duration = end - start
  return replaceRecordingAsset(pageId, recordingId, (sourcePath, newPath) =>
    runFfmpeg(
      [
        '-ss', String(start), '-i', sourcePath, '-t', String(duration),
        '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-deadline', 'good', '-cpu-used', '4',
        '-c:a', 'libopus', '-b:a', '128k',
        '-avoid_negative_ts', 'make_zero', '-y', newPath,
      ],
      {
        totalSeconds: duration,
        onProgress: (pct) => event.sender.send('recording:edit-progress', { recordingId, step: 'trim', pct }),
      }
    )
  )
})

ipcMain.handle('recording:remove-audio', async (event, pageId, recordingId, { sourceDurationSeconds } = {}) => {
  return replaceRecordingAsset(pageId, recordingId, (sourcePath, newPath) =>
    runFfmpeg(['-i', sourcePath, '-map', '0:v:0', '-c:v', 'copy', '-an', '-y', newPath], {
      totalSeconds: sourceDurationSeconds,
      onProgress: (pct) => event.sender.send('recording:edit-progress', { recordingId, step: 'audio', pct }),
    })
  )
})

ipcMain.handle('recording:replace-audio', async (event, pageId, recordingId, { audioPath, sourceDurationSeconds }) => {
  if (typeof audioPath !== 'string' || !audioPath) throw new Error('archivo de audio inválido')
  return replaceRecordingAsset(pageId, recordingId, (sourcePath, newPath) =>
    runFfmpeg(
      [
        '-i', sourcePath, '-i', audioPath,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-af', 'apad', '-c:a', 'libopus', '-b:a', '128k', '-shortest',
        '-y', newPath,
      ],
      {
        totalSeconds: sourceDurationSeconds,
        onProgress: (pct) => event.sender.send('recording:edit-progress', { recordingId, step: 'audio', pct }),
      }
    )
  )
})

// construye el grafo de filtros de audio para mezclar la pista original (si
// no está muteada) con las pistas activas agregadas por el usuario (ya
// filtradas: nunca incluye pistas muteadas — ver buildMixArgs), cada una
// recortada a su propio in/out y desplazada a su posición en el timeline de
// salida. normalize=0 en amix es a propósito: el default de amix divide el
// volumen por la cantidad de inputs, lo que pisaría en silencio el volumen
// que el usuario ya configuró por pista cada vez que agrega una más.
function buildMixFilterComplex({ original, activeTracks }) {
  const parts = []
  const labels = []
  if (!original.muted) {
    parts.push(original.volume !== 1 ? `[0:a]volume=${original.volume}[a0]` : `[0:a]anull[a0]`)
    labels.push('[a0]')
  }
  activeTracks.forEach((t, i) => {
    const idx = i + 1
    const label = `a${idx}`
    const vol = t.volume !== 1 ? `,volume=${t.volume}` : ''
    // all=1: los archivos externos suelen ser mono, y adelay tira error si la
    // cantidad de delays no coincide con la cantidad de canales de la fuente
    parts.push(
      `[${idx}:a]atrim=${t.inPoint}:${t.outPoint},asetpts=PTS-STARTPTS,adelay=${Math.round(t.offset * 1000)}:all=1${vol}[${label}]`
    )
    labels.push(`[${label}]`)
  })
  if (labels.length === 0) return null
  if (labels.length === 1) return { filter: parts.join(';'), outLabel: labels[0] }
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[aout]`)
  return { filter: parts.join(';'), outLabel: '[aout]' }
}

// recorte + mezcla en un solo pase de ffmpeg — los offsets de las pistas ya
// están definidos sobre el timeline de SALIDA (post-recorte, ver
// AudioTimeline.jsx), así que -ss en el input 0 alcanza sin traducir nada.
// -t al final garantiza que la salida nunca exceda la duración del video
// recortado, la misma regla de "el video manda" que ya usan replace-audio y
// remove-audio, generalizada a N pistas.
//
// las pistas muteadas ni siquiera se abren como -i: si se incluyeran (aunque
// sea para descartarlas en el filtro) y ese archivo estuviera roto/movido,
// ffmpeg fallaría igual al abrir el input — mutear una pista debe volverla
// invisible para toda la operación, no solo para la mezcla final.
function buildMixArgs(sourcePath, trimStart, trimEnd, tracks, originalTrack, newPath) {
  const videoLen = trimEnd - trimStart
  const activeTracks = tracks.filter((t) => !t.muted)
  const args = ['-ss', String(trimStart), '-i', sourcePath]
  for (const t of activeTracks) args.push('-i', t.path)
  const mix = buildMixFilterComplex({ original: originalTrack, activeTracks })
  if (mix) args.push('-filter_complex', mix.filter, '-map', '0:v:0', '-map', mix.outLabel)
  else args.push('-map', '0:v:0', '-an')
  args.push(
    '-t', String(videoLen),
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-deadline', 'good', '-cpu-used', '4'
  )
  if (mix) args.push('-c:a', 'libopus', '-b:a', '128k')
  args.push('-avoid_negative_ts', 'make_zero', '-y', newPath)
  return args
}

function coerceNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

// valida/normaliza lo que llega por IPC antes de meterlo en argv/filter_complex
// — el renderer es código propio (no hay riesgo de inyección de shell, spawn
// recibe argv separados), pero un valor no numérico igual rompería el grafo
// de filtros con un mensaje de ffmpeg críptico en vez de fallar claro acá.
ipcMain.handle('recording:apply-edits', async (event, pageId, recordingId, { trim, originalTrack, tracks }) => {
  const safeTrim = { start: coerceNumber(trim?.start, 0), end: coerceNumber(trim?.end, 0) }
  if (safeTrim.end <= safeTrim.start) throw new Error('rango de recorte inválido')
  const safeOriginal = { volume: coerceNumber(originalTrack?.volume, 1), muted: Boolean(originalTrack?.muted) }
  const safeTracks = (Array.isArray(tracks) ? tracks : [])
    .filter((t) => typeof t?.path === 'string' && t.path)
    .map((t) => ({
      path: t.path,
      inPoint: coerceNumber(t.inPoint, 0),
      outPoint: coerceNumber(t.outPoint, 0),
      offset: Math.max(0, coerceNumber(t.offset, 0)),
      volume: coerceNumber(t.volume, 1),
      muted: Boolean(t.muted),
    }))
    .filter((t) => t.outPoint > t.inPoint)
  return replaceRecordingAsset(pageId, recordingId, (sourcePath, newPath) =>
    runFfmpeg(buildMixArgs(sourcePath, safeTrim.start, safeTrim.end, safeTracks, safeOriginal, newPath), {
      totalSeconds: safeTrim.end - safeTrim.start,
      onProgress: (pct) => event.sender.send('recording:edit-progress', { recordingId, step: 'mix', pct }),
    })
  )
})

// Grabaciones largas (hasta varias horas): en vez de acumular todo en RAM del
// renderer y volcarlo al final, cada chunk del MediaRecorder (con timeslice)
// se va agregando al archivo en disco a medida que llega. Los chunks de un
// mismo archivo se encolan (mismo motivo que indexQueue/withIndex): dos
// fs.appendFile concurrentes sobre el mismo archivo podrían escribirse
// entreverados.
const recordingWriteQueues = new Map()

ipcMain.handle('recording:begin', () => uniqueAssetName('.webm'))

ipcMain.handle('recording:append-chunk', async (_event, filename, bytes) => {
  if (!/^[A-Za-z0-9_-]+\.webm$/.test(filename)) throw new Error('nombre de archivo de grabación inválido')
  const buffer = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)
  await fs.mkdir(assetsDir(), { recursive: true })
  const prev = recordingWriteQueues.get(filename) ?? Promise.resolve()
  const next = prev.then(() => fs.appendFile(path.join(assetsDir(), filename), buffer))
  recordingWriteQueues.set(filename, next.catch(() => {}))
  await next
})

ipcMain.handle('recording:finish', async (_event, filename) => {
  await (recordingWriteQueues.get(filename) ?? Promise.resolve())
  recordingWriteQueues.delete(filename)
  return `appasset://local/${filename}`
})

// ---------- Exportar / Importar ----------

ipcMain.handle('export:save', async (_event, content, suggestedName, filter) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [filter, { name: 'Todos los archivos', extensions: ['*'] }],
  })
  if (canceled || !filePath) return { saved: false }
  await fs.writeFile(filePath, content, 'utf8')
  return { saved: true, filePath }
})

// descarga un adjunto de chat (Supabase Storage) al disco vía diálogo nativo
// "Guardar como" — así un adjunto ya no abre una ventana nueva del navegador,
// se comporta como una descarga real.
ipcMain.handle('files:download-url', async (_event, sourceUrl, suggestedName) => {
  if (typeof sourceUrl !== 'string' || !/^https?:\/\//.test(sourceUrl)) {
    throw new Error('URL de archivo inválida')
  }
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: suggestedName || 'archivo',
  })
  if (canceled || !filePath) return { saved: false }
  const response = await net.fetch(sourceUrl)
  if (!response.ok) throw new Error(`no se pudo descargar el archivo (${response.status})`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(filePath, buffer)
  return { saved: true, filePath }
})

ipcMain.handle('import:markdown-pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    properties: ['openFile'],
  })
  if (canceled || filePaths.length === 0) return null
  const content = await fs.readFile(filePaths[0], 'utf8')
  const name = path.basename(filePaths[0]).replace(/\.[^.]+$/, '')
  return { content, name }
})

// ---------- Ventana ----------

// solo restaura una posición guardada si sigue cayendo dentro de algún
// monitor conectado (evita una ventana fuera de pantalla tras desconectar uno)
function clampBoundsToDisplay(bounds) {
  if (!bounds || typeof bounds.width !== 'number') return null
  const fits = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return bounds.x >= a.x - 50 && bounds.y >= a.y - 50 && bounds.x < a.x + a.width && bounds.y < a.y + a.height
  })
  return fits ? bounds : null
}

function buildAppMenu(win) {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Nueva página', accelerator: 'CmdOrCtrl+N', click: () => win.webContents.send('menu:new-page') },
        { label: 'Guardar', accelerator: 'CmdOrCtrl+S', click: () => win.webContents.send('menu:save') },
        { type: 'separator' },
        { label: 'Exportar a Markdown…', click: () => win.webContents.send('menu:export-markdown') },
        { label: 'Exportar a HTML…', click: () => win.webContents.send('menu:export-html') },
        { label: 'Importar Markdown…', click: () => win.webContents.send('menu:import-markdown') },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Cerrar ventana' } : { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Edición',
      submenu: [
        { label: 'Deshacer', role: 'undo' },
        { label: 'Rehacer', role: 'redo' },
        { type: 'separator' },
        { label: 'Cortar', role: 'cut' },
        { label: 'Copiar', role: 'copy' },
        { label: 'Pegar', role: 'paste' },
        { label: 'Seleccionar todo', role: 'selectAll' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        {
          label: 'Tema',
          submenu: [
            { label: 'Sistema', click: () => setThemeSource('system') },
            { label: 'Claro', click: () => setThemeSource('light') },
            { label: 'Oscuro', click: () => setThemeSource('dark') },
          ],
        },
        {
          label: 'Mostrar barra de menú',
          type: 'checkbox',
          checked: Boolean(settingsCache?.menuBarVisible),
          // Alt la muestra igual aunque esté destildado (autoHideMenuBar) —
          // esto es para dejarla fija en vez de tener que apretar Alt cada vez.
          click: (menuItem) => setMenuBarVisible(win, menuItem.checked),
        },
        { type: 'separator' },
        ...(isDev
          ? [
              { label: 'Recargar', role: 'reload' },
              { label: 'Herramientas de desarrollador', role: 'toggleDevTools' },
              { type: 'separator' },
            ]
          : []),
        { label: 'Pantalla completa', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [{ label: 'Buscar actualizaciones', click: () => checkForUpdatesManually(win) }],
    },
  ]
  return Menu.buildFromTemplate(template)
}

// a diferencia del chequeo silencioso de fondo (setupAutoUpdater, cada 4hs),
// este lo dispara el usuario a propósito desde el menú — así que sí o sí
// tiene que darle una respuesta visible, sea cual sea el resultado (ya
// estás al día / se está descargando / hubo un error), no quedarse mudo
// como el automático.
let manualUpdateCheckInProgress = false
// versión que electron-updater ya terminó de bajar en segundo plano y está
// esperando el reinicio. Con esto seteado, "Buscar actualizaciones" ofrece
// instalarla en vez de arrancar otro chequeo/descarga sobre lo mismo.
let downloadedUpdateVersion = null

// Este chequeo falla de forma INTERMITENTE en máquinas con un antivirus que
// filtra HTTPS (ESET, reportado 2026-08-12 con
// net::ERR_HTTP2_SERVER_REFUSED_STREAM — el prefijo net:: delata que viene
// del stack de red de Chromium, justo el que el filtro intercepta). Que la
// descarga en segundo plano SÍ funcione en la misma máquina confirma que es
// intermitente y no una falla real de conectividad, así que tirarle un
// cartel de error al usuario en el primer tropiezo es peor que reintentar.
//
// A propósito, esto reintenta SOLO LA CONSULTA: no toca la descarga, ni
// quitAndInstall, ni el instalador NSIS — o sea, nada del camino que ya
// costó siete rondas dejar estable (ver [[notion-clone-no-break-install-flow]]).
const MANUAL_UPDATE_ATTEMPTS = 3
const MANUAL_UPDATE_RETRY_MS = 1500

// Último recurso cuando electron-updater falla: preguntarle al feed público
// de GitHub Releases directo (el MISMO que consume el updater, sin su
// maquinaria de descarga/firma en el medio). No instala nada — solo puede
// decir si hay algo más nuevo y abrir la página para bajar el instalador a
// mano. Existe para que "Buscar actualizaciones" nunca sea un callejón sin
// salida: antes, cualquier error del updater dejaba al usuario con un cartel
// rojo y ninguna acción posible.
async function fetchLatestPublishedRelease() {
  const { owner, repo } = { owner: 'edwardgko', repo: 'flashlab-releases' }
  const response = await net.fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub respondió ${response.status}`)
  const data = await response.json()
  return { version: String(data.tag_name || '').replace(/^v/, ''), url: data.html_url }
}

// compara "0.1.66" contra "0.1.9" sin depender del orden alfabético (que
// diría que 0.1.9 es mayor que 0.1.66)
function isNewerVersion(candidate, current) {
  const parse = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

async function offerManualDownload(win, detail) {
  let latest = null
  try {
    latest = await fetchLatestPublishedRelease()
  } catch (err) {
    detail = `${detail}\nTampoco se pudo consultar GitHub: ${err?.message || err}`
  }
  if (win.isDestroyed()) return
  if (latest && !isNewerVersion(latest.version, app.getVersion())) {
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Actualizaciones de FlashLab',
      message: 'Ya contás con la última versión de FlashLab instalada.',
      detail: `La actualización automática no pudo verificarlo por su cuenta, pero la última versión publicada es la ${latest.version} y es la que tenés.\n\nDetalle técnico: ${detail}`,
    })
    return
  }
  const { response } = await dialog.showMessageBox(win, {
    type: latest ? 'info' : 'error',
    title: 'Actualizaciones de FlashLab',
    message: latest
      ? `Hay una nueva versión disponible (${latest.version}), pero la actualización automática falló.`
      : 'No se pudieron buscar actualizaciones.',
    detail: latest
      ? `Podés bajar el instalador a mano desde la página de la versión. Se instala encima de la actual, no hace falta desinstalar nada.\n\nDetalle técnico: ${detail}`
      : `Las actualizaciones automáticas en segundo plano siguen intentándolo por su cuenta.\n\nDetalle técnico: ${detail}`,
    buttons: latest ? ['Abrir la página de descarga', 'Ahora no'] : ['Entendido'],
    defaultId: 0,
    cancelId: latest ? 1 : 0,
  })
  if (latest && response === 0) await shell.openExternal(latest.url)
}

function checkForUpdatesManually(win, attempt = 1) {
  if (!app.isPackaged) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Actualizaciones de FlashLab',
      message: 'Las actualizaciones automáticas están disponibles únicamente en la versión instalada de FlashLab.',
    })
    return
  }
  // Si el chequeo de fondo (setupAutoUpdater, cada 4hs) ya bajó la
  // actualización, volver a llamar a checkForUpdates() acá la haría entrar
  // OTRA VEZ al camino de descarga sobre un archivo que ya está en disco —
  // ruido innecesario, y una de las formas de que este menú termine en un
  // error en vez de en la acción obvia. Lo obvio es ofrecer instalarla.
  if (attempt === 1 && downloadedUpdateVersion) {
    dialog
      .showMessageBox(win, {
        type: 'info',
        title: 'Actualizaciones de FlashLab',
        message: `La versión ${downloadedUpdateVersion} ya está descargada y lista para instalar.`,
        detail: 'FlashLab se va a cerrar y volver a abrir para completar la instalación.',
        buttons: ['Instalar ahora', 'Más tarde'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) triggerQuitAndInstall()
      })
    return
  }
  // el candado se toma en el primer intento y se suelta recién con el
  // resultado FINAL — si no, un reintento se vería a sí mismo como "ya hay
  // un chequeo en curso" y cortaría la cadena en seco.
  if (attempt === 1) {
    if (manualUpdateCheckInProgress) return
    manualUpdateCheckInProgress = true
  }

  // autoUpdater avisa del error por partida doble (evento 'error' Y promesa
  // rechazada), así que sin este flag un solo fallo dispararía dos veces el
  // manejador — dos carteles, o peor, dos reintentos en paralelo.
  let settled = false
  const cleanup = () => {
    autoUpdater.removeListener('update-available', onAvailable)
    autoUpdater.removeListener('update-not-available', onNotAvailable)
    autoUpdater.removeListener('error', onError)
  }
  const showResult = (options) => {
    if (win.isDestroyed()) return
    dialog.showMessageBox(win, { title: 'Actualizaciones de FlashLab', ...options })
  }
  const finish = (build) => (arg) => {
    if (settled) return
    settled = true
    cleanup()
    manualUpdateCheckInProgress = false
    showResult(build(arg))
  }
  const onAvailable = finish((info) => ({
    type: 'info',
    message: `Hay una nueva versión disponible (${info.version}). Se está descargando en segundo plano y te avisaremos en cuanto esté lista para instalar.`,
  }))
  const onNotAvailable = finish(() => ({
    type: 'info',
    message: 'Ya contás con la última versión de FlashLab instalada.',
  }))
  const onError = (err) => {
    if (settled) return
    settled = true
    cleanup()
    // el código (ERR_UPDATER_*, ENOENT, ECONNRESET…) es lo único que
    // distingue una causa de otra cuando esto se reporta desde otra máquina;
    // el mensaje solo, sin él, no alcanzó para diagnosticar el error de
    // v0.1.65.
    console.error('[autoUpdater] chequeo manual falló:', err?.code || '(sin código)', err?.message || err)
    if (attempt < MANUAL_UPDATE_ATTEMPTS) {
      setTimeout(() => checkForUpdatesManually(win, attempt + 1), MANUAL_UPDATE_RETRY_MS)
      return
    }
    manualUpdateCheckInProgress = false
    // en vez de un cartel rojo sin salida, se pregunta directo al feed de
    // GitHub y se ofrece la descarga a mano si de verdad hay algo nuevo
    offerManualDownload(win, `${err?.code ? `${err.code}: ` : ''}${err?.message || err}`).catch((dialogErr) =>
      console.error('[autoUpdater] no se pudo mostrar el fallback:', dialogErr)
    )
  }
  autoUpdater.once('update-available', onAvailable)
  autoUpdater.once('update-not-available', onNotAvailable)
  autoUpdater.once('error', onError)
  autoUpdater.checkForUpdates().catch(onError)
}

async function setThemeSource(source) {
  nativeTheme.themeSource = source
  await saveSettings({ themeSource: source })
}

function setMenuBarVisible(win, visible) {
  win.setMenuBarVisibility(visible)
  win.autoHideMenuBar = !visible
  saveSettings({ menuBarVisible: visible })
}

let tray = null
let isQuitting = false
// autoUpdater.quitAndInstall() spawna el instalador ANTES de que app.quit()
// termine de correr (ver BaseUpdater.js: install() dispara el .exe y recién
// después, en un setImmediate, llama a this.app.quit()) — el instalador
// arranca a chequear "¿sigue corriendo FlashLab?" mientras la app todavía
// está 100% viva, y solo tiene un puñado de segundos de reintentos antes de
// darse por vencido y mostrarle al usuario "No se puede cerrar FlashLab.
// Cerrala manualmente y hacé clic en reintentar" (visto dos veces
// seguidas, v0.1.33 y v0.1.34 — confirmado con Get-Process en la máquina
// real que la app YA NO estaba corriendo para cuando apareció ese cartel,
// o sea que cerró bien pero tarde). El cierre en dos tiempos de abajo
// (esperar hasta 2s a que el renderer confirme que vació el autosave) le
// come presupuesto a esa carrera para nada — en el camino de actualización
// no hace falta esa cortesía, más vale cerrar ya.
let updateInstallPending = false

// bandeja del sistema: cerrar la ventana (la X) la oculta en vez de matar el
// proceso, como Notion — el ícono de bandeja la vuelve a mostrar. "Salir" de
// verdad (menú Archivo, o el menú de la propia bandeja) es lo único que cierra
// todo, vía app.quit()/before-quit (ver isQuitting más abajo).
function createTray(win) {
  if (tray) return
  // 16x16 (el tamaño "clásico" de bandeja) pierde el rayo del logo por
  // completo, no importa la calidad del resize ni si se parte del .ico o
  // del .png — probado lado a lado con un repro aislado: a 16px queda un
  // blob dorado sin forma reconocible, a 32px el hexágono+rayo se ve
  // nítido. Se parte del .png maestro (2048x2048, sin las capas ya
  // pre-reducidas del .ico) con resize de mejor calidad.
  const iconPath = path.join(__dirname, '../build/icon.png')
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32, quality: 'best' })
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('FlashLab')
  const showWindow = () => {
    win.show()
    win.focus()
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir FlashLab', click: showWindow },
      { type: 'separator' },
      { label: 'Salir', click: () => app.quit() },
    ])
  )
  tray.on('click', showWindow)
}

function createWindow(initialBounds) {
  const bounds = clampBoundsToDisplay(initialBounds) ?? { width: 1280, height: 820 }
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    // sin esto, Electron en Windows usa su propio ícono genérico para la
    // ventana (barra de tareas, Alt+Tab) en vez del nuestro — el .ico del
    // exe (win.icon en package.json) solo cubre el ícono del ARCHIVO en el
    // Explorador, no el de la ventana en tiempo de ejecución, son cosas
    // separadas. El .ico multi-resolución (16/32/48/256, ver [[notion-clone-tray-icon-16px-blur]])
    // le sirve bien acá porque Windows elige el tamaño según el contexto —
    // a diferencia de la bandeja, que exige un bitmap único ya resuelto.
    icon: path.join(__dirname, '../build/icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff',
    autoHideMenuBar: !settingsCache?.menuBarVisible,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // habilita el visor de PDF nativo de Chromium para el <iframe> de
      // vista previa de adjuntos del chat (ver ChatView.jsx) — sin esto un
      // iframe apuntando a un PDF queda en blanco.
      plugins: true,
      // default true = Chromium empieza a clampear/pausar timers (setInterval,
      // setTimeout, rAF) cuando la ventana está minimizada u oculta en bandeja.
      // El realtime de Supabase (heartbeat + reconexión del WebSocket, ambos
      // corren sobre setInterval/setTimeout en @supabase/realtime-js) se ve
      // afectado por eso — el socket puede terminar cayéndose y no reconectar
      // a tiempo, así que ni las notificaciones de chat ni el contador de no
      // leídos se actualizan mientras la ventana no está visible. Con esto en
      // false esos timers siguen corriendo a tiempo real en segundo plano.
      backgroundThrottling: false,
    },
  })
  if (settingsCache?.menuBarVisible) win.setMenuBarVisibility(true)

  Menu.setApplicationMenu(buildAppMenu(win))
  createTray(win)

  // clic en una notificación de escritorio del chat: traer la ventana al
  // frente (si estaba minimizada u oculta en bandeja, win.focus() solo no alcanza)
  ipcMain.handle('app:focus', () => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  // Windows no tiene un equivalente al setBadge de macOS (texto en el ícono
  // del dock) — el análogo es setOverlayIcon sobre el ícono de la barra de
  // tareas, pero solo acepta una IMAGEN, no un número: el número hay que
  // dibujarlo nosotros. dataUrl ya viene renderizado (canvas) desde el
  // renderer (ver src/lib/desktopNotify.js); acá solo se decodifica y se
  // aplica. null limpia el overlay (0 mensajes sin leer).
  ipcMain.handle('app:set-unread-badge', (_event, dataUrl, count) => {
    if (process.platform !== 'win32') return
    if (!dataUrl) {
      win.setOverlayIcon(null, '')
      return
    }
    win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), `${count} mensajes sin leer`)
  })

  ipcMain.handle('app:get-version', () => app.getVersion())

  // menú contextual (cortar/copiar/pegar) — Chromium no lo da gratis en Electron
  win.webContents.on('context-menu', (_event, params) => {
    const template = []
    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length > 0) {
        template.push(
          ...params.dictionarySuggestions.map((suggestion) => ({
            label: suggestion,
            click: () => win.webContents.replaceMisspelling(suggestion),
          }))
        )
      } else {
        template.push({ label: 'Sin sugerencias', enabled: false })
      }
      template.push(
        { type: 'separator' },
        {
          label: `Agregar "${params.misspelledWord}" al diccionario`,
          click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      template.push(
        { label: 'Cortar', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copiar', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Pegar', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Seleccionar todo', role: 'selectAll', enabled: params.editFlags.canSelectAll }
      )
    } else if (params.selectionText) {
      template.push({ label: 'Copiar', role: 'copy' })
    }
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win })
  })

  // persistir tamaño/posición con debounce; no en cada pixel de arrastre
  let boundsTimer = null
  const persistBounds = () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => saveSettings({ windowBounds: win.getBounds() }), 400)
  }
  win.on('resize', persistBounds)
  win.on('move', persistBounds)

  // Cierre en dos tiempos: el renderer vacía el autosave pendiente y
  // confirma; si no responde en 2 s, se fuerza el cierre igualmente.
  let closeConfirmed = false
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
      return
    }
    if (closeConfirmed) return
    if (updateInstallPending) {
      // ver comentario en la declaración de updateInstallPending: acá no se
      // negocia con el renderer, se corta directo — el instalador del
      // update ya está corriendo y contando los segundos.
      closeConfirmed = true
      win.destroy()
      return
    }
    event.preventDefault()

    const onReady = () => {
      clearTimeout(fallback)
      closeConfirmed = true
      win.close()
    }
    const fallback = setTimeout(() => {
      ipcMain.removeListener('app:close-ready', onReady)
      closeConfirmed = true
      win.destroy()
    }, 2000)

    ipcMain.once('app:close-ready', onReady)
    win.webContents.send('app:before-close')
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  return win
}

// Migración de rebranding "Notion Clone" -> "FlashLab": app.getPath('userData')
// depende del productName (%APPDATA%\<productName>), así que renombrar la app
// sin esto dejaría las páginas/config viejas en una carpeta a la que ya nadie
// apunta. Se ejecuta una sola vez: si la carpeta nueva no existe pero la
// vieja sí, se renombra; en cualquier otro caso no hace nada.
// mueve archivo por archivo (nunca la carpeta contenedora entera: si el
// directorio destino ya existe —como pasa con newDir, ver más abajo—
// fs.rename(carpeta, carpeta) tira EPERM en Windows) con reintentos, mismo
// motivo que writeJsonAtomic: un antivirus escaneando puede tener el archivo
// bloqueado un instante.
async function moveEntry(oldPath, newPath, attempts = 4) {
  const stat = await fs.stat(oldPath).catch(() => null)
  if (!stat) return
  if (stat.isDirectory()) {
    await fs.mkdir(newPath, { recursive: true })
    const files = await fs.readdir(oldPath)
    for (const file of files) {
      await moveEntry(path.join(oldPath, file), path.join(newPath, file), attempts)
    }
    return
  }
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(oldPath, newPath)
      return
    } catch (err) {
      if (i === attempts - 1) throw err
      await delay(300)
    }
  }
}

async function migrateUserDataFolder() {
  const oldDir = path.join(app.getPath('appData'), 'Notion Clone')
  const newDir = app.getPath('userData')
  // Ojo: la carpeta newDir ya existe para cuando esto corre (Electron/Chromium
  // se crea ahí su propia caché — Cache, GPUCache, Local State, etc. — antes
  // de que whenReady() dispare), así que comprobar solo si el directorio
  // existe no sirve: hay que mirar si HAY DATOS NUESTROS (index.json).
  try {
    await fs.access(path.join(newDir, 'index.json'))
    return // ya hay datos reales acá, no hay nada que migrar
  } catch {
    // seguir e intentar migrar
  }
  try {
    await fs.access(path.join(oldDir, 'index.json'))
  } catch {
    return // tampoco había una instalación previa con datos reales
  }
  await fs.mkdir(newDir, { recursive: true })
  for (const entry of ['index.json', 'settings.json', 'calendar-auth.enc', 'pages', 'assets', 'recordings']) {
    try {
      await moveEntry(path.join(oldDir, entry), path.join(newDir, entry))
    } catch (err) {
      console.error(`[migración] no se pudo mover ${entry}:`, err)
    }
  }
  console.log('[migración] datos de Notion Clone movidos a', newDir)
}

const MIME_BY_EXT = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
}

// Sirve los assets locales CON soporte real de rangos de bytes (206).
//
// Antes esto era un net.fetch() a un file:// — que siempre responde 200 con
// el archivo entero e ignora cualquier header Range que se le pase. Sin un
// 206 y sin 'Accept-Ranges', Chromium marca el medio como no-buscable:
// video.seekable queda en [0, 0] y TODA asignación a video.currentTime se
// descarta en silencio. Por eso arrastrar los handles de recorte no movía el
// cuadro mostrado (el preview quedaba "pegado" y no encajaba con el rango) y
// el play tampoco podía arrancar en el punto de inicio. Verificado con el
// mismo .webm servido de las dos formas: sin rangos seekable=[0,0] y
// currentTime vuelve a 0; con rangos seekable=[0, duración] y el seek cae
// exacto donde se pidió.
async function handleAssetRequest(request) {
  const url = new URL(request.url)
  const filename = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (!/^[A-Za-z0-9_-]+\.[a-z0-9]{1,5}$/.test(filename)) {
    return new Response('nombre de archivo inválido', { status: 400 })
  }
  const filePath = path.join(assetsDir(), filename)
  let total
  try {
    total = (await fs.stat(filePath)).size
  } catch {
    return new Response('asset no encontrado', { status: 404 })
  }
  const contentType = MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'
  const asBody = (stream) => Readable.toWeb(stream)

  // Cache-Control: no-store — un video editado (recortado/con audio
  // reemplazado) sale con nombre nuevo (ver replaceRecordingAsset), pero si
  // se reabre el mismo archivo sin editar nada, Chromium puede quedarse con
  // una respuesta 206 vieja cacheada para esa URL y servir un rango
  // desactualizado o incompleto la vez siguiente — un asset local en disco
  // no necesita ningún cacheo HTTP, siempre es más rápido leerlo de nuevo.
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get('Range') ?? '').trim())
  if (!rangeMatch || total === 0) {
    return new Response(asBody(createReadStream(filePath)), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    })
  }

  // "bytes=-500" (sufijo) pide los ÚLTIMOS 500 bytes, no desde el 0 — es
  // justo lo que usa Chromium para leer la cola de un webm, así que tratarlo
  // como un rango normal devolvería el pedazo equivocado.
  const [, rawStart, rawEnd] = rangeMatch
  let start
  let end
  if (rawStart === '') {
    const suffixLength = rawEnd === '' ? 0 : Number(rawEnd)
    start = Math.max(0, total - suffixLength)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
  }

  return new Response(asBody(createReadStream(filePath, { start, end })), {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  })
}

// driveasset://file/{fileId} — reproducir inline (video/audio/imagen) un
// adjunto de chat que está en Drive. Solo funciona para archivos que esta
// cuenta subió: con el scope drive.file, el token propio no tiene forma de
// leer bytes de un archivo ajeno aunque esté compartido como reader (eso
// solo se puede ver abriendo el webViewLink en el navegador, con la sesión
// de Google de cada uno — ver AttachmentContent en ChatView.jsx, que por
// eso separa "es mío" de "es de otro remitente"). Pasa el header Range tal
// cual a Drive y devuelve la respuesta 206 que da Drive — así Chromium
// puede hacer seek en el video sin bajarlo entero.
// tamaño/mime reales de un archivo de Drive — se cachean un rato porque
// Chromium puede pedir varios Range distintos seguidos al hacer seek, y el
// tamaño de un archivo ya subido no cambia.
const driveAssetMetaCache = new Map() // fileId -> { size, mimeType, expiry }
const DRIVE_ASSET_META_TTL_MS = 5 * 60 * 1000

async function getDriveAssetMeta(accessToken, fileId) {
  const cached = driveAssetMetaCache.get(fileId)
  if (cached && cached.expiry > Date.now()) return cached
  const res = await net.fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=size,mimeType`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`no se pudo leer metadata del archivo de Drive (${res.status})`)
  const data = await res.json()
  const meta = {
    size: Number(data.size),
    mimeType: data.mimeType || 'application/octet-stream',
    expiry: Date.now() + DRIVE_ASSET_META_TTL_MS,
  }
  driveAssetMetaCache.set(fileId, meta)
  return meta
}

// recorta un stream a [start, end] sin bufferear el archivo entero — se usa
// cuando Drive ignora el header Range y manda el archivo completo (ver más
// abajo por qué eso importa).
function sliceWebStream(source, start, end) {
  const reader = source.getReader()
  const wanted = end - start + 1
  let skipped = 0
  let sent = 0
  return new ReadableStream({
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

async function handleDriveAssetRequest(request) {
  const url = new URL(request.url)
  const fileId = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) {
    return new Response('id de archivo inválido', { status: 400 })
  }

  let accessToken
  try {
    accessToken = await ensureDriveAccessToken()
  } catch {
    return new Response('Drive no está conectado', { status: 401 })
  }

  // el tamaño real SIEMPRE sale de acá, nunca de confiar en los headers
  // crudos que devuelva Drive en el propio pedido de archivo — en un GET
  // sin Range a un archivo grande, Drive puede responder con
  // Transfer-Encoding chunked (sin Content-Length), y sin el tamaño total
  // posta Chromium no calcula bien la duración ni deja hacer seek.
  let meta
  try {
    meta = await getDriveAssetMeta(accessToken, fileId)
  } catch (err) {
    return new Response(err.message, { status: 502 })
  }
  const total = meta.size
  const mediaUrl = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`
  // un fileId de Drive es inmutable una vez subido (mismo argumento que ya
  // justifica cachear meta.size/mimeType arriba) — antes esto decía
  // 'no-store', así que CADA fondo de chat (el ya asignado a una
  // conversación Y cada miniatura de la galería de "ya usados", hasta 40 a
  // la vez) volvía a pedirle el archivo entero a Drive en cada render, sin
  // excepción. Cacheable de verdad: Chromium sirve la miniatura/el fondo de
  // memoria/disco en vez de ida y vuelta a la API de Drive cada vez.
  const baseHeaders = { 'Content-Type': meta.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' }

  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get('Range') ?? '').trim())
  if (!rangeMatch || !Number.isFinite(total) || total === 0) {
    const driveRes = await net.fetch(mediaUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!driveRes.ok) return new Response('no se pudo leer el archivo de Drive', { status: driveRes.status })
    const headers = { ...baseHeaders }
    if (Number.isFinite(total)) headers['Content-Length'] = String(total)
    return new Response(driveRes.body, { status: 200, headers })
  }

  // el rango se calcula SIEMPRE contra el total real, no contra lo que
  // conteste Drive — incluye el caso "bytes=-N" (sufijo: los últimos N
  // bytes), que Chromium usa para leer la cola de un contenedor.
  const [, rawStart, rawEnd] = rangeMatch
  let start
  let end
  if (rawStart === '') {
    const suffixLength = rawEnd === '' ? 0 : Number(rawEnd)
    start = Math.max(0, total - suffixLength)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
  }

  const driveRes = await net.fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Range: `bytes=${start}-${end}` },
  })
  if (!driveRes.ok && driveRes.status !== 206) {
    return new Response('no se pudo leer el archivo de Drive', { status: driveRes.status })
  }

  const headers = {
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': String(end - start + 1),
  }
  // Si Drive IGNORA el Range y devuelve 200 con el archivo entero, no se
  // puede pasar ese body tal cual: el reproductor pidió desde el byte
  // `start` y recibiría bytes desde el 0, así que la línea de tiempo deja de
  // corresponder con lo que suena/se ve (exactamente el síntoma reportado).
  // En ese caso se recorta acá y se responde igual un 206 correcto.
  const body = driveRes.status === 206 ? driveRes.body : sliceWebStream(driveRes.body, start, end)
  return new Response(body, { status: 206, headers })
}

// ---------- Auto-actualización ----------
// electron-updater consulta el feed de GitHub Releases (repo edwardgko/
// flashlab-releases, ver build.publish en package.json y app-update.yml
// dentro del paquete) — se publica con `npm run release`, nunca a mano
// (ver [[notion-clone-auto-update]] en memoria). Descarga la actualización
// en segundo plano sin molestar y recién avisa (notificación nativa de
// Windows) cuando ya está lista para instalar; clickearla reinicia la app y
// la aplica.
// autoInstallOnAppQuit es la red de seguridad: si nadie clickea el aviso,
// se instala sola la próxima vez que la app cierre de verdad (no con la X,
// que solo la esconde a la bandeja — ver isQuitting).
//
// IMPORTANTE: esto solo puede escribir en una instalación per-user (sin
// permisos de administrador) — ver nsis.perMachine=false en package.json y
// warnIfPerMachineInstall más abajo. Una instalación en Program Files nunca
// se va a poder actualizar sola.
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // cada 4hs — la app suele quedar abierta todo el día

// Antes, la única forma de instalar una actualización ya descargada era
// clickear la notificación nativa de Windows — si el usuario la cerraba, la
// perdía de vista, o Notification.isSupported() daba false, no quedaba
// ningún otro botón EN LA APP para completar la instalación. La alternativa
// que terminaban usando (bajar el instalador de nuevo desde GitHub y
// correrlo a mano) choca con que la X de la ventana solo esconde la app a la
// bandeja (ver createTray) en vez de cerrarla — el instalador sigue viendo
// "FlashLab.exe" corriendo y no tiene forma de saber que hace falta matarlo,
// así que se queda pidiendo que se cierre sin que el usuario sepa cómo
// (reportado como "me dice que la app está abierta pero no me la cierra").
// Ahora, además de la notificación, se le avisa al renderer (update:ready)
// para mostrar un botón persistente en el Sidebar que llama a
// autoUpdater.quitAndInstall() directo — mismo camino "bueno" que ya cierra
// la app de verdad antes de lanzar el instalador (ver quitAndInstall en
// electron-updater/out/BaseUpdater.js), en vez de depender de que el usuario
// note y clickee un toast que puede pasar desapercibido.
// ver comentario de updateInstallPending: marcar el flag ANTES de llamar a
// quitAndInstall (que ya spawnea el instalador de forma síncrona) asegura
// que win.on('close') lo vea seteado apenas app.quit() dispare el cierre.
//
// NOTA: hubo acá un intento de ir más lejos (build/installer.nsh
// reemplazando el chequeo "¿sigue abierta?" del instalador + app.exit(0)
// para matar el proceso sin ceremonia). Se sacó — después de publicarlo el
// usuario tuvo que desinstalar y reinstalar la app a mano para que
// volviera a andar, una regresión real sobre un flujo que ya funcionaba
// (ver [[notion-clone-auto-update]]). No se pudo confirmar cuál de las dos
// piezas rompió qué, y no vale la pena arriesgar de nuevo por una molestia
// menor (un clic de más en "Reintentar" a veces) — better safe than sorry.
function triggerQuitAndInstall() {
  updateInstallPending = true
  autoUpdater.quitAndInstall()
}

function setupAutoUpdater(win) {
  if (!app.isPackaged) return // en dev no hay nada publicado que buscar, y no hay instalador que aplicar

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateVersion = info.version
    win.webContents.send('update:ready', { version: info.version })
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: 'FlashLab',
      body: `Hay una nueva versión de FlashLab (${info.version}) lista para instalar. Hacé clic aquí para reiniciar y completar la actualización.`,
    })
    notification.on('click', () => triggerQuitAndInstall())
    notification.show()
  })

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater] error:', err?.message || err)
  })

  ipcMain.handle('update:install', () => triggerQuitAndInstall())

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[autoUpdater] checkForUpdates:', err?.message || err))
  }
  // corre una vez al ratito de arrancar (no compite con la carga inicial de
  // la ventana) y después cada UPDATE_CHECK_INTERVAL_MS mientras siga abierta
  setTimeout(check, 10_000)
  setInterval(check, UPDATE_CHECK_INTERVAL_MS)
}

// detecta si ESTA instalación corre desde Program Files (per-machine) — algo
// que podía pasar antes de fijar nsis.perMachine=false si el instalador se
// corrió alguna vez con permisos de administrador. Esas instalaciones nunca
// se pueden auto-actualizar (quitAndInstall corre sin privilegios, no puede
// escribir ahí), así que se van quedando atrás para siempre sin que el
// usuario sepa por qué.
//
// A propósito NO intenta desinstalar ni arreglar nada solo: un incidente
// real (2026-08-06) mostró que desinstalar a mano la copia de Program Files
// puede llevarse puesta también la instalación per-user buena (el
// desinstalador de esa build vieja no distinguía cuál de las dos
// pertenecía). Esto solo avisa una vez, con los pasos manuales seguros.
async function warnIfPerMachineInstall(win) {
  if (!app.isPackaged) return
  const perMachineDirs = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean)
  if (!perMachineDirs.some((dir) => process.execPath.startsWith(dir))) return

  const settings = await loadSettings()
  if (settings.perMachineWarningShown) return
  await saveSettings({ perMachineWarningShown: true })

  dialog.showMessageBox(win, {
    type: 'warning',
    title: 'FlashLab',
    message: 'Esta instalación de FlashLab no se puede actualizar sola',
    detail:
      'Está instalada en una ubicación que necesita permisos de administrador, así que las actualizaciones automáticas no van a funcionar acá — te vas a ir quedando atrás de versión sin darte cuenta.\n\n' +
      'Para solucionarlo (una sola vez):\n' +
      '1. Configuración de Windows → Aplicaciones → Aplicaciones instaladas.\n' +
      '2. Buscá "FlashLab" y desinstalá esa entrada.\n' +
      '3. Descargá la última versión desde https://github.com/edwardgko/flashlab-releases/releases/latest e instalala de nuevo (sin "Ejecutar como administrador").\n\n' +
      'A partir de ahí se va a mantener actualizada sola.',
  })
}

app.whenReady().then(async () => {
  await migrateUserDataFolder()
  session.defaultSession.setSpellCheckerLanguages(['es-419', 'en-US'])
  // getDisplayMedia() del renderer dispara esto; con useSystemPicker el
  // propio SO (el selector nativo de Windows, con opción de audio del
  // sistema) elige qué compartir — no hace falta armar un picker propio con
  // desktopCapturer.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      console.log('[TRACE setDisplayMediaRequestHandler] pedido de captura, frame=', request.frame?.url)
      // useSystemPicker abre el selector nativo de Windows y usa lo que el
      // usuario elija ahí — pero igual exige una fuente de video "de
      // respaldo" en el callback (si no, tira "no video stream was
      // provided"), por si el picker nativo no está disponible.
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      callback({ video: sources[0], audio: 'loopback' })
    },
    { useSystemPicker: true }
  )
  protocol.handle('appasset', (request) => handleAssetRequest(request))
  protocol.handle('driveasset', (request) => handleDriveAssetRequest(request))
  await buildIndexes()
  const settings = await loadSettings()
  nativeTheme.themeSource = settings.themeSource
  nativeTheme.on('updated', () => {
    console.log(
      '[TRACE nativeTheme updated] source=',
      nativeTheme.themeSource,
      'shouldUseDarkColors=',
      nativeTheme.shouldUseDarkColors,
      'ventanas=',
      BrowserWindow.getAllWindows().length
    )
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('theme:updated', {
        source: nativeTheme.themeSource,
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      })
    }
  })
  const win = createWindow(settings.windowBounds)
  setupAutoUpdater(win)
  warnIfPerMachineInstall(win)
  // en segundo plano, sin bloquear el arranque
  relockSharedDriveRecordings().catch((err) =>
    console.error('falló la revisión de permisos de las grabaciones en Drive:', err)
  )
})

// dispara antes que 'close' en cada ventana — así el handler de 'close' sabe
// si esto es "Salir" de verdad (dejar seguir el cierre) o solo la X (esconder)
app.on('before-quit', () => {
  isQuitting = true
  // la metadata de una edición en curso recién se pisa si ffmpeg termina bien
  // (ver replaceRecordingAsset), así que matar el proceso acá no arriesga la
  // grabación original — solo se pierde el recorte/reemplazo a medio hacer
  for (const child of activeFfmpegProcesses) child.kill()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
