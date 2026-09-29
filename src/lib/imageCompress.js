// Comprime/redimensiona una imagen ANTES de subirla — pensado para fondos de
// chat (se muestran con background-size:cover en un panel que nunca es más
// grande que la pantalla, así que no hace falta conservar la resolución
// original de una foto de cámara, fácil que pese varios MB). Reportado como
// "cuesta que cargue el fondo ya asignado al abrir un chat" — el archivo
// pesado es la causa más directa: cada apertura sin cache local vuelve a
// bajar esos mismos bytes de Drive.
const MAX_DIMENSION = 1600
const JPEG_QUALITY = 0.82
const SKIP_BELOW_BYTES = 300 * 1024 // ya es chico, recomprimir no ayudaría

// no toca gifs (perdería la animación, createImageBitmap solo trae el
// primer frame) ni archivos ya livianos. Si algo falla (formato raro que el
// navegador no puede decodificar, etc.) sube el original en vez de romper
// la subida — comprimir es una mejora, nunca un requisito.
export async function compressImageForUpload(file) {
  if (!file.type?.startsWith('image/') || file.type === 'image/gif' || file.size <= SKIP_BELOW_BYTES) {
    return file
  }
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    // si por lo que sea el resultado no achicó nada, mejor quedarse con el
    // original (evita el caso raro de "comprimir" y terminar más pesado).
    if (!blob || blob.size >= file.size) return file
    const name = file.name.replace(/\.\w+$/, '') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg' })
  } catch (err) {
    console.error('no se pudo comprimir la imagen, se sube el original:', err)
    return file
  }
}
