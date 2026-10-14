import { useEffect, useRef, useState } from 'react'

// Reordenar arrastrando una manija, con pointer events (no el drag & drop
// nativo de HTML5, que con el dedo no anda en el WebView de Android): mismo
// código para mouse y touch. Los ítems no se mueven en el DOM mientras se
// arrastra, solo se corren con transform para hacerle lugar al que se lleva;
// el orden real cambia recién al soltar: onReorder(from, to), con `to` =
// índice entre los DEMÁS ítems (lo mismo que espera movePage).
// Lo usan Finanzas (FinanceView) y la tabla de las bases de datos.
//
// containerRef va en el padre directo de los ítems (<ul>, <tbody>): al
// empezar a arrastrar se miden sus hijos.

const AUTOSCROLL_EDGE = 56

// el primer ancestro que de verdad scrollea en vertical — mirar solo el
// overflow no alcanza: un overflow-x-auto (el de la tabla) deja overflow-y
// en auto aunque no haya nada que scrollear en vertical
function scrollParentOf(el) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

export function useSortableList({ count, onReorder }) {
  const containerRef = useRef(null)
  // lo que cambia en cada pointermove sin necesitar render propio
  const dragRef = useRef(null)
  const [drag, setDrag] = useState(null) // { from, over, dy, height }

  useEffect(() => () => cancelAnimationFrame(dragRef.current?.raf ?? 0), [])

  const update = () => {
    const d = dragRef.current
    if (!d) return
    // coordenadas de contenido (clientY + scroll), así el autoscroll no
    // descuadra el ítem de debajo del dedo
    const dy = d.lastClientY + (d.scroller?.scrollTop ?? 0) - d.startY
    const center = d.mids[d.from] + dy
    d.over = d.mids.filter((mid, i) => i !== d.from && mid < center).length
    setDrag({ from: d.from, over: d.over, dy, height: d.height })
  }

  const autoScroll = () => {
    const d = dragRef.current
    if (!d) return
    if (d.scroller) {
      const box = d.scroller.getBoundingClientRect()
      let speed = 0
      if (d.lastClientY < box.top + AUTOSCROLL_EDGE) {
        speed = -Math.ceil((box.top + AUTOSCROLL_EDGE - d.lastClientY) / 6)
      } else if (d.lastClientY > box.bottom - AUTOSCROLL_EDGE) {
        speed = Math.ceil((d.lastClientY - (box.bottom - AUTOSCROLL_EDGE)) / 6)
      }
      if (speed) {
        d.scroller.scrollTop += speed
        update()
      }
    }
    d.raf = requestAnimationFrame(autoScroll)
  }

  const startDrag = (event, index) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const scroller = scrollParentOf(containerRef.current)
    const scrollTop = scroller?.scrollTop ?? 0
    const rects = [...containerRef.current.children].map((item) => item.getBoundingClientRect())
    dragRef.current = {
      scroller,
      from: index,
      over: index,
      height: rects[index].height,
      startY: event.clientY + scrollTop,
      lastClientY: event.clientY,
      mids: rects.map((rect) => rect.top + scrollTop + rect.height / 2),
      raf: 0,
    }
    dragRef.current.raf = requestAnimationFrame(autoScroll)
    setDrag({ from: index, over: index, dy: 0, height: rects[index].height })
  }

  const moveDrag = (event) => {
    if (!dragRef.current) return
    dragRef.current.lastClientY = event.clientY
    update()
  }

  const endDrag = (commit) => {
    const d = dragRef.current
    if (!d) return
    cancelAnimationFrame(d.raf)
    dragRef.current = null
    setDrag(null)
    if (commit && d.over !== d.from) onReorder(d.from, d.over)
  }

  // teclado: flechas sobre la manija mueven de a un lugar
  const onHandleKey = (event, index) => {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null
    if (to === null) return
    event.preventDefault()
    if (to >= 0 && to < count) onReorder(index, to)
  }

  const handleProps = (index) => ({
    onPointerDown: (event) => startDrag(event, index),
    onPointerMove: moveDrag,
    onPointerUp: () => endDrag(true),
    onPointerCancel: () => endDrag(false),
    onKeyDown: (event) => onHandleKey(event, index),
  })

  // dragging: el que se lleva. shifting: hay un arrastre en curso y este
  // ítem se corre para hacerle lugar — la transición va SOLO entonces: si
  // quedara puesta al soltar, el salto del transform al orden nuevo se
  // animaría y los ítems "volarían".
  const itemState = (index) => {
    if (!drag) return { style: undefined, dragging: false, shifting: false }
    if (index === drag.from) return { style: { transform: `translateY(${drag.dy}px)` }, dragging: true, shifting: false }
    let offset = 0
    if (drag.from < drag.over && index > drag.from && index <= drag.over) offset = -drag.height
    if (drag.over < drag.from && index >= drag.over && index < drag.from) offset = drag.height
    return { style: offset ? { transform: `translateY(${offset}px)` } : undefined, dragging: false, shifting: true }
  }

  return { containerRef, handleProps, itemState }
}
