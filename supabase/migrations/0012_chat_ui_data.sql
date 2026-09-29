-- FlashLab — datos para unificar la lista de chat (DMs + grupos, ordenados
-- por actividad reciente en vez de dos secciones separadas).
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores).

-- se reemplaza el tipo de retorno (agrega last_message_at) — hace falta
-- dropear primero, create or replace no permite cambiar las columnas de una
-- función que retorna table.
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
    on (dm.sender_id = u.id and dm.recipient_id = (select auth.uid()))
    or (dm.recipient_id = u.id and dm.sender_id = (select auth.uid()))
  where u.id in (
    select sender_id from public.direct_messages where recipient_id = (select auth.uid())
    union
    select recipient_id from public.direct_messages where sender_id = (select auth.uid())
  )
  group by u.id, u.email;
$$;

grant execute on function public.get_conversation_partner_emails() to authenticated;

-- mis grupos + la fecha del último mensaje (o de creación, si todavía no
-- tiene ninguno) — antes se leía directo de `conversations`, sin esto no
-- hay forma de ordenar por actividad reciente.
create or replace function public.get_my_groups()
returns table (id uuid, name text, icon text, created_by uuid, last_message_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.id,
    c.name,
    c.icon,
    c.created_by,
    coalesce((select max(gm.created_at) from public.group_messages gm where gm.conversation_id = c.id), c.created_at) as last_message_at
  from public.conversations c
  where public.is_conversation_member(c.id, (select auth.uid()));
$$;

grant execute on function public.get_my_groups() to authenticated;
