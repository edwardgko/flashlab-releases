# Reglas del proyecto

## Lectura obligatoria al iniciar un nuevo chat

Al iniciar cualquier nueva sesión o chat sobre este proyecto, consultar y leer ARQUITECTURA.md para comprender de inmediato la lógica del sistema, stack, flujos de datos, módulos y componentes sin necesidad de reanalizar el código desde cero.

## Mobile first

Pensar siempre en mobile first en todo lo que se haga en este proyecto (UI, layout, interacciones). Diseñar y maquetar primero para pantallas chicas, y expandir hacia desktop después (`sm:`/`md:`/`lg:` en Tailwind como mejora progresiva, no como base). Esto aplica a toda funcionalidad nueva y a cualquier ajuste visual, no solo a pantallas pensadas explícitamente para mobile.

## Idioma y modo de respuesta

Responder siempre en español en este proyecto. Además, activar el modo caveman (skill `caveman`) en cada sesión de trabajo sobre este repo.

## Regla de oro: publicar cada cambio a GitHub Release

Cada ronda de cambios (fix, feature, lo que sea) termina con `npm run release` — no alcanza con un build local (`npm run dist`) ni con mandar el instalador por chat. Pasos:

1. Bump de `"version"` en `package.json`.
2. `GH_TOKEN` en el entorno (o en `.env` de la raíz, gitignored).
3. Pre-crear el release en GitHub antes de correr `npm run release` (electron-builder 26.15.3 tiene una race condition real si el release no existe todavía — ver memoria `notion-clone-auto-update` para el comando curl exacto y cómo limpiar un release parcial si ya pasó).
4. `npm run release` (= `vite build && electron-builder --publish always`) — publica el `.exe` + `.blockmap` + `latest.yml`.
5. Buildear también el `.apk` de Android y subirlo a ESE MISMO release (electron-builder no lo toca, hay que subirlo aparte):
   - `npx cap sync android` (copia el `dist/` ya buildeado en el paso 4 al proyecto nativo).
   - `JAVA_HOME="C:\Users\edwar\dev-tools\jdk21-home" android\gradlew.bat assembleRelease` (correr desde `android/`) — `versionCode`/`versionName` salen solos de `package.json`, no hay que tocar `build.gradle`.
   - Subir `android/app/build/outputs/apk/release/app-release.apk` como asset `FlashLab-X.Y.Z.apk` al release ya creado en el paso 3 (vía API de GitHub — `POST` a `uploads.github.com/repos/edwardgko/flashlab-releases/releases/{release_id}/assets?name=FlashLab-X.Y.Z.apk`, no hay flag de electron-builder para esto).

Esto reemplaza el flujo anterior de "build local + mandar el .exe por chat" — ese sigue sirviendo para builds de prueba que el usuario todavía no confirmó, pero una vez que un cambio está listo para quedar, se publica **con los dos instaladores en el mismo release, no solo el `.exe`** — así el botón "Actualizar" de Android (que compara contra `/releases/latest`) siempre encuentra un `.apk` de la misma versión. No dejar cambios "solo probados localmente" sin publicar de una sesión a la otra, y no dejar un release con un solo instalador cuando el otro también cambió (aunque el cambio de esa ronda haya sido pensado solo para desktop o solo para mobile — si el código es compartido, versionar los dos).

## Regla de oro: migraciones SQL siempre se entregan como archivo

Cada vez que se le pida al usuario correr una migración de Supabase (nueva o pendiente de rondas anteriores), hay que darle el/los archivo(s) directamente (mandarlos como adjunto, ej. con la herramienta de enviar archivos) — no alcanza con nombrar la ruta o decir "correlas en el SQL Editor". El usuario no las encuentra solo navegando el repo. Esto vale tanto para migraciones nuevas de la ronda actual como para cualquier pendiente de rondas anteriores que se le vuelva a recordar.
