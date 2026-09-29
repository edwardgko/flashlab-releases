import { api } from './api.js'

// Cuánto esperar al truco del <video> (ver abajo) antes de darlo por perdido.
// No es "cuánto tarda en cargar el video": es cuánto tarda Chromium en
// AVERIGUAR la duración de un archivo que no la declara, escaneándolo. Medido
// en 3,7s para un webm de 20 min / 225 MB sin índice de búsqueda, y crece con
// el tamaño — de ahí que el margen sea amplio. Lo que importa no es el número
// exacto sino que EXISTA: sin timeout la promesa quedaba pendiente para
// siempre y el editor se clavaba en "Duración 0:00.0".
const SEEK_PROBE_TIMEOUT_MS = 20000

// Los .webm que graba MediaRecorder no traen la duración total en el header
// (se escriben en vivo, sin saber cuándo van a terminar) — Chromium reporta
// video.duration=Infinity y deja el rango buscable en [0, 0] hasta que se
// busca una vez cerca del final.
//
// El workaround clásico para eso es asignar un currentTime absurdo (1e101) y
// esperar el 'durationchange' que dispara Chromium al toparse con el final
// real. PERO en una grabación larga y sin índice de búsqueda (cues), ese
// salto obliga a escanear el archivo entero: puede tardar muchísimo o no
// disparar ningún evento nunca. Sin timeout, la promesa quedaba pendiente
// para siempre y el editor se quedaba clavado en "Duración 0:00.0" hasta
// cerrarlo y volver a abrirlo (la segunda vez andaba porque el archivo ya
// estaba en caché del sistema). De ahí este timeout: pase lo que pase, esto
// resuelve.
function probeDurationViaSeek(video) {
  return new Promise((resolve) => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      resolve(video.duration)
      return
    }
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      video.removeEventListener('durationchange', onSettled)
      video.removeEventListener('timeupdate', onSettled)
      resolve(value)
    }
    const onSettled = () => {
      if (!Number.isFinite(video.duration)) return
      video.currentTime = 0
      finish(video.duration)
    }
    const timer = setTimeout(() => finish(0), SEEK_PROBE_TIMEOUT_MS)
    video.addEventListener('durationchange', onSettled)
    video.addEventListener('timeupdate', onSettled)
    video.currentTime = 1e101
  })
}

// Duración real de una grabación. Prioriza ffmpeg en el proceso main
// (asset:probe-duration): lee el header y contesta al instante, sin depender
// de las rarezas de Chromium con los webm de duración desconocida. Es la
// misma decisión que ya se había tomado para las pistas de audio importadas
// (ver probeMediaDuration en electron/main.js) — acá se aplica también al
// video, que era donde seguía fallando.
//
// El truco del <video> queda solo como respaldo: para el fallback en
// navegador (sin Electron, sin ffmpeg) y por si ffmpeg no pudiera leer el
// header. Siempre devuelve un número finito, nunca queda pendiente.
export async function resolveDuration(video, assetUrl) {
  if (assetUrl) {
    try {
      const probed = await api.probeAssetDuration?.(assetUrl)
      if (Number.isFinite(probed) && probed > 0) {
        // aunque ya sepamos cuánto dura, el elemento sigue necesitando su
        // propio rango buscable para poder hacer seek — se dispara sin
        // esperarlo (no bloquea mostrar la duración correcta ya mismo).
        probeDurationViaSeek(video)
        return probed
      }
    } catch {
      // sin ffmpeg o asset no encontrado: seguir con el respaldo de abajo
    }
  }
  return probeDurationViaSeek(video)
}
