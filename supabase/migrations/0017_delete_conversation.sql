-- FlashLab — eliminar una conversación 1:1 entera (no un mensaje suelto,
-- ver 0013_chat_edit_delete.sql para eso), con las dos opciones de Telegram:
-- "para mí" (solo deja de aparecerte a vos, la otra persona no nota nada) y
-- "para los dos" (borra el historial completo, de ambos lados, sin dejar
-- rastro — no hay tombstone acá porque no tiene sentido "recordar" que hubo
-- una conversación que ya no existe para nadie).
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores).

-- ============================================================
-- 1) "Para mí": mismo mecanismo que hide_dm_for_me pero aplicado a TODOS
--    los mensajes del par de una sola vez.
-- ============================================================

create or replace function public.delete_dm_conversation_for_me(_other_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.direct_messages
  set deleted_for = array_append(deleted_for, auth.uid())
  where ((sender_id = auth.uid() and recipient_id = _other_user_id)
      or (sender_id = _other_user_id and recipient_id = auth.uid()))
    and not (auth.uid() = any(deleted_for));
end;
$$;

-- ============================================================
-- 2) "Para los dos": a diferencia de delete_dm_for_everyone (que solo deja
--    borrar TUS PROPIOS mensajes), acá se borra la conversación entera —
--    incluye los mensajes que te mandó la otra persona, porque el pedido es
--    "borrar este chat", no "borrar lo que yo escribí". Requiere ser uno de
--    los dos participantes; borrado real (no tombstone), la fila deja de
--    existir para ambos.
-- ============================================================

create or replace function public.delete_dm_conversation_for_everyone(_other_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.direct_messages
  where (sender_id = auth.uid() or recipient_id = auth.uid())
    and ((sender_id = auth.uid() and recipient_id = _other_user_id)
      or (sender_id = _other_user_id and recipient_id = auth.uid()));
end;
$$;

grant execute on function public.delete_dm_conversation_for_me(uuid) to authenticated;
grant execute on function public.delete_dm_conversation_for_everyone(uuid) to authenticated;

-- ============================================================
-- 3) La lista de conversaciones no debe seguir mostrando un chat que
--    eliminaste para vos — antes get_conversation_partner_emails no miraba
--    deleted_for en absoluto (una conversación "vaciada" seguía apareciendo,
--    vacía, en vez de desaparecer de la lista hasta el próximo mensaje).
-- ============================================================

drop function if exists public.get_conversation_partner_emails();

create or replace function public.get_conversation_partner_emails()
returns table (id uuid, email text, last_message_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.email, max(dm.created_at) as last_message_at
  from auth.users u
  join public.direct_messages dm
    on ((dm.sender_id = u.id and dm.recipient_id = (select auth.uid()))
     or (dm.recipient_id = u.id and dm.sender_id = (select auth.uid())))
    and not ((select auth.uid()) = any(dm.deleted_for))
  where u.id in (
    select sender_id from public.direct_messages
    where recipient_id = (select auth.uid()) and not ((select auth.uid()) = any(deleted_for))
    union
    select recipient_id from public.direct_messages
    where sender_id = (select auth.uid()) and not ((select auth.uid()) = any(deleted_for))
  )
  group by u.id, u.email;
$$;

grant execute on function public.get_conversation_partner_emails() to authenticated;

-- mismo criterio en el contador de no leídos: un mensaje que ya te
-- "eliminaste para vos" no debería seguir empujando el contador de no leídos
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
    and not ((select auth.uid()) = any(dm.deleted_for))
  group by dm.sender_id;
$$;

grant execute on function public.get_unread_counts() to authenticated;

-- ============================================================
-- 4) REPLICA IDENTITY FULL: para que el borrado "para los dos" avise en
--    vivo al otro lado si tiene el chat abierto en ese momento. Sin esto,
--    un evento DELETE de Realtime solo trae la PK en `old` (no
--    sender_id/recipient_id), y el cliente no puede saber a qué
--    conversación pertenecía la fila borrada.
-- ============================================================

alter table public.direct_messages replica identity full;
