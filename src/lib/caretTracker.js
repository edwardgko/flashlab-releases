/**
 * Obtiene las coordenadas precisas del puntero de texto (caret) en pantalla
 * relativas al contenedor de scroll de la página.
 */
export function getCaretCoordinates(scrollContainer) {
  if (!scrollContainer) return null
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  if (!range) return null

  // Asegurarse de que el foco esté dentro del contenedor de scroll
  const focusNode = selection.focusNode
  const editable =
    focusNode?.nodeType === Node.ELEMENT_NODE
      ? focusNode.closest('[contenteditable="true"], textarea, input')
      : focusNode?.parentElement?.closest('[contenteditable="true"], textarea, input')

  if (!editable || !scrollContainer.contains(editable)) return null

  const containerRect = scrollContainer.getBoundingClientRect()
  let rect = null

  // 1. Caso textarea o input (p.ej. título de página o título de tarjeta en base de datos)
  if (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT') {
    const elRect = editable.getBoundingClientRect()
    return {
      x: Math.round(elRect.left - containerRect.left + scrollContainer.scrollLeft + 2),
      y: Math.round(elRect.top - containerRect.top + scrollContainer.scrollTop + 4),
      height: Math.min(24, Math.max(16, elRect.height - 8)),
      blockId: editable.id || editable.dataset?.rowId || null,
      blockIndex: null,
      html: null,
      text: editable.value || '',
    }
  }

  // 2. Caso contenteditable (Editor.js)
  const clientRects = range.getClientRects()
  if (clientRects.length > 0) {
    rect = clientRects[0]
  } else {
    rect = range.getBoundingClientRect()
  }

  // Fallback si el rect da 0 (p.ej. párrafo vacío recién creado)
  if (!rect || (rect.left === 0 && rect.top === 0 && rect.height === 0)) {
    const edRect = editable.getBoundingClientRect()
    rect = {
      left: edRect.left + 2,
      top: edRect.top + 2,
      height: Math.min(26, Math.max(16, edRect.height || 20)),
    }
  }

  const blockEl = editable.closest('.ce-block')
  const blockId = blockEl?.dataset?.id || null
  const redactor = editable.closest('.codex-editor__redactor')
  const allBlocks = redactor ? Array.from(redactor.querySelectorAll('.ce-block')) : []
  const blockIndex = blockEl ? allBlocks.indexOf(blockEl) : -1

  return {
    blockId,
    blockIndex,
    x: Math.round(rect.left - containerRect.left + scrollContainer.scrollLeft),
    y: Math.round(rect.top - containerRect.top + scrollContainer.scrollTop),
    height: Math.round(rect.height) || 20,
    html: editable.innerHTML,
    text: editable.innerText,
  }
}
