import { PushNotifications } from '@capacitor/push-notifications'
import { LocalNotifications } from '@capacitor/local-notifications'
import { supabase } from './supabaseClient.js'

// se llama una sola vez por sesión de la app (App.jsx, gateado por
// IS_CAPACITOR + sesión activa) — un segundo llamado con la app ya
// registrada no hace nada, evita duplicar listeners si el componente que
// dispara esto se remonta.
let registered = false

export async function setupPushNotifications(myId) {
  if (registered || !myId) return
  registered = true

  // 1. Permisos de Push (Android 13+ exige POST_NOTIFICATIONS en runtime)
  let permStatus = await PushNotifications.checkPermissions()
  if (permStatus.receive !== 'granted') {
    permStatus = await PushNotifications.requestPermissions()
  }
  if (permStatus.receive !== 'granted') {
    registered = false // el usuario puede conceder el permiso más tarde desde Ajustes
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

  // 3. Crear canales de notificación obligatorios en Android 8+ (Oreo+)
  // importance: 5 = IMPORTANCE_HIGH (muestra banner flotante 'heads-up' y suena)
  const channelConfig = {
    id: 'fcm_fallback_notification_channel',
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
    await PushNotifications.createChannel({ ...channelConfig, id: 'flashlab_messages' })
    await LocalNotifications.createChannel(channelConfig)
    await LocalNotifications.createChannel({ ...channelConfig, id: 'flashlab_messages' })
  } catch (err) {
    console.warn('Error configurando canales de notificación:', err)
  }

  // 4. Token FCM para notificaciones en segundo plano / app cerrada
  PushNotifications.addListener('registration', async (token) => {
    const { error } = await supabase
      .from('push_tokens')
      .upsert({ token: token.value, user_id: myId, platform: 'android', updated_at: new Date().toISOString() })
    if (error) console.error('Error guardando push token:', error)
  })

  PushNotifications.addListener('registrationError', (err) => {
    console.error('Error de registro push:', err)
  })

  // 5. Si llega un push con la app en primer plano, mostrarlo con LocalNotifications
  PushNotifications.addListener('pushNotificationReceived', async (notification) => {
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            title: notification.title || 'FlashLab',
            body: notification.body || '',
            id: (Date.now() % 10000000) + Math.floor(Math.random() * 1000),
            channelId: 'fcm_fallback_notification_channel',
            smallIcon: 'ic_launcher',
            sound: 'default',
          },
        ],
      })
    } catch (err) {
      console.warn('Error mostrando notificación local:', err)
    }
  })

  PushNotifications.addListener('pushNotificationActionPerformed', () => {
    window.focus()
  })

  LocalNotifications.addListener('localNotificationActionPerformed', () => {
    window.focus()
  })

  await PushNotifications.register()
}
