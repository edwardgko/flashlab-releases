// Cola de adjuntos del chat subiendo en segundo plano — vive FUERA de React
// (no es estado de ChatView) justo para sobrevivir a que ChatView se
// desmonte: cambiás a otra pestaña (una página, el calendario) o cerrás el
// chat con un video pesado subiendo y la subida sigue corriendo igual, como
// WhatsApp. Si viviera en un useState de ChatView, React destruiría ese
// estado al desmontar el componente — el XHR seguiría corriendo "a ciegas"
// sin que nada de la UI lo refleje al volver al chat.
//
// Patrón externalStore (useSyncExternalStore en ChatView.jsx): getSnapshot()
// debe devolver SIEMPRE la misma referencia hasta el próximo commit() real,
// si no React re-renderiza en bucle.

const uploads = new Map()
const listeners = new Set()
let snapshot = []

function commit() {
  snapshot = [...uploads.values()]
  listeners.forEach((cb) => cb())
}

export function subscribe(onStoreChange) {
  listeners.add(onStoreChange)
  return () => listeners.delete(onStoreChange)
}

export function getSnapshot() {
  return snapshot
}

// send: (onProgress, signal) => Promise<void> — el caller arma el closure
// (sendAttachment/sendGroupAttachment) con el archivo y el destino ya
// resueltos; acá no se sabe ni hace falta saber de DMs/grupos.
export function enqueueUpload({ kind, targetId, file, previewUrl, send, onError, onDone }) {
  const id = crypto.randomUUID()
  const controller = new AbortController()
  uploads.set(id, { id, kind, targetId, file, previewUrl, progress: 0, controller })
  commit()

  const onProgress = (pct) => {
    const entry = uploads.get(id)
    if (!entry) return
    uploads.set(id, { ...entry, progress: pct })
    commit()
  }

  ;(async () => {
    try {
      await send(onProgress, controller.signal)
      onDone?.()
    } catch (err) {
      if (err?.name !== 'AbortError') onError?.(err)
    } finally {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      uploads.delete(id)
      commit()
    }
  })()

  return id
}

export function cancelUpload(id) {
  uploads.get(id)?.controller.abort()
}
