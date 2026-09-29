import { supabase } from './supabaseClient.js'

// Sincronización en vivo entre personas que tienen abierta LA MISMA página
// compartida, más el botón "Recargar" del sidebar.
//
// Dos piezas:
//   1. Un evento de ventana ('flashlab:reload-content'). App.jsx sabe recargar
//      el ÁRBOL de páginas, pero el contenido de la vista abierta (bloques
//      del editor, filas de una base) lo carga cada vista por su cuenta. El
//      evento es cómo se les avisa sin subir todo ese estado hasta App.
//   2. Suscripciones de Realtime a page_contents (bloques) y pages (filas y
//      metadatos de una base de datos).
//
// Lo de "solo si la página está compartida" es a propósito: si sos la única
// persona con acceso, cualquier cambio remoto solo puede ser tuyo desde otro
// dispositivo, y recargar la vista mientras estás editando ahí sería peor que
// no hacer nada. La comprobación la hace el caller con api.listShares().

export const RELOAD_CONTENT_EVENT = 'flashlab:reload-content'

// Para comparar el contenido que llega por Realtime contra el que ya tenemos
// hay que ignorar el orden de las claves (jsonb las reordena) — ver
// stableStringify.js, que vive aparte para no arrastrar este módulo (y con
// él el cliente de Supabase) a quien solo necesita comparar dos JSON.

export function emitReloadContent() {
  window.dispatchEvent(new CustomEvent(RELOAD_CONTENT_EVENT))
}

export function onReloadContent(handler) {
  window.addEventListener(RELOAD_CONTENT_EVENT, handler)
  return () => window.removeEventListener(RELOAD_CONTENT_EVENT, handler)
}

// UPDATE sobre el contenido (bloques) de UNA página. `onRemote` recibe el
// contenido nuevo ya parseado.
export function subscribeToPageContent(pageId, onRemote) {
  const channel = supabase
    .channel(`page-contents-${pageId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'page_contents', filter: `page_id=eq.${pageId}` },
      (payload) => onRemote(payload.new?.content ?? null)
    )
    .subscribe()
  return () => supabase.removeChannel(channel)
}

// Cualquier cambio en las FILAS de una base de datos (alta, baja, edición de
// una propiedad, reordenamiento) y en la base misma. Las filas son páginas
// con parent_id = el id de la base, así que un solo filtro las cubre a todas
// — pero deja afuera los cambios a la base en sí (su propio id), por eso el
// segundo `.on` sobre `id=eq.`.
//
// OJO: requiere que public.pages esté en la publicación supabase_realtime
// (migración 0027) — sin eso el canal se suscribe igual y no llega nunca
// nada, que es el modo de fallar más confuso posible.
export function subscribeToDatabaseRows(databaseId, onRemote) {
  const channel = supabase
    .channel(`db-rows-${databaseId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'pages', filter: `parent_id=eq.${databaseId}` },
      () => onRemote()
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'pages', filter: `id=eq.${databaseId}` },
      () => onRemote()
    )
    .subscribe()
  return () => supabase.removeChannel(channel)
}
