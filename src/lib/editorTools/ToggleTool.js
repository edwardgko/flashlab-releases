// Bloque propio: toggle colapsable con un resumen y un cuerpo de texto enriquecido.
// No es un contenedor de bloques anidados de Editor.js (eso exigiría instancias de
// editor anidadas); alcanza para el uso tipo "sección plegable" de la Fase 5.
export default class ToggleTool {
  static get toolbox() {
    return {
      title: 'Toggle',
      icon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>',
    }
  }

  static get sanitize() {
    const inline = { a: { href: true }, b: {}, i: {}, mark: {}, code: {} }
    return { text: inline, body: inline }
  }

  constructor({ data }) {
    this.data = {
      text: data.text || '',
      body: data.body || '',
      collapsed: data.collapsed ?? false,
    }
    this.bodyEl = null
    this.caretEl = null
    this.textEl = null
  }

  render() {
    const wrapper = document.createElement('div')
    wrapper.className = 'toggle-block'

    const header = document.createElement('div')
    header.className = 'toggle-header'

    this.caretEl = document.createElement('button')
    this.caretEl.type = 'button'
    this.caretEl.className = 'toggle-caret'
    this.caretEl.setAttribute('aria-label', 'Expandir o colapsar')
    this.caretEl.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>'
    this.caretEl.addEventListener('click', () => this.toggle())

    this.textEl = document.createElement('div')
    this.textEl.className = 'toggle-text'
    this.textEl.contentEditable = true
    this.textEl.innerHTML = this.data.text
    this.textEl.dataset.placeholder = 'Encabezado del toggle'

    header.appendChild(this.caretEl)
    header.appendChild(this.textEl)

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'toggle-body'
    this.bodyEl.contentEditable = true
    this.bodyEl.innerHTML = this.data.body
    this.bodyEl.dataset.placeholder = 'Contenido…'

    wrapper.appendChild(header)
    wrapper.appendChild(this.bodyEl)
    this.applyCollapsed()
    return wrapper
  }

  toggle() {
    this.data.collapsed = !this.data.collapsed
    this.applyCollapsed()
  }

  applyCollapsed() {
    this.bodyEl.style.display = this.data.collapsed ? 'none' : ''
    this.caretEl.style.transform = this.data.collapsed ? 'rotate(0deg)' : 'rotate(90deg)'
  }

  save() {
    return { text: this.textEl.innerHTML, body: this.bodyEl.innerHTML, collapsed: this.data.collapsed }
  }
}
