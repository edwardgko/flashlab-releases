// page.icon guarda un emoji corto o la URL de una imagen subida como ícono
// (https:// de Supabase Storage, appasset:// legado de la versión 100% local,
// blob: en el fallback de navegador sin Electron) — esto distingue cuál de
// los dos es para poder renderizar <img> vs texto.
export function isImageIcon(icon) {
  return (
    typeof icon === 'string' &&
    (icon.startsWith('https://') ||
      icon.startsWith('appasset://') ||
      icon.startsWith('blob:') ||
      icon.startsWith('data:'))
  )
}
