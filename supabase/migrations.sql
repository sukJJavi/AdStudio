-- AdStudio — migraciones incrementales (Bloques 1-3)
--
-- Consolida en un único archivo todos los `alter table` / `create table`
-- añadidos progresivamente sobre la DDL base de `supabase/schema.sql`.
-- Es idempotente: puede ejecutarse limpio tanto sobre una base que solo
-- tenga el `schema.sql` original (antes de estos bloques) como sobre una
-- que ya esté al día (todas las sentencias usan `if not exists` / son
-- no-ops si ya se aplicaron). También puede ejecutarse sin más porque
-- `schema.sql` ya incluye estas mismas migraciones inline junto a cada
-- `create table` — este archivo es la versión consolidada y comentada
-- por bloque, útil como changelog y para bases que no se han vuelto a
-- re-ejecutar contra el `schema.sql` completo.
--
-- Orden: respeta las dependencias (adstudio_masters referencia
-- adstudio_projects, así que va después de que esa tabla exista).

-- =========================================================
-- Bloque 1 — análisis de PSD e incidencias
-- =========================================================

-- adstudio_formats.copy: copy del formato usado por el análisis de
-- incidencias para validar longitud contra lib/iab/specs.ts.
alter table adstudio_formats add column if not exists copy text;

-- Nota: "copyMaxLength" (límite de caracteres por formato IAB) NO es una
-- columna de base de datos — vive como dato estático en
-- `lib/iab/specs.ts` (array `IAB_SPECS`, campo `copyMaxLength` del tipo
-- `IABFormat`), no en `adstudio_formats`. No hay migración que aplicar
-- para ese campo.

-- =========================================================
-- Bloque 2 — master y aprobación
-- =========================================================

alter table adstudio_projects add column if not exists notes text;
alter table adstudio_projects add column if not exists master_run_id text;

create table if not exists adstudio_masters (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references adstudio_projects(id) on delete cascade,
  iab_format text not null,
  jpg_path text not null,
  png_path text not null,
  width integer not null,
  height integer not null,
  jpg_size_bytes integer,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (project_id, iab_format)
);

create index if not exists adstudio_masters_project_id_idx on adstudio_masters(project_id);

alter table adstudio_masters enable row level security;

drop policy if exists adstudio_masters_select on adstudio_masters;
create policy adstudio_masters_select on adstudio_masters
  for select using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_masters.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_masters_insert on adstudio_masters;
create policy adstudio_masters_insert on adstudio_masters
  for insert with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_masters.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_masters_update on adstudio_masters;
create policy adstudio_masters_update on adstudio_masters
  for update using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_masters.project_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_masters.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_masters_delete on adstudio_masters;
create policy adstudio_masters_delete on adstudio_masters
  for delete using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_masters.project_id and p.user_id = auth.uid()
    )
  );

-- =========================================================
-- Bloque 3 — tipografías y producción de adaptaciones
-- =========================================================

alter table adstudio_projects add column if not exists font_primary text default 'Inter';
alter table adstudio_projects add column if not exists font_secondary text default null;
update adstudio_projects set font_primary = 'Inter' where font_primary is null;
alter table adstudio_projects alter column font_primary set not null;

alter table adstudio_assets add column if not exists metadata jsonb default '{}';
update adstudio_assets set metadata = '{}' where metadata is null;
alter table adstudio_assets alter column metadata set not null;

-- =========================================================
-- Bloque 4 — editor de capas
-- =========================================================

alter table adstudio_assets
  add column if not exists frame integer default null,
  add column if not exists persistent boolean default false,
  add column if not exists discarded boolean default false,
  add column if not exists z_index integer default 0,
  add column if not exists blend_mode text default null,
  add column if not exists opacity numeric default 1,
  add column if not exists text_content text default null,
  add column if not exists layer_bounds jsonb default null;
  -- layer_bounds: { x, y, width, height } en píxeles relativos al canvas

-- =========================================================
-- Bloque 5 — HTML5 generado por agente (Claude) y cacheado
-- =========================================================

-- HTML5 del master generado una única vez por Claude (lib/render/html5-generator.ts);
-- las adaptaciones lo reutilizan vía adaptHtml5ToFormat() sin volver a llamar a Claude.
alter table adstudio_projects add column if not exists master_html text default null;

-- =========================================================
-- Bloque 6 — múltiples frames por capa
-- =========================================================

-- Campo autoritativo: una capa puede pertenecer a varios frames a la vez.
-- `frame` (integer) se mantiene por compatibilidad retroactiva, sincronizado como
-- `frames[0] ?? null` desde app/api/layers/asset/[assetId]/route.ts.
alter table adstudio_assets add column if not exists frames integer[] default null;
