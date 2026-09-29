// Patrón propio (no una copia del de WhatsApp — esos íconos son de ellos),
// oscuro y sutil, para el fondo por defecto del chat. Un puñado de siluetas
// simples (globo de diálogo, estrella, nota musical, corazón, hoja)
// repetidas en mosaico a muy baja opacidad.
const DEFAULT_TILE = `
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">
  <rect width="160" height="160" fill="#13151a"/>
  <g fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="14" y="18" width="26" height="18" rx="5" />
    <path d="M20 36 l4 8 4 -8" />
    <path d="M120 20 l4 10 10 1 -7 7 2 10 -9 -5 -9 5 2 -10 -7 -7 10 -1 z" />
    <circle cx="40" cy="110" r="6" />
    <path d="M46 110 v-30 l14 -4 v28" />
    <path d="M110 90 c-8 -10 -20 -2 -12 8 l12 12 12 -12 c8 -10 -4 -18 -12 -8z" />
    <path d="M70 60 q20 -10 20 10 q-20 10 -20 -10z" />
  </g>
</svg>
`.trim()

export const DEFAULT_CHAT_BACKGROUND = `url("data:image/svg+xml,${encodeURIComponent(DEFAULT_TILE)}")`

export function chatBackgroundStyle(customUrl) {
  if (customUrl) {
    return {
      backgroundImage: `url("${customUrl}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    }
  }
  return {
    backgroundImage: DEFAULT_CHAT_BACKGROUND,
    backgroundRepeat: 'repeat',
  }
}

export function wallpaperStorageKey(userId, chatKey) {
  return `flashlab-chat-wallpaper-${userId}-${chatKey}`
}
