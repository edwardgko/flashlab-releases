-- FlashLab — Chat: no leídos, adjuntos (fotos/videos/archivos) y stickers
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- 0006_direct_messages.sql).

-- ============================================================
-- 1) direct_messages: sumar tipo de mensaje + datos de adjunto.
--    content pasa a poder ser vacío — un mensaje de tipo adjunto/
--    sticker no necesariamente lleva texto.
-- ============================================================

alter table public.direct_messages
  add column message_type text not null default 'text' check (message_type in ('text', 'sticker', 'attachment')),
  add column attachment_url text,
  add column attachment_name text,
  add column attachment_mime text;

alter table public.direct_messages alter column content drop not null;
alter table public.direct_messages alter column content set default '';

-- ============================================================
-- 2) Marca de "hasta acá leí" por conversación — separada de
--    direct_messages a propósito (esa tabla queda inmutable, sin
--    policy de update; achica RLS): un row por (yo, la otra
--    persona), se actualiza cada vez que abrís esa conversación.
-- ============================================================

create table public.direct_message_reads (
  user_id uuid not null references auth.users (id) on delete cascade,
  other_user_id uuid not null references auth.users (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (user_id, other_user_id)
);

alter table public.direct_message_reads enable row level security;

create policy "dm_reads_own" on public.direct_message_reads
  for select using (user_id = (select auth.uid()));

create policy "dm_reads_upsert_own" on public.direct_message_reads
  for insert with check (user_id = (select auth.uid()));

create policy "dm_reads_update_own" on public.direct_message_reads
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- mensajes sin leer por conversación (agrupado por quién te lo mandó)
create or replace function public.get_unread_counts()
returns table (other_user_id uuid, unread_count bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select dm.sender_id as other_user_id, count(*) as unread_count
  from public.direct_messages dm
  left join public.direct_message_reads r
    on r.user_id = (select auth.uid()) and r.other_user_id = dm.sender_id
  where dm.recipient_id = (select auth.uid())
    and dm.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
  group by dm.sender_id;
$$;

grant execute on function public.get_unread_counts() to authenticated;

-- ============================================================
-- 3) Storage: adjuntos del chat. Público de LECTURA (mismo criterio
--    que page-assets — evita necesitar URLs firmadas que vencen, la
--    ruta con los dos UUIDs no es adivinable). Escritura restringida
--    a que tu propio uid aparezca en la carpeta {uid1}_{uid2}/...
-- ============================================================

insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', true)
on conflict (id) do nothing;

create policy "chat_attachments_read_public" on storage.objects
  for select using (bucket_id = 'chat-attachments');

create policy "chat_attachments_write_participant" on storage.objects
  for insert with check (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name)) [1] like '%' || (select auth.uid())::text || '%'
  );
