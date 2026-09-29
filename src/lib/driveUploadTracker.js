import { api } from './api.js'

// Vive fuera de React (mismo patrón que screenRecording.js) para sobrevivir
// el desmontaje de PageView/RecordingsView al cambiar de pestaña o de
// archivo. Sin esto, el % de subida a Drive se "perdía" visualmente al
// volver a una pestaña: la subida en sí sigue corriendo bien en el proceso
// main pase lo que pase en el renderer, pero el progreso solo se emite por
// broadcast tick a tick (no se persiste a disco por cada %, ver
// uploadRecordingToDrive en electron/main.js) — un remount vuelve a leer la
// metadata del disco, que todavía tiene el valor de arranque (0%).
// Este store escucha esos broadcasts una sola vez, para toda la vida de la
// app, y guarda el último patch conocido por grabación para que cualquier
// componente que se monte (o remonte) pueda pintar el estado real al toque,
// sin esperar el próximo tick.
const live = new Map() // recordingId -> patch más reciente
const listeners = new Set()
let version = 0

api.onRecordingsUpdated(({ recordingId, patch }) => {
  live.set(recordingId, { ...live.get(recordingId), ...patch })
  version += 1
  listeners.forEach((cb) => cb())
})

export function subscribeDriveUploads(onChange) {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

// snapshot para useSyncExternalStore — no importa el valor en sí, solo que
// cambie para forzar un re-render; la lectura real es getLiveDrivePatch.
export function getDriveUploadsVersion() {
  return version
}

export function getLiveDrivePatch(recordingId) {
  return live.get(recordingId)
}

// aplica el último patch conocido (si hay) sobre una grabación recién leída
// del disco — así un componente recién montado no muestra un % viejo/inicial
// mientras espera el próximo broadcast.
export function withLiveDriveState(rec) {
  const patch = live.get(rec.id)
  return patch ? { ...rec, ...patch } : rec
}
