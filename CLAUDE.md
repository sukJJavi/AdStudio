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
- Sharp: procesado de imágenes
- Puppeteer: render HTML5 → JPG
- GSAP: animaciones en banners
- Stripe: suscripciones y extensiones
- Resend: emails transaccionales

## Arquitectura de carpetas
/app
  /dashboard          → proyectos del usuario
  /project/[id]
    /brief            → paso 1: datos campaña + formatos
    /upload           → paso 2: subida PSD + Excel + animación
    /analysis         → paso 3: informe de incidencias
    /master           → paso 4: preview y aprobación master
    /production       → paso 5: progreso de adaptaciones
    /delivery         → paso 6: descarga ZIP + preview cliente
  /approve/[token]    → página pública aprobación cliente (sin auth)
  /api
    /brief            → CRUD brief
    /upload           → recibe archivos → Supabase Storage
    /analysis         → lanza Trigger.dev job de análisis
    /master           → generate, status/[projectId], approve-link → lanza render-master.ts
    /master/approve, /master/request-changes → aprobación pública del master (sin sesión)
    /production       → start, status/[projectId] → lanza render-adaptations.ts
    /project/[id]/font → PATCH, guarda font_primary del selector de tipografía
    /stripe           → webhooks Stripe

/trigger
  /analyze-psd.ts     → job: ag-psd + Claude Vision por capas (+ fontName/fontSize/content de capas de texto)
  /validate-excel.ts  → job: parseo + validación copys
  /render-master.ts   → job: HTML5 master estático + JPG/PNG, aplica font_primary del proyecto
  /render-adaptations.ts → job: todos los formatos no bloqueados → HTML5 animado (GSAP) + JPG de respaldo → ZIP

/lib
  /iab                → specs IAB (dimensiones, pesos, zonas seguras) + análisis de incidencias
  /claude             → wrappers Claude API (vision, text)
  /render             → selección de assets clasificados + builder de HTML de canvas (compartido master/adaptations)
  /animation          → preset de animación GSAP por defecto
  /export             → generador de ZIP (in-memory, archiver) + manifest
  /fonts.ts           → lista de Google Fonts + helpers de import/font-family

/components
  /project            → UI por fase del proyecto
  /banner-preview     → previsualizador de piezas
  /incident-report    → informe de incidencias por formato

## Modelo de datos (tablas principales)
- users, workspaces
- projects (brief, status, tier snapshot, font_primary/font_secondary)
- formats (por proyecto: dimensiones, copy, status, incidencias)
- assets (capas extraídas del PSD, clasificadas; metadata jsonb con fontName/fontSize/content en capas de texto)
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
- Peso máximo por defecto: 150KB HTML5, sin límite JPG de respaldo
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
  `{cliente}_{producto}/manifest.json` y `{cliente}_{producto}/{nombre_soporte}_{iab_format}/index.html|assets/|fallback.jpg`
- manifest.json incluye: dimensiones, peso (JPG y HTML), versión, fecha, incidencias por pieza
- Nunca bloquear el proyecto completo por un formato con incidencia crítica

## Tipografía y animación por defecto (Bloque 3)
- `adstudio_projects.font_primary` (Google Font, default `Inter`) se aplica a claim/subclaim/CTA
  en master y adaptaciones, cargada vía `@import url(fonts.googleapis.com/css2?family=...)`;
  fallback automático a Arial si la fuente no carga (font-stack, sin lógica extra)
- Detección de tipografía real del PSD: `adstudio_assets.metadata.fontName/fontSize/content`
  en capas `classification = 'texto'` (no pasan por Claude Vision, se extraen directo de ag-psd)
- Escalado por formato en adaptaciones: logo máx 20% ancho, imagen principal máx 55% del área,
  claim proporcional a `sqrt(área)` (base 16px en 300x250), CTA altura fija 32px/padding 12px
- Animación por defecto (sin guía propia): fade fondo+imagen (0-2s) → slide up claim (2-4s) →
  fade subclaim (4-5s) → pop CTA (5-6s) → hold (6-15s) → loop máx 3 veces, vía GSAP desde CDN