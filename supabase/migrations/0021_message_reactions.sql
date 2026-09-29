-- FlashLab — reacciones a mensajes (estilo WhatsApp: 1 reacción por
-- persona por mensaje, cualquier emoji — no un set fijo, el límite de 6 es
-- solo la barra rápida del cliente).
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- 0020_drive_chat_attachments.sql).
--
-- Tablas separadas para DM/grupo, mismo criterio que el resto del chat (ver
-- 0010_group_chat.sql): no arriesgar el 1:1 ya probado.

-- ============================================================
-- 1) Tablas — PK (message_id, user_id): tocar tu propia reacción en un
--    mensaje la reemplaza, no la duplica (mismo comportamiento que
--    WhatsApp, ahí tampoco se acumulan reacciones tuyas).
-- ============================================================

create table public.direct_message_reactions (
  message_id uuid not null references public.direct_messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table public.group_message_reactions (
  message_id uuid not null references public.group_messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.direct_message_reactions enable row level security;
alter table public.group_message_reactions enable row level security;

-- ============================================================
-- 2) Policies — solo participantes del DM / miembros del grupo pueden ver
--    o poner reacciones, y cada quien solo puede tocar la propia.
-- ============================================================

create policy "dm_reactions_select_participant" on public.direct_message_reactions
  for select using (
    exists (
      select 1 from public.direct_messages dm
      where dm.id = message_id
        and (dm.sender_id = (select auth.uid()) or dm.recipient_id = (select auth.uid()))
    )
  );

create policy "dm_reactions_insert_own" on public.direct_message_reactions
  for insert with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.direct_messages dm
      where dm.id = message_id
        and (dm.sender_id = (select auth.uid()) or dm.recipient_id = (select auth.uid()))
    )
  );

create policy "dm_reactions_update_own" on public.direct_message_reactions
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "dm_reactions_delete_own" on public.direct_message_reactions
  for delete using (user_id = (select auth.uid()));

create policy "group_reactions_select_member" on public.group_message_reactions
  for select using (
    exists (
      select 1 from public.group_messages gm
      where gm.id = message_id and public.is_conversation_member(gm.conversation_id, (select auth.uid()))
    )
  );

create policy "group_reactions_insert_own" on public.group_message_reactions
  for insert with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.group_messages gm
      where gm.id = message_id and public.is_conversation_member(gm.conversation_id, (select auth.uid()))
    )
  );

create policy "group_reactions_update_own" on public.group_message_reactions
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "group_reactions_delete_own" on public.group_message_reactions
  for delete using (user_id = (select auth.uid()));

-- ============================================================
-- 3) Realtime
-- ============================================================

alter publication supabase_realtime add table public.direct_message_reactions;
alter publication supabase_realtime add table public.group_message_reactions;
