-- FlashLab — fondos de chat: subida a Drive (no Supabase Storage) + galería
-- de "ya usados" reusable entre conversaciones.
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- 0020_drive_chat_attachments.sql).
--
-- El fondo elegido para UNA conversación sigue viviendo en localStorage por
-- conversación (wallpaperStorageKey en chatWallpaper.js — eso no cambia, es
-- una preferencia de "esta conversación en esta cuenta"). Lo que sí hacía
-- falta guardar en el server es EL HISTORIAL de imágenes ya subidas, para
-- poder ofrecerlas como opción al elegir el fondo de OTRA conversación —
-- mismo motivo/patrón que custom_icons (0022): por cuenta, no por
-- instalación.

create table public.custom_wallpapers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  drive_file_id text not null,
  created_at timestamptz not null default now()
);

create unique index custom_wallpapers_user_file_idx on public.custom_wallpapers (user_id, drive_file_id);
create index custom_wallpapers_user_created_idx on public.custom_wallpapers (user_id, created_at desc);

alter table public.custom_wallpapers enable row level security;

create policy "custom_wallpapers_select_own" on public.custom_wallpapers
  for select using (user_id = (select auth.uid()));

create policy "custom_wallpapers_insert_own" on public.custom_wallpapers
  for insert with check (user_id = (select auth.uid()));

create policy "custom_wallpapers_delete_own" on public.custom_wallpapers
  for delete using (user_id = (select auth.uid()));
