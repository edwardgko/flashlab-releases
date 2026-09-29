import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const ROLE_LABEL = { viewer: 'Puede ver', editor: 'Puede editar' }

// Diálogo de "Compartir" (Fase C) — solo lo ve el dueño de la página
// (PageView ya filtra eso). Compartir una base de datos/página comparte
// también sus subpáginas/filas — lo hace has_access() del lado del servidor,
// acá no hay nada que propagar a mano.
export default function ShareDialog({ pageId, onClose, onShared }) {
  const [shares, setShares] = useState(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => api.listShares(pageId).then(setShares)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId])

  const handleShare = async (event) => {
    event.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return
    setError('')
    setSaving(true)
    try {
      await api.sharePage(pageId, trimmed, role)
      setEmail('')
      await load()
      // que las grabaciones que ya están en Drive queden accesibles también
      // para quien recién se suma (ver syncDriveAccessAfterShare en PageView)
      onShared?.()
    } catch (err) {
      setError(err.message || 'no se pudo compartir')
    } finally {
      setSaving(false)
    }
  }

  const handleRoleChange = async (shareId, newRole) => {
    await api.updateShareRole(shareId, newRole)
    await load()
  }

  const handleRemove = async (shareId) => {
    await api.removeShare(shareId)
    await load()
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />
      <div className="fixed left-1/2 top-1/3 z-40 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <p className="mb-3 text-sm font-semibold text-gray-800 dark:text-neutral-100">Compartir página</p>

        <form onSubmit={handleShare} className="flex gap-2">
          <input
            autoFocus
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="email@ejemplo.com"
            className="min-w-0 flex-1 rounded-md border border-gray-200 bg-transparent px-2 py-1.5 text-sm outline-none dark:border-neutral-700"
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="rounded-md border border-gray-200 bg-transparent px-1.5 py-1.5 text-sm outline-none dark:border-neutral-700"
          >
            <option value="viewer">Puede ver</option>
            <option value="editor">Puede editar</option>
          </select>
          <button
            type="submit"
            disabled={saving || !email.trim()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            Invitar
          </button>
        </form>
        {error && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-3 max-h-56 overflow-y-auto">
          {shares === null && <p className="text-xs text-gray-400 dark:text-neutral-500">Cargando…</p>}
          {shares?.length === 0 && (
            <p className="text-xs italic text-gray-400 dark:text-neutral-500">Todavía no compartiste esta página con nadie.</p>
          )}
          {shares?.map((share) => (
            <div key={share.id} className="flex items-center gap-2 py-1 text-sm">
              <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-neutral-200" title={share.email}>
                {share.email}
              </span>
              {!share.claimed && (
                <span className="shrink-0 text-xs text-amber-600 dark:text-amber-400" title="Todavía no se logueó en FlashLab">
                  pendiente
                </span>
              )}
              <select
                value={share.role}
                onChange={(event) => handleRoleChange(share.id, event.target.value)}
                className="shrink-0 rounded-md border border-gray-200 bg-transparent px-1 py-0.5 text-xs outline-none dark:border-neutral-700"
              >
                <option value="viewer">{ROLE_LABEL.viewer}</option>
                <option value="editor">{ROLE_LABEL.editor}</option>
              </select>
              <button
                type="button"
                aria-label="Quitar acceso"
                onClick={() => handleRemove(share.id)}
                className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-neutral-800"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            Cerrar
          </button>
        </div>
      </div>
    </>
  )
}
