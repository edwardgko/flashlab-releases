-- FlashLab — adjuntos de chat a Google Drive (en vez de Supabase Storage)
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- 0018_drive_tokens.sql y 0010_group_chat.sql).
--
-- Cada adjunto se sube al Drive PERSONAL de quien lo manda (scope
-- drive.file, ver electron/main.js) y se comparte puntual con los
-- destinatarios al momento de subir. attachment_url sigue guardando el
-- webViewLink de Drive; attachment_drive_id suma el id del archivo, que
-- hace falta para poder volver a compartirlo después (miembro nuevo en un
-- grupo, o "reintentar share" si algún email falló).

-- ============================================================
-- 1) attachment_drive_id en los dos chats
-- ============================================================

alter table public.direct_messages add column attachment_drive_id text;
alter table public.group_messages add column attachment_drive_id text;

-- ============================================================
-- 1b) email de un usuario por id — hace falta para compartir en Drive el
--    adjunto de un chat 1:1 (sendAttachment solo tiene el otherUserId, no
--    su email). Mismo criterio que find_user_id_by_email/
--    get_group_member_emails: cualquier autenticado puede resolver el
--    email de cualquier id, ya es así en el resto del chat.
-- ============================================================

create or replace function public.get_user_email(target_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select email from auth.users where id = target_id;
$$;

grant execute on function public.get_user_email(uuid) to authenticated;

-- ============================================================
-- 2) drive_pending_shares — cola de "falta compartir archivo X con
--    email Y". Hace falta porque solo el DUEÑO del archivo (quien lo
--    subió) tiene el token de Drive para compartirlo — si en el momento
--    en que alguien se suma al grupo esa persona no tiene FlashLab
--    abierto, el share queda pendiente acá hasta que abra la app de
--    nuevo (ver driveShareQueue.js, procesa "mis" filas con mi propio
--    token). Sin policy de insert: solo la escribe add_group_member()
--    (security definer, corre como dueño de la función, no como el
--    cliente) — así nadie puede encolar un share arbitrario a mano.
-- ============================================================

-- conversation_id es solo informativo (para debug), sin FK a conversations
-- a propósito: esta misma cola también se usa para reenviar un adjunto
-- ajeno a un DM (chat.js/forwardAttachment), y un DM no tiene fila en
-- conversations — un FK estricto acá rompería ese caso.
create table public.drive_pending_shares (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  drive_file_id text not null,
  share_email text not null,
  conversation_id uuid,
  created_at timestamptz not null default now()
);

create index drive_pending_shares_owner_idx on public.drive_pending_shares (owner_user_id);

alter table public.drive_pending_shares enable row level security;

create policy "drive_pending_shares_select_own" on public.drive_pending_shares
  for select using (owner_user_id = (select auth.uid()));

create policy "drive_pending_shares_delete_own" on public.drive_pending_shares
  for delete using (owner_user_id = (select auth.uid()));

-- ============================================================
-- 2b) queue_drive_share() — mismo mecanismo que usa add_group_member, pero
--    para cuando REENVÍO (forwardMessage, src/lib/forwardMessage.js) un
--    adjunto que no es mío: no tengo token para compartirlo, así que
--    encolo el share para el dueño real. Valida que el archivo aparezca
--    en algún mensaje que yo pueda ver (DM mío o grupo del que soy
--    miembro) antes de encolar nada — evita que cualquiera encole shares
--    para file ids inventados.
-- ============================================================

create or replace function public.queue_drive_share(_drive_file_id text, _share_email text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  owner uuid;
begin
  select sender_id into owner from public.direct_messages
    where attachment_drive_id = _drive_file_id
      and (sender_id = auth.uid() or recipient_id = auth.uid())
    limit 1;

  if owner is null then
    select gm.sender_id into owner from public.group_messages gm
      where gm.attachment_drive_id = _drive_file_id
        and public.is_conversation_member(gm.conversation_id, auth.uid())
      limit 1;
  end if;

  if owner is null then
    raise exception 'no se encontró ese adjunto en tus conversaciones';
  end if;

  insert into public.drive_pending_shares (owner_user_id, drive_file_id, share_email)
  values (owner, _drive_file_id, _share_email);
end;
$$;

grant execute on function public.queue_drive_share(text, text) to authenticated;

-- ============================================================
-- 3) add_group_member(): además de agregar la fila en
--    conversation_members, encola en drive_pending_shares un share por
--    cada archivo YA subido en ese grupo (agrupado por quién lo subió,
--    que es quien lo tiene que volver a compartir).
-- ============================================================

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

  insert into public.drive_pending_shares (owner_user_id, drive_file_id, share_email, conversation_id)
  select distinct gm.sender_id, gm.attachment_drive_id, target_email, _conversation_id
  from public.group_messages gm
  where gm.conversation_id = _conversation_id
    and gm.message_type = 'attachment'
    and gm.attachment_drive_id is not null;

  return true;
end;
$$;
