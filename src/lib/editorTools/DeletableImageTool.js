import ImageTool from '@editorjs/image'

// Editor.js YA permite borrar cualquier bloque (imágenes incluidas) desde el
// menú "⋮⋮ → Eliminar" a la izquierda del bloque — pero está escondido detrás
// de un ícono que hay que descubrir primero. Esta subclase agrega, además, un
// botón ✕ directo sobre la esquina de la imagen (visible al pasar el mouse),
// mismo lenguaje visual que ya usa el resto de la app para "sacar esto de
// acá" (ver PendingUploadBubble en ChatView.jsx). El "Eliminar" del menú de
// tunes se deja intacto, esto es un atajo más, no un reemplazo.
export default class DeletableImageTool extends ImageTool {
  render() {
    const wrapper = super.render()
    const deleteButton = document.createElement('button')
    deleteButton.type = 'button'
    deleteButton.className = 'image-tool__delete-btn'
    deleteButton.setAttribute('aria-label', 'Eliminar imagen')
    deleteButton.title = 'Eliminar imagen'
    deleteButton.textContent = '✕'
    deleteButton.addEventListener('click', (event) => {
      // sin esto, Editor.js interpreta el click como "seleccionar/enfocar
      // el bloque" antes de que llegue a borrarlo — inofensivo, pero innecesario.
      event.preventDefault()
      event.stopPropagation()
      const index = this.api.blocks.getBlockIndex(this.block.id)
      if (index !== undefined) this.api.blocks.delete(index)
    })
    wrapper.appendChild(deleteButton)
    return wrapper
  }
}
