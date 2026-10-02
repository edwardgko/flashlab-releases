import { isDesktop } from './api.js'
import { IS_CAPACITOR } from './supabaseClient.js'
import { LocalNotifications } from '@capacitor/local-notifications'

let permissionAsked = false
let activeChatKey = null

export function setActiveChatViewing(key) {
  activeChatKey = key
}

export function getActiveChatViewing() {
  return activeChatKey
}

async function ensurePermission() {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied' || permissionAsked) return false
  permissionAsked = true
  try {
    const result = await Notification.requestPermission()
    return result === 'granted'
  } catch {
    return false
  }
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

// Dispara una notificación nativa del sistema según la plataforma:
// - Windows Desktop: toast nativo del SO a través de Electron Notification (con ícono y sonido).
// - Android: notificación nativa de barra de estado a través de LocalNotifications / Push.
// - Web: HTML5 Notification estándar.
// Si el usuario tiene la app enfocada y está leyendo ese mismo chat, no se interrumpe.
export async function notifyNewMessage(title, body, chatKey = null) {
  if (document.hasFocus() && chatKey && activeChatKey === chatKey) {
    return
  }

  // 1. Desktop (Electron IPC al proceso main con Notification nativo de Windows)
  if (isDesktop && window.notionAPI?.showNotification) {
    try {
      await window.notionAPI.showNotification({ title, body })
      return
    } catch (err) {
      console.warn('Error en notificación nativa de Electron:', err)
    }
  }

  // 2. Android (Capacitor LocalNotifications con canal de alta prioridad)
  if (IS_CAPACITOR) {
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            title: title || 'FlashLab',
            body: body || '',
            id: (Date.now() % 10000000) + Math.floor(Math.random() * 1000),
            channelId: 'fcm_fallback_notification_channel',
            smallIcon: 'ic_launcher',
            sound: 'default',
          },
        ],
      })
      return
    } catch (err) {
      console.warn('Error en notificación nativa de Android:', err)
    }
  }

  // 3. Fallback Web Browser estándar
  if (typeof Notification !== 'undefined') {
    const granted = await ensurePermission()
    if (!granted) return
    const notification = new Notification(title, { body })
    notification.onclick = () => {
      window.notionAPI?.focusApp()
      window.focus()
    }
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
