import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { IS_CAPACITOR } from '../lib/supabaseClient.js'
import PageView from './PageView.jsx'

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  )
}

// Panel lateral tipo Notion ("peek"): se superpone a la vista actual sin
// perder su contexto (a diferencia de onNavigate, que reemplaza la pestaña
// entera). Se monta ya presente en el DOM y recién en el siguiente frame
// activa la transición de entrada — animar directo en el render inicial no
// dispara la transición porque el navegador colapsa el cambio de clase con
// el primer paint.
export default function PagePeek({ page, path, onClose, onOpenFullPage, ...pageViewProps }) {
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Android: este panel se abre TAPANDO la pantalla entera (z-[60], igual
  // que el cajón del sidebar) pero, a diferencia de ese cajón, no tenía
  // ningún manejo del botón de atrás del sistema — quedaba igual que
  // Escape del teclado: sin este listener, atrás minimizaba la app en vez
  // de cerrar el panel que se está viendo.
  useEffect(() => {
    if (!IS_CAPACITOR || !page) return undefined
    const subPromise = CapacitorApp.addListener('backButton', () => onClose())
    return () => {
      subPromise.then((sub) => sub.remove())
    }
  }, [page, onClose])

  if (!page) return null

  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div
        className={`absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity duration-200 ${entered ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div
        className={`absolute right-0 top-0 flex h-full w-[min(880px,92vw)] flex-col overflow-hidden bg-white shadow-2xl transition-transform duration-200 ease-out dark:bg-neutral-800 ${
          entered ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex shrink-0 items-center gap-1 border-b border-gray-100 px-3 py-2 dark:border-neutral-700">
          <button
            type="button"
            aria-label="Cerrar"
            title="Cerrar"
            onClick={onClose}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300"
          >
            <CloseIcon />
          </button>
          <button
            type="button"
            aria-label="Abrir como página completa"
            title="Abrir como página completa"
            onClick={onOpenFullPage}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300"
          >
            <ExpandIcon />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <PageView page={page} path={path} {...pageViewProps} />
        </div>
      </div>
    </div>,
    document.body
  )
}
