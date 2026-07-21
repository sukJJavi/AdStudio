# AdStudio

AdStudio automatiza la producción de piezas publicitarias digitales (banners IAB) que hoy se
hace a mano en una agencia: a partir de un PSD de diseño, un Excel con las adaptaciones
requeridas y un brief de campaña, genera un master aprobable por el cliente y, una vez
aprobado, produce automáticamente cada formato del plan de medios — HTML5 animado + JPG de
respaldo — listos para entregar en un ZIP. Sustituye el trabajo manual de análisis de PSD,
adaptación por formato, animación y exportación que normalmente hace un maquetador.

## Stack

- **Next.js 15** (App Router) + TypeScript + Tailwind v4 + shadcn/ui (`@base-ui/react`)
- **Supabase** — auth, Postgres (RLS por `user_id`), Storage (PSDs, capas, masters, adaptaciones, ZIPs)
- **Trigger.dev** — jobs pesados en background: análisis de PSD, render de master, render de adaptaciones
- **Claude API** (`claude-sonnet-4-6`) — clasificación visual de capas del PSD (Vision)
- **ag-psd** — extracción de capas, texto y metadata del PSD
- **Sharp** — aplanado de capas a PNG
- **Puppeteer** (`puppeteer-core` + `@sparticuz/chromium`) — render de HTML5 → JPG/PNG; Chromium
  serverless en vez del paquete `puppeteer` completo, para caber en el entorno de despliegue
- **GSAP** (CDN, embebido en las piezas generadas) — animación por defecto de las adaptaciones
- **archiver** — generación del ZIP de entrega en memoria
- **Resend** — emails transaccionales (master listo para revisar, cambios solicitados)
- **Stripe** — suscripciones y extensiones (documentado, todavía no implementado en código)

## Flujo del proyecto

Cada proyecto avanza por seis fases, reflejadas en `adstudio_projects.status` y en las páginas
bajo `/project/[id]/*`:

1. **Brief** (`/brief`) — datos de campaña (cliente, producto, objetivo, fechas, presupuesto) y
   tabla de soportes (nombre, formato IAB, versiones, copy). Valida cada fila contra
   `lib/iab/specs.ts`.
2. **Upload** (`/upload`) — hasta 2 PSD, 1 Excel de adaptaciones y una guía de animación
   opcional. En cuanto hay al menos un PSD y el Excel, lanza automáticamente el análisis
   (`trigger/analyze-psd.ts`).
3. **Analysis** (`/analysis`) — el job extrae las capas del PSD (ag-psd), las clasifica con
   Claude Vision (logo, imagen_principal, claim, subclaim, cta, disclaimer, fondo, decorativo)
   o, si son capas de texto, extrae directamente su fuente/tamaño/contenido reales sin pasar por
   Vision. Genera un informe de incidencias 🔴 crítico / 🟡 atención / 🟢 aviso por formato
   (`lib/iab/incident-analyzer.ts`) — un formato con incidencia crítica queda bloqueado, pero
   nunca bloquea el resto del proyecto.
4. **Master** (`/master`) — elige tipografía (detectada del PSD o de una lista de 20 Google
   Fonts), genera el master (`trigger/render-master.ts`, HTML5 estático → JPG/PNG con el
   formato más grande no bloqueado del plan) y lo envía a aprobación del cliente vía un link
   público firmado (`/approve/[token]`, sin login, válido 7 días). El cliente aprueba o pide
   cambios; ambas acciones notifican por email.
5. **Production** (`/production`) — una vez aprobado, produce cada formato no bloqueado
   (`trigger/render-adaptations.ts`): HTML5 animado (GSAP, máx. 15s / 3 loops, zona segura 10px)
   con assets propios en carpeta + JPG de respaldo, escalado proporcional por formato (logo máx.
   20% ancho, imagen principal máx. 55% del área, claim proporcional a `sqrt(área)`).
6. **Delivery** (`/delivery`) — grid de piezas producidas con preview, descarga del ZIP completo
   (`{cliente}_{producto}_adaptaciones.zip`, con `manifest.json`) y link de preview temporal
   (signed URL, 7 días).

## Variables de entorno

Copia `.env.local.example` a `.env.local` y rellena los valores reales — nunca se commitean
credenciales.

| Variable | Para qué |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase — *Project Settings → API* |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Cliente público (browser/sesión, respeta RLS) — *Project Settings → API* |
| `SUPABASE_SERVICE_ROLE_KEY` | Cliente admin server-side (bypass RLS; solo en jobs de Trigger.dev y en `/approve/[token]`, que no tiene sesión) — *Project Settings → API* |
| `ANTHROPIC_API_KEY` | Clasificación de capas con Claude Vision — *console.anthropic.com → API Keys* |
| `TRIGGER_SECRET_KEY` | Autenticación con Trigger.dev para lanzar/leer jobs — *Project settings → API keys* |
| `TRIGGER_API_URL` | Endpoint del proyecto de Trigger.dev — *Project settings → API keys* |
| `RESEND_API_KEY` | Envío de emails transaccionales — *dashboard de Resend → API Keys* |
| `RESEND_FROM_EMAIL` | Remitente de esos emails (requiere dominio verificado en Resend); si se deja vacía, se usa el remitente de pruebas `onboarding@resend.dev` (válido solo en desarrollo) |
| `STRIPE_SECRET_KEY` | Reservada para el módulo de suscripciones — todavía sin implementar en código |
| `STRIPE_PUBLISHABLE_KEY` | Ídem, lado cliente |
| `STRIPE_WEBHOOK_SECRET` | Ídem, verificación de webhooks |
| `NEXT_PUBLIC_APP_URL` | Origen canónico de la app (p. ej. `https://adstudio.tudominio.com`), usado para construir los links de `/approve/[token]`; si se deja vacía, se usa el origen de la request entrante (suficiente en local) |

Las tres de Supabase son imprescindibles para arrancar en local. `ANTHROPIC_API_KEY`,
`TRIGGER_SECRET_KEY`/`TRIGGER_API_URL` y `RESEND_API_KEY` son necesarias para que el análisis, el
master/producción y los emails funcionen de verdad — sin ellas la app arranca pero esos flujos
fallarán al ejecutarse. Las de Stripe no bloquean nada porque no hay código que las lea todavía.

## Cómo arrancar en local

```bash
npm install
cp .env.local.example .env.local   # y rellena los valores reales
```

Ejecuta el SQL contra tu proyecto Supabase (SQL editor del dashboard, o `supabase db push` si
usas la CLI):

1. `supabase/schema.sql` — DDL completa actual (tablas `adstudio_*`, RLS, bucket de Storage
   `adstudio-projects`). Sobre un proyecto nuevo, con este archivo basta.
2. `supabase/migrations.sql` — solo necesario si tu base de datos viene de una versión anterior
   de `schema.sql` (antes de los Bloques 2-3) y no quieres volver a pegar el archivo completo;
   aplica de forma idempotente las columnas y la tabla `adstudio_masters` añadidas después.

Después:

```bash
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000) — sin sesión redirige a `/login`; con sesión,
a `/dashboard`.

## Estructura de carpetas

```
/app
  /(auth)            → login, register, reset-password, update-password, callback
  /dashboard         → listado de proyectos del usuario
  /project/[id]
    /brief           → paso 1: datos de campaña + soportes
    /upload          → paso 2: subida PSD + Excel + guía de animación
    /analysis        → paso 3: informe de incidencias
    /master          → paso 4: tipografía + preview y aprobación del master
    /production      → paso 5: progreso de la producción de adaptaciones
    /delivery        → paso 6: descarga del ZIP + preview de piezas
  /approve/[token]   → aprobación pública del cliente (sin auth)
  /api
    /brief           → CRUD del brief
    /upload          → recibe archivos → Supabase Storage
    /analysis        → lanza y consulta el job de análisis
    /master          → generate, status/[projectId], approve-link, approve, request-changes
    /production      → start, status/[projectId]
    /project/[id]/font → guarda la tipografía elegida

/trigger
  /analyze-psd.ts        → job: ag-psd + Claude Vision por capa (+ fuente real de capas de texto)
  /render-master.ts      → job: HTML5 master estático + JPG/PNG
  /render-adaptations.ts → job: todos los formatos no bloqueados → HTML5 animado + JPG + ZIP

/lib
  /iab                → specs IAB + análisis de incidencias
  /claude             → wrapper de Claude Vision
  /render             → selección de assets clasificados + builder de HTML de canvas
  /animation          → preset de animación GSAP por defecto
  /export             → generador de ZIP (in-memory) + manifest.json
  /email              → wrapper de Resend + plantillas de email
  /supabase           → clientes Supabase (browser, server, sesión, middleware)
  /authorization.ts   → guardia de propiedad de proyecto para las API routes
  /fonts.ts           → lista de Google Fonts + helpers de import/font-family
  /types.ts           → tipos compartidos del dominio

/components
  /project            → UI por fase del proyecto (sidebar, header, forms, vistas con polling)
  /incident-report     → informe de incidencias por formato
  /approve             → acciones de la página pública de aprobación
  /auth                → formularios de login/registro/reset y logout
  /ui                  → componentes shadcn/ui

/supabase
  /schema.sql          → DDL completa actual + RLS + bucket de Storage
  /migrations.sql       → migraciones incrementales consolidadas (Bloques 1-3), idempotentes
```

Ver `CLAUDE.md` para la arquitectura y convenciones completas del proyecto, y `STATUS.md` para el
estado real de cada módulo y qué falta verificar con credenciales reales.
