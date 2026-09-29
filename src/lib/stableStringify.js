// Serializa un valor con las claves de cada objeto ORDENADAS, para poder
// comparar dos JSON por contenido y no por texto.
//
// Hace falta porque `page_contents.content` es una columna `jsonb`, y jsonb
// NO guarda el JSON que se le mandó: lo normaliza, reordenando las claves de
// cada objeto (por largo, y a igual largo bytewise). Un bloque que el editor
// manda como {id, type, data} vuelve del servidor como {id, data, type} —
// mismo contenido, distinto texto.
//
// Comparar con JSON.stringify a secas daba entonces SIEMPRE "cambió",
// incluso contra el eco de tu propio guardado. Con el cartel manual eso solo
// molestaba; con la auto-recarga de páginas compartidas se volvió un bucle:
// guardás → vuelve el eco → parece ajeno → se remonta el editor → EditorJS
// renormaliza y dispara otro guardado → … = la página parpadeando sin parar
// (reportado 2026-08-13).
//
// Vive en su propio archivo, y no dentro de liveSync.js, a propósito: ese
// importa supabaseClient.js, que arrastra api.js → webDrive.js → de vuelta
// supabaseClient.js. Ese ciclo se resuelve solo mientras la app entre por
// api.js primero, pero revienta con "Cannot access 'SUPABASE_URL' before
// initialization" si alguien lo toma como puerta de entrada. Una función
// pura no tiene por qué correr ese riesgo.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}
