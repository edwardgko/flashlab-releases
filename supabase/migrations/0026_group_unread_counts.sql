-- FlashLab — contador de no leídos para chat GRUPAL (paridad con 1:1).
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores).
--
-- Hasta ahora existía group_message_reads (migración 0015, para el doble
-- check azul) pero ninguna función para contar cuántos mensajes de grupo
-- tengo sin leer — el badge del sidebar y las notificaciones de escritorio
-- solo contaban 1:1 (get_unread_counts en 0007_chat_extras.sql). Misma
-- forma que esa función: un row por conversación con cuántos mensajes
-- llegaron después de mi last_read_at (o todos, si nunca leí esa
-- conversación).

create or replace function public.get_group_unread_counts()
returns table (conversation_id uuid, unread_count bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select gm.conversation_id, count(*) as unread_count
  from public.group_messages gm
  join public.conversation_members cm
    on cm.conversation_id = gm.conversation_id and cm.user_id = (select auth.uid())
  left join public.group_message_reads r
    on r.conversation_id = gm.conversation_id and r.user_id = (select auth.uid())
  where gm.sender_id <> (select auth.uid())
    and gm.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
  group by gm.conversation_id;
$$;

grant execute on function public.get_group_unread_counts() to authenticated;
