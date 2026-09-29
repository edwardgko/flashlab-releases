import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, isDesktop } from '../lib/api.js'
import { resolveDuration } from '../lib/video.js'
import { getDriveUploadsVersion, subscribeDriveUploads, withLiveDriveState } from '../lib/driveUploadTracker.js'

const RecordingEditor = lazy(() => import('./RecordingEditor.jsx'))

function formatDate(ts) {
  return new Date(ts).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })
}

// clases compartidas por todas las acciones de una tarjeta. Antes cada botón
// repetía text-gray-400/dark:text-neutral-500 con px-1.5 py-0.5: demasiado
// flojo de contraste contra el fondo (reportado como "no se ven estos textos
// e iconos") y con un área de toque muy chica para mobile. Un tono más
// oscuro y algo más de padding lo arregla sin volverlos protagonistas.
const ACTION_CLASS =
  'rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'

function RecordingCard({ rec, expanded, onToggle, onOpenPage, onEdit, onDelete, onUploadDrive, onReshareDrive }) {
  const [confirming, setConfirming] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [copying, setCopying] = useState(false)
  // null | 'sharing' | { shared, failed } | { error }
  const [reshare, setReshare] = useState(null)
  const handleCopy = async () => {
    setCopyError('')
    setCopying(true)
    try {
      // arma un .mp4 antes de copiar (el original queda intacto), así que
      // esto ya no es instantáneo — puede tardar según la duración
      await api.copyRecordingToFolder(rec.pageId, rec.id)
    } catch (err) {
      setCopyError(err.message || 'no se pudo copiar')
    } finally {
      setCopying(false)
    }
  }
  const handleCancelDrive = async () => {
    await api.cancelDriveUpload(rec.pageId, rec.id)
  }
  const handleReshareDrive = async () => {
    setReshare('sharing')
    try {
      setReshare(await onReshareDrive(rec))
    } catch (err) {
      setReshare({ error: err.message || 'no se pudo compartir' })
    }
  }
  return (
    <li className="rounded-lg border border-gray-200 p-3 dark:border-neutral-700">
      {/* Título y acciones van SIEMPRE en renglones separados, nunca lado a
      lado. Antes el contenedor era sm:flex-row sm:justify-between con el
      título en una columna min-w-0 y las acciones en otra: como el título es
      el único que podía encogerse, la fila de hasta 7 acciones (☁️ Drive/
      Reenviar acceso/Volver a subir/<página>/Editar/Copiar/Eliminar) lo
      aplastaba hasta quedar pegado al "☁️ Drive" sin separación, y encima
      "Eliminar" caía sola a un segundo renglón. Con las acciones en su
      propio renglón a lo ancho de la tarjeta entran holgadas y el título
      nunca se aplasta — y es lo que ya funcionaba en mobile, así que ahora
      desktop y mobile se ven igual. */}
      <div className="flex flex-col gap-2">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onToggle}
            className="block w-full truncate text-left text-sm font-medium text-gray-800 hover:underline dark:text-neutral-100"
          >
            🎥 {rec.name}
          </button>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-neutral-400">{formatDate(rec.createdAt)}</p>
        </div>
        {/* gap-y más grande que gap-x: si igual wrappea (mobile angosto), los
        renglones no se confunden entre sí */}
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
          {!rec.driveStatus && (
            <button
              type="button"
              onClick={() => onUploadDrive(rec)}
              className={ACTION_CLASS}
            >
              Subir a Drive
            </button>
          )}
          {(rec.driveStatus === 'uploading' || rec.driveStatus === 'converting') && (
            <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-neutral-400">
              {rec.driveStatus === 'converting' ? 'Preparando video' : 'Subiendo a Drive'}
              {typeof rec.driveProgress === 'number' ? ` ${rec.driveProgress}%` : '…'}
              <button
                type="button"
                onClick={handleCancelDrive}
                className="ml-0.5 rounded-md px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-red-400"
              >
                Cancelar
              </button>
            </span>
          )}
          {rec.driveStatus === 'done' && (
            <>
              <button
                type="button"
                onClick={() => api.openExternal(rec.driveUrl)}
                className={ACTION_CLASS}
              >
                ☁️ Drive
              </button>
              {isDesktop && (
                <button
                  type="button"
                  onClick={handleReshareDrive}
                  disabled={reshare === 'sharing'}
                  title="Volver a darle acceso en Drive a todos los que tienen la página compartida"
                  className={`${ACTION_CLASS} disabled:opacity-50`}
                >
                  {reshare === 'sharing' ? 'Compartiendo…' : 'Reenviar acceso'}
                </button>
              )}
              {isDesktop && (
                <button
                  type="button"
                  onClick={() => onUploadDrive(rec)}
                  title="Reemplazar el archivo en Drive (mismo link) — sirve para las que se subieron sin audio"
                  className={ACTION_CLASS}
                >
                  Volver a subir
                </button>
              )}
            </>
          )}
          {rec.driveStatus === 'error' && (
            <button
              type="button"
              title={rec.driveError || undefined}
              onClick={() => onUploadDrive(rec)}
              className="rounded-md px-2 py-1 text-xs text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/50"
            >
              Reintentar Drive
            </button>
          )}
          <button
            type="button"
            onClick={onOpenPage}
            title={rec.pageTitle}
            className="max-w-[12rem] truncate rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 hover:underline dark:text-blue-400 dark:hover:bg-blue-950/40"
          >
            {rec.pageTitle} →
          </button>
          {isDesktop && (
            <button
              type="button"
              onClick={onEdit}
              className={ACTION_CLASS}
            >
              Editar
            </button>
          )}
          {isDesktop && (
            <button
              type="button"
              title={copyError || 'Guardar una copia en .mp4, lista para ver con otro programa'}
              onClick={handleCopy}
              disabled={copying}
              className={
                copyError
                  ? 'rounded-md px-2 py-1 text-xs text-red-600 disabled:opacity-50 dark:text-red-400'
                  : `${ACTION_CLASS} disabled:opacity-50`
              }
            >
              {copying ? 'Copiando…' : 'Copiar'}
            </button>
          )}
          <button
            type="button"
            onClick={() => (confirming ? onDelete() : setConfirming(true))}
            onMouseLeave={() => setConfirming(false)}
            className={
              confirming
                ? 'rounded-md bg-red-100 px-2 py-1 text-xs text-red-600 dark:bg-red-950 dark:text-red-400'
                : ACTION_CLASS
            }
          >
            {confirming ? '¿Borrar?' : 'Eliminar'}
          </button>
        </div>
      </div>
      {reshare && reshare !== 'sharing' && (
        <p
          className={`mt-1.5 text-xs ${
            reshare.error || reshare.failed?.length
              ? 'text-red-600 dark:text-red-400'
              : 'text-gray-400 dark:text-neutral-500'
          }`}
        >
          {reshare.error
            ? reshare.error
            : reshare.failed?.length
              ? `No se pudo compartir con ${reshare.failed.map((f) => f.email).join(', ')}`
              : `Listo: ${reshare.shared} ${reshare.shared === 1 ? 'persona ya puede' : 'personas ya pueden'} abrir esta grabación.`}
        </p>
      )}
      {expanded && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={rec.url}
          controls
          onLoadedMetadata={(event) => resolveDuration(event.currentTarget, rec.url)}
          className="mt-3 w-full rounded-lg border border-gray-200 dark:border-neutral-700"
        />
      )}
    </li>
  )
}

// grabación publicada por otro en una página compartida conmigo: el archivo
// vive en el disco y el Drive de esa persona, así que acá solo se puede
// abrir en Drive — nada de Editar, Copiar ni Eliminar (ver
// 0019_page_recordings.sql: la policy tampoco lo permitiría).
function SharedRecordingCard({ rec, onOpenPage }) {
  return (
    <li className="rounded-lg border border-gray-200 p-3 dark:border-neutral-700">
      {/* mismo criterio que RecordingCard: título arriba, acciones en su
      propio renglón — así las dos tarjetas se ven iguales en la lista */}
      <div className="flex flex-col gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-800 dark:text-neutral-100">🎥 {rec.name}</p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-neutral-400">
            {formatDate(rec.createdAt)} · solo lectura
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
          <button
            type="button"
            onClick={() => api.openExternal(rec.driveUrl)}
            className={ACTION_CLASS}
          >
            ☁️ Ver en Drive
          </button>
          <button
            type="button"
            onClick={() => onOpenPage(rec.pageId)}
            title={rec.pageTitle}
            className="max-w-[12rem] truncate rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 hover:underline dark:text-blue-400 dark:hover:bg-blue-950/40"
          >
            {rec.pageTitle} →
          </button>
        </div>
      </div>
    </li>
  )
}

export default function RecordingsView({ insetLeft = false, onOpenPage }) {
  const [recordings, setRecordings] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [editingRec, setEditingRec] = useState(null)
  // las que publicó otro en páginas que me compartieron (solo lectura)
  const [sharedRecordings, setSharedRecordings] = useState([])
  const [refreshing, setRefreshing] = useState(false)
  // qué grabaciones ya se publicaron en esta sesión, para no repetir el upsert
  const publishedRef = useRef(new Set())
  // re-renderiza cuando cambia el % de subida a Drive de cualquier
  // grabación — mismo motivo que en PageView.jsx, ver driveUploadTracker.js.
  useSyncExternalStore(subscribeDriveUploads, getDriveUploadsVersion)

  // releer la lista del disco: la usa el botón ↻ y el primer render. Sirve
  // cuando una grabación se agregó o terminó de subir a Drive desde otra
  // vista (o desde una corrida anterior de la app) y esta lista quedó vieja.
  const refresh = async () => {
    setRefreshing(true)
    try {
      const [mine, shared] = await Promise.all([
        api.listAllRecordings(),
        api.listSharedRecordings().catch(() => []),
      ])
      setRecordings(mine)
      setSharedRecordings(shared)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    api.listAllRecordings().then((list) => {
      if (!cancelled) setRecordings(list)
    })
    api.listSharedRecordings().then(
      (list) => {
        if (!cancelled) setSharedRecordings(list)
      },
      (err) => console.error('no se pudieron cargar las grabaciones compartidas:', err)
    )
    return () => {
      cancelled = true
    }
  }, [])

  // otra vista (PageView) pudo haber editado esta misma grabación, o
  // terminó de subir a Drive en segundo plano — reflejarlo acá también
  useEffect(
    () =>
      api.onRecordingsUpdated(({ recordingId, patch }) => {
        setRecordings((prev) => prev?.map((r) => (r.id === recordingId ? { ...r, ...patch } : r)) ?? prev)
      }),
    []
  )

  // recién subidas a Drive: publicarlas para que le aparezcan a quien tenga
  // la página compartida (mismo upsert idempotente que hace PageView al
  // abrir una página, ver 0019_page_recordings.sql)
  useEffect(() => {
    if (!isDesktop || !recordings) return
    for (const rec of recordings) {
      if (rec.driveStatus !== 'done' || !rec.driveUrl) continue
      const stamp = `${rec.id}:${rec.name}:${rec.driveUrl}`
      if (publishedRef.current.has(stamp)) continue
      publishedRef.current.add(stamp)
      api.publishRecording(rec.pageId, rec).catch((err) => console.error('no se pudo publicar la grabación:', err))
    }
  }, [recordings])

  const deleteRecording = async (rec) => {
    // que deje de aparecerle también a quien tiene la página compartida
    api.unpublishRecording(rec.id).catch((err) => console.error('no se pudo despublicar la grabación:', err))
    await api.deleteRecording(rec.pageId, rec.id)
    setRecordings((prev) => prev.filter((r) => r.id !== rec.id))
    setExpandedId((id) => (id === rec.id ? null : id))
  }

  // sirve tanto para grabaciones que nunca se subieron como para reintentar
  // una que falló — conecta Drive primero si todavía no está conectado
  // (mismo baile OAuth que el checkbox de PageView.jsx).
  const uploadRecordingToDriveNow = async (rec) => {
    setRecordings((prev) => prev?.map((r) => (r.id === rec.id ? { ...r, driveStatus: 'uploading', driveError: null } : r)) ?? prev)
    try {
      const { connected } = await api.getDriveAuthStatus()
      if (!connected) await api.connectDriveUnified()
    } catch (err) {
      setRecordings(
        (prev) =>
          prev?.map((r) =>
            r.id === rec.id
              ? { ...r, driveStatus: 'error', driveError: err.message || 'no se pudo conectar con Drive' }
              : r
          ) ?? prev
      )
      return
    }
    const shares = await api.listShares(rec.pageId).catch(() => [])
    api.uploadRecordingToDrive(rec.pageId, rec.id, shares.map((s) => s.email))
  }

  // el archivo de Drive se comparte una sola vez, al terminar la subida: a
  // quien se sume a la página después no le llega nada. Esto vuelve a
  // repartir el acceso con los compartidos de AHORA.
  const reshareOnDrive = async (rec) => {
    const shares = await api.listShares(rec.pageId)
    const emails = shares.map((s) => s.email)
    if (emails.length === 0) throw new Error('esta página todavía no está compartida con nadie')
    return api.shareRecordingOnDrive(rec.pageId, rec.id, emails)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex h-10 shrink-0 items-center justify-between px-6 ${insetLeft ? 'pl-14' : ''}`}>
        <span className="text-sm font-medium text-gray-700 dark:text-neutral-200">Grabaciones</span>
        <button
          type="button"
          aria-label="Recargar grabaciones"
          title="Recargar grabaciones"
          onClick={refresh}
          disabled={refreshing}
          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <span className={refreshing ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 sm:px-10">
        {recordings === null && <p className="mt-8 text-sm text-gray-400 dark:text-neutral-500">Cargando…</p>}
        {recordings?.length === 0 && sharedRecordings.length === 0 && (
          <p className="mt-8 text-sm text-gray-400 dark:text-neutral-500">
            Todavía no grabaste nada. Abrí una página y usá el botón "Grabar" del header.
          </p>
        )}
        {recordings && recordings.length > 0 && (
          <ul className="mt-4 max-w-2xl space-y-2">
            {recordings.map((rec) => (
              <RecordingCard
                key={rec.id}
                rec={withLiveDriveState(rec)}
                expanded={expandedId === rec.id}
                onToggle={() => setExpandedId((id) => (id === rec.id ? null : rec.id))}
                onOpenPage={() => onOpenPage(rec.pageId)}
                onEdit={() => setEditingRec(rec)}
                onDelete={() => deleteRecording(rec)}
                onUploadDrive={uploadRecordingToDriveNow}
                onReshareDrive={reshareOnDrive}
              />
            ))}
          </ul>
        )}
        {sharedRecordings.length > 0 && (
          <div className="mt-6 max-w-2xl">
            {/* en la web esta lista incluye también las propias (no hay
                lista local que las muestre aparte), así que el rótulo
                "Compartidas conmigo" sería incorrecto ahí */}
            <p className="mb-2 text-xs font-medium text-gray-400 dark:text-neutral-500">
              {isDesktop ? 'Compartidas conmigo' : 'En Google Drive'}
            </p>
            <ul className="space-y-2">
              {sharedRecordings.map((rec) => (
                <SharedRecordingCard key={rec.id} rec={rec} onOpenPage={onOpenPage} />
              ))}
            </ul>
          </div>
        )}
      </div>
      {editingRec && (
        <Suspense fallback={null}>
          <RecordingEditor
            rec={editingRec}
            pageId={editingRec.pageId}
            onClose={() => setEditingRec(null)}
            onSaved={(updated) => setRecordings((prev) => prev.map((r) => (r.id === updated.id ? { ...r, url: updated.url } : r)))}
          />
        </Suspense>
      )}
    </div>
  )
}
