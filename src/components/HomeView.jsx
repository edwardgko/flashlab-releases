import { isImageIcon } from '../lib/icon.js'

// mismo criterio que ChatView.jsx (formatRelative) — cada archivo tiene el
// suyo, chico y autocontenido, en vez de una lib compartida para esto solo.
function formatRelative(ts) {
  if (!ts) return ''
  const diffMs = Date.now() - ts
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'ahora'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'ayer'
  if (days < 7) return `${days}d`
  return new Date(ts).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
}

function PageIcon({ page, className = 'text-base' }) {
  if (page.icon) {
    return isImageIcon(page.icon) ? (
      <img src={page.icon} alt="" className="h-[1em] w-[1em] shrink-0 rounded-sm object-cover" />
    ) : (
      <span className={`shrink-0 leading-none ${className}`}>{page.icon}</span>
    )
  }
  return <span className={`shrink-0 leading-none ${className}`}>{page.isDatabase ? '🗄️' : '📄'}</span>
}

function QuickAction({ icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-4 text-center hover:bg-gray-50 dark:border-neutral-700 dark:hover:bg-white/5"
    >
      <span className="text-xl">{icon}</span>
      <span className="text-xs font-medium text-gray-600 dark:text-neutral-300">{label}</span>
    </button>
  )
}

function SectionLabel({ children }) {
  return (
    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500">
      {children}
    </p>
  )
}

// MVP recomendado tras la investigación de la ronda: accesos rápidos +
// "seguí donde quedaste" + páginas recientes. Chat sin leer y próximos
// eventos quedan afuera a propósito — ver ROADMAP.md si se agregan después.
export default function HomeView({
  insetLeft = false,
  pages,
  lastOpenedId,
  onOpenPage,
  onCreate,
  onCreateDatabase,
  onSearch,
  onOpenRecordings,
}) {
  const activePages = pages.filter((p) => !p.trashedAt)
  const lastOpened = lastOpenedId ? activePages.find((p) => p.id === lastOpenedId) : null
  const recent = [...activePages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)

  return (
    // el inset de la izquierda (para no tapar el botón flotante de mostrar
    // sidebar) solo desde sm: en adelante — en un teléfono son 56px contra
    // 16px del otro lado, y el contenido se ve corrido a la derecha. En
    // mobile no hace falta: el botón queda arriba del py-10, sin pisar nada.
    <div className={`h-full overflow-y-auto px-4 py-10 sm:px-8 ${insetLeft ? 'sm:pl-16' : ''}`}>
      {/* safe center: centra vertical cuando el contenido entra, pero cae a
          "arriba" si es más alto que la pantalla, en vez de cortar el título */}
      <div className="mx-auto flex min-h-full max-w-2xl flex-col [justify-content:safe_center]">
        <h1 className="mb-6 text-2xl font-semibold text-gray-800 dark:text-neutral-100">Inicio</h1>

        <div className="mb-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <QuickAction icon="🔍" label="Buscar" onClick={onSearch} />
          <QuickAction icon="📄" label="Nueva página" onClick={() => onCreate(null)} />
          <QuickAction icon="🗄️" label="Nueva base de datos" onClick={() => onCreateDatabase(null)} />
          <QuickAction icon="🎥" label="Grabaciones" onClick={onOpenRecordings} />
        </div>

        {lastOpened && (
          <div className="mb-8">
            <SectionLabel>Seguí donde quedaste</SectionLabel>
            <button
              type="button"
              onClick={() => onOpenPage(lastOpened.id)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-gray-200 p-4 text-left hover:bg-gray-50 dark:border-neutral-700 dark:hover:bg-white/5"
            >
              <PageIcon page={lastOpened} className="text-2xl" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-gray-800 dark:text-neutral-100">
                  {lastOpened.title || 'Sin título'}
                </span>
                <span className="text-xs text-gray-400 dark:text-neutral-500">Continuar →</span>
              </span>
            </button>
          </div>
        )}

        {recent.length > 0 ? (
          <div>
            <SectionLabel>Páginas recientes</SectionLabel>
            <div className="flex flex-col gap-0.5">
              {recent.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpenPage(p.id)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-white/5"
                >
                  <PageIcon page={p} />
                  <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-neutral-200">
                    {p.title || 'Sin título'}
                  </span>
                  <span className="shrink-0 text-[11px] text-gray-400 dark:text-neutral-500">
                    {formatRelative(p.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-400 dark:text-neutral-500">Todavía no tenés páginas — creá la primera arriba.</p>
        )}
      </div>
    </div>
  )
}
