-- AdStudio schema
-- Este proyecto Supabase es compartido con otras apps: todas las tablas
-- llevan el prefijo adstudio_ para aislarlas del resto del esquema.
--
-- Ejecutar en el SQL editor de Supabase (o vía `supabase db push`).
-- Requiere la extensión pgcrypto/pgcrypto para gen_random_uuid(),
-- habilitada por defecto en proyectos Supabase.

-- =========================================================
-- Tablas
-- =========================================================

create table if not exists adstudio_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  cliente text not null,
  producto text,
  objetivo text,
  fecha_inicio date,
  fecha_fin date,
  presupuesto numeric,
  status text not null default 'draft',
  tier text not null default 'starter',
  -- Comentarios del cliente al solicitar cambios sobre el master (Bloque 2).
  notes text,
  -- Run id del job de Trigger.dev de render-master en curso, para que
  -- /api/master/status/[projectId] pueda leer su progreso vía runs.retrieve.
  -- Se limpia (null) al terminar el job.
  master_run_id text,
  -- Bloque 3: tipografía elegida para claim/subclaim/CTA en master y adaptaciones.
  -- font_secondary queda reservada (no usada todavía) para un futuro par claim/subclaim.
  font_primary text not null default 'Inter',
  font_secondary text default null,
  -- Bloque 5: HTML5 del master generado una única vez por Claude
  -- (lib/render/html5-generator.ts); las adaptaciones lo reutilizan vía
  -- adaptHtml5ToFormat() sin volver a llamar a Claude.
  master_html text default null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Migración idempotente para instalaciones existentes.
alter table adstudio_projects add column if not exists notes text;
alter table adstudio_projects add column if not exists master_run_id text;
alter table adstudio_projects add column if not exists font_primary text default 'Inter';
alter table adstudio_projects add column if not exists font_secondary text default null;
update adstudio_projects set font_primary = 'Inter' where font_primary is null;
alter table adstudio_projects alter column font_primary set not null;
alter table adstudio_projects add column if not exists master_html text default null;

create table if not exists adstudio_formats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references adstudio_projects(id) on delete cascade,
  nombre_soporte text not null,
  iab_format text not null,
  url_destino text,
  versiones integer not null default 1,
  status text not null default 'pending',
  incidencias jsonb not null default '[]',
  copy text,
  created_at timestamptz not null default now()
);

-- Migración idempotente para instalaciones existentes que ya tenían
-- adstudio_formats sin la columna copy (copy del formato, usado por el
-- análisis de incidencias para validar longitud contra lib/iab/specs.ts).
alter table adstudio_formats add column if not exists copy text;

create table if not exists adstudio_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references adstudio_projects(id) on delete cascade,
  layer_name text,
  layer_type text,
  classification text,
  width integer,
  height integer,
  dpi integer,
  file_path text,
  quality_score numeric,
  -- No estaba en la DDL original del brief, pero es necesaria para el flujo
  -- de /api/upload ("registra rutas en adstudio_assets (status: 'uploaded')").
  status text not null default 'uploaded',
  -- Bloque 3: metadata de capas de texto ({ fontName, fontSize, content }),
  -- ver trigger/analyze-psd.ts. Vacío ('{}') para el resto de capas/archivos.
  metadata jsonb not null default '{}',
  -- Bloque 4 (editor de capas): frame detectado desde la carpeta padre del
  -- PSD (null si no se pudo detectar), persistent si la capa aparece en
  -- todos los frames, discarded si el usuario la descarta en el editor,
  -- z_index para el orden de apilado, blend_mode/opacity/layer_bounds
  -- extraídos de ag-psd, text_content para capas de texto editables.
  frame integer default null,
  persistent boolean not null default false,
  discarded boolean not null default false,
  z_index integer not null default 0,
  blend_mode text default null,
  opacity numeric default 1,
  text_content text default null,
  -- { x, y, width, height } en píxeles relativos al canvas
  layer_bounds jsonb default null,
  -- Bloque 6: campo autoritativo de frames — una capa puede pertenecer a varios
  -- a la vez. `frame` se mantiene por compatibilidad, sincronizado a frames[0].
  frames integer[] default null,
  created_at timestamptz not null default now()
);

alter table adstudio_assets add column if not exists metadata jsonb default '{}';
update adstudio_assets set metadata = '{}' where metadata is null;
alter table adstudio_assets alter column metadata set not null;

alter table adstudio_assets
  add column if not exists frame integer default null,
  add column if not exists persistent boolean default false,
  add column if not exists discarded boolean default false,
  add column if not exists z_index integer default 0,
  add column if not exists blend_mode text default null,
  add column if not exists opacity numeric default 1,
  add column if not exists text_content text default null,
  add column if not exists layer_bounds jsonb default null;

alter table adstudio_assets add column if not exists frames integer[] default null;

-- Masters generados (Bloque 2). Un proyecto puede tener varias variantes
-- (una por formato IAB usado como canvas); is_primary marca la usada para
-- el link de aprobación y el email al cliente.
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

create table if not exists adstudio_changes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references adstudio_projects(id) on delete cascade,
  type text,
  description text,
  formats_affected jsonb not null default '[]',
  requested_at timestamptz not null default now(),
  status text not null default 'pending'
);

create table if not exists adstudio_approval_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references adstudio_projects(id) on delete cascade,
  token uuid not null default gen_random_uuid(),
  expires_at timestamptz,
  approved_at timestamptz
);

create table if not exists adstudio_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  tier text not null default 'starter',
  stripe_id text,
  projects_limit integer not null default 3,
  formats_limit integer not null default 20,
  rounds_limit integer not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists adstudio_formats_project_id_idx on adstudio_formats(project_id);
create index if not exists adstudio_assets_project_id_idx on adstudio_assets(project_id);
create index if not exists adstudio_masters_project_id_idx on adstudio_masters(project_id);
create index if not exists adstudio_changes_project_id_idx on adstudio_changes(project_id);
create index if not exists adstudio_approval_tokens_project_id_idx on adstudio_approval_tokens(project_id);
create index if not exists adstudio_approval_tokens_token_idx on adstudio_approval_tokens(token);
create index if not exists adstudio_subscriptions_user_id_idx on adstudio_subscriptions(user_id);

-- =========================================================
-- updated_at trigger para adstudio_projects
-- =========================================================

create or replace function adstudio_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists adstudio_projects_set_updated_at on adstudio_projects;
create trigger adstudio_projects_set_updated_at
  before update on adstudio_projects
  for each row
  execute function adstudio_set_updated_at();

-- =========================================================
-- RLS
-- =========================================================

alter table adstudio_projects enable row level security;
alter table adstudio_formats enable row level security;
alter table adstudio_assets enable row level security;
alter table adstudio_masters enable row level security;
alter table adstudio_changes enable row level security;
alter table adstudio_approval_tokens enable row level security;
alter table adstudio_subscriptions enable row level security;

-- adstudio_projects: dueño directo via user_id

drop policy if exists adstudio_projects_select on adstudio_projects;
create policy adstudio_projects_select on adstudio_projects
  for select using (user_id = auth.uid());

drop policy if exists adstudio_projects_insert on adstudio_projects;
create policy adstudio_projects_insert on adstudio_projects
  for insert with check (user_id = auth.uid());

drop policy if exists adstudio_projects_update on adstudio_projects;
create policy adstudio_projects_update on adstudio_projects
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists adstudio_projects_delete on adstudio_projects;
create policy adstudio_projects_delete on adstudio_projects
  for delete using (user_id = auth.uid());

-- adstudio_formats: dueño via project_id -> adstudio_projects.user_id

drop policy if exists adstudio_formats_select on adstudio_formats;
create policy adstudio_formats_select on adstudio_formats
  for select using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_formats.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_formats_insert on adstudio_formats;
create policy adstudio_formats_insert on adstudio_formats
  for insert with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_formats.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_formats_update on adstudio_formats;
create policy adstudio_formats_update on adstudio_formats
  for update using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_formats.project_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_formats.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_formats_delete on adstudio_formats;
create policy adstudio_formats_delete on adstudio_formats
  for delete using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_formats.project_id and p.user_id = auth.uid()
    )
  );

-- adstudio_assets: dueño via project_id -> adstudio_projects.user_id

drop policy if exists adstudio_assets_select on adstudio_assets;
create policy adstudio_assets_select on adstudio_assets
  for select using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_assets.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_assets_insert on adstudio_assets;
create policy adstudio_assets_insert on adstudio_assets
  for insert with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_assets.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_assets_update on adstudio_assets;
create policy adstudio_assets_update on adstudio_assets
  for update using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_assets.project_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_assets.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_assets_delete on adstudio_assets;
create policy adstudio_assets_delete on adstudio_assets
  for delete using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_assets.project_id and p.user_id = auth.uid()
    )
  );

-- adstudio_masters: dueño via project_id -> adstudio_projects.user_id
-- Nota: /approve/[token] lee los masters con la service role (sin sesión),
-- igual que adstudio_approval_tokens.

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

-- adstudio_changes: dueño via project_id -> adstudio_projects.user_id

drop policy if exists adstudio_changes_select on adstudio_changes;
create policy adstudio_changes_select on adstudio_changes
  for select using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_changes.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_changes_insert on adstudio_changes;
create policy adstudio_changes_insert on adstudio_changes
  for insert with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_changes.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_changes_update on adstudio_changes;
create policy adstudio_changes_update on adstudio_changes
  for update using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_changes.project_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_changes.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_changes_delete on adstudio_changes;
create policy adstudio_changes_delete on adstudio_changes
  for delete using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_changes.project_id and p.user_id = auth.uid()
    )
  );

-- adstudio_approval_tokens: dueño via project_id -> adstudio_projects.user_id
-- Nota: la página pública /approve/[token] no usa estas policies porque
-- consulta con la service role key (bypass de RLS) desde el servidor.

drop policy if exists adstudio_approval_tokens_select on adstudio_approval_tokens;
create policy adstudio_approval_tokens_select on adstudio_approval_tokens
  for select using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_approval_tokens.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_approval_tokens_insert on adstudio_approval_tokens;
create policy adstudio_approval_tokens_insert on adstudio_approval_tokens
  for insert with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_approval_tokens.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_approval_tokens_update on adstudio_approval_tokens;
create policy adstudio_approval_tokens_update on adstudio_approval_tokens
  for update using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_approval_tokens.project_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_approval_tokens.project_id and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_approval_tokens_delete on adstudio_approval_tokens;
create policy adstudio_approval_tokens_delete on adstudio_approval_tokens
  for delete using (
    exists (
      select 1 from adstudio_projects p
      where p.id = adstudio_approval_tokens.project_id and p.user_id = auth.uid()
    )
  );

-- adstudio_subscriptions: dueño directo via user_id

drop policy if exists adstudio_subscriptions_select on adstudio_subscriptions;
create policy adstudio_subscriptions_select on adstudio_subscriptions
  for select using (user_id = auth.uid());

drop policy if exists adstudio_subscriptions_insert on adstudio_subscriptions;
create policy adstudio_subscriptions_insert on adstudio_subscriptions
  for insert with check (user_id = auth.uid());

drop policy if exists adstudio_subscriptions_update on adstudio_subscriptions;
create policy adstudio_subscriptions_update on adstudio_subscriptions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists adstudio_subscriptions_delete on adstudio_subscriptions;
create policy adstudio_subscriptions_delete on adstudio_subscriptions
  for delete using (user_id = auth.uid());

-- =========================================================
-- Storage: bucket 'adstudio-projects'
-- Estructura de objetos: {project_id}/psd/..., {project_id}/excel/..., {project_id}/animation/...
-- =========================================================

insert into storage.buckets (id, name, public)
values ('adstudio-projects', 'adstudio-projects', false)
on conflict (id) do nothing;

drop policy if exists adstudio_storage_select on storage.objects;
create policy adstudio_storage_select on storage.objects
  for select using (
    bucket_id = 'adstudio-projects'
    and exists (
      select 1 from adstudio_projects p
      where p.id::text = (storage.foldername(name))[1]
      and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_storage_insert on storage.objects;
create policy adstudio_storage_insert on storage.objects
  for insert with check (
    bucket_id = 'adstudio-projects'
    and exists (
      select 1 from adstudio_projects p
      where p.id::text = (storage.foldername(name))[1]
      and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_storage_update on storage.objects;
create policy adstudio_storage_update on storage.objects
  for update using (
    bucket_id = 'adstudio-projects'
    and exists (
      select 1 from adstudio_projects p
      where p.id::text = (storage.foldername(name))[1]
      and p.user_id = auth.uid()
    )
  );

drop policy if exists adstudio_storage_delete on storage.objects;
create policy adstudio_storage_delete on storage.objects
  for delete using (
    bucket_id = 'adstudio-projects'
    and exists (
      select 1 from adstudio_projects p
      where p.id::text = (storage.foldername(name))[1]
      and p.user_id = auth.uid()
    )
  );

-- Nota: las subidas de esta app se hacen desde /api/upload usando la
-- service role key (bypass de RLS). Las policies de storage.objects
-- anteriores solo son necesarias si en el futuro se sube directamente
-- desde el navegador con la anon key.
