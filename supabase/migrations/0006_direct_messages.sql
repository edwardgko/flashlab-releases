-- FlashLab — Chat 1:1
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores).

-- ============================================================
-- 1) Tabla — inmutable a propósito (sin policy de update/delete
--    todavía): un mensaje se manda y ya, no hay "editar"/"borrar"
--    en esta primera versión.
-- ============================================================

create table public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index direct_messages_from_idx on public.direct_messages (sender_id, recipient_id, created_at);
create index direct_messages_to_idx on public.direct_messages (recipient_id, sender_id, created_at);

alter table public.direct_messages enable row level security;

create policy "dm_select_participant" on public.direct_messages
  for select using (
    sender_id = (select auth.uid()) or recipient_id = (select auth.uid())
  );

create policy "dm_insert_as_sender" on public.direct_messages
  for insert with check (sender_id = (select auth.uid()));

-- ============================================================
-- 2) RPCs — auth.users no es consultable directo desde el cliente
--    (PostgREST no expone ese schema), hacen falta estas dos
--    funciones puntuales para poder buscar por email y mostrar el
--    email de con quién ya hablaste.
-- ============================================================

-- iniciar una conversación nueva por email (mismo patrón que
-- "Compartir": escribís el email de la otra persona)
create or replace function public.find_user_id_by_email(target_email text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from auth.users where lower(email) = lower(target_email) limit 1;
$$;

-- con quién ya intercambié mensajes + su email, para la lista de
-- conversaciones — solo devuelve tus propios interlocutores (no sirve para
-- buscar el email de cualquiera al azar).
create or replace function public.get_conversation_partner_emails()
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.email
  from auth.users u
  where u.id in (
    select sender_id from public.direct_messages where recipient_id = (select auth.uid())
    union
    select recipient_id from public.direct_messages where sender_id = (select auth.uid())
  );
$$;

grant execute on function public.find_user_id_by_email(text) to authenticated;
grant execute on function public.get_conversation_partner_emails() to authenticated;

-- ============================================================
-- 3) Realtime
-- ============================================================

alter publication supabase_realtime add table public.direct_messages;
