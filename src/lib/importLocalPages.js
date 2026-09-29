import { supabase } from './supabaseClient.js'

// Importador único: sube las páginas que hoy viven en el JSON local
// (%APPDATA%\FlashLab) a la cuenta recién logueada en Supabase. Preserva los
// UUIDs originales — PageLinkTool guarda `data-page-id` apuntando a esos ids
// en los bloques de Editor.js, generar ids nuevos rompería todos los enlaces
// internos existentes. Sube a Storage cada imagen appasset://local/... y
// reescribe la URL, para que las páginas importadas no queden con imágenes
// rotas (appasset:// solo existe en esta instalación de Electron).

const ASSET_URL_RE = /^appasset:\/\/local\/([A-Za-z0-9_-]+\.[a-z0-9]{1,5})$/

async function uploadLocalAsset(filename, ownerId, cache) {
  if (cache.has(filename)) return cache.get(filename)
  const { bytes, mime } = await window.notionAPI.readLocalAsset(filename)
  const objectPath = `${ownerId}/${crypto.randomUUID()}-${filename}`
  const { error } = await supabase.storage
    .from('page-assets')
    .upload(objectPath, new Blob([bytes], { type: mime || 'application/octet-stream' }), {
      contentType: mime || undefined,
    })
  if (error) throw error
  const { data } = supabase.storage.from('page-assets').getPublicUrl(objectPath)
  cache.set(filename, data.publicUrl)
  return data.publicUrl
}

async function migrateAssetUrl(url, ownerId, cache) {
  const match = typeof url === 'string' ? url.match(ASSET_URL_RE) : null
  if (!match) return url
  return uploadLocalAsset(match[1], ownerId, cache)
}

async function migrateBlocks(blocks, ownerId, cache) {
  const next = []
  for (const block of blocks ?? []) {
    if (block?.type === 'image' && block.data?.file?.url) {
      const newUrl = await migrateAssetUrl(block.data.file.url, ownerId, cache)
      next.push({ ...block, data: { ...block.data, file: { ...block.data.file, url: newUrl } } })
    } else {
      next.push(block)
    }
  }
  return next
}

// ¿hay algo para importar? (páginas locales sí, pero la cuenta en Supabase
// todavía no tiene ninguna — evita ofrecer el importador de nuevo una vez
// que ya se usó, o a una cuenta que ya viene con datos propios).
export async function hasLocalPagesToImport() {
  if (!window.notionAPI) return false
  const { data, error } = await supabase.from('pages').select('id').limit(1)
  if (error || (data && data.length > 0)) return false
  const local = await window.notionAPI.listPages()
  return local.pages.length > 0
}

// onProgress({ done, total, title }) — para mostrar progreso en la UI
export async function importLocalPagesToSupabase(onProgress) {
  const { data: sessionData } = await supabase.auth.getSession()
  const ownerId = sessionData.session?.user?.id
  if (!ownerId) throw new Error('No hay sesión activa')

  const { pages } = await window.notionAPI.listPages()
  if (!pages.length) return { imported: 0 }

  const assetCache = new Map()
  const pageRows = []
  const contentRows = []

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]
    onProgress?.({ done: i, total: pages.length, title: p.title || 'Sin título' })

    const icon = await migrateAssetUrl(p.icon ?? null, ownerId, assetCache)
    const content = (await window.notionAPI.loadPage(p.id)) ?? { blocks: [] }
    const blocks = await migrateBlocks(content.blocks, ownerId, assetCache)
    const updatedAtIso = new Date(p.updatedAt ?? Date.now()).toISOString()

    pageRows.push({
      id: p.id,
      owner_id: ownerId,
      parent_id: p.parentId ?? null,
      title: p.title ?? '',
      icon: icon || null,
      is_database: Boolean(p.isDatabase),
      database_schema: p.databaseSchema ?? null,
      properties: p.properties ?? null,
      order_index: p.order ?? 0,
      trashed_at: p.trashedAt ? new Date(p.trashedAt).toISOString() : null,
      created_at: new Date(p.createdAt ?? Date.now()).toISOString(),
      updated_at: updatedAtIso,
    })
    contentRows.push({ page_id: p.id, content: { ...content, blocks }, updated_at: updatedAtIso })
  }

  // ON CONFLICT DO NOTHING: reintentar el importador (p. ej. si se cortó a
  // mitad de camino) es seguro, no duplica ni pisa nada ya subido.
  const { error: pagesError } = await supabase
    .from('pages')
    .upsert(pageRows, { onConflict: 'id', ignoreDuplicates: true })
  if (pagesError) throw pagesError

  const { error: contentsError } = await supabase
    .from('page_contents')
    .upsert(contentRows, { onConflict: 'page_id', ignoreDuplicates: true })
  if (contentsError) throw contentsError

  onProgress?.({ done: pages.length, total: pages.length, title: '' })
  return { imported: pageRows.length }
}
