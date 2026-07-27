# AdStudio (Nombre provisional)

SaaS para automatizar producción de piezas publicitarias digitales (banners IAB).
Sustituye el trabajo manual de producción en agencia: análisis de PSD, 
adaptaciones por formato, animación y exportación.

## Stack
- Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui
- Supabase: auth, Postgres, storage (PSDs, assets, ZIPs)
- Trigger.dev: jobs pesados (análisis PSD, render, exportación)
- Claude API (claude-sonnet-4-6): Vision + Text
- ag-psd: extracción de capas PSD
- Sharp: procesado de imágenes (PNG de capas del PSD, conversión final a JPG)
- Satori + Resvg (`satori`, `@resvg/resvg-js`): render del JPG del banner sin navegador — Satori
  compone un árbol de nodos a SVG, Resvg lo rasteriza a PNG. Nada de Puppeteer/Chromium: no hay
  binario que descargar ni proceso de navegador que lanzar en el entorno serverless de Trigger.dev
- GSAP: animaciones en banners
- Stripe: suscripciones y extensiones
- Resend: emails transaccionales

## Arquitectura de carpetas
/app
  /dashboard          → proyectos del usuario
  /project/[id]
    /brief            → paso 1: datos campaña + formatos + subida del Excel del plan de medios (dispara
                          parse-media-plan, ver Bloque 8/9) — el Excel se sube aquí, no en /upload
    /upload           → paso 2: subida PSD(s) + guía de animación (el Excel ya se subió en el brief)
    /analysis         → paso 3: informe de incidencias
    /layers           → paso 4: editor de capas (frame, clasificación, orden, descarte)
    /master           → paso 5: preview y aprobación master
    /production       → paso 6: progreso de adaptaciones
    /delivery         → paso 7: descarga ZIP + preview cliente
  /approve/[token]    → página pública aprobación cliente (sin auth)
  /guide/psd          → guía pública de preparación de PSD (sin auth)
  /api
    /brief            → CRUD brief
    /upload           → recibe archivos → Supabase Storage
    /analysis         → lanza Trigger.dev job de análisis
    /layers           → GET/project/[projectId] lista capas, PATCH/asset/[assetId] edita una, POST/project/[projectId]/reorder batch z_index
    /master           → generate, status/[projectId], approve-link → lanza render-master.ts
    /master/approve, /master/request-changes → aprobación pública del master (sin sesión)
    /production       → start, status/[projectId] → lanza render-adaptations.ts
    /project/[id]/font → PATCH, guarda font_primary del selector de tipografía
    /stripe           → webhooks Stripe

/trigger
  /analyze-psd.ts     → job: ag-psd + Claude Vision por capas (+ fontName/fontSize/content de capas de texto;
                          aplana el árbol de carpetas detectando frame/persistent desde el nombre de carpeta,
                          más blend_mode/opacity/layer_bounds/z_index por capa — ver editor de capas)
  /parse-media-plan.ts → job: parser inteligente del Excel de plan de medios (agencia, no tabla simple).
                          Se dispara solo con que haya Excel subido (no depende del PSD, a diferencia de
                          analyze-psd — ver `lib/media-plan.ts` y `app/api/upload/route.ts`). Busca en todas
                          las hojas la fila header (matchea ≥2 de "Formato"/"Tamaño"/"Soporte"/"Plataforma"),
                          resuelve columnas por nombre (Soporte/Soporte Detalle, Plataforma/Proveedor,
                          Tamaño/Duración|Tamaño|Formato, Tipo de Formato, Peso), filtra filas Estándar/Banner/
                          Display con patrón WxH y sin palabras de vídeo/audio/social, dedupe por
                          soporte+tamaño único (`nombre_soporte = "{plataforma} - {soporte}"`), mapea tamaño →
                          iab_format del catálogo o `"{W}x{H}"` custom si no está catalogado (ver
                          `lib/iab/specs.ts:resolveFormatDimensions`), y hace upsert manual en
                          adstudio_formats (no pisa url_destino/versiones/status si el usuario ya los editó
                          en el brief). Las filas descartadas (vídeo/audio/social/etc.) no se ignoran: se
                          guardan en `adstudio_projects.media_plan_excluded` y se muestran en el brief como
                          "no producibles por AdStudio" con el motivo.
  /validate-excel.ts  → job: parseo + validación copys
  /render-master.ts   → job: JPG/PNG de respaldo (Satori+Resvg, aplica font_primary) + HTML5 del master vía
                          Claude (1 sola llamada, ver html5-generator.ts) + ZIP (index.html + PNGs de capas +
                          fallback.jpg) subido a {project_id}/master/master.zip
  /render-adaptations.ts → job: Opción A (Browserless + Replicate FLUX + Claude Vision), maxDuration: 600.
                          Excluye el formato master (adstudio_formats.is_master, o el de mayor área si
                          ninguno lo está); lo renderiza UNA VEZ con Browserless (lib/render/browserless-
                          renderer.ts) y reutiliza ese PNG para todos los formatos. Por cada formato: FLUX
                          (lib/render/replicate-outpainting.ts) genera un background adaptado a las nuevas
                          dimensiones, y Claude Vision (adaptHtml5WithVision) posiciona el resto de assets
                          (texto/logo/CTA) viendo el master renderizado + el background + cada asset como
                          imagen. background.jpg = fallback.jpg = el outpainted (no hay composición con sharp
                          por formato). ZIP global, una carpeta por medio en adstudio_formats.soportes
                          (pieceFoldersFor en lib/export/zip.ts)

/lib
  /iab                → specs IAB (dimensiones, pesos, zonas seguras) + análisis de incidencias
  /claude             → wrappers Claude API (vision, text)
  /render
    /layout.ts          → cálculo de proporciones (logo/imagen/claim/CTA) del JPG/PNG de respaldo (Satori)
    /copy.ts            → split de adstudio_formats.copy en claim/subclaim/disclaimer
    /assets.ts          → selección de assets clasificados + descarga desde Storage
    /font-loader.ts     → descarga el TTF/OTF real de una Google Font (Satori no acepta fuentes por URL)
    /jpg-renderer.ts    → renderBannerToJpg/Png: árbol de nodos → Satori (SVG) → Resvg (PNG) → Sharp (JPG),
                          usado solo para el fallback.jpg — no interviene en el HTML5
    /html5-generator.ts → generateHtml5Master: 1 llamada a Claude por proyecto (el master), genera el HTML5
                          de producción (assets referenciados por filename externo, nunca en base64) —
                          ver prompt de agente en el propio fichero. adaptHtml5WithVision (Opción A): 1
                          llamada a Claude VISION por formato de adaptación — el mensaje mezcla texto e
                          imágenes: el master renderizado de verdad (Browserless), el background ya adaptado
                          por FLUX (que Claude referenciará como `background.jpg`, sin pedírselo como asset a
                          reposicionar), cada asset de primer plano suelto (texto/logo/CTA/decorativo —
                          BACKGROUND_CLASSIFICATIONS excluye fondo/imagen_principal) y el HTML del master como
                          texto. Claude solo decide dónde va CADA ELEMENTO DE PRIMER PLANO, no recompone el
                          fondo (eso ya lo hizo FLUX)
    /browserless-renderer.ts → renderHtmlToImage(projectId, width, height): conecta por WebSocket a un
                          Chrome remoto de browserless.io y navega a `/api/preview/[projectId]` (la misma
                          ruta pública del iframe del master) para que los assets (`src` relativos) resuelvan
                          de verdad contra Storage — un HTML servido inline (`setContent`) no tiene origen
                          detrás y sale con las imágenes rotas. Screenshot PNG = referencia visual real del
                          master (con animación en el frame inicial) para Claude Vision y para el outpainting
                          de FLUX. Requiere NEXT_PUBLIC_APP_URL configurada (no hay request entrante de la
                          que derivar el origen dentro de un job de Trigger.dev)
    /replicate-outpainting.ts → outpaintToFormat: genera el background adaptado a un formato con Replicate
                          FLUX. Ratio similar (<15% de diferencia) → FLUX Redux (reencuadre/variación); ratio
                          muy distinto → canvas del tamaño destino con el master centrado + FLUX Fill
                          (outpainting) para extender el resto
    /html5-cache.ts     → saveHtml5Master/getHtml5Master: cachea el HTML5 del master en
                          adstudio_projects.master_html — evita volver a llamar a Claude para regenerar el
                          master en cada adaptación (cada adaptación sí llama a Claude una vez, para
                          recomponer el layout a su propio formato)
    /animation-guide.ts → lee la guía de animación (.txt) subida por el usuario, para pasarla a Claude
  /animation          → preset de animación GSAP por defecto (legacy, sin uso desde el nuevo html5-generator)
  /export             → generador de ZIP (in-memory, archiver) + manifest
  /fonts.ts           → lista de Google Fonts + helpers de import/font-family

/components
  /project            → UI por fase del proyecto
  /banner-preview     → previsualizador de piezas
  /incident-report    → informe de incidencias por formato

## Modelo de datos (tablas principales)
- users, workspaces
- projects (brief, status, tier snapshot, font_primary/font_secondary, master_html — HTML5 del master
  cacheado, ver `lib/render/html5-cache.ts`; media_plan_excluded — filas del Excel de medios descartadas
  por `trigger/parse-media-plan.ts`, ver Bloque 8)
- formats (por proyecto: dimensiones, copy, status, incidencias, peso_max_kb — detectado del plan de medios
  o editado a mano en el brief, ver Bloque 8)
- assets (capas extraídas del PSD, clasificadas; metadata jsonb con fontName/fontSize/content en capas de
  texto y filename en toda capa aplanada a PNG — nombre de fichero en Storage y en el HTML5, ver
  trigger/analyze-psd.ts).
  Campos del editor de capas (Bloque 4, ver `app/project/[id]/layers`):
  | campo | tipo | uso |
  |---|---|---|
  | frames | integer[] \| null | **Bloque 6, campo autoritativo**: frames a los que pertenece la capa (una capa puede estar en varios); vacío/null si no se asignó ninguno o es persistente |
  | frame | integer \| null | *deprecado*, compatibilidad retroactiva — sincronizado como `frames[0] ?? null` desde `app/api/layers/asset/[assetId]/route.ts` |
  | persistent | boolean | capa presente en todos los frames; si true, frame(s) siempre null/vacío |
  | discarded | boolean | descartada por el usuario, no se usa en master ni adaptaciones |
  | hidden_in_psd | boolean | **Bloque 7**: capa oculta en el PSD original (`layer.hidden`) — ya NO se descarta automáticamente, se clasifica/exporta igual que las visibles y el usuario decide en el editor |
  | export_as_jpg | boolean | **Bloque 7**: exportar como JPG calidad 85 en el ZIP en vez de PNG (toggle del editor, solo para `fondo`/`imagen_principal`); el PNG en Storage nunca cambia, la conversión ocurre al construir el ZIP (`lib/render/export-format.ts`) |
  | z_index | integer | orden de apilado dentro de su frame |
  | blend_mode | text \| null | modo de fusión del PSD (`layer.blendMode`) |
  | opacity | numeric | 0–1, `layer.opacity / 255` |
  | text_content | text \| null | contenido editable de capas de texto |
  | layer_bounds | jsonb \| null | `{ x, y, width, height }` en px relativos al canvas del PSD |
- masters (variantes de master generadas, una por formato IAB usado como canvas; is_primary)
- changes (tipo A/B/C/D/E, formatos afectados, status)
- approval_tokens (UUID → project, expires_at, approved_at)
- subscriptions (tier, limits, stripe_id)
- one_time_extensions

## Tiers y límites
Starter  199€/mes  3 proyectos activos, 20 formatos, 1 ronda cambios A+B
Studio   499€/mes  10 proyectos, ilimitados formatos, 3 rondas A+B+C
Agency   999€/mes  ilimitado todo, tipos de cambio A+B+C+D+E

## Tipos de cambio
A → copy only
B → elemento visual (logo, imagen, color)
C → layout/estructura
D → variante nueva
E → revisión de master

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/` (no git remote is configured for this repo). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root, created lazily as decisions get resolved. See `docs/agents/domain.md`.

## Reglas IAB LEAN (aplicar siempre)
- Peso máximo por defecto: 150KB HTML5 sin contar los PNGs de capas (ficheros externos junto al
  index.html, nunca embebidos en base64 — ver html5-generator.ts), sin límite JPG de respaldo
- Animación: máx 15s, máx 3 loops, sin autoplay con sonido
- Zona segura: 10px interior en todos los formatos
- Siempre entregar HTML5 + JPG de respaldo

## Niveles de incidencia
🟢 AVISO     → produce, calidad aceptable
🟡 ATENCIÓN  → produce, resultado puede no ser óptimo
🔴 CRÍTICO   → bloquea ese formato, no el proyecto completo

## Convenciones
- Cada job de Trigger.dev reporta progreso por paso (no solo inicio/fin)
- El link de aprobación es un UUID en /approve/[token], sin login
- El ZIP se nombra `{cliente}_{producto}_adaptaciones.zip`, con esta estructura interna:
  `{cliente}_{producto}/manifest.json` y, por cada medio en `adstudio_formats.soportes` (o `nombre_soporte`
  si no hay ninguno, ver Bloque 10):
  `{cliente}_{producto}/{medio}/{iab_format}/index.html|background.jpg|{filename}.png (resto de capas)|fallback.jpg`
  (background.jpg es el generado por FLUX para ese formato — Opción A, ver adaptHtml5WithVision en
  html5-generator.ts; fallback.jpg es ese mismo buffer; el resto de PNGs son los mismos del master en todos
  los formatos, Claude Vision decide dónde posicionarlos). El ZIP del master (`{project_id}/master/master.zip`)
  sigue la misma estructura sin subcarpeta por pieza (fallback.jpg ahí sí compuesto con Satori/sharp, ver
  render-master.ts).
- manifest.json incluye: dimensiones, peso (JPG y HTML), versión, fecha, incidencias por pieza
- Nunca bloquear el proyecto completo por un formato con incidencia crítica

## Tipografía y animación por defecto (Bloque 3 — solo aplica al JPG/PNG de respaldo vía Satori)
- `adstudio_projects.font_primary` (Google Font, default `Inter`) se aplica a claim/subclaim/CTA
  del fallback.jpg/png (Satori, `lib/render/jpg-renderer.ts` + `lib/render/layout.ts`); fallback
  automático a Arial si la fuente no carga (font-stack, sin lógica extra)
- Detección de tipografía real del PSD: `adstudio_assets.metadata.fontName/fontSize/content`
  en capas `classification = 'texto'` (no pasan por Claude Vision, se extraen directo de ag-psd)
- Escalado del fallback.jpg/png por formato: logo máx 20% ancho, imagen principal máx 55% del área,
  claim proporcional a `sqrt(área)` (base 16px en 300x250), CTA altura fija 32px/padding 12px
- El HTML5 (master y adaptaciones) ya NO usa este layout ni GSAP: lo genera Claude directamente
  (ver `lib/render/html5-generator.ts`), infiriendo la animación del orden de frames y clasificación
  de capas, o de la guía de animación si el usuario subió una (`lib/render/animation-guide.ts`)

## Plan de medios — parser del Excel (Bloque 8)
- El Excel real de un plan de medios de agencia no es una tabla simple (bloques por soporte, notas,
  cabeceras variables): `trigger/parse-media-plan.ts` busca la tabla principal en vez de asumir una
  posición fija, y se dispara automáticamente al subir el Excel (independiente de si ya hay PSD)
- Solo se producen formatos con tipo de formato Estándar/Banner/Display, tamaño con patrón `WxH`
  detectado, y sin palabras de vídeo/audio/social (`:15`/`:20`/`:30`, mp4, mp3, Stories, Reels...).
  El resto NO se ignora: se guarda en `adstudio_projects.media_plan_excluded` y se muestra en el
  brief como "no producible por AdStudio" con el motivo (vídeo/audio/social/otro)
- Deduplicación: varias filas del mismo soporte+tamaño para distintos targets/fechas colapsan en un
  único `adstudio_formats`, nombrado `"{plataforma} - {soporte}"`
- Tamaños del catálogo IAB mapean a su `iab_format` (300x250→medium-rectangle, 728x90→leaderboard,
  300x600→half-page, 320x480→mobile-interstitial, 160x600→wide-skyscraper, 970x250→billboard,
  320x50→mobile-banner); cualquier otro tamaño válido se guarda como `iab_format: "{W}x{H}"` (custom,
  fuera del catálogo — ver `lib/iab/specs.ts:resolveFormatDimensions`, usado en vez de
  `getIABFormatById` donde hay que soportar estos formatos custom, p. ej. `components/project/brief-form.tsx`)
- El upsert en `adstudio_formats` no pisa `url_destino`/`versiones`/`status` de formatos que el
  usuario ya haya editado a mano en el brief tras una importación anterior — solo actualiza
  `peso_max_kb`. El usuario puede corregir cualquier campo del formato detectado antes de analizar el PSD

## Smart Crop (sin uso actualmente, disponible para futuro)
- `lib/render/smart-crop.ts`: reencuadra con Claude Vision una imagen para un
  formato de proporción muy distinta a la original. Con diferencia de
  proporción < 20% hace un resize/cover directo con Sharp, sin llamar a Claude
- **No se usa en `trigger/render-adaptations.ts`**: el background adaptado a
  cada formato lo genera Replicate FLUX (Opción A, `lib/render/replicate-
  outpainting.ts`), no smart-crop; el resto de assets del master se reutilizan
  tal cual — es Claude Vision quien decide cómo posicionarlos, no hace falta
  recortar el PNG. La función se mantiene para un posible uso futuro (p. ej.
  si se necesitara recortar un asset concreto en vez de reposicionarlo)
- Cache en memoria por ejecución del job, clave `{srcW}x{srcH}_to_{targetW}x{targetH}`:
  varios formatos con la misma proporción origen→destino no repiten la llamada
  a Claude Vision. Asume que imagen_principal y fondo no comparten exactamente
  las mismas dimensiones de origen dentro del mismo proyecto (si coincidieran,
  compartirían crop — limitación aceptada, ver comentario en el propio fichero)
- Fallback si Claude no devuelve un JSON de recorte válido (o falla la llamada):
  center crop calculado localmente según la proporción destino

## Refactoring de flujo (Bloque 9)
- El Excel del plan de medios se sube en `/brief` (no en `/upload`): zona de drop propia en
  `components/project/brief-form.tsx`, mismo patrón de subida directa a Storage con progreso
  (`lib/client-upload.ts`, compartido con `components/project/upload-zones.tsx`). Al terminar, dispara
  `parse-media-plan` y hace polling de `/api/brief` (sin endpoint de status para ese job) para rellenar
  la tabla de formatos automáticamente
- `/upload` queda solo con PSD(s) + guía de animación; el Excel ya existe en `adstudio_assets` para
  cuando llegue el PSD (el auto-trigger de `analyze-psd` en `app/api/upload/route.ts` sigue exigiendo
  PSD + Excel, sin cambios)
- "Continuar al master" (editor de capas) solo bloquea por `NO_USABLE_LAYERS` o `PSD_PARSE_ERROR` —
  fijado explícitamente por código en `components/project/layers-editor.tsx`
  (`BLOCKING_INCIDENT_CODES`), no por el nivel "critico"/derivedStatus del análisis. Cualquier otra
  incidencia (LOW_QUALITY_MAIN_IMAGE, MISSING_COPY, MISSING_MAIN_IMAGE...) es como mucho ATENCIÓN y no
  impide navegar
- `adstudio_projects.psd_width/psd_height`: dimensiones reales del canvas del PSD, guardadas en
  `trigger/analyze-psd.ts` al leer el archivo. El brief avisa (🟡, no bloquea) si no coinciden con las
  del formato marcado como master
- Formato master explícito: `adstudio_formats.is_master` (radio button en el brief, solo uno true por
  proyecto, forzado en `app/api/brief/route.ts`). Por defecto se marca el de mayor área
  (`withDefaultMaster` en `brief-form.tsx`), pero el usuario puede cambiarlo. `lib/master.ts` y
  `trigger/render-master.ts` usan el formato marcado en vez de asumir "el de mayor área"; sin ninguno
  marcado (planes antiguos) caen a ese fallback
- Regenerar master (botón en `components/project/master-view.tsx`) resetea
  `adstudio_projects.master_html = null` en `lib/master.ts:triggerMasterGeneration` antes de lanzar el
  job, para cualquier status de partida (no solo `master_ready`/`approved`) — evita servir el HTML5
  viejo si el job de regeneración falla a mitad

## Dedupe por tamaño y ZIP agrupado por soporte (Bloque 10)
- `trigger/parse-media-plan.ts` deduplica por TAMAÑO únicamente (antes: soporte+tamaño): un mismo
  `adstudio_formats` cubre todos los medios del plan que necesiten ese tamaño, acumulados en el nuevo
  campo `soportes` (jsonb, array de strings — ver `adstudio_formats.soportes`). `nombre_soporte` pasa a
  ser siempre el tamaño (`"300x250"`), nunca el nombre del medio
  - Reimportar el Excel fusiona `soportes` (unión), nunca lo sobreescribe — no borra medios que el
    usuario haya añadido a mano en el brief
- En el brief (`components/project/brief-form.tsx`), la columna "Soporte" muestra los medios como
  badges (`row.soportes`), editables (añadir con Enter, quitar con ×). `nombre_soporte` ya no es un
  campo editable: se deriva automáticamente del `iab_format` (`nombreSoporteFor`)
- ZIP de adaptaciones (`trigger/render-adaptations.ts` + `lib/export/zip.ts:pieceFoldersFor`): cada
  pieza (HTML5 + PNGs recortados + fallback.jpg) se genera UNA SOLA VEZ por formato, y sus buffers se
  copian (mismas referencias, no se regeneran) a una carpeta `{medio}/{iab_format}/` por cada entrada de
  `soportes[]`. Si un formato no tiene ningún medio asignado, cae a una única carpeta
  `{nombre_soporte}/{iab_format}/` (el tamaño). El ZIP del master no cambia (sigue sin subcarpeta por
  pieza, ver Bloque 8 en Convenciones)
