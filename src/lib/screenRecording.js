import { api } from './api.js'

// Grabación de pantalla — vive FUERA de React (no es estado de PageView) para
// sobrevivir a que PageView se desmonte: antes, cambiar de pestaña (otra
// página, Inicio, Chat, Grabaciones) o incluso volver a la MISMA página en
// otra pestaña remontaba PageView, y su efecto de limpieza cortaba el
// MediaRecorder a propósito ("si cambiás de página con una grabación en
// curso, no dejarla colgada capturando"). Eso hacía que grabar y después
// mirar otra cosa un segundo cortara la grabación entera. Mismo patrón
// externalStore que backgroundUploads.js (useSyncExternalStore en PageView):
// getSnapshot() debe devolver SIEMPRE la misma referencia hasta el próximo
// commit() real, si no React re-renderiza en bucle.

let snapshot = { pageId: null, state: 'idle', startedAt: 0, error: '' }
const listeners = new Set()

function commit(patch) {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((cb) => cb())
}

export function subscribe(onStoreChange) {
  listeners.add(onStoreChange)
  return () => listeners.delete(onStoreChange)
}

export function getSnapshot() {
  return snapshot
}

let mediaRecorder = null
let displayStream = null
let micStream = null
let audioCtx = null
let recordingFilename = null
let lastChunkWrite = Promise.resolve()
let wantsDriveUpload = false

export function isRecordingActive() {
  return snapshot.state !== 'idle'
}

// qué compartir (pantalla completa / una ventana / una pestaña) lo elige el
// propio diálogo nativo que dispara getDisplayMedia — el navegador SIEMPRE
// lo muestra, no hay forma de preseleccionarlo desde código (ni tendría
// sentido: es justamente el permiso explícito que exige la API). No hace
// falta nada nuevo acá para eso.
//
// resolución: capada a propósito (ver comentario más abajo sobre por qué
// 1080p) — 720p entra como opción MÁS chica para máquinas más limitadas
// (pedido explícito), no se ofrece "nativa/sin límite" porque reintroduciría
// el problema de rendimiento que este límite ya resolvió.
const RESOLUTION_PRESETS = {
  '720p': { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } },
  '1080p': { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } },
}

export async function startScreenRecording(
  pageId,
  { saveToDrive = false, includeAudio = true, resolution = '1080p' } = {}
) {
  if (snapshot.state !== 'idle') return // ya hay una grabación en curso (de esta u otra página)
  wantsDriveUpload = saveToDrive
  commit({ pageId, state: 'starting', startedAt: 0, error: '' })
  try {
    // limitar resolución/30fps: sin esto, Chromium captura a la resolución/
    // frecuencia nativas del monitor (4K/60 en varias máquinas), multiplicando
    // el costo de encoding sin necesidad real para esto (tutoriales/reuniones,
    // no edición profesional) — una de las dos causas de que grabar pusiera
    // lenta toda la máquina.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { ...(RESOLUTION_PRESETS[resolution] ?? RESOLUTION_PRESETS['1080p']), frameRate: { ideal: 30, max: 30 } },
      audio: includeAudio,
    })
    displayStream = stream

    // el audio del sistema (getDisplayMedia) trae lo que sale por parlantes
    // — la voz de los demás — pero no tu propio micrófono, que es una
    // fuente de audio aparte. Si hay mic disponible, se mezclan los dos
    // con Web Audio en un único track antes de grabar. Nada de esto corre
    // si el usuario pidió grabar sin audio (includeAudio=false): ni se pide
    // el track del sistema (audio:false arriba) ni se abre el micrófono.
    let audioTrack = includeAudio ? (stream.getAudioTracks()[0] ?? null) : null
    if (includeAudio) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        audioCtx = new AudioContext()
        const destination = audioCtx.createMediaStreamDestination()
        if (audioTrack) audioCtx.createMediaStreamSource(new MediaStream([audioTrack])).connect(destination)
        audioCtx.createMediaStreamSource(micStream).connect(destination)
        audioTrack = destination.stream.getAudioTracks()[0]
      } catch (err) {
        console.log('[TRACE startScreenRecording] sin micrófono, sigo solo con audio del sistema:', err?.name)
      }
    }

    const videoTrack = stream.getVideoTracks()[0]
    const mixedStream = new MediaStream([videoTrack, audioTrack].filter(Boolean))

    // grabaciones largas (reuniones de varias horas): en vez de juntar todo
    // en RAM y recién escribir al final, cada chunk se manda a disco a
    // medida que llega (requiere start(timeslice), si no ondataavailable
    // solo dispara una vez al final y no sirve de nada). lastChunkWrite
    // encadena los envíos para no mandar dos chunks del mismo archivo en
    // paralelo (podrían llegar desordenados al escribir).
    recordingFilename = await api.beginRecording()
    lastChunkWrite = Promise.resolve()
    // H.264 tiene encoder por HARDWARE en casi cualquier PC (Intel Quick
    // Sync, NVENC, AMD VCE) — VP9 casi nunca, así que MediaRecorder lo
    // encodeaba por software, saturando la CPU durante TODA la grabación
    // (la otra causa de la lentitud). Sigue siendo un .webm — Chromium
    // soporta H.264 dentro de ese contenedor tanto para grabar como para
    // reproducir, así que el resto del pipeline (ffmpeg, <video>) no
    // necesita cambios. Mismo patrón de fallback que el audio de
    // ChatView.jsx (MediaRecorder.isTypeSupported antes de elegir).
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus')
      ? 'video/webm;codecs=h264,opus'
      : 'video/webm;codecs=vp9,opus'
    const recorder = new MediaRecorder(mixedStream, { mimeType, videoBitsPerSecond: 6_000_000 })
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      lastChunkWrite = lastChunkWrite
        .then(() => event.data.arrayBuffer())
        .then((buf) => api.appendRecordingChunk(recordingFilename, new Uint8Array(buf)))
    }
    recorder.onstop = async () => {
      commit({ state: 'saving' })
      const savedPageId = snapshot.pageId
      try {
        await lastChunkWrite
        const url = await api.finishRecording(recordingFilename)
        const entry = await api.addRecording(savedPageId, {
          url,
          name: `Grabación ${new Date().toLocaleString('es-AR')}`,
        })
        window.dispatchEvent(new CustomEvent('flashlab:recording-saved', { detail: { pageId: savedPageId, entry } }))
        // best-effort, en segundo plano — no bloquea que la UI vuelva a
        // 'idle' (ver finally acá abajo). Si quien graba no es el dueño de
        // la página, listShares falla por RLS: igual sube a Drive, solo sin
        // auto-compartir (ver plan).
        if (wantsDriveUpload) {
          api
            .listShares(savedPageId)
            .catch(() => [])
            .then((shares) => api.uploadRecordingToDrive(savedPageId, entry.id, shares.map((s) => s.email)))
            .catch((err) => console.error('no se pudo subir la grabación a Drive:', err))
        }
      } catch (err) {
        commit({ error: err.message || 'no se pudo guardar la grabación' })
      } finally {
        displayStream?.getTracks().forEach((t) => t.stop())
        micStream?.getTracks().forEach((t) => t.stop())
        audioCtx?.close()
        displayStream = null
        micStream = null
        audioCtx = null
        mediaRecorder = null
        commit({ pageId: null, state: 'idle', startedAt: 0 })
      }
    }
    // si el usuario corta desde el control nativo del SO ("Dejar de compartir"),
    // frenar la grabación en vez de quedar grabando una pantalla ya cerrada
    videoTrack?.addEventListener('ended', () => {
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
    })
    mediaRecorder = recorder
    recorder.start(3000) // volcar a disco cada 3s, no acumular todo en RAM
    commit({ state: 'recording', startedAt: Date.now() })
  } catch (err) {
    console.log('[TRACE startScreenRecording] error name=', err?.name, 'message=', err?.message, err)
    commit({ state: 'idle', startedAt: 0, error: err?.name !== 'NotAllowedError' ? err.message || 'no se pudo iniciar la grabación' : '' })
  }
}

export function stopScreenRecording() {
  mediaRecorder?.stop()
}
