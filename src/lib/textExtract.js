// Extrae texto plano (para el índice de búsqueda) y los ids de página
// enlazados (para backlinks) del contenido de una página. El HTML siempre
// viene de nuestro propio Editor.js/bloques propios, nunca de una fuente
// externa — un regex simple alcanza, no hace falta un parser HTML completo.

const TAG_RE = /<[^>]+>/g
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
const LINK_RE = /data-page-id="([A-Za-z0-9_-]+)"/g

function stripHtml(html) {
  if (!html) return ''
  return html
    .replace(TAG_RE, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectLinks(html, sink) {
  if (!html) return
  for (const match of html.matchAll(LINK_RE)) sink.add(match[1])
}

function listItemText(item, textParts, linkIds) {
  if (!item) return
  textParts.push(stripHtml(item.content))
  collectLinks(item.content, linkIds)
  for (const child of item.items ?? []) listItemText(child, textParts, linkIds)
}

// { text: string, linkedPageIds: string[] }
export function extractPageText(blocks = []) {
  const textParts = []
  const linkIds = new Set()

  for (const block of blocks) {
    const data = block?.data ?? {}
    switch (block?.type) {
      case 'paragraph':
      case 'header':
      case 'callout':
        textParts.push(stripHtml(data.text))
        collectLinks(data.text, linkIds)
        break
      case 'toggle':
        textParts.push(stripHtml(data.text), stripHtml(data.body))
        collectLinks(data.text, linkIds)
        collectLinks(data.body, linkIds)
        break
      case 'quote':
        textParts.push(stripHtml(data.text), stripHtml(data.caption))
        collectLinks(data.text, linkIds)
        break
      case 'list':
        for (const item of data.items ?? []) listItemText(item, textParts, linkIds)
        break
      case 'checklist':
        for (const item of data.items ?? []) {
          textParts.push(stripHtml(item?.text))
          collectLinks(item?.text, linkIds)
        }
        break
      case 'code':
        textParts.push(data.code ?? '')
        break
      case 'table':
        for (const row of data.content ?? []) {
          for (const cell of row) {
            textParts.push(stripHtml(cell))
            collectLinks(cell, linkIds)
          }
        }
        break
      case 'image':
        textParts.push(stripHtml(data.caption))
        break
      default:
        break
    }
  }

  return { text: textParts.filter(Boolean).join(' '), linkedPageIds: [...linkIds] }
}

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPE[c])

// Reescribe el texto visible de los enlaces `<a data-page-id="ID">...</a>`
// a un page renombrado, sin tocar el resto del markup del bloque.
function rewriteLinkText(html, pageId, newTitle, state) {
  if (!html) return html
  const re = new RegExp(`(<a[^>]*data-page-id="${pageId}"[^>]*>)([\\s\\S]*?)(</a>)`, 'g')
  if (!re.test(html)) return html
  state.changed = true
  return html.replace(re, (_m, open, _old, close) => `${open}${escapeHtml(newTitle)}${close}`)
}

function rewriteListItem(item, pageId, newTitle, state) {
  if (!item) return item
  return {
    ...item,
    content: rewriteLinkText(item.content, pageId, newTitle, state),
    items: (item.items ?? []).map((child) => rewriteListItem(child, pageId, newTitle, state)),
  }
}

// { blocks, changed }: nuevo array de bloques con el texto de enlace actualizado
export function renameLinksInBlocks(blocks = [], pageId, newTitle) {
  const state = { changed: false }
  const next = blocks.map((block) => {
    const data = block?.data ?? {}
    switch (block?.type) {
      case 'paragraph':
      case 'header':
      case 'callout':
        return { ...block, data: { ...data, text: rewriteLinkText(data.text, pageId, newTitle, state) } }
      case 'toggle':
        return {
          ...block,
          data: {
            ...data,
            text: rewriteLinkText(data.text, pageId, newTitle, state),
            body: rewriteLinkText(data.body, pageId, newTitle, state),
          },
        }
      case 'quote':
        return { ...block, data: { ...data, text: rewriteLinkText(data.text, pageId, newTitle, state) } }
      case 'list':
        return {
          ...block,
          data: { ...data, items: (data.items ?? []).map((it) => rewriteListItem(it, pageId, newTitle, state)) },
        }
      case 'checklist':
        return {
          ...block,
          data: {
            ...data,
            items: (data.items ?? []).map((it) => ({
              ...it,
              text: rewriteLinkText(it?.text, pageId, newTitle, state),
            })),
          },
        }
      case 'table':
        return {
          ...block,
          data: {
            ...data,
            content: (data.content ?? []).map((row) =>
              row.map((cell) => rewriteLinkText(cell, pageId, newTitle, state))
            ),
          },
        }
      default:
        return block
    }
  })
  return { blocks: next, changed: state.changed }
}
