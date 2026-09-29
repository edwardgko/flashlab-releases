# Notion Clone — Roadmap por fases

Stack fijo: Electron + React (Vite) + Tailwind CSS 4 + Editor.js. JavaScript puro (sin TypeScript).
Regla general: cada fase termina con la app usable y estable. No se adelanta código de fases futuras.

---

## Fase 1 — Scaffolding y motor core ✅ (17-jul-2026)

- Proyecto Vite + React + Tailwind 4 + Electron 43.
- `electron/main.js` (ESM, `app.isPackaged`, DevTools detached en dev).
- `Editor.jsx` con Editor.js (header, list) y botón que captura el JSON en consola.
- Gotcha resuelto: `destroy()` de Editor.js limpia el holder completo → holder hijo por instancia + `isReady` en cleanup (StrictMode).

## Fase 2 — Persistencia local ✅ (17-jul-2026)

**Objetivo:** que lo escrito sobreviva al cierre de la app. Una sola página por ahora.

> Implementado: `preload.cjs` (contextBridge: `loadPage`/`savePage`/`onBeforeClose`/`confirmClose`),
> handlers `page:save`/`page:load` con ids sanitizados, escritura atómica (`.tmp` + rename),
> JSON corrupto se aparta como `.corrupt-<ts>`, autosave con debounce de 800 ms,
> cierre en dos tiempos con fallback de 2 s, indicador de estado en la UI.
> Verificado end-to-end: autosave → disco, cierre con guardado pendiente, y carga al arrancar.

- `electron/preload.js` con `contextBridge` (API mínima: `savePage`, `loadPage`) e `ipcMain.handle` en el main. `sandbox: false` no; preload en CommonJS o `.mjs` según soporte.
- Almacenamiento: JSON plano en `app.getPath('userData')/pages/<id>.json`. Nada de SQLite todavía — se decide en Fase 4 si hace falta.
- Escritura atómica: escribir a `.tmp` + `rename` para no corromper el archivo si se cierra la app a mitad de guardado.
- Autosave: `onChange` de Editor.js con debounce (~800 ms) + guardado al cerrar ventana (`before-quit`).
- Indicador de estado en la UI ("Guardando… / Guardado").
- Cargar el JSON existente al arrancar (`data` en el constructor de EditorJS).

**Done:** escribo, cierro la app, abro, y el contenido está.

## Fase 3 — Multi-página y Sidebar ✅ (17-jul-2026)

**Objetivo:** varias páginas planas con navegación estilo Notion.

> Implementado: `index.json` (metadatos + lastOpenedId) con cache en memoria y cola de
> escritura en el main (evita read-modify-write concurrente entre handlers IPC);
> IPC `pages:list/create/rename/delete/set-last-opened`; recuperación de páginas
> huérfanas al construir el índice; sidebar colapsable (crear, doble clic renombra,
> eliminar con confirmación en dos pasos); título como campo propio con renombrado
> debounced y flush al desmontar; navegación por estado con `key={pageId}`;
> `src/lib/api.js` con backend en memoria para desarrollo en navegador.
> **Fix clave:** guardar SIEMPRE al desmontar el editor (cambio de página) — el
> onChange de Editor.js tiene debounce interno (~500 ms) y confiar en "hay guardado
> pendiente" pierde los últimos cambios; gateado a carga inicial exitosa para no
> sobrescribir datos buenos con un editor vacío.
> Verificado E2E: crear/renombrar/cambiar/eliminar, flush en cambio rápido de página,
> y relanzado con restauración de páginas, última abierta y contenido.

- Modelo: `index.json` con metadatos (`id`, `title`, `createdAt`, `updatedAt`) + un JSON por página. IPC: `listPages`, `createPage`, `deletePage`, `renamePage`.
- Sidebar colapsable: lista de páginas, crear, renombrar inline, eliminar (con confirmación), página activa resaltada.
- Título de página como campo propio encima del editor (estilo Notion), no como bloque header.
- Navegación por estado (`currentPageId`), sin react-router — app de escritorio, no hay URLs. Remontar el editor con `key={pageId}` (el patrón holder-hijo + `isReady` ya soporta destruir/recrear).
- Guardar la última página abierta y restaurarla al arrancar.

**Done:** creo 5 páginas, salto entre ellas sin perder contenido ni duplicar editores.

## Fase 4 — Jerarquía y organización ✅ (22-jul-2026)

**Objetivo:** páginas anidadas, el corazón organizativo de Notion.

> Implementado: árbol vía `parentId` + `order` en `index.json` (se quedó JSON, no hizo
> falta migrar a SQLite — el volumen y las consultas siguen siendo triviales);
> helpers de árbol en el main (`childrenOf`, `subtreeIds`, `isDescendant`) reusados por
> mover/papelera/restaurar/borrar; IPC `pages:move/trash/restore/delete/empty-trash`
> con rechazo de movimientos cíclicos; sidebar con árbol recursivo (`TreeNode`),
> expandir/colapsar persistido en `localStorage` y auto-expansión de ancestros al
> navegar a una página profunda; drag & drop nativo HTML5 (antes/dentro/después
> según la posición vertical del cursor, sin dnd-kit — no hizo falta la dependencia);
> papelera con soft-delete en cascada (enviar un padre a la papelera marca todo el
> subárbol), restaurar (a la raíz si el padre original ya no existe) y vaciar con
> confirmación en dos pasos; breadcrumbs clicables sobre el título.
> Verificado E2E en navegador (backend en memoria: anidar, reordenar, colapsar,
> rechazo de ciclo, papelera→restaurar→vaciar) y contra IPC real en Electron
> (creación anidada, movimiento, papelera y rechazo de ciclo con datos en disco).

**Done:** árbol de 3 niveles, reordenado por drag & drop, papelera funcional, reinicio sin pérdidas.

## Fase 5 — Bloques avanzados del editor ✅ (22-jul-2026)

**Objetivo:** paridad razonable con los bloques de Notion.

> Implementado: quote, code, table, delimiter, marker, inline-code oficiales. **Nota:**
> no se instaló `@editorjs/checklist` — `@editorjs/list` 2.0.9 ya trae "Checklist"
> integrado (mismo tool, `data.style: "checklist"`); instalarlo aparte duplicaba la
> entrada en el toolbox.
> Imágenes: `@editorjs/image` con uploader custom (`src/lib/editorTools/imageUploader.js`)
> que manda los bytes por IPC en vez de a un endpoint HTTP; el main los escribe en
> `userData/assets/` con nombre único (timestamp+random) y los sirve de vuelta con un
> protocolo privilegiado `appasset://` (`net.fetch` + `pathToFileURL`, sanitizando el
> nombre de archivo contra path traversal). También soporta pegar una URL externa
> (`saveImageFromUrl`, descarga con `net.fetch` + User-Agent explícito — varios hosts
> como Wikimedia devuelven 400/403 sin uno — y la guarda local igual que un archivo).
> Bloques propios en `src/lib/editorTools/`: `CalloutTool.js` (icono cicla entre un
> set fijo al click, texto editable) y `ToggleTool.js` (resumen + cuerpo colapsable;
> no son bloques anidados de Editor.js de verdad, sería requerir editores anidados —
> alcance correcto para esta fase).
> **Gotcha resuelto:** el protocolo `appasset://` necesita `corsEnabled: true` en
> `registerSchemesAsPrivileged`, si no `fetch()`/`<img>` desde el renderer (origen
> `http://localhost:5173` en dev) lo rechazan como cross-origin.
> Verificado: los 12 tipos de bloque en el toolbox sin duplicados; creación de cada
> uno con contenido real; persistencia íntegra tras remontar el editor (cambio de
> página); toggle colapsa/expande; y contra IPC real de Electron — subida por archivo
> y por URL, `fetch()` exitoso al `appasset://`, y un `<img>` real renderizando la
> imagen con dimensiones correctas.

**Done:** una página de prueba usa todos los tipos de bloque, se guarda y se restaura idéntica.

## Fase 6 — Búsqueda y enlaces internos ✅ (22-jul-2026)

**Objetivo:** encontrar y conectar información.

> Implementado: `MiniSearch` en el main (título con boost×3, fuzzy 0.2, prefix) indexando
> texto plano extraído de todos los tipos de bloque (`src/lib/textExtract.js`, compartido
> con el backend en memoria del navegador); reindexado incremental en cada
> save/create/rename/trash/restore/delete. Quick switcher (Ctrl+P o botón "Buscar" en
> el sidebar) con navegación por teclado (↑↓ Enter Esc). `PageLinkTool` — inline tool
> propio de Editor.js: selecciona texto → click en el botón de enlace → popover propio
> (no `renderActions()` del core, timing poco fiable entre versiones) para buscar y
> elegir la página destino; click en el enlace navega (delegación de eventos en el
> holder del editor). Backlinks: panel "mencionada en N páginas" al pie de la página,
> vía `linksIndex` (Map targetId→Set sourceId) mantenido junto al índice de búsqueda.
> Renombrar reescribe el texto visible de los enlaces entrantes en el contenido
> guardado de las páginas que enlazan (regex sobre el markup propio, no hace falta
> parser HTML).
>
> **Bugs encontrados y corregidos:**
> 1. `PageLinkTool`: `openPopover()` llamaba a `closePopover()` para limpiar un popover
>    previo, pero `this.anchorEl` ya apuntaba al ancla recién creada → se autodesenvolvía
>    al instante. Separado en `removePopoverDom()` (solo limpieza de DOM) vs
>    `closePopover()` (limpieza + descarte si quedó sin página elegida).
> 2. **Bug real de Fase 6, el más serio:** `renameIncomingLinks` iteraba directamente
>    `linksIndex.get(pageId)` (un `Set` en vivo). Dentro del loop, `indexPageContent()`
>    reindexa los enlaces salientes de cada página fuente — si esa fuente también es
>    enlazada por `pageId` (típico: A y B se enlazan mutuamente), eso hace
>    `delete`+`add` de la fuente en el MISMO Set que se está iterando. Por la semántica
>    del iterador de `Set` en JS, re-agregar un elemento borrado durante la iteración
>    hace que el iterador lo vuelva a visitar — **loop infinito**. Fix: `const sourceIds
>    = [...sources]` (snapshot) antes de iterar.
>
> Diagnóstico: un wrapper temporal sobre `ipcMain.handle` que traza `[TRACE] -> canal` /
> `<- canal` fue clave para ubicar que el cuelgue estaba dentro de `pages:rename`
> (no en I/O de disco como se sospechó al principio). Ojo aparte: durante las pruebas,
> el patrón `comando &` combinado con `run_in_background` del harness dejó procesos
> Vite/Electron huérfanos compitiendo por el puerto 5173 y los mismos archivos — usar
> siempre `run_in_background: true` en la propia tool sin `&` manual.
>
> Verificado E2E contra IPC real de Electron: búsqueda por título y contenido, backlinks,
> reescritura de enlaces al renombrar, y exclusión/reaparición correcta en
> papelera→restaurar.

**Done:** Ctrl+P encuentra por contenido; los enlaces navegan y los backlinks aparecen.

## Fase 7 — Pulido de escritorio ✅ (23-jul-2026)

**Objetivo:** que se sienta app nativa, no web empaquetada.

> Implementado: dark mode con variante custom de Tailwind v4 (`@custom-variant dark
> (&:where(.dark, .dark *))`, clase en `<html>`, no solo `prefers-color-scheme`) —
> `nativeTheme.themeSource` es la fuente de verdad en Electron (persiste en
> `settings.json`, emite `theme:updated` a todas las ventanas); backend en memoria del
> navegador sigue `matchMedia` para desarrollo. Overrides oscuros para Editor.js
> (`.tc-table`, `.ce-code__textarea`, `.cdx-marker`) y los bloques propios
> (callout/toggle/page-link/popover). Ctrl+N y Ctrl+S como *aceleradores del menú
> nativo* (no listeners del renderer, para no competir con los atajos del SO); Ctrl+P
> y Ctrl+B/I ya eran de fases anteriores. Menú nativo (Archivo/Edición/Ver, en
> español) + menú contextual real (`context-menu` de `webContents`, cortar/copiar/pegar
> condicionado a `editFlags`). Bounds de ventana persistidos con debounce y clamp
> contra monitores desconectados. Exportar a Markdown/HTML vía `src/lib/exportBlocks.js`
> (mapper por tipo de bloque, toggle como `<details>/<summary>` — válido en ambos
> formatos) y diálogo nativo de guardado; importar Markdown básico (headers/listas/citas/
> párrafos) crea una página nueva.
> Verificado: en navegador (memoria) el ciclo de tema, guardado forzado, y los 11 tipos
> de bloque a través del mapper de export/import; contra Electron real — menú nativo
> con las entradas esperadas, `theme:set` actualiza `nativeTheme` y `settings.json`,
> export/import con diálogos stubbeados escribiendo/leyendo archivos reales, y
> restauración de tema+bounds confirmada en un segundo arranque limpio.
> **No implementado** (explícitamente opcional en el roadmap): bloqueo local con
> contraseña.

**Done:** dark mode completo (editor incluido), atajos operativos, export MD legible.

## Fase 8 — Empaquetado y distribución ✅ (22-jul-2026)

**Objetivo:** instalable de verdad en Windows.

> Implementado: `base: './'` en `vite.config.js` (assets con ruta relativa, necesario
> para `loadFile()` en producción); icono generado con Pillow (`build/icon.ico`,
> documento blanco sobre fondo morado de marca); `package.json` reorganizado —
> `minisearch` es la única dependencia real de runtime (el main la importa
> directamente); React y todo `@editorjs/*` pasaron a devDependencies porque Vite
> los empaqueta dentro de `dist/`, el proceso main nunca los toca. Config de
> `electron-builder` con target NSIS, `"files"` explícito que incluye
> `src/lib/textExtract.js` (el main lo importa fuera de `electron/`, se habría roto
> silenciosamente en el paquete si no se listaba). Scripts: `npm run build` (solo
> renderer) y `npm run dist` (build + electron-builder).
> **Gotcha importante:** la app empaquetada usa `%APPDATA%\Notion Clone`
> (el `productName`) como carpeta de `userData`, NO `%APPDATA%\notion-clone` (el
> `name` de dev) — carpetas distintas, los datos de una sesión de desarrollo no
> aparecen en el instalado y viceversa. Es el comportamiento esperado de Electron,
> no un bug, pero hay que saberlo.
> Verificado: `npm run dist` genera `release/Notion Clone Setup 0.1.0.exe`
> (instalador NSIS) y `release/win-unpacked/Notion Clone.exe`; se lanzó el
> `.exe` empaquetado (asar real, `app.isPackaged === true` por primera vez en
> todo el proyecto) y se inspeccionó su renderer vía Chrome DevTools Protocol
> (`--remote-debugging-port`, ya que no hay DevTools abiertas en producción):
> `window.notionAPI` presente, página inicial creada, tema restaurado, y un
> ciclo completo de escribir contenido + subir una imagen confirmó que la
> persistencia en disco y el protocolo `appasset://` funcionan igual empaquetados
> que en desarrollo.
> **No implementado** (fuera de alcance / opcional): firma de código real (el exe
> queda sin firmar, puede disparar SmartScreen en una máquina limpia — aceptable
> para un proyecto personal) y auto-update con electron-updater.

**Done:** `.exe` instalable en una máquina limpia con todo funcionando.

---

## Fase 9 — Bases de datos (Tablero/Tabla) ✅ (23-jul-2026)

**Objetivo:** que una página pueda ser una colección de páginas con propiedades tipadas, vista como Kanban o como tabla — como las "databases" de Notion real (no formaba parte del roadmap original de 8 fases; agregada a pedido explícito tras revisar Notion real).

**Alcance deliberadamente acotado** (no es un clon del motor de bases de datos completo de Notion):

- Propiedades tipadas: texto, número, select (con color), checkbox, fecha. Fuera de alcance: persona, relación, fórmula, rollup, archivos.
- Dos vistas: Tablero (agrupado por una propiedad select, arrastrar tarjetas entre columnas cambia su valor) y Tabla (filas editables en línea). Fuera de alcance: Calendario, Lista, Galería, Timeline.
- Cada fila **es una página real** del árbol existente (con `parentId` = la base de datos): reutiliza el editor de bloques, la búsqueda, la papelera y la jerarquía sin cambios. Click en una tarjeta/fila abre su página completa.
- Fuera de alcance: filtros avanzados, ordenar por columna, fórmulas.

> Implementado: cada página gana campos opcionales `isDatabase`/`databaseSchema`/`properties`
> en `index.json` (normalizados en `loadIndex()`, backward-compatible con páginas
> existentes que no los tienen). IPC nuevos: `pages:create-database` (esquema por
> defecto con una propiedad "Estado" select de 4 opciones, mismos nombres/colores
> que Notion real), `pages:set-schema`, `pages:set-properties` (mezcla, no
> reemplaza — así el drag&drop del Tablero y la edición de la Tabla no se pisan);
> `pages:create` ahora acepta un 4º parámetro `properties` opcional para crear una
> fila con un valor preseteado (usado al agregar una tarjeta desde una columna
> específica del Tablero). `DatabaseView.jsx` nuevo: pestañas Tablero/Tabla,
> Tablero agrupa por la primera propiedad `select` del esquema con drag&drop HTML5
> nativo (mismo patrón que el Sidebar de Fase 4) entre columnas + una columna
> "Sin estado"; Tabla con celdas editables in-line por tipo (texto/número/fecha/
> checkbox/`<select>` con color). `PageView.jsx` renderiza `DatabaseView` en vez del
> `Editor` cuando `page.isDatabase`, con contenedor más ancho (bases de datos
> necesitan más espacio horizontal que una página de texto). Sidebar: ícono de
> grilla para páginas-base de datos, botón "+ Nueva base de datos" junto a
> "+ Nueva página".
> Verificado en navegador (memoria): crear base de datos, agregar filas a una
> columna, arrastrar entre columnas, editar el select desde la Tabla y ver el
> cambio reflejado en el Tablero, abrir una fila como página completa con su
> propio contenido, papelera cascadeando la base de datos + sus filas y
> restaurando ambas, persistencia tras remontar. Verificado contra IPC real de
> Electron con un smoke test: creación, filas con valor preseteado,
> `setPageProperties` mezclando correctamente, papelera/restore cascadeando, y el
> contenido de una fila persistiendo en disco — todo pasó al primer intento.
> **Nota:** el instalador de la Fase 8 (`release/`) quedó generado ANTES de esta
> fase — para reflejar bases de datos en la versión empaquetada hace falta correr
> `npm run dist` de nuevo.

**Done:** crear una base de datos con 4-5 filas, cambiarles el estado arrastrando en el Tablero, editar valores en la Tabla, abrir una fila y editarle el contenido como página normal — todo sobrevive a cerrar y reabrir la app.

---

## Fase 10 — Rebrand a FlashLab, Calendario, pestañas, grabaciones ✅ (24-jul-2026)

**Objetivo:** todo lo agregado en la sesión del 23→24 de julio de 2026, fuera del roadmap original y de la Fase 9. No es una fase "cerrada" temáticamente como las anteriores — es el acumulado de una sesión larga de pedidos incrementales. Se documenta acá para que quede en el mismo lugar que el resto de la historia del proyecto.

### Rebrand: "Notion Clone" → "FlashLab"

> `package.json` (`name`, `productName`, `build.appId`, `build.productName`), `index.html`
> (`<title>`), texto del sidebar y el mensaje post-OAuth en `main.js` — todos actualizados.
> Ícono nuevo generado con Pillow (mismo patrón que Fase 8) a partir de un PNG con
> transparencia real provisto por el usuario (rayo dorado + matraz de laboratorio),
> recortado al bounding box y centrado con margen — `build/icon.ico`, ahora también
> listado en `files` de electron-builder porque además de usarse para compilar el .exe
> se lee en tiempo de ejecución para el ícono de la bandeja del sistema.
> **Gotcha serio:** `app.getPath('userData')` depende de `productName`
> (`%APPDATA%\<productName>`) — cambiar el nombre deja los datos viejos en una carpeta
> a la que la app ya no apunta. Se agregó `migrateUserDataFolder()` en `main.js`,
> con dos vueltas de corrección:
> 1. Chequear solo si la carpeta nueva *existe* no alcanza — Electron/Chromium ya se
>    crea ahí su propia caché (Cache, GPUCache, Local State...) antes de `whenReady()`.
>    Hay que chequear si existe `index.json` específicamente (dato real nuestro).
> 2. `fs.rename(carpetaVieja, carpetaNueva)` tira `EPERM` en Windows cuando la carpeta
>    destino ya existe (el caso normal, por el punto anterior). Solución: mover
>    archivo por archivo (recursivo para subcarpetas como `assets/`, `pages/`,
>    `recordings/`) con reintentos — mismo motivo y mismo patrón que `writeJsonAtomic`
>    (antivirus bloqueando momentáneamente).
> `safeStorage` (usado para el token de Google Calendar) cifra atado a la identidad de
> la app — el token viejo quedó indescifrable tras el cambio de `appId`, hubo que
> reconectar Google Calendar una vez.

### Integración con Google Calendar

> OAuth "Desktop app" con flujo loopback (RFC 8252): servidor HTTP efímero en
> `127.0.0.1:<puerto libre>`, `shell.openExternal` al navegador del sistema (nunca un
> webview embebido — Google lo rechaza), `access_type=offline&prompt=consent` para
> asegurar `refresh_token`. Credenciales (Client ID/Secret, tipo "Desktop app" de
> Google Cloud) se pegan una vez desde la UI y se guardan en `settings.json`; el
> refresh token se cifra con `safeStorage` en `calendar-auth.enc` (separado de
> settings.json por ser credencial real, no metadata).
> `CalendarView.jsx`: grilla mensual (lunes primero), crear/editar/eliminar eventos
> (de día completo o con hora), reconectar/desconectar. **Bug de fecha corregido:**
> `new Date("2026-07-24")` (string sin hora) se interpreta como medianoche **UTC**, no
> local — en huso horario negativo un evento de todo el día aparecía un día antes en
> la grilla. Fix: para eventos `allDay` usar el string tal cual como clave, nunca
> pasarlo por `new Date()`.
> Notas de reunión: cada evento puede vincularse a una página normal
> (`calendarEventPages: { [eventId]: pageId }` en settings.json, IPC
> `calendar:get/link-event-page`) — "Crear notas de la reunión" crea la página y la
> vincula; "Abrir notas" navega si ya existe.
> **Gotcha de Google Cloud:** la consola le cambió el nombre a "OAuth consent screen"
> por "Google Auth Platform" (pestañas Branding/Audience/Clients). Modo "Prueba" +
> agregarse como test user evita el trámite de verificación.

### Grabación de videollamadas

> `session.defaultSession.setDisplayMediaRequestHandler(..., { useSystemPicker: true })`
> en `main.js` abre el selector nativo de Windows ("Elegir qué compartir", con opción
> de audio del sistema) — pero **igual exige** una fuente de video de respaldo en el
> callback (`desktopCapturer.getSources()`) aunque el picker nativo termine mandando;
> si no, tira `"Video was requested, but no video stream was provided"`.
> `PageView.jsx`: botón "Grabar" captura pantalla+audio del sistema
> (`getDisplayMedia`) y opcionalmente el micrófono (`getUserMedia`), mezclados en un
> solo track de audio con Web Audio (`AudioContext` + `createMediaStreamDestination`)
> — el audio del sistema por sí solo no incluye la voz propia. **Grabaciones largas
> (hasta ~5h):** en vez de acumular todo en RAM y volcar un solo blob al final,
> `MediaRecorder` corre con `timeslice` (3s) y cada chunk se manda por IPC y se
> aplica con `fs.appendFile` en el proceso main, encolado por archivo (mismo patrón
> `indexQueue`) para no entreverar escrituras concurrentes. Contador de tiempo
> transcurrido (HH:MM:SS) mientras graba.
> Metadata de grabaciones aparte de `index.json`/`pages/<id>.json` a propósito
> (`userData/recordings/<pageId>.json`) — no compite con el autosave del editor.
> Vista agregada "Grabaciones" en el sidebar (todas las páginas), y borrado con
> confirmación en dos pasos (mismo patrón ya establecido en el resto de la app) tanto
> ahí como en el panel de la propia página — borra el registro y el archivo de video.

### Pestañas, título como columna movible, y editor de Select rediseñado

> **Pestañas** arriba de todo (`TabBar.jsx`): cada una es `{ id, kind: 'page' |
> 'calendar' | 'recordings', pageId }`; `App.jsx` pasó de trackear una sola
> `currentId` a un array `tabs` + `activeTabId`, con `patchActiveTab()` como punto
> único de mutación. Abrir/cerrar pestañas, "+" abre el buscador rápido para elegir
> qué mostrar en la nueva.
> **"Título" pasó a ser una propiedad más del esquema** (tipo especial `'title'`,
> id fijo `'title'`, sin `options`) en vez de una columna fija hardcodeada — ahora se
> puede arrastrar y reordenar como cualquier otra. `sanitizeSchema` en `main.js` exige
> exactamente una columna de este tipo; migración automática para bases de datos
> creadas antes de este cambio (se le agrega al principio si falta). No se puede
> ocultar ni eliminar (ni desde el menú de columna ni desde el panel de Propiedades).
> **Editor de celda Select rediseñado** calcado del picker real de Notion: pill del
> valor actual con "×", buscador que también crea una opción nueva al tipear, lista
> reordenable por drag&drop, y un puntito de color por opción que abre una paleta
> para recolorearla ahí mismo (además del mismo control ya existente en el panel de
> Propiedades).
> **Popover con portal:** los popovers de celda/columna vivían con
> `position: absolute` dentro del contenedor `overflow-x-auto` de la tabla — por la
> semántica de `overflow` en CSS (un eje no-visible fuerza al otro a `auto`) terminaban
> recortados en vez de flotar libres. Se armó un componente `Popover` genérico que
> monta vía `createPortal` en `document.body`, con posición `fixed` calculada del
> `getBoundingClientRect()` del disparador (capturado en el momento del click, nunca
> leído más tarde dentro de un `setState` funcional — ver bug de abajo).
> Drag&drop nativo para reordenar columnas en la Tabla, mismo patrón que el árbol del
> sidebar (Fase 4) y las opciones de un Select.

### Personalización: bandeja del sistema, barra de menú, íconos de página

> **Segundo plano tipo Notion:** cerrar la ventana (la X) la esconde en vez de matar
> el proceso (`Tray` + ícono en la bandeja, clic la vuelve a mostrar); solo "Salir"
> (menú Archivo o el de la propia bandeja) cierra de verdad, vía una bandera
> `isQuitting` seteada en `app.on('before-quit')` que el handler de `close` de la
> ventana consulta antes de decidir entre `hide()` o el cierre en dos tiempos ya
> existente (autosave pendiente).
> **Barra de menú ocultable:** `autoHideMenuBar: true` (Alt la muestra momentáneamente,
> convención estándar de Windows) + toggle persistente en `Ver → Mostrar barra de
> menú` para dejarla fija.
> **Íconos de página** (emoji): campo `icon` en cada página de `index.json`, IPC
> `pages:set-icon`. Selector propio en `PageView.jsx` (grilla de emoji comunes +
> campo para pegar cualquier otro) — se ve junto al título grande y en el árbol del
> sidebar.

### Paleta de colores — tres vueltas hasta el resultado final

> Iteración larga en base a feedback directo comparando contra Notion real:
> 1. Colores por defecto (`COLOR_PALETTE` en `SchemaEditor.jsx`, y los 4 de "Estado"
>    en `main.js`/`api.js`) eran genéricos — se cambiaron a los hues reales con
>    nombre de Notion (gris/marrón/naranja/amarillo/verde/azul/violeta/rosa/rojo).
> 2. Esos hues reales están pensados para texto sobre blanco: sobre el fondo casi
>    negro de la app (con alpha ~40%, el mismo patrón `tint()` de toda la Fase 9) se
>    veían apagados/"tristes". Se reemplazaron por equivalentes vívidos estilo
>    Tailwind-400, misma cantidad y mismo orden de nombres.
> 3. El texto de las etiquetas, que había pasado por blanco fijo (pedido explícito
>    anterior, para que se leyera sobre cualquier fondo), se cambió a **un tono del
>    mismo color de la etiqueta** — más oscuro en modo claro, más pálido en modo
>    oscuro (`mixHex()` mezclando el hex hacia `#000`/`#fff` una fracción fija, aplicado
>    vía variables CSS `--tag-text-light`/`--tag-text-dark` porque un `style={{}}`
>    inline no puede consultar la clase `.dark` del documento).

### Bugs de React encontrados dos veces en esta sesión (mismo patrón)

> **Nunca leer una propiedad de un evento sintético (`event.currentTarget`, etc.)
> dentro del callback funcional de un `setState`** (`setX((prev) => ...)`). React, en
> desarrollo bajo StrictMode, vuelve a invocar esa función más tarde para detectar
> impurezas — para entonces el evento ya no es válido y `currentTarget` es `null`,
> tirando `TypeError` y dejando la pantalla en negro (React desmonta todo sin
> error boundary, revelando el `backgroundColor` de la `BrowserWindow`). Apareció en
> el handler de click del encabezado de columna (doble click lo disparaba) y estuvo a
> punto de repetirse en el picker de Select. Solución siempre igual: capturar el valor
> derivado del evento en una variable **antes** de llamar a `setState`, pasar solo esa
> variable al callback funcional.

### Metodología de esta sesión (para las próximas)

> Se reforzó bastante el patrón ya anotado en la Fase 6: ante un bug de UI reportado
> por captura de pantalla, reproducirlo primero uno mismo — vía un backend en memoria
> corriendo en el navegador (`localhost:5173` sin Electron) con `javascript_tool` para
> simular clicks/drags y leer errores reales (`window.onerror`), en vez de agregar
> trazas a ciegas y esperar que el usuario vuelva a probar. Para bugs que solo existen
> con IPC real (OAuth, `getDisplayMedia`, migración de `userData`), trazas
> `console.log` temporales en `main.js` leídas directo del proceso en background.

---

## Orden y dependencias

```
F1 ✅ → F2 (persistencia) → F3 (multi-página) → F4 (jerarquía)
                                              ↘ F5 (bloques) — puede ir en paralelo tras F3
F4 + F5 → F6 (búsqueda/enlaces) → F7 (pulido) → F8 (empaquetado)
F4 → F9 (bases de datos, agregada tras el roadmap original)
F8 + F9 → F10 (rebrand FlashLab, Calendario, pestañas, grabaciones — sesión larga de pedidos incrementales)
```

Riesgos a vigilar: módulos nativos con Electron (better-sqlite3 → electron-rebuild), imágenes en producción (protocolo custom vs file://), y cualquier refactor de `Editor.jsx` debe conservar el patrón holder-hijo + `isReady`. Sumado en Fase 10: cualquier cambio futuro a `productName`/`appId` requiere revisar `migrateUserDataFolder()` y asumir que el usuario va a tener que reconectar Google Calendar (el token cifrado no sobrevive el cambio de identidad).
