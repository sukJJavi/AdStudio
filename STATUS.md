# AdStudio — Estado del proyecto

Estado real tras los Bloques 1-4. Ver `CLAUDE.md` para la arquitectura y convenciones completas,
`README.md` para cómo arrancar en local.

## Resumen por módulo

### Brief (`/project/[id]/brief`) — funcional
Formulario de campaña + tabla editable de soportes, validados contra `lib/iab/specs.ts` (15
formatos IAB). CRUD vía `/api/brief` (GET/POST/PUT/DELETE), ahora con comprobación explícita de
propiedad del proyecto (ver Seguridad más abajo). Verificado con `npm run build`; no probado
end-to-end contra un Supabase real en esta sesión.

### Upload (`/project/[id]/upload`) — funcional
Tres zonas de subida (PSD, Excel, guía de animación) → Storage + `adstudio_assets` vía
`/api/upload`. Dispara el análisis automáticamente al tener PSD + Excel. Requiere
`SUPABASE_SERVICE_ROLE_KEY` real y el bucket `adstudio-projects` creado (vía `schema.sql`) para
funcionar; no ejecutado contra credenciales reales en esta sesión.

### Analysis (`/project[id]/analysis`) — funcional, sin probar en runtime
`trigger/analyze-psd.ts`: extrae capas con `ag-psd`, aplana a PNG con Sharp, clasifica con Claude
Vision (`lib/claude/vision.ts`, modelo `claude-sonnet-4-6`) — salvo las capas de texto, que se
clasifican directamente como `'texto'` con su fuente/tamaño/contenido reales extraídos del PSD
(`layer.text.style.font.name`), sin llamar a Claude. Genera el informe de incidencias
(`lib/iab/incident-analyzer.ts`). **No verificado en runtime**: requiere `ANTHROPIC_API_KEY` real,
un proyecto de Trigger.dev desplegado (`npx trigger deploy` nunca se ha ejecutado) y un PSD real
de prueba.

### Master (`/project/[id]/master`) — funcional, verificado parcialmente
Selector de tipografía (fuente detectada del PSD + 20 Google Fonts + preview en vivo) →
`PATCH /api/project/[id]/font`. `trigger/render-master.ts` descarga las capas clasificadas
(fondo/imagen principal/logo) y la Google Font elegida, y compone el banner con
`lib/render/jpg-renderer.ts` (Satori → SVG → Resvg → PNG → Sharp → JPG, sin navegador) para el
JPG/PNG, y `lib/render/html5-generator.ts` (string building puro) para el HTML. Aprobación
pública vía `/approve/[token]` (UUID, 7 días, sin login) + emails con Resend. El pipeline de
render (descarga de fuente real de Google Fonts vía el truco de User-Agent legacy, construcción
del árbol Satori, rasterizado con Resvg, conversión a JPG con Sharp) se probó de extremo a extremo
localmente en esta sesión con datos de prueba — no verificado dentro de un job real de
Trigger.dev. Pendiente: `RESEND_API_KEY` real para los emails.

### Production (`/project/[id]/production`) — funcional, verificado parcialmente
`trigger/render-adaptations.ts` produce cada formato no bloqueado: JPG vía Satori+Resvg (mismo
pipeline que Master) + HTML5 animado autocontenido (GSAP vía CDN, fondo/imagen/logo embebidos en
base64 — el límite IAB LEAN de 150KB aplica al HTML sin contar esos assets), con el escalado
proporcional pedido (logo 20% ancho, imagen principal 55% del área, claim `16px·√(área/75000)`,
CTA 32px de alto) calculado una sola vez en `lib/render/layout.ts` y compartido entre el JPG y el
HTML. Progreso derivado del `status` de cada formato en BD (sin depender de metadata de
Trigger.dev). Un formato que falla no aborta el resto del lote. Mismo nivel de verificación que
Master (pipeline de render probado localmente, no dentro de un job real).

### Delivery (`/project/[id]/delivery`) — funcional, sin probar en runtime
Grid de piezas producidas (JPG de respaldo vía signed URL), descarga del ZIP
(`{cliente}_{producto}_adaptaciones.zip`, con `manifest.json`) y link de preview temporal (signed
URL, 7 días). Depende de que `render-adaptations.ts` se haya ejecutado antes.

## Seguridad (Bloque 4)

- **IDOR cerrado**: `lib/authorization.ts::requireProjectOwnership(projectId)` — exige sesión
  (401 `Unauthorized` si no hay) y que `adstudio_projects.user_id = auth.uid()` (403 `Forbidden`
  en caso contrario, tanto si el proyecto no existe como si es de otro usuario, para no filtrar
  cuál de los dos). Aplicado antes de cualquier operación en: `/api/brief` (GET/PUT/DELETE — POST
  es creación, no aplica), `/api/upload`, `/api/analysis`, `/api/analysis/status/[projectId]`,
  `/api/master/generate`, `/api/master/status/[projectId]`, `/api/master/approve-link`,
  `/api/production/start`, `/api/production/status/[projectId]`, `/api/project/[id]/font`.
  `/api/master/approve` y `/api/master/request-changes` quedan fuera a propósito — son públicas
  por token (sin `projectId`, sin sesión), como pide el flujo de aprobación del cliente.
- **Bloqueo de jobs concurrentes**: `POST /api/analysis`, `POST /api/master/generate` y
  `POST /api/production/start` comprueban el `status` del proyecto (`analyzing`,
  `master_generating`, `producing` respectivamente — no `generating_master`, que no existe en
  nuestro enum real) y devuelven `429 { error: "Job already running" }` si ya hay uno en curso.
  Esto es un **candado de concurrencia por proyecto**, no un rate limiter genérico (no limita
  volumen de requests por IP/usuario ni protege contra polling agresivo de los endpoints
  `GET .../status/[projectId]`) — Supabase Auth aplica sus propios límites en los endpoints de
  login/registro por separado.
- **Páginas** (`/project/[id]/*`, Server Components): ya usaban `createSessionSupabaseClient` +
  RLS antes de este bloque, así que un usuario que visite el proyecto de otro no ve sus datos
  (RLS filtra la fila directamente); no se ha añadido un guard adicional a nivel de página porque
  la protección real ya la da RLS en el propio `select`.
- **Raíz (`/`)**: ahora redirige server-side a `/dashboard` (con sesión) o `/login` (sin sesión),
  en vez de ser una landing suelta.

## Variables de entorno

`.env.local.example` documenta las 12 variables usadas o reservadas (Supabase ×3, Anthropic,
Trigger.dev ×2, Resend ×2, Stripe ×3, `NEXT_PUBLIC_APP_URL`) con comentario de dónde conseguir
cada una. `RESEND_FROM_EMAIL` y `NEXT_PUBLIC_APP_URL` son nuevas en este bloque y ya están
cableadas en el código (`lib/email/client.ts`, `lib/approval.ts`) con fallback si se dejan vacías.
Las tres de Stripe están documentadas pero **no hay código que las lea** — el módulo de
suscripciones no está implementado, solo previsto en `CLAUDE.md`.

## Migraciones

- `supabase/schema.sql` — DDL completa y actual; ya incluye inline todas las columnas y la tabla
  `adstudio_masters` añadidas en los Bloques 1-3. Suficiente por sí sola para un proyecto nuevo.
- `supabase/migrations.sql` — nuevo en este bloque: consolida esos mismos `alter table`/
  `create table` en un único archivo idempotente, pensado para bases que vengan de una versión
  anterior de `schema.sql` y no quieran re-pegar el archivo completo. No se ha ejecutado contra
  un Supabase real en esta sesión (no hay credenciales) — sintácticamente verificado a mano
  contra `schema.sql` (mismas sentencias, mismo orden de dependencias).

## Preparado para Git

- `.gitignore` ya cubre `.env`, `.env.local`, `.env.*.local`, `/node_modules`, `/.next/`,
  `/out/`, `*.psd`, `*.xlsx`, `*.xls` — verificado, sin cambios necesarios.
- No se ha ejecutado ningún comando de git en esta sesión (ni `git init` ni ningún otro). El
  repo queda listo para que lo inicialices tú:
  ```bash
  git init
  git add .
  git commit -m "feat: AdStudio MVP completo"
  ```

## Huecos conocidos (fuera del alcance de los Bloques 1-4)

- **Stripe / suscripciones**: sin implementar (ni `/api/stripe`, ni checkout, ni lectura de
  `adstudio_subscriptions` desde la UI). Documentado en `CLAUDE.md` como arquitectura objetivo.
- **`validate-excel.ts`**: mencionado en `CLAUDE.md` como job planeado (parseo/validación de
  copys del Excel de adaptaciones); nunca se ha construido — hoy el Excel solo se sube y
  previsualiza en cliente (`upload-zones.tsx`), no se valida ni se cruza con los formatos.
- **`adstudio_changes`** (solicitudes de cambio A/B/C/D/E): tabla y tipos existen
  (`lib/types.ts`), pero no hay API ni UI para crearlas o gestionarlas.
- **`font_secondary`**: columna reservada, sin usar todavía (solo hay un selector de tipografía
  primaria).
- **`one_time_extensions`**: mencionada en `CLAUDE.md`, nunca modelada en el schema.

## Qué requiere prueba end-to-end con credenciales reales

Salvo el pipeline de render (ver punto 4), nada de lo anterior se ha ejecutado contra servicios
reales en esta sesión — solo se ha verificado que compila y tipa limpio. Para validar de verdad
hace falta, en este orden:

1. **Supabase real**: ejecutar `schema.sql` (o `migrations.sql` sobre una base antigua), probar
   registro/login real (envía un email de confirmación real desde el proyecto compartido) y
   confirmar que RLS efectivamente aísla proyectos entre usuarios distintos.
2. **Trigger.dev desplegado**: los tres jobs (`analyze-psd`, `render-master`,
   `render-adaptations`) nunca se han ejecutado contra un proyecto de Trigger.dev real — hace
   falta `npx trigger deploy` (o `dev`) con `TRIGGER_SECRET_KEY`/`TRIGGER_API_URL` reales antes de
   que `tasks.trigger(...)` tenga algo que ejecutar.
3. **Claude Vision real**: subir un PSD real y confirmar que la clasificación por capa
   (`ANTHROPIC_API_KEY`) produce categorías razonables y que el `quality_score` calculado tiene
   sentido con dimensiones/dpi reales.
4. **Render sin navegador (Satori+Resvg)**: ya no hay Puppeteer/Chromium en el proyecto —
   `render-master.ts` y `render-adaptations.ts` usan `lib/render/jpg-renderer.ts` (Satori compone
   el árbol de nodos a SVG, Resvg lo rasteriza a PNG, Sharp lo convierte a JPG) y
   `lib/render/html5-generator.ts` (string building puro, sin renderizar nada). El pipeline
   completo — descarga real de una Google Font vía `lib/render/font-loader.ts`, construcción del
   árbol Satori con imágenes de prueba, SVG → PNG con Resvg, PNG → JPG con Sharp — se ejecutó y
   verificó localmente en esta sesión (fuera de Trigger.dev) sin errores. Pendiente confirmar
   dentro de un job real: que el entorno de Trigger.dev tiene salida de red hacia
   `fonts.googleapis.com` (si no, `loadGoogleFont` falla al no poder descargar la fuente — no hay
   fallback a una fuente local) y que `@resvg/resvg-js` (binario nativo prebuilt) tiene un binario
   compatible con la arquitectura/SO del runtime de Trigger.dev.
5. **Resend real**: confirmar que los emails de "master listo" y "cambios solicitados" llegan,
   con `RESEND_FROM_EMAIL` apuntando a un dominio verificado (el remitente de pruebas
   `onboarding@resend.dev` no es apto para producción).
6. **Flujo completo con un proyecto real**: Brief → Upload (PSD + Excel reales) → Analysis →
   elegir tipografía → generar Master → aprobar vía `/approve/[token]` → Production → descargar
   el ZIP de Delivery y abrir un `index.html` generado en un navegador para confirmar que la
   animación GSAP y las rutas relativas a `assets/` funcionan fuera de Supabase Storage.

## Cómo verificar lo que sí se ha comprobado en esta sesión

```bash
npm run build   # compila limpio, sin errores de tipos ni lint (verificado)
npx tsc --noEmit -p tsconfig.json   # sin errores de tipos (verificado)
npx eslint app lib components       # sin errores de lint (verificado)
npm run dev     # servidor local; "/" redirige según sesión, /project/* exige login
```
