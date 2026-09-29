// Helpers de datos para MobileEditor.jsx — sin nada de React acá, para
// poder testear/razonar la forma de los bloques por separado del DOM.
//
// Mismo formato que graba Editor.js (ver textExtract.js, que ya documenta
// cada shape leyendo page_contents real): { blocks: [{ id, type, data }] }.
// El editor táctil solo sabe EDITAR paragraph/header/list — todo lo demás
// (quote, code, table, image, callout, toggle, delimiter, pageLink) se
// muestra de solo lectura pero se conserva intacto al guardar, para no
// destruir contenido armado desde desktop.

export const EDITABLE_TYPES = new Set(['paragraph', 'header', 'list'])

export const HEADER_LEVELS = [1, 2, 3]

export function newId() {
  return crypto.randomUUID()
}

export function newParagraphBlock() {
  return { id: newId(), type: 'paragraph', data: { text: '' } }
}

export function newHeaderBlock(level = 2) {
  return { id: newId(), type: 'header', data: { text: '', level } }
}

export function newListItem() {
  return { content: '', meta: {}, items: [] }
}

export function newListBlock(style = 'unordered') {
  return { id: newId(), type: 'list', data: { style, items: [newListItem()] } }
}

// La forma vieja 'checklist' (plana: items[].text + items[].checked, sin
// meta ni nesting) es de antes de que @editorjs/list absorbiera los 3
// estilos en un solo tool. Se normaliza a la forma nueva para editar todo
// con el mismo código — lo que se vuelve a guardar ya sale en formato
// nuevo, pero nunca se pierde contenido viejo por no reconocerlo.
export function normalizeBlock(block) {
  if (block?.type === 'checklist') {
    return {
      ...block,
      type: 'list',
      data: {
        style: 'checklist',
        items: (block.data?.items ?? []).map((it) => ({
          content: it?.text ?? '',
          meta: { checked: Boolean(it?.checked) },
          items: [],
        })),
      },
    }
  }
  return block
}

// ícono + etiqueta corta para los bloques que en el celular son de solo
// lectura — así al menos se entiende qué hay ahí en vez de verse vacío.
// pageLink NO es un tipo de bloque — es una herramienta inline que envuelve
// texto dentro de paragraph/header/list (<a class="page-link" data-page-id>,
// ver PageLinkTool.js), por eso no tiene entrada acá: viaja como parte del
// HTML de esos bloques, que sí son editables.
export const READONLY_BLOCK_INFO = {
  quote: { icon: '❝', label: 'Cita' },
  code: { icon: '💻', label: 'Código' },
  table: { icon: '▦', label: 'Tabla' },
  image: { icon: '🖼️', label: 'Imagen' },
  callout: { icon: '💡', label: 'Destacado' },
  toggle: { icon: '▸', label: 'Desplegable' },
  delimiter: { icon: '⋯', label: 'Separador' },
}

const TAG_RE = /<[^>]+>/g
function stripHtml(html) {
  return String(html ?? '')
    .replace(TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// texto corto para mostrar dentro de la tarjeta de solo lectura — no hace
// falta que sea perfecto, solo que no se vea vacío.
export function readonlyPreviewText(block) {
  const data = block?.data ?? {}
  switch (block?.type) {
    case 'quote':
      return stripHtml(data.text)
    case 'code':
      return data.code ?? ''
    case 'callout':
      return stripHtml(data.text)
    case 'toggle':
      return stripHtml(data.text)
    case 'table':
      return `${data.content?.length ?? 0} filas`
    case 'image':
      return stripHtml(data.caption) || data.file?.url || data.url || ''
    case 'pageLink':
      return data.title ?? ''
    default:
      return ''
  }
}
