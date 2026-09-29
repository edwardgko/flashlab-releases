import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from './supabaseClient.js'

// supabase-js (storage-js) no expone progreso de subida — su .upload() es un
// fetch simple sin eventos intermedios. Para poder mostrar un porcentaje
// real (archivos grandes, sin límite de tamaño) hace falta hablar directo
// con la REST API de Storage vía XMLHttpRequest, que sí tiene
// xhr.upload.onprogress.
export async function uploadWithProgress(bucket, path, file, onProgress, signal) {
  const { data: sessionData } = await supabase.auth.getSession()
  const accessToken = sessionData.session?.access_token
  if (!accessToken) throw new Error('No hay sesión activa')

  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY)
    xhr.setRequestHeader('x-upsert', 'false')
    if (file.type) xhr.setRequestHeader('Content-Type', file.type)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`no se pudo subir el archivo (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('error de red al subir el archivo'))
    // cancelar (archivos grandes, ej. videos, pueden tardar bastante) — un
    // AbortError con ese `name` puntual para que el caller lo distinga de un
    // error real y no muestre un mensaje de "falló" por algo que el usuario
    // mismo interrumpió.
    xhr.onabort = () => {
      const err = new Error('Subida cancelada')
      err.name = 'AbortError'
      reject(err)
    }
    if (signal) {
      if (signal.aborted) {
        xhr.abort()
        return
      }
      signal.addEventListener('abort', () => xhr.abort())
    }
    xhr.send(file)
  })

  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}
