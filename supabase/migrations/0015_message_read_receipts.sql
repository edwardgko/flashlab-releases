-- FlashLab — Chat: check de "leído" (1 palomita = enviado, 2 azules = leído)
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores).

-- ============================================================
-- 1) direct_messages: quien mandó el mensaje necesita poder ver el
--    last_read_at del OTRO participante (para saber si ya lo leyó) —
--    hasta ahora la policy solo dejaba ver la fila propia.
-- ============================================================

drop policy if exists "dm_reads_own" on public.direct_message_reads;
create policy "dm_reads_participant" on public.direct_message_reads
  for select using (
    user_id = (select auth.uid()) or other_user_id = (select auth.uid())
  );

alter publication supabase_realtime add table public.direct_message_reads;

-- ============================================================
-- 2) group_message_reads: no existía ningún tracking de lectura para
--    grupos (a diferencia de direct_message_reads). Mismo diseño:
--    un row por (conversación, usuario), se actualiza cada vez que
--    abrís ese grupo. "Leído" en un grupo = todos los demás miembros
--    tienen last_read_at >= el created_at del mensaje.
-- ============================================================

create table public.group_message_reads (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.group_message_reads enable row level security;

create policy "group_reads_select_member" on public.group_message_reads
  for select using (public.is_conversation_member(conversation_id, (select auth.uid())));

create policy "group_reads_upsert_own" on public.group_message_reads
  for insert with check (
    user_id = (select auth.uid())
    and public.is_conversation_member(conversation_id, (select auth.uid()))
  );

create policy "group_reads_update_own" on public.group_message_reads
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter publication supabase_realtime add table public.group_message_reads;
