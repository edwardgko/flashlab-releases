import { api } from '../api.js'

// Uploader custom para @editorjs/image: en vez de un endpoint HTTP, pasa los
// bytes por IPC y el proceso principal los guarda en userData/assets.
export const imageUploader = {
  async uploadByFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    return api.saveImage(bytes, file.name, file.type)
  },
  async uploadByUrl(url) {
    return api.saveImageFromUrl(url)
  },
}
