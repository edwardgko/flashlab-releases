-- FlashLab — Fase C: compartir páginas con permisos
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- 0001_pages.sql y 0002_calendar_tokens.sql).

-- ============================================================
-- 1) Tabla page_shares
-- ============================================================
-- invited_email siempre se guarda (es "a qué email se compartió"), user_id
-- se completa después, cuando esa persona se loguea por primera vez y
-- reclama la invitación (claim_pending_shares(), más abajo) — así el dueño
-- siempre puede mostrar el email de cada persona con la que compartió, esté
-- registrada en FlashLab o no todavía.

create table public.page_shares (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.pages (id) on delete cascade,
  invited_email text not null,
  user_id uuid references auth.users (id) on delete cascade,
  role text not null check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now()
);

create unique index page_shares_page_email_uidx on public.page_shares (page_id, lower(invited_email));
create index page_shares_user_idx on public.page_shares (user_id);

alter table public.page_shares enable row level security;

-- visible para el dueño de la página (para administrar quién tiene acceso) y
-- para la persona con la que se compartió (para que sepa su propio rol)
create policy "page_shares_select" on public.page_shares
  for select using (
    exists (select 1 from public.pages p where p.id = page_shares.page_id and p.owner_id = (select auth.uid()))
    or user_id = (select auth.uid())
    or lower(invited_email) = lower((select auth.jwt() ->> 'email'))
  );

-- administrar quién tiene acceso (crear/editar rol/quitar) es solo del
-- owner_id de esa página puntual — nunca vía has_access recursivo, si no un
-- editor invitado podría re-compartir a terceros sin que el dueño se entere
create policy "page_shares_insert_owner" on public.page_shares
  for insert with check (
    exists (select 1 from public.pages p where p.id = page_shares.page_id and p.owner_id = (select auth.uid()))
  );

create policy "page_shares_update_owner" on public.page_shares
  for update using (
    exists (select 1 from public.pages p where p.id = page_shares.page_id and p.owner_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.pages p where p.id = page_shares.page_id and p.owner_id = (select auth.uid()))
  );

create policy "page_shares_delete_owner" on public.page_shares
  for delete using (
    exists (select 1 from public.pages p where p.id = page_shares.page_id and p.owner_id = (select auth.uid()))
  );

-- ============================================================
-- 2) has_access(page_id, uid, min_role) — recorre el árbol hacia
--    arriba desde page_id: dueño de cualquier ancestro, o un
--    page_shares en cualquier ancestro, da acceso al descendiente
--    completo (compartir una base de datos comparte sus filas/
--    subpáginas). SECURITY DEFINER + search_path fijo: sin esto
--    quedaría vulnerable a schema hijacking (el error de seguridad
--    clásico en funciones SECURITY DEFINER de Postgres), y además
--    necesita saltarse RLS para poder leer páginas de OTROS dueños
--    mientras recorre la cadena de ancestros.
-- ============================================================

create or replace function public.has_access(target_page_id uuid, uid uuid, min_role text default 'viewer')
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  current_id uuid := target_page_id;
  row_owner uuid;
  row_parent uuid;
  share_role text;
  my_email text;
  guard int := 0;
begin
  if uid is null or target_page_id is null then
    return false;
  end if;

  select email into my_email from auth.users where id = uid;

  while current_id is not null and guard < 1000 loop
    guard := guard + 1;

    select owner_id, parent_id into row_owner, row_parent from public.pages where id = current_id;
    if row_owner is null then
      return false; -- la página (o algún ancestro en la cadena) no existe
    end if;
    if row_owner = uid then
      return true;
    end if;

    select role into share_role
      from public.page_shares
      where page_id = current_id
        and (user_id = uid or (my_email is not null and lower(invited_email) = lower(my_email)))
      order by (role = 'editor') desc
      limit 1;

    if share_role is not null and (min_role <> 'editor' or share_role = 'editor') then
      return true;
    end if;

    current_id := row_parent;
  end loop;

  return false;
end;
$$;

-- ============================================================
-- 3) claim_pending_shares() — al loguearse, resuelve las
--    invitaciones pendientes que apuntan al email de esta cuenta.
--    RPC en vez de policy de UPDATE en page_shares: así el cliente
--    nunca puede tocar `role` de su propio share, solo el server
--    (definer) puede completar user_id.
-- ============================================================

create or replace function public.claim_pending_shares()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  my_email text;
begin
  select email into my_email from auth.users where id = auth.uid();
  if my_email is null then
    return;
  end if;
  update public.page_shares
    set user_id = auth.uid()
    where user_id is null and lower(invited_email) = lower(my_email);
end;
$$;

grant execute on function public.claim_pending_shares() to authenticated;
grant execute on function public.has_access(uuid, uuid, text) to authenticated;

-- ============================================================
-- 4) Reemplazar las policies solo-dueño de pages/page_contents
--    (Fase B) por versiones que también aceptan acceso compartido.
--    Borrado físico sigue siendo solo del owner_id (no se toca esa
--    policy) — un editor invitado solo puede mandar a la papelera
--    (eso es un UPDATE de trashed_at, no un DELETE).
-- ============================================================

drop policy "pages_select_own" on public.pages;
create policy "pages_select_access" on public.pages
  for select using (
    owner_id = (select auth.uid())
    or public.has_access(id, (select auth.uid()), 'viewer')
  );

drop policy "pages_insert_own" on public.pages;
create policy "pages_insert_access" on public.pages
  for insert with check (
    owner_id = (select auth.uid())
    and (parent_id is null or public.has_access(parent_id, (select auth.uid()), 'editor'))
  );

drop policy "pages_update_own" on public.pages;
create policy "pages_update_access" on public.pages
  for update using (
    owner_id = (select auth.uid())
    or public.has_access(id, (select auth.uid()), 'editor')
  )
  with check (
    owner_id = (select auth.uid())
    or (
      public.has_access(id, (select auth.uid()), 'editor')
      and (parent_id is null or public.has_access(parent_id, (select auth.uid()), 'editor'))
    )
  );

drop policy "page_contents_select_own" on public.page_contents;
create policy "page_contents_select_access" on public.page_contents
  for select using (public.has_access(page_id, (select auth.uid()), 'viewer'));

drop policy "page_contents_insert_own" on public.page_contents;
create policy "page_contents_insert_access" on public.page_contents
  for insert with check (public.has_access(page_id, (select auth.uid()), 'editor'));

drop policy "page_contents_update_own" on public.page_contents;
create policy "page_contents_update_access" on public.page_contents
  for update using (public.has_access(page_id, (select auth.uid()), 'editor'))
  with check (public.has_access(page_id, (select auth.uid()), 'editor'));
