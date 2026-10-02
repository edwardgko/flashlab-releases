import { PushNotifications } from '@capacitor/push-notifications'
import { LocalNotifications } from '@capacitor/local-notifications'
import { App as CapacitorApp } from '@capacitor/app'
import { supabase } from './supabaseClient.js'
import { notifyNewMessage } from './desktopNotify.js'
import { sendChatPush } from './chat.js'

let currentUserId = null
let currentToken = null
let isInitialized = false

async function persistToken(token, userId) {
  if (!token || !userId) return
  try {
    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        { token, user_id: userId, platform: 'android', updated_at: new Date().toISOString() },
        { onConflict: 'token' }
      )
    if (error) {
      console.warn('Aviso guardando push token en Supabase:', error.message)
    }
    // Doble garantía vía Edge Function con service_role (bypasea cualquier fricción de RLS)
    await sendChatPush({ action: 'register_token', token, platform: 'android' })
  } catch (err) {
    console.warn('Excepción guardando push token:', err)
  }
}

export async function setupPushNotifications(myId) {
  if (!myId) return
  currentUserId = myId

  // Si ya tenemos token de esta sesión o de Firebase, sincronizarlo para este usuario
  if (currentToken) {
    persistToken(currentToken, currentUserId)
  }

  // 1. Permisos de Push (Android 13+ exige POST_NOTIFICATIONS en runtime)
  let permStatus = await PushNotifications.checkPermissions()
  if (permStatus.receive !== 'granted') {
    permStatus = await PushNotifications.requestPermissions()
  }
  if (permStatus.receive !== 'granted') {
    return
  }

  // 2. Permisos de Notificaciones Locales (para avisos en primer plano)
  try {
    const localPerm = await LocalNotifications.checkPermissions()
    if (localPerm.display !== 'granted') {
      await LocalNotifications.requestPermissions()
    }
  } catch (err) {
    console.warn('Error solicitando permisos locales:', err)
  }

  // 3. Crear canales de notificación en Android 8+ (Oreo+)
  // importance: 5 = IMPORTANCE_HIGH (muestra banner flotante 'heads-up' y suena)
  const channelConfig = {
    id: 'flashlab_messages',
    name: 'Mensajes de chat',
    description: 'Notificaciones de mensajes de FlashLab',
    importance: 5,
    visibility: 1,
    sound: 'default',
    vibration: true,
    lights: true,
  }

  try {
    await PushNotifications.createChannel(channelConfig)
    await PushNotifications.createChannel({ ...channelConfig, id: 'fcm_fallback_notification_channel' })
    await LocalNotifications.createChannel(channelConfig)
    await LocalNotifications.createChannel({ ...channelConfig, id: 'fcm_fallback_notification_channel' })
  } catch (err) {
    console.warn('Error configurando canales de notificación:', err)
  }

  if (isInitialized) {
    // Si ya inicializó listeners, solo re-registramos para refrescar token si hiciera falta
    await PushNotifications.register()
    return
  }
  isInitialized = true

  // 4. Token FCM para notificaciones en segundo plano / app cerrada
  PushNotifications.addListener('registration', async (token) => {
    currentToken = token.value
    if (currentUserId) {
      await persistToken(currentToken, currentUserId)
    }
  })

  PushNotifications.addListener('registrationError', (err) => {
    console.error('Error de registro push en Firebase:', err)
  })

  // 5. Si llega un push con la app en primer plano, gestionar con notifyNewMessage
  // (evita duplicar si ya se mostró por Realtime o si el usuario está en ese mismo chat)
  PushNotifications.addListener('pushNotificationReceived', async (notification) => {
    try {
      const data = notification.data || {}
      const senderId = data.senderId
      const conversationId = data.conversationId
      const chatKey = conversationId ? `group-${conversationId}` : (senderId ? `dm-${senderId}` : null)
      const uniqueId = notification.id || data.messageId || `${notification.title}:${notification.body}`
      await notifyNewMessage(notification.title || 'FlashLab', notification.body || '', chatKey, uniqueId)
    } catch (err) {
      console.warn('Error procesando push recibido en primer plano:', err)
    }
  })

  PushNotifications.addListener('pushNotificationActionPerformed', () => {
    window.focus()
  })

  LocalNotifications.addListener('localNotificationActionPerformed', () => {
    window.focus()
  })

  // 6. Al volver al primer plano (appStateChange), refrescar registro de push
  CapacitorApp.addListener('appStateChange', async ({ isActive }) => {
    if (isActive && currentUserId) {
      if (currentToken) {
        persistToken(currentToken, currentUserId)
      }
      try {
        await PushNotifications.register()
      } catch {}
    }
  })

  await PushNotifications.register()
}
