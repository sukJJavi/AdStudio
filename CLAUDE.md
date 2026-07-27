# AdStudio

SaaS que automatiza la producción de piezas publicitarias digitales (banners IAB): análisis de PSD, adaptación por formato, HTML5 y exportación, sustituyendo el trabajo manual de producción en agencia.

## Stack

- **Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui** — frontend y API routes
- **Supabase** — auth, Postgres, storage (PSDs, assets, ZIPs)
- **Trigger.dev** — jobs pesados: análisis de PSD, render de master y adaptaciones
- **Claude API (claude-sonnet-4-6)** — Vision (clasificación de capas, adaptación de layout) y Text (generación de HTML5)
- **ag-psd** — extracción de capas de PSD
- **Sharp** — procesado de imágenes: PNG de capas, conversión a JPG, composición del fallback
- **Satori + Resvg** — render del PNG/JPG del master sin navegador (Satori compone a SVG, Resvg rasteriza a PNG); nada de Puppeteer/Chromium
- **Browserless** — renderiza el HTML5 real del master a PNG vía Chrome remoto, como referencia visual para Claude Vision y FLUX
- **Replicate (FLUX Kontext Pro)** — reencuadra imágenes (fondo/imagen_principal) a nuevos formatos IAB
- **Stripe** — suscripciones y extensiones (reservado, sin implementar aún)
- **Resend** — emails transaccionales

## Flujo del producto

1. **Brief** (`/project/[id]/brief`) — datos de campaña, tabla de formatos, sube el Excel del plan de medios → dispara `parse-media-plan`
2. **Upload** (`/project/[id]/upload`) — sube PSD(s) + guía de animación opcional → dispara `analyze-psd`
3. **Analysis** (`/project/[id]/analysis`) — informe de incidencias por formato
4. **Layers** (`/project/[id]/layers`) — editor de capas: frame, clasificación, orden, descarte
5. **Master** (`/project/[id]/master`) — genera y aprueba el master → dispara `render-master`; aprobación pública sin login en `/approve/[token]`
6. **Production** (`/project/[id]/production`) — lanza y sigue el progreso de las adaptaciones → dispara `render-adaptations`
7. **Delivery** (`/project/[id]/delivery`) — descarga del ZIP final + preview cliente

## Jobs de Trigger.dev

- **`analyze-psd`** — recibe `projectId`. Extrae capas del PSD con ag-psd, aplana carpetas (detecta frame/persistente por nombre de carpeta), clasifica cada capa con Claude Vision (o extrae texto directo si es capa de texto), asigna filename único y sube cada capa como PNG a Storage. Produce filas en `adstudio_assets` con `classification`, `frames`, `layer_bounds`, `z_index`, `blend_mode`, `opacity`.
- **`parse-media-plan`** — recibe `projectId`. Parsea el Excel del plan de medios (busca la tabla real entre bloques y notas, no asume posición fija), filtra formatos producibles (Estándar/Banner/Display con patrón `WxH`), deduplica por tamaño y hace upsert en `adstudio_formats` sin pisar campos ya editados a mano. Las filas no producibles se guardan en `adstudio_projects.media_plan_excluded`.
- **`render-master`** — recibe `projectId` y el formato elegido. Compone el fallback.jpg con las capas reales del frame del CTA (Sharp), renderiza el PNG/JPG de respaldo con Satori, genera el HTML5 de producción con Claude (una sola llamada, cacheada en `adstudio_projects.master_html`) y empaqueta todo en `{project_id}/master/master.zip`.
- **`render-adaptations`** — recibe `projectId`. Por cada formato del plan (excepto el master): reencuadra fondo/imagen_principal con FLUX Kontext, recompone el layout con Claude Vision, compone el fallback.jpg con Sharp, y agrupa todo en un ZIP organizado por medio/formato.

## Arquitectura de carpetas

```
/app
  /dashboard              proyectos del usuario
  /project/[id]/...       las 7 fases del flujo (brief, upload, analysis, layers, master, production, delivery)
  /approve/[token]        aprobación pública del cliente, sin auth
  /guide/psd              guía pública de preparación de PSD
  /api                    API routes: brief, upload, analysis, layers, master, production, preview, stripe
/trigger                  los 4 jobs de Trigger.dev descritos arriba
/lib
  /iab                    specs IAB (dimensiones, pesos) + análisis de incidencias
  /claude                 wrappers del cliente Claude (vision, text)
  /render                 pipeline de render: layout, copy, assets, fuentes, HTML5, fallback, Browserless, Replicate
  /export                 generación del ZIP (in-memory, archiver) + manifest
  /supabase               clientes Supabase (browser, server, sesión, Trigger.dev)
  authorization.ts        requireProjectOwnership — guardia de auth para API routes
/components
  /project                UI por fase del proyecto
  /incident-report        informe de incidencias por formato
```

## Modelo de datos

- **`adstudio_projects`** — `status` (fase actual), `tier`, `font_primary`, `master_html` (HTML5 cacheado), `media_plan_excluded`, `psd_width`/`psd_height`
- **`adstudio_formats`** — por proyecto: `iab_format`, `nombre_soporte`, `status` (`pending`/`producing`/`ready`/`incident`), `incidencias[]`, `copy`, `peso_max_kb`, `is_master` (uno solo por proyecto), `soportes[]` (medios/plataformas que necesitan ese tamaño)
- **`adstudio_assets`** — capas extraídas del PSD: `classification`, `frames[]` (autoritativo; `frame` deprecado), `persistent`, `discarded`, `hidden_in_psd`, `export_as_jpg`, `z_index`, `blend_mode`, `opacity`, `text_content`, `layer_bounds`, `metadata.filename` (nombre real en Storage)
- **`adstudio_masters`** — variantes de master generadas, una por formato IAB, con `is_primary`
- **`adstudio_changes`** — `type` (A–E), `formats_affected[]`, `status`
- **`approval_tokens`** — UUID → proyecto, `expires_at`, `approved_at`
- **`subscriptions`** — `tier`, límites, `stripe_id`

## Pipeline de render

### Master

PSD → ag-psd extrae capas → Claude Vision clasifica cada capa → editor de capas (usuario ajusta frame/clasificación/orden) → Claude genera el HTML5 de producción (una llamada, recibe el árbol de capas como JSON) → Browserless renderiza ese HTML5 a PNG real para preview → ZIP con `index.html` + PNGs de capas + `fallback.jpg` (compuesto con Sharp a partir de las capas reales, no un re-render).

### Adaptaciones

Por cada formato del plan (menos el master):

1. Claude Vision identifica el sujeto principal de cada imagen a reencuadrar (fondo/imagen_principal)
2. Replicate FLUX Kontext Pro adapta esa imagen al nuevo formato, dejando espacio para el resto de elementos
3. Claude Vision genera el HTML5 recomponiendo el layout completo — recibe el master renderizado (Browserless), las imágenes ya adaptadas y el resto de assets como imágenes sueltas
4. Sharp compone el `fallback.jpg` con las capas reales (adaptadas cuando aplica)
5. La pieza se genera una vez y se copia a una carpeta por cada entrada en `adstudio_formats.soportes[]` dentro del ZIP

## Tiers y límites

| Tier | Precio | Proyectos | Formatos | Rondas de cambios |
|---|---|---|---|---|
| Starter | 199€/mes | 3 activos | 20 | 1 ronda (A+B) |
| Studio | 499€/mes | 10 | ilimitados | 3 rondas (A+B+C) |
| Agency | 999€/mes | ilimitado | ilimitados | todo (A+B+C+D+E) |

Tipos de cambio: **A** copy · **B** elemento visual (logo/imagen/color) · **C** layout/estructura · **D** variante nueva · **E** revisión de master.

## Reglas IAB LEAN

- Peso máximo por defecto: 150KB HTML5 (sin contar PNGs externos, nunca en base64)
- Animación: máx 15s, máx 3 loops, sin autoplay con sonido
- Zona segura: 10px interior en todos los formatos
- Siempre entregar HTML5 + JPG de respaldo

## Convenciones

- Naming de assets aplanados del PSD: `f{N}_{classification}.png` si tiene frame, `{classification}.png` si es persistente con rol reservado, nombre original saneado si es `desconocido` (ver `baseFilenameFor` en `trigger/analyze-psd.ts`)
- Estructura del ZIP de adaptaciones: `{cliente}_{producto}/{medio}/{iab_format}/index.html|fallback.jpg|{filename}.png...`
- Incidencias: solo `NO_USABLE_LAYERS` y `PSD_PARSE_ERROR` bloquean el avance al master; el resto (nivel 🟡 ATENCIÓN o menor) no impide navegar
- Niveles de incidencia: 🟢 AVISO (produce) · 🟡 ATENCIÓN (produce, puede no ser óptimo) · 🔴 CRÍTICO (bloquea ese formato, no el proyecto)
- Auth: `requireProjectOwnership(projectId)` al principio de toda API route que reciba un `projectId`
- Supabase en jobs de Trigger.dev: usar siempre `createTriggerSupabaseClient`, nunca el cliente de sesión de usuario
- Nunca bloquear el proyecto completo por un formato con incidencia crítica
