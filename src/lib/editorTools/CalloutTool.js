const ICONS = ['💡', '⚠️', '📌', '✅', '❗', '📝']

// Bloque propio: Editor.js no trae callout. El icono cicla entre un set fijo
// al hacer click; sin picker para mantener la Fase 5 dentro de su alcance.
export default class CalloutTool {
  static get toolbox() {
    return {
      title: 'Callout',
      icon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2Z"/><path d="M9 21h6"/></svg>',
    }
  }

  static get sanitize() {
    return { text: { a: { href: true }, b: {}, i: {}, mark: {}, code: {} } }
  }

  constructor({ data }) {
    this.data = { text: data.text || '', icon: data.icon || ICONS[0] }
    this.wrapper = null
    this.textEl = null
  }

  render() {
    this.wrapper = document.createElement('div')
    this.wrapper.className = 'callout-block'

    const iconBtn = document.createElement('button')
    iconBtn.type = 'button'
    iconBtn.className = 'callout-icon'
    iconBtn.textContent = this.data.icon
    iconBtn.title = 'Click para cambiar el icono'
    iconBtn.addEventListener('click', () => {
      const next = ICONS[(ICONS.indexOf(this.data.icon) + 1) % ICONS.length]
      this.data.icon = next
      iconBtn.textContent = next
    })

    this.textEl = document.createElement('div')
    this.textEl.className = 'callout-text'
    this.textEl.contentEditable = true
    this.textEl.innerHTML = this.data.text
    this.textEl.dataset.placeholder = 'Escribe una nota destacada…'

    this.wrapper.appendChild(iconBtn)
    this.wrapper.appendChild(this.textEl)
    return this.wrapper
  }

  save() {
    return { text: this.textEl.innerHTML, icon: this.data.icon }
  }
}
