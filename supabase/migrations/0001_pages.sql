-- FlashLab — Fase B: tablas de páginas en Supabase
-- Correr una sola vez en Supabase Dashboard → SQL Editor → New query → Run.
-- RLS solo-dueño (sin compartir todavía — eso es Fase C).

-- ============================================================
-- 1) Tablas
-- ============================================================

create table public.pages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  parent_id uuid references public.pages (id) on delete cascade deferrable initially deferred,
  title text not null default '',
  icon text,
  is_database boolean not null default false,
  database_schema jsonb,
  properties jsonb,
  order_index integer not null default 0,
  trashed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pages_owner_parent_idx on public.pages (owner_id, parent_id);

-- separada de `pages`: Postgres reescribe la fila entera en cada UPDATE, y el
-- autoguardado del editor (debounce de 800ms) escribe esto constantemente —
-- mezclarlo con título/orden/schema generaría contención de locks entre
-- "alguien renombra" y "alguien tipea" sobre la misma página.
create table public.page_contents (
  page_id uuid primary key references public.pages (id) on delete cascade,
  content jsonb not null default '{"blocks": []}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 2) Row Level Security — primer statement de la migración, no
--    algo para "probar al final": sin esto la tabla queda abierta
--    a cualquiera con la anon key (pública por diseño).
-- ============================================================

alter table public.pages enable row level security;
alter table public.page_contents enable row level security;

create policy "pages_select_own" on public.pages
  for select using (owner_id = (select auth.uid()));

create policy "pages_insert_own" on public.pages
  for insert with check (owner_id = (select auth.uid()));

create policy "pages_update_own" on public.pages
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "pages_delete_own" on public.pages
  for delete using (owner_id = (select auth.uid()));

create policy "page_contents_select_own" on public.page_contents
  for select using (
    exists (select 1 from public.pages p where p.id = page_contents.page_id and p.owner_id = (select auth.uid()))
  );

create policy "page_contents_insert_own" on public.page_contents
  for insert with check (
    exists (select 1 from public.pages p where p.id = page_contents.page_id and p.owner_id = (select auth.uid()))
  );

create policy "page_contents_update_own" on public.page_contents
  for update using (
    exists (select 1 from public.pages p where p.id = page_contents.page_id and p.owner_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.pages p where p.id = page_contents.page_id and p.owner_id = (select auth.uid()))
  );

create policy "page_contents_delete_own" on public.page_contents
  for delete using (
    exists (select 1 from public.pages p where p.id = page_contents.page_id and p.owner_id = (select auth.uid()))
  );

-- ============================================================
-- 3) owner_id inmutable — si no, cualquiera con permiso de UPDATE
--    podría reescribirlo y adueñarse de la página.
-- ============================================================

create or replace function public.prevent_owner_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.owner_id <> old.owner_id then
    raise exception 'owner_id no se puede modificar';
  end if;
  return new;
end;
$$;

create trigger pages_owner_immutable
  before update on public.pages
  for each row execute function public.prevent_owner_change();

-- ============================================================
-- 4) Anti-ciclos en parent_id — con escritura directa del
--    renderer (ya no solo el proceso main como en la versión
--    100% local) hace falta esta protección en la base, o un
--    ciclo cuelga cualquier recorrido del árbol.
--    `constraint trigger ... deferrable initially deferred` para
--    poder importar un árbol completo en una sola transacción sin
--    que el orden de inserción de filas individuales importe.
--    `security definer` (+ search_path fijo, para no quedar
--    vulnerable a schema hijacking): el recorrido hacia arriba del
--    árbol hace SELECTs contra `pages`, y en la Fase C esos SELECTs
--    empiezan a cruzar páginas compartidas de otros dueños — sin
--    definer, RLS se los ocultaría y el chequeo de ciclos podría
--    dar falsos negativos.
-- ============================================================

create or replace function public.prevent_parent_cycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_id uuid;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'una página no puede ser su propio padre';
  end if;
  current_id := new.parent_id;
  while current_id is not null loop
    if current_id = new.id then
      raise exception 'parent_id crearía un ciclo en el árbol de páginas';
    end if;
    select parent_id into current_id from public.pages where id = current_id;
  end loop;
  return new;
end;
$$;

create constraint trigger pages_no_cycle
  after insert or update of parent_id on public.pages
  deferrable initially deferred
  for each row execute function public.prevent_parent_cycle();

-- ============================================================
-- 5) updated_at automático
-- ============================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger pages_touch_updated_at
  before update on public.pages
  for each row execute function public.touch_updated_at();

create trigger page_contents_touch_updated_at
  before update on public.page_contents
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 6) Storage: bucket de imágenes embebidas en páginas.
--    Bucket público de LECTURA (reemplaza a appasset://local/...,
--    que ya era servido sin autenticación dentro de la app) para
--    no tener que sincronizar policies de Storage con el reparto
--    de permisos de page_shares en la Fase C. Escritura restringida
--    al dueño, en su propia carpeta ({user_id}/...).
-- ============================================================

insert into storage.buckets (id, name, public)
values ('page-assets', 'page-assets', true)
on conflict (id) do nothing;

create policy "page_assets_read_public" on storage.objects
  for select using (bucket_id = 'page-assets');

create policy "page_assets_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'page-assets'
    and (storage.foldername(name)) [1] = (select auth.uid())::text
  );

create policy "page_assets_update_own" on storage.objects
  for update using (
    bucket_id = 'page-assets'
    and (storage.foldername(name)) [1] = (select auth.uid())::text
  );

create policy "page_assets_delete_own" on storage.objects
  for delete using (
    bucket_id = 'page-assets'
    and (storage.foldername(name)) [1] = (select auth.uid())::text
  );
