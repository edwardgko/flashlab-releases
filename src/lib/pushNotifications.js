import { PushNotifications } from '@capacitor/push-notifications'
import { supabase } from './supabaseClient.js'

// se llama una sola vez por sesión de la app (App.jsx, gateado por
// IS_CAPACITOR + sesión activa) — un segundo llamado con la app ya
// registrada no hace nada, evita duplicar listeners si el componente que
// dispara esto se remonta.
let registered = false

export async function setupPushNotifications(myId) {
  if (registered || !myId) return
  registered = true

  let permStatus = await PushNotifications.checkPermissions()
  if (permStatus.receive === 'prompt') {
    permStatus = await PushNotifications.requestPermissions()
  }
  if (permStatus.receive !== 'granted') {
    registered = false // el usuario puede conceder el permiso más tarde desde Ajustes; no lo dejamos trabado en "ya lo intenté"
    return
  }

  // el token puede cambiar (reinstalación, limpieza de datos) — upsert por
  // token (ver migración push_tokens) así un dispositivo nuevo no pisa el
  // de otro.
  PushNotifications.addListener('registration', async (token) => {
    const { error } = await supabase
      .from('push_tokens')
      .upsert({ token: token.value, user_id: myId, platform: 'android', updated_at: new Date().toISOString() })
    if (error) console.error('Error guardando push token:', error)
  })

  PushNotifications.addListener('registrationError', (err) => {
    console.error('Error de registro push:', err)
  })

  await PushNotifications.register()
}
