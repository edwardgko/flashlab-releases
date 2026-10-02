const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Aplicar la clase `dark` acá, síncrono y antes de que corra cualquier script
// de la página, evita el flash de modo claro en cada arranque con el SO en
// oscuro: useTheme.js (src/lib/useTheme.js) recién sabe el tema real después
// de una IPC async (theme:get) — hasta que esa promesa resuelve, el primer
// paint (LoginGate incluido) siempre salía en claro. sendSync bloquea acá
// nomás, en preload, antes de que exista contenido visible todavía.
try {
  const initialTheme = ipcRenderer.sendSync('theme:get-sync')
  if (initialTheme?.shouldUseDarkColors) document.documentElement.classList.add('dark')
} catch {
  // si algo falla acá, useTheme.js igual la aplica un instante después
}

// helper: suscribirse a un evento push del main y devolver la función de limpieza
function onEvent(channel, callback) {
  const listener = (_event, data) => callback(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('notionAPI', {
  getAuthSession: () => ipcRenderer.invoke('auth:get-session'),
  login: () => ipcRenderer.invoke('auth:login'),
  cancelGoogleAuth: () => ipcRenderer.invoke('auth:cancel-google-auth'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  persistAuthSession: (session) => ipcRenderer.invoke('auth:persist-session', session),
  loadPage: (id) => ipcRenderer.invoke('page:load', id),
  savePage: (id, data) => ipcRenderer.invoke('page:save', id, data),
  listPages: () => ipcRenderer.invoke('pages:list'),
  createPage: (title, parentId, properties) => ipcRenderer.invoke('pages:create', title, parentId, properties),
  createDatabase: (title, parentId) => ipcRenderer.invoke('pages:create-database', title, parentId),
  setDatabaseSchema: (id, schema) => ipcRenderer.invoke('pages:set-schema', id, schema),
  setPageProperties: (id, properties) => ipcRenderer.invoke('pages:set-properties', id, properties),
  renamePage: (id, title) => ipcRenderer.invoke('pages:rename', id, title),
  setPageIcon: (id, icon) => ipcRenderer.invoke('pages:set-icon', id, icon),
  movePage: (id, newParentId, newIndex) => ipcRenderer.invoke('pages:move', id, newParentId, newIndex),
  duplicatePage: (id) => ipcRenderer.invoke('pages:duplicate', id),
  trashPage: (id) => ipcRenderer.invoke('pages:trash', id),
  restorePage: (id) => ipcRenderer.invoke('pages:restore', id),
  deleteForever: (id) => ipcRenderer.invoke('pages:delete', id),
  emptyTrash: () => ipcRenderer.invoke('pages:empty-trash'),
  setLastOpened: (id) => ipcRenderer.invoke('pages:set-last-opened', id),
  saveImage: (bytes, filename, mime) => ipcRenderer.invoke('image:save', bytes, filename, mime),
  saveImageFromUrl: (url) => ipcRenderer.invoke('image:save-from-url', url),
  fetchImageBytes: (url) => ipcRenderer.invoke('image:fetch-bytes', url),
  readLocalAsset: (filename) => ipcRenderer.invoke('image:read-local-asset', filename),
  search: (query) => ipcRenderer.invoke('search:query', query),
  backlinks: (id) => ipcRenderer.invoke('pages:backlinks', id),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (source) => ipcRenderer.invoke('theme:set', source),
  onThemeUpdated: (callback) => onEvent('theme:updated', callback),
  onMenuNewPage: (callback) => onEvent('menu:new-page', callback),
  onMenuSave: (callback) => onEvent('menu:save', callback),
  onMenuExportMarkdown: (callback) => onEvent('menu:export-markdown', callback),
  onMenuExportHtml: (callback) => onEvent('menu:export-html', callback),
  onMenuImportMarkdown: (callback) => onEvent('menu:import-markdown', callback),
  exportFile: (content, suggestedName, filter) => ipcRenderer.invoke('export:save', content, suggestedName, filter),
  downloadFileFromUrl: (url, suggestedName) => ipcRenderer.invoke('files:download-url', url, suggestedName),
  importMarkdownFile: () => ipcRenderer.invoke('import:markdown-pick'),
  getCalendarAuthStatus: () => ipcRenderer.invoke('calendar:auth-status'),
  ensureCalendarConnected: () => ipcRenderer.invoke('calendar:ensure-connected'),
  connectCalendarUnified: () => ipcRenderer.invoke('calendar:connect-unified'),
  listCalendarEvents: (timeMinIso, timeMaxIso) => ipcRenderer.invoke('calendar:list-events', timeMinIso, timeMaxIso),
  createCalendarEvent: (eventData) => ipcRenderer.invoke('calendar:create-event', eventData),
  updateCalendarEvent: (id, eventData) => ipcRenderer.invoke('calendar:update-event', id, eventData),
  deleteCalendarEvent: (id) => ipcRenderer.invoke('calendar:delete-event', id),
  getEventPage: (eventId) => ipcRenderer.invoke('calendar:get-event-page', eventId),
  linkEventPage: (eventId, pageId) => ipcRenderer.invoke('calendar:link-event-page', eventId, pageId),
  getDriveAuthStatus: () => ipcRenderer.invoke('drive:auth-status'),
  connectDriveUnified: () => ipcRenderer.invoke('drive:connect-unified'),
  disconnectDrive: () => ipcRenderer.invoke('drive:disconnect'),
  uploadRecordingToDrive: (pageId, recordingId, shareEmails) =>
    ipcRenderer.invoke('recording:upload-to-drive', pageId, recordingId, shareEmails),
  shareRecordingOnDrive: (pageId, recordingId, shareEmails) =>
    ipcRenderer.invoke('recording:share-drive', pageId, recordingId, shareEmails),
  getDriveAccessToken: () => ipcRenderer.invoke('drive:get-access-token'),
  ensureDriveFolder: (pathSegments) => ipcRenderer.invoke('drive:ensure-folder', pathSegments),
  shareDriveFile: (fileId, emails) => ipcRenderer.invoke('drive:share-file', fileId, emails),
  saveAttachmentAs: (args) => ipcRenderer.invoke('attachment:save-as', args),
  copyAttachmentImage: (args) => ipcRenderer.invoke('attachment:copy-image', args),
  openAttachmentWith: (args) => ipcRenderer.invoke('attachment:open-with', args),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  uploadVideoAttachmentToDrive: (filePath, folderSegments) =>
    ipcRenderer.invoke('drive:upload-video-attachment', filePath, folderSegments),
  repairDriveVideo: (fileId) => ipcRenderer.invoke('drive:repair-video', fileId),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  beginRecording: () => ipcRenderer.invoke('recording:begin'),
  appendRecordingChunk: (filename, bytes) => ipcRenderer.invoke('recording:append-chunk', filename, bytes),
  finishRecording: (filename) => ipcRenderer.invoke('recording:finish', filename),
  listRecordings: (pageId) => ipcRenderer.invoke('recordings:list', pageId),
  addRecording: (pageId, recording) => ipcRenderer.invoke('recordings:add', pageId, recording),
  listAllRecordings: () => ipcRenderer.invoke('recordings:list-all'),
  deleteRecording: (pageId, recordingId) => ipcRenderer.invoke('recordings:delete', pageId, recordingId),
  copyRecordingToFolder: (pageId, recordingId) => ipcRenderer.invoke('recordings:copy-to-folder', pageId, recordingId),
  cancelDriveUpload: (pageId, recordingId) => ipcRenderer.invoke('recording:cancel-drive-upload', pageId, recordingId),
  pickAudioFile: () => ipcRenderer.invoke('dialog:pick-audio-file'),
  importAudioAsset: (sourcePath) => ipcRenderer.invoke('asset:import-audio', sourcePath),
  probeAssetDuration: (assetUrl) => ipcRenderer.invoke('asset:probe-duration', assetUrl),
  trimRecording: (pageId, recordingId, opts) => ipcRenderer.invoke('recording:trim', pageId, recordingId, opts),
  replaceRecordingAudio: (pageId, recordingId, opts) =>
    ipcRenderer.invoke('recording:replace-audio', pageId, recordingId, opts),
  removeRecordingAudio: (pageId, recordingId, opts) =>
    ipcRenderer.invoke('recording:remove-audio', pageId, recordingId, opts),
  applyRecordingEdits: (pageId, recordingId, opts) =>
    ipcRenderer.invoke('recording:apply-edits', pageId, recordingId, opts),
  onRecordingEditProgress: (callback) => onEvent('recording:edit-progress', callback),
  onRecordingsUpdated: (callback) => onEvent('recordings:updated', callback),
  onBeforeClose: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app:before-close', listener)
    return () => ipcRenderer.removeListener('app:before-close', listener)
  },
  confirmClose: () => ipcRenderer.send('app:close-ready'),
  focusApp: () => ipcRenderer.invoke('app:focus'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  onUpdateReady: (callback) => onEvent('update:ready', callback),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  setUnreadBadge: (dataUrl, count) => ipcRenderer.invoke('app:set-unread-badge', dataUrl, count),
  showNotification: (opts) => ipcRenderer.invoke('app:show-notification', opts),
})
