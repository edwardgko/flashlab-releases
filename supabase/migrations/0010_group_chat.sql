-- FlashLab — Chat grupal
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores). Tablas separadas de direct_messages a
-- propósito: el chat 1:1 ya funciona probado, evita tocar/migrar ese schema
-- para no arriesgar romperlo.

-- ============================================================
-- 1) Tablas
-- ============================================================

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table public.group_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  content text default '',
  message_type text not null default 'text' check (message_type in ('text', 'attachment')),
  attachment_url text,
  attachment_name text,
  attachment_mime text,
  created_at timestamptz not null default now()
);

create index group_messages_conversation_idx on public.group_messages (conversation_id, created_at);

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.group_messages enable row level security;

-- ============================================================
-- 2) is_conversation_member() — SECURITY DEFINER para que las
--    policies de conversation_members puedan chequear la propia
--    tabla sin depender de que RLS ya te deje ver esas filas
--    (mismo motivo que has_access() en Fase C).
-- ============================================================

create or replace function public.is_conversation_member(_conversation_id uuid, uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = _conversation_id and user_id = uid
  );
$$;

grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;

-- ============================================================
-- 3) Policies
-- ============================================================

create policy "conversations_select_member" on public.conversations
  for select using (public.is_conversation_member(id, (select auth.uid())));

create policy "conversations_insert_creator" on public.conversations
  for insert with check (created_by = (select auth.uid()));

create policy "conversation_members_select" on public.conversation_members
  for select using (public.is_conversation_member(conversation_id, (select auth.uid())));

-- agregar miembros: el creador del grupo, o vos mismo (al crearlo, el
-- propio create_group_conversation() te agrega como primer miembro)
create policy "conversation_members_insert" on public.conversation_members
  for insert with check (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.created_by = (select auth.uid())
    )
  );

-- salir del grupo vos mismo, o el creador saca a alguien
create policy "conversation_members_delete" on public.conversation_members
  for delete using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.created_by = (select auth.uid())
    )
  );

create policy "group_messages_select_member" on public.group_messages
  for select using (public.is_conversation_member(conversation_id, (select auth.uid())));

create policy "group_messages_insert_member" on public.group_messages
  for insert with check (
    sender_id = (select auth.uid())
    and public.is_conversation_member(conversation_id, (select auth.uid()))
  );

-- ============================================================
-- 4) RPCs
-- ============================================================

-- crea el grupo + te agrega como miembro + agrega a cada email que ya
-- tenga cuenta en FlashLab (los que no, simplemente no se agregan — a
-- diferencia de compartir páginas, acá no hay "invitación pendiente").
create or replace function public.create_group_conversation(group_name text, member_emails text[])
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_id uuid;
  member_id uuid;
  target_email text;
begin
  insert into public.conversations (name, created_by) values (group_name, auth.uid()) returning id into new_id;
  insert into public.conversation_members (conversation_id, user_id) values (new_id, auth.uid());

  foreach target_email in array member_emails loop
    select u.id into member_id from auth.users u where lower(u.email) = lower(target_email);
    if member_id is not null and member_id <> auth.uid() then
      insert into public.conversation_members (conversation_id, user_id)
      values (new_id, member_id)
      on conflict do nothing;
    end if;
  end loop;

  return new_id;
end;
$$;

-- agregar un miembro a un grupo ya creado — solo el creador puede (mismo
-- criterio que compartir páginas: administrar el grupo es del dueño)
create or replace function public.add_group_member(_conversation_id uuid, target_email text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  member_id uuid;
begin
  if not exists (
    select 1 from public.conversations where id = _conversation_id and created_by = auth.uid()
  ) then
    raise exception 'solo quien creó el grupo puede agregar miembros';
  end if;

  select u.id into member_id from auth.users u where lower(u.email) = lower(target_email);
  if member_id is null then
    return false;
  end if;

  insert into public.conversation_members (conversation_id, user_id)
  values (_conversation_id, member_id)
  on conflict do nothing;
  return true;
end;
$$;

-- nombre + email de los miembros de un grupo (auth.users no es consultable
-- directo desde el cliente)
create or replace function public.get_group_member_emails(_conversation_id uuid)
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.user_id, u.email
  from public.conversation_members m
  join auth.users u on u.id = m.user_id
  where m.conversation_id = _conversation_id
    and public.is_conversation_member(_conversation_id, auth.uid());
$$;

grant execute on function public.create_group_conversation(text, text[]) to authenticated;
grant execute on function public.add_group_member(uuid, text) to authenticated;
grant execute on function public.get_group_member_emails(uuid) to authenticated;

-- ============================================================
-- 5) Storage para adjuntos de grupo — bucket aparte de chat-attachments
--    (esa policy valida el path por "tu uid aparece en la carpeta",
--    que no tiene sentido acá: la carpeta es el id del grupo, no un
--    par de usuarios). Público de lectura, mismo criterio que el
--    resto; escritura solo si sos miembro del grupo al que apunta la
--    carpeta.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('group-attachments', 'group-attachments', true)
on conflict (id) do nothing;

create policy "group_attachments_read_public" on storage.objects
  for select using (bucket_id = 'group-attachments');

create policy "group_attachments_write_member" on storage.objects
  for insert with check (
    bucket_id = 'group-attachments'
    and public.is_conversation_member(((storage.foldername(name))[1])::uuid, (select auth.uid()))
  );

-- ============================================================
-- 6) Realtime
-- ============================================================

alter publication supabase_realtime add table public.group_messages;
