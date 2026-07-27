# AdStudio — Estado del proyecto

Estado tras los Bloques 1-10 (ver `CLAUDE.md`) más la reescritura de adaptaciones a "Opción A"
(Browserless + Replicate FLUX + Claude Vision). `CLAUDE.md` tiene la arquitectura y convenciones
completas; este documento es el resumen de qué funciona, qué se ha verificado y qué falta.

## Resumen por módulo

### Brief (`/project/[id]/brief`) — funcional
Datos de campaña + tabla de formatos: **Master** (radio `is_master`, uno por proyecto, por defecto
el de mayor área), **Soporte** (badges de medios en `soportes[]`, añadir/quitar — Bloque 10:
dedupe del plan de medios por tamaño, no por soporte+tamaño), **Formato IAB** (select, admite
tamaños custom fuera del catálogo), **Dimensiones** (solo lectura), **Peso máx (KB)**, **URL
destino**, **Versiones**.

Zona de subida del Excel del plan de medios (Bloque 9: movida aquí desde `/upload`) — sube
directo a Storage, dispara `parse-media-plan` automáticamente y hace polling de `/api/brief` hasta
que el recuento de formatos se estabiliza en dos lecturas seguidas (evita quedarse con una foto a
mitad del upsert fila-a-fila del job) para rellenar la tabla sola. Formatos no producibles
(vídeo/audio/social) se listan aparte con motivo (`adstudio_projects.media_plan_excluded`), nunca
se ignoran en silencio. Aviso 🟡 no bloqueante si `psd_width`/`psd_height` del proyecto no coincide
con el formato marcado master. CRUD vía `/api/brief`, con comprobación de propiedad del proyecto.

### Upload (`/project/[id]/upload`) — funcional
Solo PSD(s) (máx. 2) + guía de animación (PDF/TXT o texto libre). El Excel ya no se sube aquí
(Bloque 9). Dispara `analyze-psd` automáticamente en cuanto hay PSD + Excel — el Excel ya existe en
`adstudio_assets` desde el Brief para cuando llega el PSD.

### Analysis / editor de capas (`/project/[id]/analysis`, `/project/[id]/layers`) — funcional
`trigger/analyze-psd.ts`: `ag-psd` + Claude Vision por capa (las de texto se clasifican directo,
sin llamar a Claude, con fuente/tamaño/contenido reales extraídos del PSD). Guarda
`psd_width`/`psd_height` del proyecto. Editor de capas: frames múltiples por capa, `persistent`,
`hidden_in_psd` (ya no se descartan solas), `export_as_jpg` por capa. "Continuar al master" solo
bloquea por `NO_USABLE_LAYERS`/`PSD_PARSE_ERROR` — fijado explícitamente por código
(`BLOCKING_INCIDENT_CODES` en `layers-editor.tsx`), no por el nivel "critico"/`derivedStatus`
genérico del análisis; recalcula incidencias vía `/api/analysis/recalculate` con las clasificaciones
actuales antes de dejar navegar.

### Master (`/project/[id]/master`) — funcional
`trigger/render-master.ts`: JPG/PNG de respaldo (Satori → Resvg → Sharp, `lib/render/jpg-renderer.ts`)
+ HTML5 de producción real vía Claude (1 llamada, `generateHtml5Master`) + ZIP subido a
`{project_id}/master/master.zip`. Usa el formato marcado `is_master` (fallback: mayor área si
ninguno lo está). "Regenerar master" resetea `master_html = null` antes de relanzar el job, para
cualquier status de partida — evita servir el HTML5 viejo si la regeneración falla a mitad.
Selector de tipografía (Google Fonts + preview), chat de cambios (tipo C, límite de rondas por
tier), aprobación pública vía `/approve/[token]` (UUID, sin login) + emails con Resend.

### Production / adaptaciones (`/project/[id]/production`) — Opción A, implementado, **sin probar contra servicios reales**
`trigger/render-adaptations.ts`, `maxDuration: 600`:
1. Excluye el formato master del loop (no se adapta a sí mismo).
2. Renderiza el master **una sola vez** con Browserless (`lib/render/browserless-renderer.ts`):
   `puppeteer-core` conecta por WebSocket a un Chrome remoto de browserless.io y navega con
   `page.goto()` a `/api/preview/[projectId]` — la misma ruta pública del iframe del master — para
   que los `src` relativos de los assets resuelvan de verdad contra Storage (un HTML servido
   inline con `setContent()` no tiene origen detrás y sale con las imágenes rotas). Requiere
   `NEXT_PUBLIC_APP_URL` pública y alcanzable desde internet (Browserless no llega a `localhost`).
3. Por formato: Replicate FLUX (`lib/render/replicate-outpainting.ts`) genera el background
   adaptado a las nuevas dimensiones (FLUX Redux si el ratio es similar, <15% de diferencia; FLUX
   Fill/outpainting si no), y Claude Vision (`adaptHtml5WithVision`) posiciona el resto de assets
   (texto/logo/CTA/decorativo) viendo el master renderizado + el background + cada asset suelto
   como imagen.
4. `background.jpg` = `fallback.jpg` = el outpainted directamente (sin composición adicional con
   Sharp por formato).
5. ZIP agrupado por medio (`adstudio_formats.soportes`, Bloque 10) en vez de por formato: cada
   pieza se genera una sola vez y sus buffers se copian a una carpeta por cada medio que necesita
   ese tamaño.

`lib/render/smart-crop.ts` (Claude Vision + Sharp para reencuadre) quedó sin uso tras esta
reescritura — se conserva en el repo para un posible uso futuro, no se llama desde ningún job.

**No verificado en runtime**: requiere `BROWSERLESS_API_KEY`, `REPLICATE_API_KEY`,
`NEXT_PUBLIC_APP_URL` pública, y un proyecto de Trigger.dev desplegado. El pipeline completo
(Browserless → FLUX → Claude Vision → ZIP) nunca se ha ejecutado de punta a punta contra los tres
servicios reales en esta sesión.

### Delivery (`/project/[id]/delivery`) — funcional, sin probar en runtime
Grid de piezas producidas, descarga del ZIP y link de preview temporal. Sin cambios de fondo esta
sesión salvo la nueva estructura de carpetas por medio dentro del ZIP (ver Production).

## Seguridad

Sin cambios esta sesión respecto al estado ya documentado en bloques anteriores:
`lib/authorization.ts::requireProjectOwnership` sigue aplicado antes de cualquier operación en las
API routes que reciben `projectId`; RLS sigue siendo la protección real a nivel de página/Server
Component; `/api/master/approve` y `/api/master/request-changes` siguen fuera del guard a
propósito (públicas por token, sin `projectId`).

## Variables de entorno

`.env.local.example` documenta ahora también `BROWSERLESS_API_KEY` (browserless.io) y
`REPLICATE_API_KEY` (replicate.com), añadidas para la Opción A de adaptaciones. El resto
(Supabase ×3, Anthropic, Trigger.dev, Resend ×2, Stripe ×3, `NEXT_PUBLIC_APP_URL`) sin cambios.

## Migraciones

`supabase/schema.sql` (DDL completa) y `supabase/migrations.sql` (idempotente, changelog por
bloque) están sincronizados e incluyen, además de los bloques anteriores: `adstudio_formats.
peso_max_kb`/`is_master`/`soportes`, `adstudio_projects.media_plan_excluded`/`psd_width`/
`psd_height`. **No ejecutadas contra un Supabase real en esta sesión** — verificadas a mano
(mismas sentencias en ambos ficheros, `if not exists` en todas, orden de dependencias correcto).

## Huecos conocidos

- **Stripe / suscripciones**: sin implementar (ni `/api/stripe`, ni checkout). Documentado en
  `CLAUDE.md` como arquitectura objetivo.
- **`validate-excel.ts`**: el job mencionado en `CLAUDE.md` para parseo/validación de copys nunca
  se construyó tal cual — `trigger/parse-media-plan.ts` cubre el parseo del plan de medios, pero
  no hay validación de copys standalone.
- **`adstudio_changes`** (cambios A/B/C/D/E): tabla y tipos existen; solo el tipo C (revisión de
  master, chat de cambios) tiene API/UI real. A/B/D/E siguen sin implementar.
- **`font_secondary`**, **`one_time_extensions`**: reservados, sin usar.
- **Smart crop** (`lib/render/smart-crop.ts`): implementado y probado en una iteración anterior de
  adaptaciones, sin uso desde que Production pasó a Opción A (Browserless + FLUX).

## Qué requiere prueba end-to-end con credenciales reales

Nada de lo de Production (Opción A) se ha ejecutado contra servicios reales esta sesión. Orden
sugerido:

1. **Supabase real**: ejecutar `schema.sql`/`migrations.sql`, confirmar RLS entre usuarios.
2. **Trigger.dev desplegado**: los cuatro jobs (`analyze-psd`, `parse-media-plan`, `render-master`,
   `render-adaptations`) requieren `npx trigger deploy`/`dev` con `TRIGGER_SECRET_KEY` real.
3. **Claude (Vision + texto)**: clasificación de capas, generación del HTML5 del master, y las
   llamadas Vision de `adaptHtml5WithVision` — nunca probadas con `ANTHROPIC_API_KEY` real en esta
   sesión.
4. **Browserless real**: confirmar que `page.goto()` a `/api/preview/[projectId]` con
   `NEXT_PUBLIC_APP_URL` pública renderiza el master con los assets cargados (no solo que el
   screenshot no falle con 400).
5. **Replicate/FLUX real**: confirmar que `flux-redux-dev`/`flux-fill-dev` devuelven una imagen
   coherente como background para al menos un formato de cada rama (ratio similar / muy distinto).
6. **Resend real**: emails de master listo / cambios solicitados, con dominio verificado.
7. **Flujo completo con un proyecto real**: Brief (+ Excel real) → Upload (PSD real) → Analysis →
   Layers → Master → aprobar → Production (Opción A completa) → Delivery → abrir el ZIP y
   verificar que cada pieza por formato/medio anima y carga sus assets correctamente.

## Cómo verificar lo que sí se ha comprobado en esta sesión

```bash
npm run build                       # compila limpio, sin errores de tipos ni lint (verificado)
npx tsc --noEmit                    # sin errores de tipos (verificado)
npx eslint <ficheros tocados>       # sin errores de lint (verificado, fichero por fichero)
```

No se ha ejecutado `npm run dev` ni se ha probado ningún flujo contra Supabase/Trigger.dev/Claude/
Browserless/Replicate reales en esta sesión — solo se ha verificado que el código compila y tipa
limpio.
