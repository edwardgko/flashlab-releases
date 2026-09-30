import { useCallback, useEffect, useRef } from 'react'
import EditorJS from '@editorjs/editorjs'
import Header from '@editorjs/header'
import List from '@editorjs/list'
import Quote from '@editorjs/quote'
import CodeTool from '@editorjs/code'
import Table from '@editorjs/table'
import Delimiter from '@editorjs/delimiter'
import Marker from '@editorjs/marker'
import InlineCode from '@editorjs/inline-code'
import { api } from '../lib/api.js'
import CalloutTool from '../lib/editorTools/CalloutTool.js'
import ToggleTool from '../lib/editorTools/ToggleTool.js'
import PageLinkTool from '../lib/editorTools/PageLinkTool.js'
import DeletableImageTool from '../lib/editorTools/DeletableImageTool.js'
import { imageUploader } from '../lib/editorTools/imageUploader.js'

const AUTOSAVE_DELAY_MS = 800

// Editor.js viene en inglés por defecto — traduce su UI nativa (toolbox,
// popover de conversión, tunes de bloque) y los strings propios de cada
// tool instalado. Las claves son las que usa el core internamente (no hay
// forma de listarlas en su documentación pública; se confirmaron leyendo
// el bundle: namespace "tools" resuelve como tools[<key del objeto tools
// de arriba>], "toolNames" resuelve por el title exacto de cada
// toolbox — ver comentarios puntuales abajo donde no es obvio).
const EDITOR_I18N = {
  messages: {
    ui: {
      blockTunes: {
        toggler: {
          'Click to tune': 'Clic para ajustar',
          'or drag to move': 'o arrastrá para mover',
        },
      },
      inlineToolbar: {
        converter: { 'Convert to': 'Convertir a' },
      },
      toolbar: {
        toolbox: { Add: 'Agregar' },
      },
      popover: {
        Filter: 'Filtrar',
        'Nothing found': 'No se encontró nada',
        'Convert to': 'Convertir a',
      },
    },
    toolNames: {
      Text: 'Texto',
      Link: 'Enlace',
      Bold: 'Negrita',
      Italic: 'Cursiva',
      Heading: 'Encabezado',
      // @editorjs/list expone 3 toolbox separados (no un "List" único)
      'Unordered List': 'Lista con viñetas',
      'Ordered List': 'Lista numerada',
      Checklist: 'Lista de tareas',
      Quote: 'Cita',
      Code: 'Código',
      Table: 'Tabla',
      Delimiter: 'Separador',
      Image: 'Imagen',
      Callout: 'Destacado',
      Toggle: 'Desplegable',
      // marker/inlineCode/pageLink no definen toolbox propio: el core cae
      // al nombre de su key en tools{} con la primera letra en mayúscula
      Marker: 'Resaltador',
      InlineCode: 'Código en línea',
      PageLink: 'Enlace a página',
    },
    tools: {
      header: { 'Heading 1': 'Título 1', 'Heading 2': 'Título 2', 'Heading 3': 'Título 3' },
      list: {
        Unordered: 'Con viñetas',
        Ordered: 'Numerada',
        Checklist: 'Tareas',
        'Start with': 'Empezar en',
        'Counter type': 'Tipo de contador',
        Numeric: 'Numérico',
        'Lower Roman': 'Romano minúscula',
        'Upper Roman': 'Romano mayúscula',
        'Lower Alpha': 'Alfabético minúscula',
        'Upper Alpha': 'Alfabético mayúscula',
      },
      quote: {
        'Enter a quote': 'Escribí una cita',
        'Enter a caption': 'Escribí una leyenda',
        'Align Left': 'Alinear a la izquierda',
        'Align Center': 'Centrar',
      },
      code: { 'Enter a code': 'Escribí código' },
      table: {
        'Add column to left': 'Agregar columna a la izquierda',
        'Add column to right': 'Agregar columna a la derecha',
        'Delete column': 'Eliminar columna',
        'Add row above': 'Agregar fila arriba',
        'Add row below': 'Agregar fila abajo',
        'Delete row': 'Eliminar fila',
        Heading: 'Encabezado',
        'With headings': 'Con encabezados',
        'Without headings': 'Sin encabezados',
        Collapse: 'Contraer',
        Stretch: 'Expandir',
      },
      image: {
        'Select an Image': 'Seleccionar una imagen',
        Caption: 'Leyenda',
        'With border': 'Con borde',
        'Stretch image': 'Expandir imagen',
        'With background': 'Con fondo',
        // apóstrofe tipográfico (’), no recto — así lo emite el plugin
        'Couldn’t upload image. Please try another.': 'No se pudo subir la imagen. Probá con otra.',
      },
      link: { 'Add a link': 'Agregar un enlace' },
      stub: { 'The block can not be displayed correctly.': 'El bloque no se puede mostrar correctamente.' },
    },
    blockTunes: {
      delete: { Delete: 'Eliminar', 'Click to delete': 'Clic para eliminar' },
      moveUp: { 'Move up': 'Mover arriba' },
      moveDown: { 'Move down': 'Mover abajo' },
    },
  },
}

async function searchPagesExcluding(query, excludeId) {
  const q = query.trim()
  const list = q
    ? await api.search(q)
    : (await api.listPages()).pages
        .filter((p) => !p.trashedAt)
        .slice(0, 20)
        .map((p) => ({ id: p.id, title: p.title }))
  return list.filter((p) => p.id !== excludeId)
}

export default function Editor({
  pageId,
  onStatusChange,
  onNavigatePage,
  onContentSynced,
  remoteCursors,
  broadcastElementFocus,
}) {
  const holderRef = useRef(null)
  const editorRef = useRef(null)
  const saveTimerRef = useRef(null)
  const pendingRef = useRef(false)

  const persist = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return
    try {
      const data = await editor.save()
      // Avisar ANTES de escribir, no después: si no, el eco de este mismo
      // guardado que vuelve por Realtime (postgres_changes) puede llegar
      // antes de que actualicemos la referencia, y PageView lo confunde con
      // un cambio ajeno ("alguien actualizó esta página" sobre tu propia edición).
      onContentSynced?.(data)
      await api.savePage(pageId, data)
      pendingRef.current = false
      onStatusChange('saved')
    } catch (err) {
      console.error('Error al guardar la página:', err)
      onStatusChange('error')
    }
  }, [pageId, onStatusChange, onContentSynced])

  const scheduleSave = useCallback(() => {
    pendingRef.current = true
    onStatusChange('saving')
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(persist, AUTOSAVE_DELAY_MS)
  }, [persist, onStatusChange])

  useEffect(() => {
    let cancelled = false
    let editor = null
    let loadOk = false
    // Holder hijo por instancia: destroy() limpia el innerHTML del holder
    // completo, y con StrictMode (doble montaje) borraría el DOM de la
    // instancia viva si ambas compartieran el mismo nodo.
    const holder = document.createElement('div')
    holderRef.current.appendChild(holder)

    ;(async () => {
      let data = null
      try {
        data = await api.loadPage(pageId)
        loadOk = true
        onContentSynced?.(data)
      } catch (err) {
        console.error('Error al cargar la página:', err)
      }
      if (cancelled) return

      editor = new EditorJS({
        holder,
        autofocus: false,
        minHeight: 120,
        placeholder: 'Escribe algo, o presiona "/" para ver los bloques...',
        data: data ?? undefined,
        onChange: scheduleSave,
        tools: {
          header: {
            class: Header,
            inlineToolbar: true,
            config: { levels: [1, 2, 3], defaultLevel: 2 },
          },
          list: {
            class: List,
            inlineToolbar: true,
          },
          quote: {
            class: Quote,
            inlineToolbar: true,
          },
          code: {
            class: CodeTool,
          },
          table: {
            class: Table,
            inlineToolbar: true,
            config: { withHeadings: true },
          },
          delimiter: Delimiter,
          image: {
            class: DeletableImageTool,
            config: { uploader: imageUploader },
          },
          callout: {
            class: CalloutTool,
            inlineToolbar: true,
          },
          toggle: {
            class: ToggleTool,
            inlineToolbar: true,
          },
          marker: {
            class: Marker,
            shortcut: 'CMD+SHIFT+M',
          },
          inlineCode: {
            class: InlineCode,
            shortcut: 'CMD+SHIFT+C',
          },
          pageLink: {
            class: PageLinkTool,
            config: { searchPages: (query) => searchPagesExcluding(query, pageId) },
          },
        },
        i18n: EDITOR_I18N,
      })
      editorRef.current = editor
      editor.isReady
        .then(() => {
          if (!cancelled) onStatusChange('idle')
        })
        .catch((err) => console.error('Editor.js no pudo inicializar:', err))
    })()

    // delegado: click en un enlace interno navega en vez de editar
    const handleLinkClick = (event) => {
      const anchor = event.target.closest('a.page-link')
      if (!anchor?.dataset.pageId) return
      event.preventDefault()
      onNavigatePage?.(anchor.dataset.pageId)
    }
    holder.addEventListener('click', handleLinkClick)

    return () => {
      cancelled = true
      holder.removeEventListener('click', handleLinkClick)
      clearTimeout(saveTimerRef.current)
      if (editorRef.current === editor) editorRef.current = null
      if (editor) {
        const currentEditor = editor
        // Solo guardar al desmontar si realmente quedaron cambios pendientes
        // sin guardar. Antes loadOk obligaba a guardar siempre, disparando
        // guardados de contenido viejo al desmontar que hacían parpadear y
        // pisaban las ediciones de otros usuarios en tiempo real.
        const mustFlush = Boolean(pendingRef.current)
        // destroy() antes de isReady lanza excepción
        currentEditor.isReady
          .then(async () => {
            if (mustFlush) {
              try {
                const data = await currentEditor.save()
                await api.savePage(pageId, data)
              } catch (err) {
                console.error('Error al vaciar el guardado pendiente:', err)
              }
            }
            currentEditor.destroy()
          })
          .catch(() => {})
          .finally(() => holder.remove())
      } else {
        holder.remove()
      }
    }
  }, [pageId, scheduleSave, onStatusChange, onNavigatePage, onContentSynced])

  // Sincronización in-place cuando otra persona edita la misma página:
  // usa editor.render() sin desmontar ni destruir el DOM del editor, evitando
  // parpadeos y preservando el scroll y el estado.
  useEffect(() => {
    const onRemoteContent = async (event) => {
      const incoming = event.detail
      const editor = editorRef.current
      if (!editor || !incoming?.blocks) return

      // Si el usuario local está escribiendo en este momento, no pisarle el texto
      if (pendingRef.current) return

      try {
        await editor.isReady
        await editor.render({ blocks: incoming.blocks })
        onContentSynced?.(incoming)
      } catch (err) {
        console.warn('Error al aplicar contenido remoto en Editor.js:', err)
      }
    }

    window.addEventListener(`flashlab:remote-page-content-${pageId}`, onRemoteContent)
    return () => {
      window.removeEventListener(`flashlab:remote-page-content-${pageId}`, onRemoteContent)
    }
  }, [pageId, onContentSynced])

  // Notificar a los demás colaboradores qué bloque / línea estamos editando
  useEffect(() => {
    const holder = holderRef.current
    if (!holder || !broadcastElementFocus) return

    const updateFocusedBlock = () => {
      const activeEl = document.activeElement
      if (!activeEl || !holder.contains(activeEl)) return

      const blockEl = activeEl.closest('.ce-block')
      if (!blockEl) return

      const blockId = blockEl.dataset?.id || null
      const allBlocks = Array.from(holder.querySelectorAll('.ce-block'))
      const blockIndex = allBlocks.indexOf(blockEl)

      if (blockIndex >= 0) {
        broadcastElementFocus({ blockIndex, blockId })
      }
    }

    const handleBlur = (e) => {
      if (!holder.contains(e.relatedTarget)) {
        broadcastElementFocus({ blockIndex: null, blockId: null })
      }
    }

    holder.addEventListener('focusin', updateFocusedBlock)
    holder.addEventListener('click', updateFocusedBlock)
    holder.addEventListener('keyup', updateFocusedBlock)
    holder.addEventListener('focusout', handleBlur)

    return () => {
      holder.removeEventListener('focusin', updateFocusedBlock)
      holder.removeEventListener('click', updateFocusedBlock)
      holder.removeEventListener('keyup', updateFocusedBlock)
      holder.removeEventListener('focusout', handleBlur)
    }
  }, [broadcastElementFocus])

  // Mostrar visualmente en qué bloque / línea está ubicado cada colaborador
  // (barra lateral izquierda en el bloque + badge con su nombre, estilo Google Docs / Word)
  useEffect(() => {
    const holder = holderRef.current
    if (!holder) return

    // Limpiar marcas previas
    holder.querySelectorAll('.collab-block-badge').forEach((el) => el.remove())
    holder.querySelectorAll('.collab-block-active').forEach((el) => {
      el.classList.remove('collab-block-active')
      el.style.borderLeft = ''
      el.style.paddingLeft = ''
      el.style.borderRadius = ''
      el.style.position = ''
    })

    const allBlocks = Array.from(holder.querySelectorAll('.ce-block'))
    if (allBlocks.length === 0 || !remoteCursors) return

    Object.values(remoteCursors).forEach((c) => {
      if (!c || c.hidden) return
      let targetBlock = null
      if (c.activeBlockId) {
        targetBlock = holder.querySelector(`.ce-block[data-id="${c.activeBlockId}"]`)
      }
      if (!targetBlock && c.activeBlockIndex != null && c.activeBlockIndex >= 0 && c.activeBlockIndex < allBlocks.length) {
        targetBlock = allBlocks[c.activeBlockIndex]
      }
      if (targetBlock) {
        targetBlock.classList.add('collab-block-active')
        targetBlock.style.position = 'relative'
        targetBlock.style.borderLeft = `3.5px solid ${c.color?.bg || '#2563eb'}`
        targetBlock.style.paddingLeft = '6px'
        targetBlock.style.transition = 'border-color 0.15s ease, padding 0.15s ease'

        const badge = document.createElement('div')
        badge.className = 'collab-block-badge pointer-events-none absolute -top-2.5 left-2 z-20 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-xs select-none'
        badge.style.backgroundColor = c.color?.bg || '#2563eb'
        badge.textContent = c.name
        targetBlock.appendChild(badge)
      }
    })
  }, [remoteCursors])

  // Vaciar el autosave pendiente cuando el proceso principal avisa del cierre
  useEffect(() => {
    const unsubscribe = api.onBeforeClose(async () => {
      clearTimeout(saveTimerRef.current)
      try {
        await persist()
      } finally {
        api.confirmClose()
      }
    })
    return unsubscribe
  }, [persist])

  // Atajo "Guardar" (Ctrl+S, vía menú nativo) y "Exportar" (Archivo > Exportar…)
  useEffect(() => {
    const onForceSave = () => {
      clearTimeout(saveTimerRef.current)
      persist()
    }
    const onExport = async (event) => {
      const editor = editorRef.current
      if (!editor) return
      const { format } = event.detail
      const data = await editor.save()
      const title = document.getElementById('page-title')?.value || 'Sin título'
      const { toMarkdown, toHtml } = await import('../lib/exportBlocks.js')
      const ext = format === 'markdown' ? 'md' : 'html'
      const content = format === 'markdown' ? toMarkdown(data.blocks, title) : toHtml(data.blocks, title)
      const safeName = title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'pagina'
      await api.exportFile(content, `${safeName}.${ext}`, {
        name: format === 'markdown' ? 'Markdown' : 'HTML',
        extensions: [ext],
      })
    }
    window.addEventListener('app:force-save', onForceSave)
    window.addEventListener('app:export', onExport)
    return () => {
      window.removeEventListener('app:force-save', onForceSave)
      window.removeEventListener('app:export', onExport)
    }
  }, [persist])

  return <div ref={holderRef} />
}
