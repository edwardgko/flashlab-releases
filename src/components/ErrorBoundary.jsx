import { Component } from 'react'

// Sin esto, un error de render en cualquier vista (Chat, Calendario, una
// página) tira abajo TODA la app — React desmonta el árbol entero ante una
// excepción no atrapada y no queda nada en pantalla, ni el sidebar. Acá
// contenemos el error a la vista que falló y mostramos el mensaje real, en
// vez de una pantalla negra sin pistas.
export default class ErrorBoundary extends Component {
  state = { error: null, resetKey: undefined }

  static getDerivedStateFromError(error) {
    return { error }
  }

  // si cambia resetKey (p. ej. se pasó a otra pestaña), limpiar el error
  // viejo — se resuelve en render, no con un setState en componentDidUpdate,
  // para no forzar una vuelta extra de render.
  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey }
    }
    return null
  }

  componentDidCatch(error, info) {
    console.error('Error de render atrapado por ErrorBoundary:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-neutral-200">Esta vista tuvo un error.</p>
          <p className="max-w-md text-xs text-gray-500 dark:text-neutral-400">{String(this.state.error?.message || this.state.error)}</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-1 cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            Reintentar
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
