# Supabase en AdStudio

## Clientes: cuál usar

Tres wrappers en `lib/supabase/`, no confundirlos:

- **`createSessionSupabaseClient()`** (`lib/supabase/server-session.ts`, usa `createServerClient` de `@supabase/ssr` + cookies de `next/headers`).
  Para Server Components, Server Actions y Route Handlers que actúan **en nombre del usuario logueado**. Respeta RLS. Es el cliente por defecto para leer/escribir datos del proyecto (`adstudio_projects`, `adstudio_formats`, `adstudio_assets`, `adstudio_changes`, `adstudio_subscriptions`).
- **`createBrowserSupabaseClient()`** (`lib/supabase/client.ts`, `createBrowserClient` de `@supabase/ssr`).
  Solo en Client Components (`"use client"`). Respeta RLS. Usar solo si hace falta reactividad en cliente (realtime, listeners de auth); si el dato se puede leer en el server, preferir Server Component + `createSessionSupabaseClient`.
- **`createServerSupabaseClient()`** (`lib/supabase/server.ts`, `createClient` de `@supabase/supabase-js` con `SUPABASE_SERVICE_ROLE_KEY`).
  Service-role, **bypassa RLS por completo**. Reservado para: jobs de Trigger.dev (`/trigger/*.ts`), webhooks de Stripe, y la página pública `/approve/[token]` (no hay sesión de usuario ahí). Nunca importar este cliente desde código que sirve datos a un usuario autenticado.

## Regla RLS: nunca service-role para datos del usuario

Cualquier route handler, server action o page que lea/escriba datos en nombre del usuario logueado (dashboard, brief, upload, analysis, master, production, delivery) debe usar `createSessionSupabaseClient()`. Usar el cliente de service-role ahí anula las policies de RLS y puede filtrar datos de otro `user_id`. El service-role solo se justifica cuando no existe sesión de usuario (job en background, webhook, endpoint público con token).

Ver `lib/assets.ts` como patrón de referencia (siempre `createSessionSupabaseClient`, con `try/catch` que devuelve `[]`/vacío si falla en vez de tirar la request).

## Tablas (prefijo `adstudio_`)

Todas las tablas viven en `supabase/schema.sql`, prefijadas porque el proyecto Supabase es compartido con otras apps:

- `adstudio_projects` — proyecto (brief, `status`, `tier`). PK `id`, dueño por `user_id`.
- `adstudio_formats` — formatos IAB de un proyecto (`iab_format`, `versiones`, `status`, `incidencias jsonb`). FK `project_id`.
- `adstudio_assets` — capas extraídas del PSD + archivos subidos (PSD/Excel/animación) y clasificación (`layer_name`, `layer_type`, `classification`, `width`, `height`, `dpi`, `file_path`, `quality_score`, `status`). FK `project_id`.
- `adstudio_masters` — masters generados (`trigger/render-master.ts`, Bloque 2): una fila por variante/formato IAB usado como canvas (`iab_format`, `jpg_path`, `png_path`, `width`, `height`, `jpg_size_bytes`, `is_primary`). FK `project_id`. `is_primary` marca la variante usada en el link de aprobación y el email al cliente; solo una por proyecto.
- `adstudio_changes` — solicitudes de cambio tipo A/B/C/D/E (`type`, `formats_affected jsonb`, `status`). FK `project_id`.
- `adstudio_approval_tokens` — UUID de aprobación pública (`token`, `expires_at`, `approved_at`). FK `project_id`. Se consulta con service-role desde `/approve/[token]` porque no hay sesión.
- `adstudio_subscriptions` — tier y límites (`tier`, `stripe_id`, `projects_limit`, `formats_limit`, `rounds_limit`). Dueño por `user_id`.

Todas tienen RLS habilitado; policy estándar es "dueño directo por `user_id`" (`adstudio_projects`, `adstudio_subscriptions`) o "dueño vía `project_id` → `adstudio_projects.user_id`" (el resto). Al añadir una tabla nueva, replicar ese patrón de policies y añadirla a este listado.

Storage: bucket `adstudio-projects` (privado), estructura `{project_id}/psd/...`, `{project_id}/excel/...`, `{project_id}/animation/...`. Las subidas desde `/api/upload` usan service-role; las policies de `storage.objects` solo aplican si en el futuro se sube directo desde el navegador con la anon key.
