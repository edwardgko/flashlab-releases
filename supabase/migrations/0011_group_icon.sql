-- FlashLab — ícono de grupo (emoji o imagen subida)
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- 0010_group_chat.sql).

alter table public.conversations add column icon text;

-- administrar el grupo (nombre, ícono) es del creador — mismo criterio que
-- ya se usa para miembros
create policy "conversations_update_creator" on public.conversations
  for update using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));
