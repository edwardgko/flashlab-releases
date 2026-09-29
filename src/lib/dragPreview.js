// Imagen "fantasma" del arrastre (HTML5 drag & drop).
//
// El navegador usa como imagen de arrastre una foto del elemento sobre el
// que se disparó `dragstart`. Cuando ese elemento es el manijita de 6 puntos
// (tabla y lista de bases de datos, columnas, tarjetas del tablero, árbol
// del sidebar), lo que sigue al cursor es un cuadradito de 20px con seis
// puntitos y nada más — imposible saber qué estás moviendo si hay varias
// filas parecidas.
//
// `setDragPreview(event, elementoDeVerdad)` reemplaza esa foto por una de la
// FILA/TARJETA entera. Se clona el elemento real (no se dibuja nada a mano)
// así la vista previa siempre queda igual a lo que se está moviendo, sin
// tener que mantener dos versiones del mismo diseño en paralelo.

const PREVIEW_ID = 'flashlab-drag-preview'
const MAX_WIDTH = 360
const MAX_HEIGHT = 220

// cloneNode(true) copia el ATRIBUTO value, no la propiedad — un <textarea>
// clonado sale con el texto original del render, no con lo que hay tipeado
// ahora (los títulos de fila son textareas, ver InlineTitle). Se copian a
// mano recorriendo los dos árboles en paralelo, que tienen la misma forma
// por construcción.
function copyFieldValues(source, clone) {
  const fields = source.querySelectorAll('input, textarea, select')
  const clonedFields = clone.querySelectorAll('input, textarea, select')
  fields.forEach((field, i) => {
    const target = clonedFields[i]
    if (!target) return
    if (field.type === 'checkbox' || field.type === 'radio') target.checked = field.checked
    else target.value = field.value
  })
}

// Los controles que solo aparecen al pasar el mouse (opacity-0 +
// group-hover: duplicar, eliminar, abrir) están en el DOM aunque no se vean.
// Clonados tal cual, el clon los muestra con opacidad heredada del clon (no
// del original) y la miniatura sale con botones que en pantalla no estaban.
//
// La tentación es borrar todos los <button> del clon — y estaría MAL: en el
// árbol del sidebar el título de la página vive DENTRO de un button, así que
// eso dejaría la miniatura vacía. Se mira lo que de verdad importa, que es
// si el nodo ORIGINAL se ve o no.
function dropInvisibleNodes(source, clone) {
  const sourceNodes = source.querySelectorAll('*')
  const clonedNodes = clone.querySelectorAll('*')
  const doomed = []
  sourceNodes.forEach((node, i) => {
    const style = getComputedStyle(node)
    if (style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none') {
      if (clonedNodes[i]) doomed.push(clonedNodes[i])
    }
  })
  // recién acá: sacar nodos DURANTE el recorrido desalinearía las dos listas
  doomed.forEach((node) => node.remove())
}

// un <tr> suelto fuera de una tabla no se renderiza (el navegador lo tira o
// lo colapsa) — hay que devolverle su <table><tbody> alrededor, copiando el
// ancho de la tabla original para que las columnas caigan donde caían.
function wrapIfTableRow(source, clone) {
  if (source.tagName !== 'TR') return clone
  const table = document.createElement('table')
  const sourceTable = source.closest('table')
  table.className = sourceTable?.className ?? ''
  table.style.width = `${source.getBoundingClientRect().width}px`
  table.style.tableLayout = 'fixed'
  const tbody = document.createElement('tbody')
  tbody.appendChild(clone)
  table.appendChild(tbody)
  return table
}

export function setDragPreview(event, source, { offsetX = 16, offsetY = 16 } = {}) {
  const dataTransfer = event?.dataTransfer
  if (!source || typeof dataTransfer?.setDragImage !== 'function') return
  const rect = source.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  document.getElementById(PREVIEW_ID)?.remove()

  const clone = source.cloneNode(true)
  copyFieldValues(source, clone)
  dropInvisibleNodes(source, clone)

  const holder = document.createElement('div')
  holder.id = PREVIEW_ID
  holder.appendChild(wrapIfTableRow(source, clone))
  // fuera de la pantalla pero RENDERIZADO: Chromium saca la foto del layout
  // real, así que no sirve display:none ni visibility:hidden — sí sirve
  // mandarlo a coordenadas negativas.
  Object.assign(holder.style, {
    position: 'fixed',
    top: '0px',
    left: '-10000px',
    width: `${Math.min(rect.width, MAX_WIDTH)}px`,
    maxHeight: `${MAX_HEIGHT}px`,
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: '6px 8px',
    borderRadius: '10px',
    // fondo propio: el elemento original casi siempre es transparente y
    // hereda el de la página; sin esto la foto sale con el texto flotando
    // sobre un fondo negro (así lo rellena el compositor).
    background: 'var(--drag-preview-bg, #ffffff)',
    color: 'inherit',
    border: '1px solid var(--drag-preview-border, rgba(0,0,0,0.12))',
    boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
    opacity: '0.92',
    pointerEvents: 'none',
    zIndex: '-1',
  })
  document.body.appendChild(holder)

  dataTransfer.setDragImage(holder, offsetX, offsetY)
  // la foto se saca al TERMINAR de despachar dragstart, así que recién en el
  // próximo tick se puede sacar el clon del DOM.
  setTimeout(() => holder.remove(), 0)
}

// atajo para el caso más común: el `dragstart` salió de la manijita, y el
// elemento que de verdad se arrastra es un ancestro suyo.
export function setDragPreviewFromHandle(event, selector) {
  setDragPreview(event, event.currentTarget?.closest(selector))
}
