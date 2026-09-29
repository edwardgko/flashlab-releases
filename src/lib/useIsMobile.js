import { useEffect, useState } from 'react'
// directo de @capacitor/core, NO el IS_CAPACITOR de supabaseClient.js: ese
// módulo importa api.js, que importa webDrive.js, que vuelve a importar
// supabaseClient.js. Ese ciclo ya existe y se resuelve solo mientras la
// app entre por api.js primero — pero este archivo lo importa medio mundo,
// y alcanzaba con que uno de esos imports quedara antes en el orden para
// que el ciclo arrancara del lado equivocado y reventara con "Cannot access
// 'SUPABASE_URL' before initialization" (comprobado en el dev server).
import { Capacitor } from '@capacitor/core'

// mismo corte que el md: de Tailwind (768px) — es el único breakpoint que
// hace falta acá, no todo un sistema de tamaños: por debajo de eso el
// sidebar pasa de panel fijo a cajón (drawer) superpuesto.
const BREAKPOINT = 767

// ¿el dispositivo apunta con el dedo? Un teléfono/tablet real da
// `(pointer: coarse)`; un mouse o trackpad da `(pointer: fine)`. Es la única
// señal que NO depende de cuántos píxeles CSS mide la pantalla — y eso
// importa porque el escalado de Windows los divide: a 125% un portátil de
// 1366x768 reporta 1092x614 CSS px, a 150% uno de 1920x1080 reporta
// 1280x720. Con la regla vieja (mirar solo la dimensión chica) esos dos
// casos daban "es un teléfono" y el sidebar se abría como cajón a pantalla
// completa en una PC de escritorio (reportado con escala 125%).
function hasCoarsePointer() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

// tres caminos, en orden:
//  1. APK de Capacitor -> siempre mobile, sin importar la geometría.
//  2. ventana angosta (ancho <= 767) -> cajón, también en desktop: una
//     ventana de Electron achicada a mano merece el mismo layout que un
//     teléfono, y ahí el ancho SÍ es la señal correcta.
//  3. teléfono acostado (844x390): es "ancho" según innerWidth pero sigue
//     siendo una pantalla chica. La dimensión CHICA no cambia al rotar, así
//     que es la que lo delata — pero solo vale si además hay puntero grueso,
//     si no se come a cualquier ventana de escritorio baja o escalada.
function computeIsMobile() {
  if (Capacitor.isNativePlatform()) return true
  if (window.innerWidth <= BREAKPOINT) return true
  return hasCoarsePointer() && Math.min(window.innerWidth, window.innerHeight) <= BREAKPOINT
}

// misma respuesta que el hook pero sin React — la usa App.jsx para el estado
// INICIAL del sidebar (antes del primer render, donde no se puede llamar a
// un hook). Antes ahí había una copia a mano de la fórmula vieja, y arreglar
// una sin la otra dejaba el arranque en el modo equivocado.
export { computeIsMobile as isMobileNow }

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(computeIsMobile)
  useEffect(() => {
    const onResize = () => setIsMobile(computeIsMobile())
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  return isMobile
}
