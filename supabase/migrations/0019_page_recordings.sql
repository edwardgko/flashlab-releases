-- FlashLab — grabaciones visibles para quien tiene la página compartida.
-- Correr en Supabase Dashboard → SQL Editor → New query → Run.
--
-- El video en sí NO vive acá: sigue en el disco de quien grabó y, si se
-- subió, en su Google Drive. Esta tabla es solo el índice —nombre + link de
-- Drive— para que a los invitados de la página les APAREZCA la grabación en
-- vez de no ver nada (antes, recordings/<pageId>.json era 100% local y una
-- página compartida no mostraba ninguna).
--
-- Solo se publica una fila cuando la grabación ya está subida a Drive: sin
-- drive_url no habría forma de que el invitado la abra.

create table public.page_recordings (
  -- mismo id que la grabación local (userData/recordings/<pageId>.json), así
  -- publicar es un upsert idempotente y no hay que mapear ids
  id uuid primary key,
  page_id uuid not null references public.pages (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  drive_file_id text,
  drive_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index page_recordings_page_idx on public.page_recordings (page_id);
create index page_recordings_owner_idx on public.page_recordings (owner_id);

alter table public.page_recordings enable row level security;

-- Ver: cualquiera que tenga acceso a la página (dueño o compartido, aunque
-- sea 'viewer').
create policy "page_recordings_select_access" on public.page_recordings
  for select using (public.has_access(page_id, (select auth.uid()), 'viewer'));

-- Escribir: SOLO el dueño de la grabación (owner_id), y encima tiene que
-- poder editar la página. Un 'editor' invitado puede publicar las suyas,
-- pero NO tocar ni borrar las de otro: para todos los demás la grabación es
-- de solo lectura, tengan el rol que tengan en la página.
create policy "page_recordings_insert_own" on public.page_recordings
  for insert with check (
    owner_id = (select auth.uid())
    and public.has_access(page_id, (select auth.uid()), 'editor')
  );

create policy "page_recordings_update_own" on public.page_recordings
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "page_recordings_delete_own" on public.page_recordings
  for delete using (owner_id = (select auth.uid()));
