import { isDesktop } from './api.js'

// Notification (Web API estándar) — Electron ya la implementa nativa como
// notificación real del SO, no hace falta nada de electron/main.js más que
// el foco de ventana al hacer clic (ver app:focus en preload.cjs).

let permissionAsked = false

async function ensurePermission() {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied' || permissionAsked) return false
  permissionAsked = true
  const result = await Notification.requestPermission()
  return result === 'granted'
}

export function previewForMessage(row) {
  if (row.message_type === 'sticker') return `envió ${row.content}`
  if (row.message_type === 'attachment') {
    if (row.attachment_mime?.startsWith('image/')) return 'envió una foto'
    if (row.attachment_mime?.startsWith('video/')) return 'envió un video'
    return `envió un archivo: ${row.attachment_name || ''}`
  }
  return row.content
}

// no interrumpe si la ventana ya está en foco — ahí ya lo estás viendo
export async function notifyNewMessage(title, body) {
  if (!isDesktop || document.hasFocus()) return
  const granted = await ensurePermission()
  if (!granted) return
  const notification = new Notification(title, { body })
  notification.onclick = () => {
    window.notionAPI?.focusApp()
    window.focus()
  }
}

// Windows no expone un badge nativo con número (a diferencia del dock de
// macOS) — hay que dibujar el círculo+número nosotros mismos y mandarlo
// como imagen a electron/main.js (ver setUnreadBadge en preload.cjs), que
// lo aplica con win.setOverlayIcon sobre el ícono de la barra de tareas.
let lastBadgeCount = -1
export function updateTaskbarBadge(count) {
  if (!isDesktop || !window.notionAPI?.setUnreadBadge) return
  if (count === lastBadgeCount) return
  lastBadgeCount = count
  if (!count) {
    window.notionAPI.setUnreadBadge(null, 0)
    return
  }
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#e11d48'
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = count > 9 ? 'bold 30px sans-serif' : 'bold 38px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 9 ? '9+' : String(count), size / 2, size / 2 + 2)
  window.notionAPI.setUnreadBadge(canvas.toDataURL('image/png'), count)
}
