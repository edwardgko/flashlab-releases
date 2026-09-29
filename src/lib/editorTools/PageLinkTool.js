const ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'

// Inline tool de Editor.js: envuelve la selección en <a class="page-link"
// data-page-id> y abre un popover propio (no usa renderActions() del core,
// cuyo timing/soporte varía entre versiones) para buscar y elegir la página
// destino. Si se cierra sin elegir, deshace el wrap.
export default class PageLinkTool {
  static get isInline() {
    return true
  }

  static get sanitize() {
    return { a: { href: true, class: true, 'data-page-id': true } }
  }

  constructor({ api, config }) {
    this.api = api
    this.config = config || {}
    this.button = null
    this.anchorEl = null
    this.popover = null
    this.outsideHandler = null
  }

  render() {
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.classList.add(this.api.styles.inlineToolButton)
    this.button.innerHTML = ICON
    this.button.title = 'Enlazar a una página'
    return this.button
  }

  surround(range) {
    const existing = this.api.selection.findParentTag('A', 'page-link')
    if (existing) {
      this.unwrap(existing)
      return
    }
    if (!range || range.collapsed) return
    const anchor = document.createElement('a')
    anchor.className = 'page-link'
    anchor.href = '#'
    anchor.dataset.pageId = ''
    anchor.appendChild(range.extractContents())
    range.insertNode(anchor)
    this.openPopover(anchor)
  }

  unwrap(anchor) {
    const parent = anchor.parentNode
    while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor)
    parent.removeChild(anchor)
  }

  checkState() {
    const anchor = this.api.selection.findParentTag('A', 'page-link')
    this.button?.classList.toggle(this.api.styles.inlineToolButtonActive, !!anchor)
    return !!anchor
  }

  openPopover(anchor) {
    // Solo limpia el DOM de un popover previo, sin pasar por closePopover():
    // this.anchorEl ya apunta al ancla recién creada, y closePopover()
    // desenvolvería inmediatamente cualquier ancla sin data-page-id.
    this.removePopoverDom()
    this.anchorEl = anchor
    const rect = anchor.getBoundingClientRect()
    const popover = document.createElement('div')
    popover.className = 'page-link-popover'
    popover.style.left = `${rect.left}px`
    popover.style.top = `${rect.bottom + 6}px`

    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'Buscar página…'
    input.className = 'page-link-search'

    const list = document.createElement('div')
    list.className = 'page-link-results'

    popover.appendChild(input)
    popover.appendChild(list)
    document.body.appendChild(popover)
    this.popover = popover

    const runSearch = async (query) => {
      const results = (await this.config.searchPages?.(query)) ?? []
      list.innerHTML = ''
      if (results.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'page-link-empty'
        empty.textContent = 'Sin resultados'
        list.appendChild(empty)
        return
      }
      for (const page of results) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'page-link-result'
        item.dataset.resultId = page.id
        item.textContent = page.title || 'Sin título'
        item.addEventListener('mousedown', (event) => {
          event.preventDefault() // no perder la selección antes del click
          anchor.dataset.pageId = page.id
          this.closePopover()
        })
        list.appendChild(item)
      }
    }

    input.addEventListener('input', () => runSearch(input.value))
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closePopover()
    })

    this.outsideHandler = (event) => {
      if (!popover.contains(event.target)) this.closePopover()
    }
    document.addEventListener('mousedown', this.outsideHandler, true)

    requestAnimationFrame(() => input.focus())
    runSearch('')
  }

  removePopoverDom() {
    if (this.popover) {
      this.popover.remove()
      this.popover = null
    }
    if (this.outsideHandler) {
      document.removeEventListener('mousedown', this.outsideHandler, true)
      this.outsideHandler = null
    }
  }

  closePopover() {
    this.removePopoverDom()
    if (this.anchorEl && !this.anchorEl.dataset.pageId) {
      this.unwrap(this.anchorEl)
    }
    this.anchorEl = null
  }
}
