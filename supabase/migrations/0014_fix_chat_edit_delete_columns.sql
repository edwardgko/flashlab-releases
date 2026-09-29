-- FlashLab — arregla "column direct_messages.deleted_at does not exist" y el
-- mismo error en group_messages.
-- Correr en Supabase Dashboard → SQL Editor → New query → Run.
--
-- La migración 0013 (chat_edit_delete) agrega deleted_at/deleted_for/edited_at
-- a direct_messages y group_messages, más las policies y funciones RPC para
-- editar/eliminar mensajes — pero nunca llegó a aplicarse contra este
-- proyecto (ninguna de las dos tablas tiene las columnas). Esta es una
-- repetición de esa misma migración con guards (`if not exists` /
-- `create or replace` / `drop policy if exists`) para que sea segura de
-- correr sin importar qué parte, si alguna, ya haya quedado aplicada.

-- ============================================================
-- 1) direct_messages
-- ============================================================

alter table public.direct_messages add column if not exists deleted_at timestamptz;
alter table public.direct_messages add column if not exists deleted_for uuid[] not null default '{}';
alter table public.direct_messages add column if not exists edited_at timestamptz;

drop policy if exists "dm_select_participant" on public.direct_messages;
create policy "dm_select_participant" on public.direct_messages
  for select using (
    (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()))
    and not ((select auth.uid()) = any(deleted_for))
  );

create or replace function public.hide_dm_for_me(_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.direct_messages
  set deleted_for = array_append(deleted_for, auth.uid())
  where id = _message_id
    and (sender_id = auth.uid() or recipient_id = auth.uid())
    and not (auth.uid() = any(deleted_for));
end;
$$;

create or replace function public.delete_dm_for_everyone(_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.direct_messages
  set content = '', attachment_url = null, attachment_name = null, attachment_mime = null, deleted_at = now()
  where id = _message_id and sender_id = auth.uid();
end;
$$;

create or replace function public.edit_dm(_message_id uuid, new_content text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.direct_messages
  set content = new_content, edited_at = now()
  where id = _message_id and sender_id = auth.uid() and message_type = 'text' and deleted_at is null;
end;
$$;

grant execute on function public.hide_dm_for_me(uuid) to authenticated;
grant execute on function public.delete_dm_for_everyone(uuid) to authenticated;
grant execute on function public.edit_dm(uuid, text) to authenticated;

-- ============================================================
-- 2) group_messages
-- ============================================================

alter table public.group_messages add column if not exists deleted_at timestamptz;
alter table public.group_messages add column if not exists deleted_for uuid[] not null default '{}';
alter table public.group_messages add column if not exists edited_at timestamptz;

drop policy if exists "group_messages_select_member" on public.group_messages;
create policy "group_messages_select_member" on public.group_messages
  for select using (
    public.is_conversation_member(conversation_id, (select auth.uid()))
    and not ((select auth.uid()) = any(deleted_for))
  );

create or replace function public.hide_group_message_for_me(_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_conversation uuid;
begin
  select conversation_id into target_conversation from public.group_messages where id = _message_id;
  if target_conversation is null or not public.is_conversation_member(target_conversation, auth.uid()) then
    return;
  end if;
  update public.group_messages
  set deleted_for = array_append(deleted_for, auth.uid())
  where id = _message_id and not (auth.uid() = any(deleted_for));
end;
$$;

create or replace function public.delete_group_message_for_everyone(_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.group_messages
  set content = '', attachment_url = null, attachment_name = null, attachment_mime = null, deleted_at = now()
  where id = _message_id and sender_id = auth.uid();
end;
$$;

create or replace function public.edit_group_message(_message_id uuid, new_content text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.group_messages
  set content = new_content, edited_at = now()
  where id = _message_id and sender_id = auth.uid() and message_type = 'text' and deleted_at is null;
end;
$$;

grant execute on function public.hide_group_message_for_me(uuid) to authenticated;
grant execute on function public.delete_group_message_for_everyone(uuid) to authenticated;
grant execute on function public.edit_group_message(uuid, text) to authenticated;
