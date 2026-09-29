-- FlashLab — sincronizar las pestañas abiertas entre dispositivos.
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores).
--
-- Antes, las pestañas abiertas (App.jsx) vivían solo en localStorage, por
-- dispositivo — lo que dejabas abierto en desktop nunca aparecía al entrar
-- desde el celular. Esta tabla las guarda por cuenta en el server. A
-- diferencia de chat_settings (que cualquiera puede leer, porque hace falta
-- para pintar el check azul de lectura del otro lado), acá SOLO el dueño
-- puede leer sus propias pestañas — no es información que otro usuario
-- necesite ver nunca.

create table public.tab_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tabs jsonb not null default '[]'::jsonb,
  active_tab_id text,
  updated_at timestamptz not null default now()
);

alter table public.tab_state enable row level security;

create policy "tab_state_select_own" on public.tab_state
  for select using (user_id = (select auth.uid()));

create policy "tab_state_upsert_own" on public.tab_state
  for insert with check (user_id = (select auth.uid()));

create policy "tab_state_update_own" on public.tab_state
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
