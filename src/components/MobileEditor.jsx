import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import {
  EDITABLE_TYPES,
  HEADER_LEVELS,
  READONLY_BLOCK_INFO,
  newHeaderBlock,
  newListBlock,
  newListItem,
  newParagraphBlock,
  normalizeBlock,
  readonlyPreviewText,
} from '../lib/mobileBlocks.js'

const AUTOSAVE_DELAY_MS = 800

// Objeto vacío estable (ver el comentario de initialHtmlRef sobre por qué la
// IDENTIDAD del objeto importa, no solo su contenido).
const EMPTY_HTML = { __html: '' }

// Editor pensado para dedo, no mouse: sin manijas de arrastre ni barras que
// dependen de :hover (no existe en táctil). Alcance a propósito, confirmado
// con el usuario: texto plano, títulos y listas. Todo lo demás (tabla,
// código, imagen, cita, destacado, desplegable) se muestra de solo lectura
// pero NUNCA se pierde al guardar — solo se reescriben los bloques
// editables, el resto pasa intacto.
//
// Mismo contrato de props que Editor.jsx (el de desktop) para que PageView
// pueda elegir uno u otro según isMobile sin tocar nada más alrededor.
//
// Arquitectura del texto: cada bloque de texto es un contentEditable cuyo
// __html inicial se fija UNA sola vez (en un ref, nunca en el estado que
// dispara re-render) — así React nunca vuelve a tocar ese innerHTML server
// mientras el usuario escribe, sin importar cuántas veces se re-renderice
// el resto de la página por otro motivo (evita el bug clásico de
// contentEditable+React: el cursor saltando al principio a mitad de tipeo).
// La ESTRUCTURA (qué bloques hay, en qué orden, checked de un ítem, nivel
// de un título) sí vive en estado normal, porque esos cambios no compiten
// con estar escribiendo.
export default function MobileEditor({ pageId, onStatusChange, onNavigatePage, onContentSynced }) {
  const [blocks, setBlocks] = useState(null)
  const blocksRef = useRef(null)
  // blockId o "blockId:i" -> el OBJETO { __html } que se le pasa a
  // dangerouslySetInnerHTML, no el string suelto.
  //
  // Que sea el objeto entero es lo que hace que esto funcione: React 19
  // decide si reaplicar una prop del DOM comparando por IDENTIDAD de
  // referencia (`nextProp === lastProp`), no por valor. Un literal inline
  // `dangerouslySetInnerHTML={{ __html: x }}` crea un objeto nuevo en cada
  // render, así que React lo ve siempre "distinto" y reescribe el innerHTML
  // completo — borrando lo que el usuario venía tipeando (React 18 comparaba
  // el string `__html` y este patrón era seguro; en 19 ya no). Guardando y
  // reusando el mismo objeto, React lo ve idéntico y no toca el DOM.
  const initialHtmlRef = useRef(new Map())
  const nodeRefs = useRef(new Map()) // misma key -> nodo DOM contentEditable
  const saveTimerRef = useRef(null)
  const pendingRef = useRef(false)
  const containerRef = useRef(null)
  const focusKeyRef = useRef(null) // key a enfocar en el próximo efecto post-render

  useEffect(() => {
    blocksRef.current = blocks
  }, [blocks])

  const registerInitialHtml = (key, html) => {
    if (!initialHtmlRef.current.has(key)) initialHtmlRef.current.set(key, { __html: html ?? '' })
  }

  // Vuelca al mapa el HTML VIVO de cada nodo del DOM. Hace falta antes de
  // cualquier cambio estructural (agregar/borrar/reordenar), porque ahí las
  // keys de React se corren y remonta nodos: sin este volcado, un ítem que
  // se desplaza se remonta con su html ORIGINAL y pierde lo tipeado.
  const syncHtmlFromDom = () => {
    for (const [key, node] of nodeRefs.current) {
      const holder = initialHtmlRef.current.get(key)
      if (holder && node) holder.__html = node.innerHTML
    }
  }

  // arma blocksRef/initialHtmlRef a partir de datos crudos (carga inicial,
  // o después de agregar/quitar un bloque) — separado de setBlocks porque
  // agregar un bloque nuevo también necesita registrar su html inicial
  // (vacío) antes de que se monte.
  const applyBlocks = (nextBlocks) => {
    setBlocks(nextBlocks)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let data = null
      try {
        data = await api.loadPage(pageId)
      } catch (err) {
        console.error('Error al cargar la página:', err)
      }
      if (cancelled) return
      onContentSynced?.(data)
      const rawBlocks = data?.blocks?.length ? data.blocks : [newParagraphBlock()]
      const normalized = rawBlocks.map(normalizeBlock)
      for (const block of normalized) {
        if (block.type === 'list') {
          block.data.items.forEach((item, i) => registerInitialHtml(`${block.id}:${i}`, item.content))
        } else {
          registerInitialHtml(block.id, block.data?.text)
        }
      }
      applyBlocks(normalized)
      onStatusChange('idle')
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId])

  // recorre el DOM de los bloques editables y arma el array final a
  // guardar — la estructura sale de blocksRef, el TEXTO sale del DOM (ver
  // comentario de arriba: nunca se mantuvo sincronizado en estado).
  const serialize = useCallback(() => {
    // DOM primero (fuente de verdad mientras se escribe), después lo último
    // volcado al mapa por syncHtmlFromDom, y el texto original del bloque
    // solo como último recurso — antes ese original era el ÚNICO fallback, y
    // si el lookup del nodo fallaba se guardaba texto viejo, descartando en
    // silencio lo que el usuario había escrito.
    const htmlOf = (key, fallback) => {
      const node = nodeRefs.current.get(key)
      if (node) return node.innerHTML
      return initialHtmlRef.current.get(key)?.__html ?? fallback
    }
    return (blocksRef.current ?? []).map((block) => {
      if (block.type === 'paragraph' || block.type === 'header') {
        return { ...block, data: { ...block.data, text: htmlOf(block.id, block.data.text) } }
      }
      if (block.type === 'list') {
        return {
          ...block,
          data: {
            ...block.data,
            items: block.data.items.map((item, i) => ({
              ...item,
              content: htmlOf(`${block.id}:${i}`, item.content),
            })),
          },
        }
      }
      return block
    })
  }, [])

  const persist = useCallback(async () => {
    const data = { time: Date.now(), blocks: serialize(), version: '2.31.6' }
    try {
      onContentSynced?.(data)
      await api.savePage(pageId, data)
      pendingRef.current = false
      onStatusChange('saved')
    } catch (err) {
      console.error('Error al guardar la página:', err)
      onStatusChange('error')
    }
  }, [pageId, serialize, onStatusChange, onContentSynced])

  const scheduleSave = useCallback(() => {
    pendingRef.current = true
    onStatusChange('saving')
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(persist, AUTOSAVE_DELAY_MS)
  }, [persist, onStatusChange])

  // guardar de una al desmontar (cambiar de página) si quedó algo pendiente
  // del debounce — mismo criterio que Editor.jsx.
  useEffect(() => {
    return () => {
      clearTimeout(saveTimerRef.current)
      if (pendingRef.current) persist()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId])

  useEffect(() => {
    if (!focusKeyRef.current) return
    const node = nodeRefs.current.get(focusKeyRef.current)
    focusKeyRef.current = null
    if (!node) return
    node.focus()
    const range = document.createRange()
    range.selectNodeContents(node)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }, [blocks])

  const insertBlockAfter = (afterId, block) => {
    syncHtmlFromDom()
    const current = blocksRef.current ?? []
    const idx = current.findIndex((b) => b.id === afterId)
    const next = [...current.slice(0, idx + 1), block, ...current.slice(idx + 1)]
    registerInitialHtml(block.id, block.data?.text ?? '')
    focusKeyRef.current = block.id
    applyBlocks(next)
    scheduleSave()
  }

  const addBlockAtEnd = (block) => {
    syncHtmlFromDom()
    registerInitialHtml(block.id, block.data?.text ?? '')
    focusKeyRef.current = block.id
    applyBlocks([...(blocksRef.current ?? []), block])
    scheduleSave()
  }

  const removeBlock = (id) => {
    syncHtmlFromDom()
    const current = blocksRef.current ?? []
    if (current.length <= 1) return // no dejar la página sin ningún bloque
    const idx = current.findIndex((b) => b.id === id)
    const prev = current[idx - 1]
    nodeRefs.current.delete(id)
    initialHtmlRef.current.delete(id)
    if (prev) focusKeyRef.current = prev.type === 'list' ? `${prev.id}:${prev.data.items.length - 1}` : prev.id
    applyBlocks(current.filter((b) => b.id !== id))
    scheduleSave()
  }

  const moveBlock = (id, dir) => {
    syncHtmlFromDom()
    const current = blocksRef.current ?? []
    const idx = current.findIndex((b) => b.id === id)
    const swapWith = idx + dir
    if (swapWith < 0 || swapWith >= current.length) return
    const next = [...current]
    ;[next[idx], next[swapWith]] = [next[swapWith], next[idx]]
    applyBlocks(next)
    scheduleSave()
  }

  const setHeaderLevel = (id, level) => {
    applyBlocks((blocksRef.current ?? []).map((b) => (b.id === id ? { ...b, data: { ...b.data, level } } : b)))
    scheduleSave()
  }

  const setListStyle = (id, style) => {
    applyBlocks((blocksRef.current ?? []).map((b) => (b.id === id ? { ...b, data: { ...b.data, style } } : b)))
    scheduleSave()
  }

  const toggleChecked = (blockId, itemIndex) => {
    applyBlocks(
      (blocksRef.current ?? []).map((b) => {
        if (b.id !== blockId) return b
        const items = b.data.items.map((it, i) =>
          i === itemIndex ? { ...it, meta: { ...it.meta, checked: !it.meta?.checked } } : it
        )
        return { ...b, data: { ...b.data, items } }
      })
    )
    scheduleSave()
  }

  const addListItem = (blockId, afterIndex) => {
    syncHtmlFromDom()
    const current = blocksRef.current ?? []
    const block = current.find((b) => b.id === blockId)
    if (!block) return
    const item = newListItem()
    const items = [...block.data.items.slice(0, afterIndex + 1), item, ...block.data.items.slice(afterIndex + 1)]
    const key = `${blockId}:${afterIndex + 1}`
    registerInitialHtml(key, '')
    // los items después del insertado corren su key +1 — sus html "iniciales"
    // ya están fijados con la key vieja, hay que migrarlos para no perder
    // lo que tenían tipeado (no hay estado de texto en React, así que esto
    // es lo único que hace falta re-mapear).
    for (let i = block.data.items.length - 1; i > afterIndex; i--) {
      const oldKey = `${blockId}:${i}`
      const newKey = `${blockId}:${i + 1}`
      if (initialHtmlRef.current.has(oldKey)) {
        initialHtmlRef.current.set(newKey, initialHtmlRef.current.get(oldKey))
        initialHtmlRef.current.delete(oldKey)
      }
    }
    focusKeyRef.current = key
    applyBlocks(current.map((b) => (b.id === blockId ? { ...b, data: { ...b.data, items } } : b)))
    scheduleSave()
  }

  const removeListItem = (blockId, index) => {
    syncHtmlFromDom()
    const current = blocksRef.current ?? []
    const block = current.find((b) => b.id === blockId)
    if (!block || block.data.items.length <= 1) return
    for (let i = index; i < block.data.items.length; i++) {
      const key = `${blockId}:${i}`
      nodeRefs.current.delete(key)
      initialHtmlRef.current.delete(key)
    }
    block.data.items.forEach((_, i) => {
      if (i <= index) return
      const oldKey = `${blockId}:${i}`
      const node = nodeRefs.current.get(oldKey)
      if (node) {
        nodeRefs.current.set(`${blockId}:${i - 1}`, node)
        nodeRefs.current.delete(oldKey)
      }
    })
    const items = block.data.items.filter((_, i) => i !== index)
    applyBlocks(current.map((b) => (b.id === blockId ? { ...b, data: { ...b.data, items } } : b)))
    scheduleSave()
  }

  const handleParagraphKeyDown = (event, block) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      insertBlockAfter(block.id, newParagraphBlock())
      return
    }
    if (event.key === 'Backspace') {
      const node = nodeRefs.current.get(block.id)
      if (node && node.textContent === '') {
        event.preventDefault()
        removeBlock(block.id)
      }
    }
  }

  const handleListItemKeyDown = (event, block, index) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addListItem(block.id, index)
      return
    }
    if (event.key === 'Backspace') {
      const node = nodeRefs.current.get(`${block.id}:${index}`)
      if (node && node.textContent === '' && block.data.items.length > 1) {
        event.preventDefault()
        removeListItem(block.id, index)
      }
    }
  }

  // clic en un enlace interno (data-page-id, de PageLinkTool) navega en vez
  // de entrar en modo edición — mismo criterio que Editor.jsx.
  const handleContainerClick = (event) => {
    const anchor = event.target.closest('a.page-link')
    if (anchor?.dataset.pageId) {
      event.preventDefault()
      onNavigatePage?.(anchor.dataset.pageId)
    }
  }

  if (!blocks) {
    return <p className="py-4 text-sm text-gray-400 dark:text-neutral-500">Cargando…</p>
  }

  // min-w-0: sin esto, un flex item con flex-1 no se achica más allá del
  // ancho de su contenido (default min-width:auto) — el texto empujaba la
  // fila entera más ancha que la pantalla en vez de ajustarse/hacer wrap,
  // sobre todo en los ítems de lista, angostados encima por el checkbox y el
  // botón ✕ al lado. break-words: min-w-0 sólo alcanza para wrap normal
  // (espacios) — una URL o palabra larga sin espacios seguía desbordando el
  // ancho, y el contenedor de arriba (overflow-x-hidden, ver PageView.jsx)
  // la recorta en vez de scrollear, dando texto "cortado" a la derecha.
  // sin focus:bg — antes resaltaba el bloque enfocado con un fondo gris
  // marcado (bg-gray-50/white-5), pero ningún otro campo de la app hace eso
  // al editarse (el título de la página, por ejemplo, es bg-transparent
  // liso) — quedaba desentonado, reportado como que había que unificar el
  // estilo con el resto de los campos.
  const editableClass =
    'min-h-[1.6em] min-w-0 flex-1 break-words rounded-sm px-1 py-0.5 outline-none [&_a.page-link]:text-blue-600 [&_a.page-link]:underline dark:[&_a.page-link]:text-blue-400'

  return (
    <div ref={containerRef} onClick={handleContainerClick} className="flex flex-col gap-0.5">
      {blocks.map((block, i) => (
        // antes era flex-row (contenido | barra mover/borrar al costado): la
        // barra le robaba ancho horizontal a CADA bloque para nada la
        // mayoría del tiempo (solo se ve con el bloque enfocado), y en una
        // pantalla angosta eso importa — reportado como "darle más anchura
        // al input". Ahora flex-col: el contenido usa el 100% del ancho, la
        // barra pasa a su propia fila abajo (mismo lugar/estilo que los
        // botones +Texto/+Título/+Lista del final del documento).
        <div key={block.id} className="group flex flex-col gap-0.5">
          <div className="flex min-w-0 flex-col">
            {block.type === 'paragraph' && (
              <div
                ref={(node) => {
                  if (node) nodeRefs.current.set(block.id, node)
                  else nodeRefs.current.delete(block.id)
                }}
                contentEditable
                suppressContentEditableWarning
                data-placeholder="Escribí algo…"
                className={`${editableClass} text-base text-gray-800 empty:before:text-gray-300 empty:before:content-[attr(data-placeholder)] dark:text-neutral-100 dark:empty:before:text-neutral-600`}
                dangerouslySetInnerHTML={initialHtmlRef.current.get(block.id) ?? EMPTY_HTML}
                onInput={scheduleSave}
                onBlur={scheduleSave}
                onKeyDown={(e) => handleParagraphKeyDown(e, block)}
              />
            )}

            {block.type === 'header' && (
              <div className="flex items-center gap-2">
                <div
                  ref={(node) => {
                    if (node) nodeRefs.current.set(block.id, node)
                    else nodeRefs.current.delete(block.id)
                  }}
                  contentEditable
                  suppressContentEditableWarning
                  data-placeholder="Título"
                  className={`${editableClass} font-semibold text-gray-900 empty:before:text-gray-300 empty:before:content-[attr(data-placeholder)] dark:text-neutral-50 dark:empty:before:text-neutral-600 ${
                    block.data.level === 1 ? 'text-2xl' : block.data.level === 2 ? 'text-xl' : 'text-lg'
                  }`}
                  dangerouslySetInnerHTML={initialHtmlRef.current.get(block.id) ?? EMPTY_HTML}
                  onInput={scheduleSave}
                  onBlur={scheduleSave}
                  onKeyDown={(e) => handleParagraphKeyDown(e, block)}
                />
                <div className="flex shrink-0 gap-0.5">
                  {HEADER_LEVELS.map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => setHeaderLevel(block.id, lvl)}
                      className={`cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        block.data.level === lvl
                          ? 'bg-gray-200 text-gray-700 dark:bg-neutral-700 dark:text-neutral-200'
                          : 'text-gray-400 hover:bg-gray-100 dark:text-neutral-500 dark:hover:bg-neutral-800'
                      }`}
                    >
                      H{lvl}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {block.type === 'list' && (
              <div className="flex flex-col gap-2">
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  {[
                    ['unordered', '•'],
                    ['ordered', '1.'],
                    ['checklist', '☑'],
                  ].map(([style, icon]) => (
                    <button
                      key={style}
                      type="button"
                      onClick={() => setListStyle(block.id, style)}
                      className={`cursor-pointer rounded px-1.5 py-0.5 text-xs ${
                        block.data.style === style
                          ? 'bg-gray-200 text-gray-700 dark:bg-neutral-700 dark:text-neutral-200'
                          : 'text-gray-400 hover:bg-gray-100 dark:text-neutral-500 dark:hover:bg-neutral-800'
                      }`}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
                {block.data.items.map((item, idx) => {
                  const itemKey = `${block.id}:${idx}`
                  return (
                    <div key={itemKey} className="flex items-start gap-2">
                      {block.data.style === 'checklist' ? (
                        <input
                          type="checkbox"
                          checked={Boolean(item.meta?.checked)}
                          onChange={() => toggleChecked(block.id, idx)}
                          className="mt-1.5 h-4 w-4 shrink-0 cursor-pointer"
                        />
                      ) : (
                        <span className="mt-0.5 shrink-0 text-sm text-gray-400 dark:text-neutral-500">
                          {block.data.style === 'ordered' ? `${idx + 1}.` : '•'}
                        </span>
                      )}
                      <div
                        ref={(node) => {
                          if (node) nodeRefs.current.set(itemKey, node)
                          else nodeRefs.current.delete(itemKey)
                        }}
                        contentEditable
                        suppressContentEditableWarning
                        className={`${editableClass} text-sm ${
                          item.meta?.checked ? 'text-gray-400 line-through dark:text-neutral-500' : 'text-gray-800 dark:text-neutral-100'
                        }`}
                        dangerouslySetInnerHTML={initialHtmlRef.current.get(itemKey) ?? EMPTY_HTML}
                        onInput={scheduleSave}
                        onBlur={scheduleSave}
                        onKeyDown={(e) => handleListItemKeyDown(e, block, idx)}
                      />
                      <button
                        type="button"
                        aria-label="Borrar ítem"
                        onClick={() => removeListItem(block.id, idx)}
                        // ídem el comentario de la barra de mover/borrar de
                        // arriba: hidden en vez de opacity-0 para no robarle
                        // ancho al texto del ítem mientras no se está editando.
                        className="mt-0.5 hidden shrink-0 cursor-pointer rounded p-0.5 text-xs text-gray-300 hover:text-red-500 group-focus-within:block dark:text-neutral-600"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
                <button
                  type="button"
                  onClick={() => addListItem(block.id, block.data.items.length - 1)}
                  className="w-fit cursor-pointer px-1 text-xs text-gray-400 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                >
                  + Ítem
                </button>
              </div>
            )}

            {!EDITABLE_TYPES.has(block.type) && (
              <div className="flex items-start gap-2 rounded-md border border-dashed border-gray-200 px-3 py-2 text-sm text-gray-500 dark:border-neutral-700 dark:text-neutral-400">
                <span>{READONLY_BLOCK_INFO[block.type]?.icon ?? '❓'}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">
                    {READONLY_BLOCK_INFO[block.type]?.label ?? block.type} · solo lectura acá
                  </p>
                  {readonlyPreviewText(block) && (
                    <p className="mt-0.5 truncate">{readonlyPreviewText(block)}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* antes opacity-0 (invisible pero SIGUE ocupando ancho, shrink-0,
          al costado del contenido) — en touch no hay :hover que lo revele
          nunca, así que esta barra de mover/borrar bloque le robaba ancho a
          CADA línea del documento para nada (reportado dos veces: primero
          "las listas no se ajustan al 100% del ancho", después "darle más
          anchura al input"). Con hidden en vez de opacity-0, cuando no está
          enfocada ocupa 0 espacio — y ahora que el bloque es flex-col (ver
          arriba), esta fila cae DEBAJO del contenido en vez de al costado:
          el ancho horizontal completo queda siempre para el texto, la barra
          solo aparece (en su propia fila, mismo estilo que +Texto/+Título/
          +Lista) al enfocar ese bloque puntual. */}
          {/* mismo estilo (border+rounded-md+px-2.5 py-1.5) que los botones
          +Texto/+Título/+Lista del final del documento — pedido explícito
          de unificar look, ya que ahora viven en la misma zona visual. */}
          <div className="hidden gap-1.5 group-focus-within:flex">
            <button
              type="button"
              aria-label="Mover arriba"
              disabled={i === 0}
              onClick={() => moveBlock(block.id, -1)}
              className="cursor-pointer rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:hover:bg-transparent dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-white/5"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Mover abajo"
              disabled={i === blocks.length - 1}
              onClick={() => moveBlock(block.id, 1)}
              className="cursor-pointer rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:hover:bg-transparent dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-white/5"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label="Borrar bloque"
              disabled={blocks.length <= 1}
              onClick={() => removeBlock(block.id)}
              className="cursor-pointer rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-500 disabled:opacity-30 disabled:hover:border-gray-200 disabled:hover:bg-transparent disabled:hover:text-gray-500 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-red-900 dark:hover:bg-red-950/40 dark:hover:text-red-400"
            >
              🗑
            </button>
          </div>
        </div>
      ))}

      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => addBlockAtEnd(newParagraphBlock())}
          className="cursor-pointer rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-white/5"
        >
          + Texto
        </button>
        <button
          type="button"
          onClick={() => addBlockAtEnd(newHeaderBlock())}
          className="cursor-pointer rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-white/5"
        >
          + Título
        </button>
        <button
          type="button"
          onClick={() => addBlockAtEnd(newListBlock())}
          className="cursor-pointer rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-white/5"
        >
          + Lista
        </button>
      </div>
    </div>
  )
}
