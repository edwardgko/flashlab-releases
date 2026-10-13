import { useEffect, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { getNotificationStatus, openNotificationSettings } from '../lib/pushNotifications.js'

// Android: si el permiso de notificaciones está negado (Android 13+ deja de
// preguntar después de dos "No") o el canal de chat está silenciado, los
// push llegan pero el sistema no muestra nada, sin ningún error visible.
// Este aviso es la única pista que tiene el usuario. Se vuelve a chequear al
// volver a la app (típicamente, después de activarlas en Ajustes).
export default function NotificationsBanner() {
  const [disabled, setDisabled] = useState(false)

  useEffect(() => {
    let cancelled = false
    const check = () =>
      getNotificationStatus().then((status) => {
        if (!cancelled && status) setDisabled(!status.appEnabled || !status.channelEnabled)
      })
    check()
    const subPromise = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) check()
    })
    return () => {
      cancelled = true
      subPromise.then((sub) => sub.remove())
    }
  }, [])

  if (!disabled) return null
  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
      <span className="min-w-0 flex-1">Las notificaciones de FlashLab están desactivadas: no te van a llegar los mensajes.</span>
      <button
        type="button"
        onClick={openNotificationSettings}
        className="shrink-0 cursor-pointer rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700"
      >
        Activar
      </button>
    </div>
  )
}
