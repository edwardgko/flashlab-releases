import { useEffect, useState } from 'react'
import { api } from './api.js'

// Aplica/retira la clase `dark` en <html> según nativeTheme (Electron) o
// matchMedia (navegador); `shouldUseDarkColors` es siempre la fuente de verdad,
// nunca calculamos "system → oscuro" nosotros mismos en el componente.
export function useTheme() {
  // arranca leyendo la clase `dark` de <html> en vez de asumir claro: en
  // Electron, preload.cjs ya la aplicó síncrono antes de este primer render
  // (ver ahí) — si acá se hardcodeaba shouldUseDarkColors:false, el efecto de
  // abajo la pisaba de vuelta a claro apenas montaba, deshaciendo lo que
  // preload acababa de hacer bien.
  const [state, setState] = useState(() => ({
    source: 'system',
    shouldUseDarkColors: document.documentElement.classList.contains('dark'),
  }))

  useEffect(() => {
    let cancelled = false
    api.getTheme().then((theme) => {
      console.log('[TRACE useTheme] getTheme inicial ->', theme)
      if (!cancelled) setState(theme)
    })
    const unsubscribe = api.onThemeUpdated((theme) => {
      console.log('[TRACE useTheme] onThemeUpdated ->', theme)
      setState(theme)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    console.log('[TRACE useTheme] aplicando clase dark=', state.shouldUseDarkColors, 'a <html>')
    document.documentElement.classList.toggle('dark', state.shouldUseDarkColors)
  }, [state.shouldUseDarkColors])

  // No alcanza con esperar el evento onThemeUpdated: Electron solo lo emite
  // cuando cambia shouldUseDarkColors, no cuando cambia themeSource — si el
  // SO ya está en oscuro, ciclar "oscuro"→"sistema" da el mismo
  // shouldUseDarkColors y el evento nunca dispara. Releer explícito después
  // de cada cambio evita depender de eso.
  const setTheme = async (source) => {
    console.log('[TRACE useTheme] setTheme llamado con', source)
    await api.setTheme(source)
    const theme = await api.getTheme()
    console.log('[TRACE useTheme] releído tras setTheme ->', theme)
    setState(theme)
  }

  return { theme: state.source, setTheme }
}
