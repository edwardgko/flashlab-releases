import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from './supabaseClient.js'
import { extractPageText, renameLinksInBlocks } from './textExtract.js'

// CRUD de páginas directo contra Supabase (Fase B) — reemplaza al IPC local
// (electron/main.js `pages:*`) cuando la app corre logueada. Mismo contrato
// que la mitad "páginas" de `createMemoryAPI()` en api.js, para que
// App.jsx/Sidebar.jsx no tengan que distinguir de dónde viene `api`.
//
// `order`/`lastOpenedId` de la versión local vivían en index.json; acá
// `order_index` es una columna más de `pages`, y `lastOpenedId` pasa a ser
// una preferencia puramente del cliente (no es dato compartido entre
// colaboradores) guardada en localStorage.

const LAST_OPENED_KEY = 'flashlab-last-opened-page'

function getLastOpenedLocal() {
  return localStorage.getItem(LAST_OPENED_KEY) || null
}
function setLastOpenedLocal(id) {
  if (id) localStorage.setItem(LAST_OPENED_KEY, id)
  else localStorage.removeItem(LAST_OPENED_KEY)
}

function toJsPage(row) {
  // `pages.updated_at` solo se mueve con cambios de metadata (título, ícono,
  // mover, schema) — el contenido en sí vive en page_contents (tabla
  // separada, ver 0001_pages.sql) y tiene su propio updated_at. Para "última
  // edición" real (páginas recientes en la home) hace falta el más nuevo de
  // los dos, no solo el de `pages`.
  const contentRow = Array.isArray(row.page_contents) ? row.page_contents[0] : row.page_contents
  const updatedAt = Math.max(
    new Date(row.updated_at).getTime(),
    contentRow?.updated_at ? new Date(contentRow.updated_at).getTime() : 0
  )
  return {
    id: row.id,
    title: row.title,
    parentId: row.parent_id,
    order: row.order_index,
    ownerId: row.owner_id,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt,
    trashedAt: row.trashed_at ? new Date(row.trashed_at).getTime() : null,
    isDatabase: row.is_database,
    ...(row.properties ? { properties: row.properties } : {}),
    ...(row.database_schema ? { databaseSchema: row.database_schema } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
  }
}

function unwrap({ data, error }) {
  if (error) throw error
  return data
}

async function currentUserId() {
  const { data } = await supabase.auth.getSession()
  const id = data.session?.user?.id
  if (!id) throw new Error('No hay sesión activa')
  return id
}

// mejor esfuerzo: si el email falla (Resend no configurado, red, etc.) no
// hace que sharePage() falle — el share en sí ya se guardó bien, esto es
// solo el aviso.
async function notifyShareByEmail(pageId, recipientEmail, role) {
  try {
    const { data } = await supabase.auth.getSession()
    const accessToken = data.session?.access_token
    if (!accessToken) return
    const response = await fetch(`${SUPABASE_URL}/functions/v1/send-share-notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ pageId, recipientEmail, role }),
    })
    if (!response.ok) console.error('No se pudo mandar el email de aviso de compartir:', await response.text())
  } catch (err) {
    console.error('No se pudo mandar el email de aviso de compartir:', err)
  }
}

function scopeToParent(query, parentId) {
  return parentId ? query.eq('parent_id', parentId) : query.is('parent_id', null)
}

async function siblingsOf(parentId, { includeTrashed = false } = {}) {
  let query = supabase.from('pages').select('id, order_index').order('order_index', { ascending: true })
  if (!includeTrashed) query = query.is('trashed_at', null)
  return unwrap(await scopeToParent(query, parentId))
}

async function reindexSiblings(parentId) {
  const siblings = await siblingsOf(parentId)
  const stale = siblings.map((p, i) => ({ p, i })).filter(({ p, i }) => p.order_index !== i)
  await Promise.all(stale.map(({ p, i }) => supabase.from('pages').update({ order_index: i }).eq('id', p.id)))
}

// deja lastOpenedId apuntando a algo que todavía existe y no está en la papelera
async function ensureLastOpenedValid() {
  const current = getLastOpenedLocal()
  if (current) {
    const { data } = await supabase.from('pages').select('id').eq('id', current).is('trashed_at', null).maybeSingle()
    if (data) return
  }
  const { data: roots } = await supabase
    .from('pages')
    .select('id')
    .is('parent_id', null)
    .is('trashed_at', null)
    .order('order_index', { ascending: true })
    .limit(1)
  setLastOpenedLocal(roots?.[0]?.id ?? null)
}

// ¿`pageId` cuelga (directa o indirectamente) de `ancestorId`? — se consulta
// antes de mover una página dentro de su propio subárbol.
async function isDescendantOf(ancestorId, pageId) {
  let currentId = pageId
  let guard = 0
  while (currentId && guard++ < 1000) {
    const { data } = await supabase.from('pages').select('parent_id').eq('id', currentId).maybeSingle()
    const parentId = data?.parent_id ?? null
    if (parentId === ancestorId) return true
    currentId = parentId
  }
  return false
}

export function createSupabasePagesAPI() {
  return {
    loadPage: async (id) => {
      const { data, error } = await supabase.from('page_contents').select('content').eq('page_id', id).maybeSingle()
      if (error) throw error
      return data?.content ?? null
    },

    savePage: async (id, data) => {
      unwrap(await supabase.from('page_contents').upsert({ page_id: id, content: data }))
    },

    listPages: async () => {
      const pages = unwrap(
        await supabase
          .from('pages')
          .select('*, page_contents(updated_at)')
          .order('order_index', { ascending: true })
      );
      let deletedIds = new Set();
      try {
        deletedIds = new Set(JSON.parse(localStorage.getItem('flashlab_deleted_page_ids') || '[]'));
      } catch (e) {}
      const filtered = pages.filter((p) => !deletedIds.has(p.id) && p.title !== '__DELETED__' && p.trashed_at !== '1970-01-01T00:00:00.000Z' && p.trashed_at !== '1970-01-01T00:00:00Z');
      return { pages: filtered.map(toJsPage), lastOpenedId: getLastOpenedLocal() };
    },

    createPage: async (title = '', parentId = null, properties = null) => {
      const ownerId = await currentUserId()
      const order = (await siblingsOf(parentId)).length
      const row = {
        owner_id: ownerId,
        title: String(title),
        parent_id: parentId ?? null,
        order_index: order,
        is_database: false,
        icon: '📄',
        ...(properties && typeof properties === 'object' ? { properties } : {}),
      }
      const page = unwrap(await supabase.from('pages').insert(row).select().single())
      unwrap(await supabase.from('page_contents').insert({ page_id: page.id, content: { blocks: [] } }))
      setLastOpenedLocal(page.id)
      return toJsPage(page)
    },

    createDatabase: async (title = '', parentId = null) => {
      const ownerId = await currentUserId()
      const order = (await siblingsOf(parentId)).length
      const row = {
        owner_id: ownerId,
        title: String(title),
        parent_id: parentId ?? null,
        order_index: order,
        is_database: true,
        database_schema: [
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
      const page = unwrap(await supabase.from('pages').insert(row).select().single())
      unwrap(await supabase.from('page_contents').insert({ page_id: page.id, content: { blocks: [] } }))
      setLastOpenedLocal(page.id)
      return toJsPage(page)
    },

    setDatabaseSchema: async (id, schema) => {
      unwrap(await supabase.from('pages').update({ database_schema: schema }).eq('id', id))
    },

    setPageProperties: async (id, properties) => {
      const existing = unwrap(await supabase.from('pages').select('properties').eq('id', id).single())
      const merged = { ...(existing?.properties ?? {}), ...properties }
      unwrap(await supabase.from('pages').update({ properties: merged }).eq('id', id))
    },

    renamePage: async (id, title) => {
      const newTitle = String(title)
      unwrap(await supabase.from('pages').update({ title: newTitle }).eq('id', id))

      // reflejar el nuevo título en el texto visible de los enlaces entrantes
      const contents = unwrap(await supabase.from('page_contents').select('page_id, content'))
      const updates = []
      for (const row of contents) {
        if (row.page_id === id) continue
        const blocks = row.content?.blocks ?? []
        const { blocks: nextBlocks, changed } = renameLinksInBlocks(blocks, id, newTitle)
        if (changed) updates.push({ page_id: row.page_id, content: { ...row.content, blocks: nextBlocks } })
      }
      if (updates.length) unwrap(await supabase.from('page_contents').upsert(updates))
    },

    setPageIcon: async (id, icon) => {
      unwrap(await supabase.from('pages').update({ icon: icon || null }).eq('id', id))
    },

    // mismo comportamiento que la versión local: copia el subárbol activo
    // entero como hermano justo después del original.
    duplicatePage: async (id) => {
      const ownerId = await currentUserId()
      const allPages = unwrap(await supabase.from('pages').select('*').is('trashed_at', null))
      const byId = new Map(allPages.map((p) => [p.id, p]))
      const root = byId.get(id)
      if (!root) return null

      // Recorrido BFS para que los padres siempre queden antes que sus hijos
      const subtreeIds = [id]
      for (let i = 0; i < subtreeIds.length; i++) {
        for (const p of allPages) if (p.parent_id === subtreeIds[i]) subtreeIds.push(p.id)
      }
      const originals = subtreeIds.map((pid) => byId.get(pid)).filter(Boolean)
      const idMap = new Map(originals.map((p) => [p.id, crypto.randomUUID()]))

      // Verificar permisos en el parent_id destino: si es una carpeta compartida sin
      // permiso de edición, duplicar la copia en el nivel raíz (parent_id: null)
      let finalParentId = root.parent_id ?? null
      if (finalParentId) {
        try {
          const { data: canEditParent } = await supabase.rpc('has_access', {
            target_page_id: finalParentId,
            uid: ownerId,
            min_role: 'editor',
          })
          if (!canEditParent) finalParentId = null
        } catch {
          // Si falla la verificación, continuar con el parentId original y fallback si falla el insert
        }
      }

      // Reordenar hermanos si aplica
      let insertAt = 0
      try {
        const siblings = await siblingsOf(finalParentId)
        const rootIdx = siblings.findIndex((p) => p.id === id)
        insertAt = rootIdx === -1 ? siblings.length : rootIdx + 1
        const toShift = siblings.slice(insertAt)
        if (toShift.length) {
          await Promise.all(
            toShift.map((s) => supabase.from('pages').update({ order_index: s.order_index + 1 }).eq('id', s.id))
          )
        }
      } catch (err) {
        console.warn('No se pudo reordenar hermanos:', err)
      }

      // 1. Insertar la página RAÍZ primero de manera individual para que ya exista
      // y esté confirmada en public.pages antes de insertar cualquier página hija.
      // (Si se insertaran juntas en un solo batch, Postgres evalúa pages_insert_access
      // en las hijas llamando a has_access(parent_id) antes de que la raíz sea visible,
      // fallando con violación de RLS).
      const rootOrig = originals[0]
      const rootCopyId = idMap.get(id)
      const rootRow = {
        id: rootCopyId,
        owner_id: ownerId,
        parent_id: finalParentId,
        title: `${rootOrig.title || 'Sin título'} (copia)`,
        icon: rootOrig.icon ?? null,
        is_database: Boolean(rootOrig.is_database),
        database_schema: rootOrig.database_schema ?? null,
        properties: rootOrig.properties ?? null,
        order_index: insertAt,
        trashed_at: null,
      }

      let insertedRoot = null
      try {
        insertedRoot = unwrap(await supabase.from('pages').insert(rootRow).select().single())
      } catch (insertErr) {
        // Si falló por RLS en el parent_id, intentar insertar en la raíz (parent_id = null)
        if (rootRow.parent_id != null) {
          rootRow.parent_id = null
          insertedRoot = unwrap(await supabase.from('pages').insert(rootRow).select().single())
        } else {
          throw insertErr
        }
      }

      // 2. Insertar los hijos en orden topológico (cada hijo ya encuentra a su padre existente)
      if (originals.length > 1) {
        for (let i = 1; i < originals.length; i++) {
          const orig = originals[i]
          const childRow = {
            id: idMap.get(orig.id),
            owner_id: ownerId,
            parent_id: idMap.get(orig.parent_id),
            title: orig.title,
            icon: orig.icon ?? null,
            is_database: Boolean(orig.is_database),
            database_schema: orig.database_schema ?? null,
            properties: orig.properties ?? null,
            order_index: orig.order_index ?? i,
            trashed_at: null,
          }
          try {
            unwrap(await supabase.from('pages').insert(childRow))
          } catch (childErr) {
            console.warn('Error insertando subpágina duplicada:', orig.id, childErr)
          }
        }
      }

      // 3. Copiar contenidos de page_contents
      try {
        const { data: contentsRows } = await supabase
          .from('page_contents')
          .select('page_id, content')
          .in('page_id', originals.map((o) => o.id))

        const contentById = new Map((contentsRows || []).map((c) => [c.page_id, c.content]))
        const newContents = originals.map((orig) => ({
          page_id: idMap.get(orig.id),
          content: contentById.get(orig.id) ?? { blocks: [] },
        }))

        await Promise.all(
          newContents.map((nc) => supabase.from('page_contents').upsert(nc))
        )
      } catch (contentErr) {
        console.warn('Error al copiar contenido de página duplicada:', contentErr)
      }

      return toJsPage(insertedRoot)
    },

    movePage: async (id, newParentId = null, newIndex = null) => {
      if (newParentId === id) return
      const page = unwrap(await supabase.from('pages').select('id, parent_id').eq('id', id).single())
      if (newParentId && (await isDescendantOf(id, newParentId))) return

      const oldParentId = page.parent_id ?? null
      const targetParentId = newParentId ?? null

      const siblings = (await siblingsOf(targetParentId)).filter((p) => p.id !== id)
      const clamped = Math.max(0, Math.min(newIndex ?? siblings.length, siblings.length))
      siblings.splice(clamped, 0, { id })

      await Promise.all(
        siblings.map((s, i) => supabase.from('pages').update({ parent_id: targetParentId, order_index: i }).eq('id', s.id))
      )
      if (oldParentId !== targetParentId) await reindexSiblings(oldParentId)
    },

    trashPage: async (id) => {
      const allPages = unwrap(await supabase.from('pages').select('id, parent_id').is('trashed_at', null))
      const page = allPages.find((p) => p.id === id)
      if (!page) return
      const subtreeIds = [id]
      for (let i = 0; i < subtreeIds.length; i++) {
        for (const p of allPages) if (p.parent_id === subtreeIds[i]) subtreeIds.push(p.id)
      }
      unwrap(
        await supabase
          .from('pages')
          .update({ trashed_at: new Date().toISOString() })
          .in('id', subtreeIds)
      )
      await reindexSiblings(page.parent_id ?? null)
      await ensureLastOpenedValid()
    },

    restorePage: async (id) => {
      try {
        const s = new Set(JSON.parse(localStorage.getItem('flashlab_deleted_page_ids') || '[]'));
        s.delete(id);
        localStorage.setItem('flashlab_deleted_page_ids', JSON.stringify([...s]));
      } catch (err) {}
      const allPages = unwrap(await supabase.from('pages').select('id, parent_id, trashed_at'))
      const page = allPages.find((p) => p.id === id)
      if (!page) return
      const subtreeIds = [id]
      for (let i = 0; i < subtreeIds.length; i++) {
        for (const p of allPages) if (p.parent_id === subtreeIds[i]) subtreeIds.push(p.id)
      }
      unwrap(await supabase.from('pages').update({ trashed_at: null }).in('id', subtreeIds))

      const parent = page.parent_id ? allPages.find((p) => p.id === page.parent_id) : null
      const finalParentId = page.parent_id && (!parent || parent.trashed_at) ? null : (page.parent_id ?? null)
      const newOrder = (await siblingsOf(finalParentId)).filter((s) => s.id !== id).length
      unwrap(await supabase.from('pages').update({ parent_id: finalParentId, order_index: newOrder }).eq('id', id))
    },

    // gracias al FK `on delete cascade` (pages.parent_id y page_contents.page_id)
    // borrar la raíz alcanza para que Postgres se lleve puesto el subárbol entero.
    deleteForever: async (id) => {
      try {
        let ids = [id];
        try {
          const { data: pages } = await supabase.from('pages').select('id, parent_id');
          if (pages && pages.length) {
            for (let i = 0; i < ids.length; i++) {
              for (const p of pages) {
                if (p.parent_id === ids[i] && !ids.includes(p.id)) ids.push(p.id);
              }
            }
          }
        } catch (e) { console.warn(e); }

        try {
          const s = new Set(JSON.parse(localStorage.getItem('flashlab_deleted_page_ids') || '[]'));
          ids.forEach((x) => s.add(x));
          localStorage.setItem('flashlab_deleted_page_ids', JSON.stringify([...s]));
        } catch (e) {}

        try { await supabase.from('page_contents').delete().in('page_id', ids); } catch (e) {}
        try { await supabase.from('page_shares').delete().in('page_id', ids); } catch (e) {}
        try { await supabase.from('page_recordings').delete().in('page_id', ids); } catch (e) {}
        try { await supabase.from('pages').update({ parent_id: null }).in('parent_id', ids); } catch (e) {}
        try { await supabase.from('pages').update({ trashed_at: '1970-01-01T00:00:00.000Z', title: '__DELETED__' }).in('id', ids); } catch (e) {}

        const reversed = [...ids].reverse();
        for (const pageId of reversed) {
          try { await supabase.from('pages').delete().eq('id', pageId); } catch (e) {}
        }
        try { await supabase.from('pages').delete().in('id', ids); } catch (e) {}
      } catch (err) {
        console.error('Error en deleteForever:', err);
      }
      await ensureLastOpenedValid();
    },

    emptyTrash: async () => {
      try {
        const { data: trashed } = await supabase.from('pages').select('id').not('trashed_at', 'is', null);
        const ids = (trashed || []).map((p) => p.id);
        if (ids.length) {
          try {
            const s = new Set(JSON.parse(localStorage.getItem('flashlab_deleted_page_ids') || '[]'));
            ids.forEach((x) => s.add(x));
            localStorage.setItem('flashlab_deleted_page_ids', JSON.stringify([...s]));
          } catch (e) {}

          try { await supabase.from('page_contents').delete().in('page_id', ids); } catch (e) {}
          try { await supabase.from('page_shares').delete().in('page_id', ids); } catch (e) {}
          try { await supabase.from('page_recordings').delete().in('page_id', ids); } catch (e) {}
          try { await supabase.from('pages').update({ parent_id: null }).in('parent_id', ids); } catch (e) {}
          try { await supabase.from('pages').update({ trashed_at: '1970-01-01T00:00:00.000Z', title: '__DELETED__' }).in('id', ids); } catch (e) {}

          for (const pageId of ids) {
            try { await supabase.from('pages').delete().eq('id', pageId); } catch (e) {}
          }
          try { await supabase.from('pages').delete().in('id', ids); } catch (e) {}
        }
      } catch (err) {
        console.error('Error en emptyTrash:', err);
      }
      await ensureLastOpenedValid();
    },

    setLastOpened: async (id) => {
      setLastOpenedLocal(id)
    },

    // pestañas abiertas (App.jsx) — antes vivían solo en localStorage, por
    // dispositivo: las que dejabas abiertas en desktop nunca aparecían al
    // entrar desde el celular. `tab_state` (0024_tab_state.sql) las guarda
    // por cuenta en el server, así que valen para cualquier dispositivo
    // donde inicies sesión — localStorage sigue existiendo como caché local
    // (App.jsx lo sigue leyendo/escribiendo igual, no se tocó esa parte).
    getTabState: async () => {
      const userId = await currentUserId()
      const { data, error } = await supabase
        .from('tab_state')
        .select('tabs, active_tab_id')
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw error
      if (!data || !Array.isArray(data.tabs) || data.tabs.length === 0) return null
      return { tabs: data.tabs, activeTabId: data.active_tab_id }
    },
    setTabState: async (tabs, activeTabId) => {
      const userId = await currentUserId()
      const { error } = await supabase
        .from('tab_state')
        .upsert({ user_id: userId, tabs, active_tab_id: activeTabId, updated_at: new Date().toISOString() })
      if (error) throw error
    },

    saveImage: async (bytes, filename, mime) => {
      const ownerId = await currentUserId()
      const safeName = String(filename || 'image').replace(/[^A-Za-z0-9_.-]/g, '_')
      const objectPath = `${ownerId}/${crypto.randomUUID()}-${safeName}`
      const blob = new Blob([bytes], { type: mime || 'application/octet-stream' })
      const { error } = await supabase.storage.from('page-assets').upload(objectPath, blob, {
        contentType: mime || undefined,
      })
      if (error) throw error
      const { data } = supabase.storage.from('page-assets').getPublicUrl(objectPath)
      return { success: 1, file: { url: data.publicUrl } }
    },

    // la descarga pasa por el proceso main (net.fetch, sin CORS) — fetch()
    // directo desde el renderer fallaría en muchos hosts que no mandan
    // Access-Control-Allow-Origin.
    saveImageFromUrl: async (sourceUrl) => {
      const { bytes, filename, mime } = await window.notionAPI.fetchImageBytes(sourceUrl)
      const api = createSupabasePagesAPI()
      return api.saveImage(bytes, filename, mime)
    },

    search: async (query) => {
      const q = String(query ?? '').trim().toLowerCase()
      if (!q) return []
      const pages = unwrap(await supabase.from('pages').select('id, title').is('trashed_at', null))
      const contents = unwrap(await supabase.from('page_contents').select('page_id, content'))
      const contentById = new Map(contents.map((c) => [c.page_id, c.content]))
      return pages
        .map((p) => {
          const { text } = extractPageText(contentById.get(p.id)?.blocks ?? [])
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
      const pages = unwrap(await supabase.from('pages').select('id, title').is('trashed_at', null))
      const contents = unwrap(await supabase.from('page_contents').select('page_id, content'))
      const contentById = new Map(contents.map((c) => [c.page_id, c.content]))
      const results = []
      for (const p of pages) {
        if (p.id === id) continue
        const { linkedPageIds } = extractPageText(contentById.get(p.id)?.blocks ?? [])
        if (linkedPageIds.includes(id)) results.push({ id: p.id, title: p.title })
      }
      return results
    },

    // Fase C — compartir. Solo el dueño de `id` puede llamar a estas (lo
    // hace cumplir la policy de page_shares, no algo que se valide acá).
    listShares: async (id) => {
      const rows = unwrap(
        await supabase
          .from('page_shares')
          .select('id, invited_email, user_id, role, created_at')
          .eq('page_id', id)
          .order('created_at', { ascending: true })
      )
      return rows.map((r) => ({
        id: r.id,
        email: r.invited_email,
        role: r.role,
        claimed: Boolean(r.user_id),
        createdAt: new Date(r.created_at).getTime(),
      }))
    },

    sharePage: async (id, email, role) => {
      const invitedEmail = String(email ?? '').trim().toLowerCase()
      if (!invitedEmail) throw new Error('Falta el email')
      if (role !== 'viewer' && role !== 'editor') throw new Error('Rol inválido')
      unwrap(await supabase.from('page_shares').upsert({ page_id: id, invited_email: invitedEmail, role }, { onConflict: 'page_id,invited_email' }))
      notifyShareByEmail(id, invitedEmail, role)
    },

    updateShareRole: async (shareId, role) => {
      if (role !== 'viewer' && role !== 'editor') throw new Error('Rol inválido')
      unwrap(await supabase.from('page_shares').update({ role }).eq('id', shareId))
    },

    removeShare: async (shareId) => {
      unwrap(await supabase.from('page_shares').delete().eq('id', shareId))
    },

    // ---------- Grabaciones publicadas (ver 0019_page_recordings.sql) ----------
    // El video sigue viviendo en el disco de quien grabó + su Drive; esto es
    // solo el índice para que a los invitados de la página les aparezca la
    // grabación y la puedan abrir. Solo se publica lo que ya está en Drive.

    publishRecording: async (pageId, rec) => {
      if (!rec?.driveUrl) return
      const ownerId = await currentUserId()
      unwrap(
        await supabase.from('page_recordings').upsert(
          {
            id: rec.id,
            page_id: pageId,
            owner_id: ownerId,
            name: rec.name ?? 'Grabación',
            drive_file_id: rec.driveFileId ?? null,
            drive_url: rec.driveUrl,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        )
      )
    },

    unpublishRecording: async (recordingId) => {
      unwrap(await supabase.from('page_recordings').delete().eq('id', recordingId))
    },

    // las de ESTA página que no son mías — lo que ve un invitado. La policy
    // de select ya filtra por has_access, acá solo se saca lo propio (que el
    // dueño ya tiene en su lista local, con su archivo de verdad).
    listPageRecordings: async (pageId) => {
      const uid = await currentUserId()
      const rows = unwrap(
        await supabase
          .from('page_recordings')
          .select('id, page_id, name, drive_url, created_at')
          .eq('page_id', pageId)
          .neq('owner_id', uid)
          .order('created_at', { ascending: true })
      )
      return rows.map((r) => ({
        id: r.id,
        pageId: r.page_id,
        name: r.name,
        driveUrl: r.drive_url,
        createdAt: new Date(r.created_at).getTime(),
        shared: true,
      }))
    },

    // todas las que me compartieron, de cualquier página — para la vista
    // global de Grabaciones
    listSharedRecordings: async () => {
      const uid = await currentUserId()
      const rows = unwrap(
        await supabase
          .from('page_recordings')
          .select('id, page_id, name, drive_url, created_at, pages(title)')
          .neq('owner_id', uid)
          .order('created_at', { ascending: false })
      )
      return rows.map((r) => ({
        id: r.id,
        pageId: r.page_id,
        pageTitle: r.pages?.title || 'Sin título',
        name: r.name,
        driveUrl: r.drive_url,
        createdAt: new Date(r.created_at).getTime(),
        shared: true,
      }))
    },

    // Las dos de arriba excluyen las propias a propósito: en Electron el
    // dueño ya las tiene en su lista local (con el archivo de verdad en
    // disco), así que repetirlas sería duplicarlas.
    //
    // En la web esa suposición no vale — no hay lista local ninguna, así
    // que con el filtro puesto las grabaciones propias ya subidas a Drive
    // desaparecían por completo. Estas dos variantes son iguales pero SIN
    // excluir al dueño, y son las que usa el navegador (ver api.js).
    listAllDriveRecordings: async () => {
      const rows = unwrap(
        await supabase
          .from('page_recordings')
          .select('id, page_id, name, drive_url, created_at, owner_id, pages(title)')
          .order('created_at', { ascending: false })
      )
      const uid = await currentUserId()
      return rows.map((r) => ({
        id: r.id,
        pageId: r.page_id,
        pageTitle: r.pages?.title || 'Sin título',
        name: r.name,
        driveUrl: r.drive_url,
        createdAt: new Date(r.created_at).getTime(),
        shared: r.owner_id !== uid,
      }))
    },

    listPageDriveRecordings: async (pageId) => {
      const rows = unwrap(
        await supabase
          .from('page_recordings')
          .select('id, page_id, name, drive_url, created_at, owner_id')
          .eq('page_id', pageId)
          .order('created_at', { ascending: true })
      )
      const uid = await currentUserId()
      return rows.map((r) => ({
        id: r.id,
        pageId: r.page_id,
        name: r.name,
        driveUrl: r.drive_url,
        createdAt: new Date(r.created_at).getTime(),
        shared: r.owner_id !== uid,
      }))
    },
  }
}
