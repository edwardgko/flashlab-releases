import { memo } from 'react'

/**
 * Barra superior de avatares con los colaboradores que están viendo / editando
 * la misma página en tiempo real.
 */
function CollaboratorsBar({ collaborators }) {
  if (!collaborators || collaborators.length === 0) return null

  const visible = collaborators.slice(0, 4)
  const remaining = collaborators.length - visible.length

  return (
    <div
      className="flex items-center gap-1.5 rounded-full bg-gray-50/80 px-2 py-0.5 border border-gray-200/70 dark:bg-neutral-800/80 dark:border-neutral-700/70"
      title={`${collaborators.length} colaborador${collaborators.length === 1 ? '' : 'es'} en esta página`}
    >
      <div className="flex -space-x-1.5 overflow-hidden">
        {visible.map((user) => {
          const color = user.color || { bg: '#2563eb', text: '#ffffff' }
          const initial = (user.name || user.email || 'U').charAt(0).toUpperCase()

          return (
            <div
              key={user.userId}
              className="relative inline-block h-6 w-6 rounded-full border-2 border-white shadow-xs dark:border-neutral-900"
              style={{ borderColor: color.bg }}
              title={`${user.name} (${user.email || 'conectado'})`}
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.name}
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                <div
                  className="flex h-full w-full items-center justify-center rounded-full text-[10px] font-bold"
                  style={{ backgroundColor: color.bg, color: color.text }}
                >
                  {initial}
                </div>
              )}
              {/* Punto verde de conexión activa */}
              <span
                className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white bg-emerald-500 dark:border-neutral-900"
                aria-hidden="true"
              />
            </div>
          )
        })}

        {remaining > 0 && (
          <div
            className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-gray-200 text-[10px] font-bold text-gray-700 dark:border-neutral-900 dark:bg-neutral-700 dark:text-neutral-200"
            title={`+${remaining} más`}
          >
            +{remaining}
          </div>
        )}
      </div>

      <span className="text-[11px] font-medium text-gray-500 dark:text-neutral-400 hidden sm:inline">
        {collaborators.length === 1 ? '1 activo' : `${collaborators.length} activos`}
      </span>
    </div>
  )
}

export default memo(CollaboratorsBar)
