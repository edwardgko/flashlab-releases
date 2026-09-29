-- FlashLab — íconos-imagen personalizados, por cuenta (no por instalación)
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores).
--
-- Antes vivían en localStorage (customIcons.js), que en esta app es por
-- INSTALACIÓN de Electron, no por cuenta de Supabase — cambiar de cuenta en
-- la misma máquina seguía viendo los "personalizados" de la cuenta
-- anterior. Mismo motivo por el que chat_settings (0016) ya está en el
-- server en vez de localStorage.

create table public.custom_icons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  url text not null,
  created_at timestamptz not null default now()
);

-- resubir un ícono ya guardado lo trae al frente (upsert con
-- onConflict:'user_id,url' actualiza created_at) en vez de duplicar fila.
create unique index custom_icons_user_url_idx on public.custom_icons (user_id, url);
create index custom_icons_user_created_idx on public.custom_icons (user_id, created_at desc);

alter table public.custom_icons enable row level security;

create policy "custom_icons_select_own" on public.custom_icons
  for select using (user_id = (select auth.uid()));

create policy "custom_icons_insert_own" on public.custom_icons
  for insert with check (user_id = (select auth.uid()));

create policy "custom_icons_update_own" on public.custom_icons
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "custom_icons_delete_own" on public.custom_icons
  for delete using (user_id = (select auth.uid()));
