-- FlashLab — interruptor de "confirmaciones de lectura" (Chat → ⚙️
-- Configuración). Solo aplica a 1:1: en grupos WhatsApp tampoco permite
-- desactivarlo, así que ahí seguimos mandando confirmación siempre.
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores).
--
-- Guardado en el server (no localStorage) porque quien necesita consultar
-- tu preferencia es LA OTRA PERSONA, para decidir si pintarte el doble
-- check azul — no alcanza con que quede solo en tu propio dispositivo.
-- direct_message_reads/group_message_reads siguen actualizándose SIEMPRE
-- (tu propio contador de no leídos depende de eso); lo único que cambia es
-- si esa marca se usa para mostrarle a otros que leíste.

create table public.chat_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  read_receipts_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.chat_settings enable row level security;

-- cualquier usuario logueado puede leer el flag de cualquier otro: es
-- justamente lo que hace falta para poder pintar (o no) el check azul del
-- otro lado. No expone nada más sensible que un sí/no.
create policy "chat_settings_select_any" on public.chat_settings
  for select using (true);

create policy "chat_settings_upsert_own" on public.chat_settings
  for insert with check (user_id = (select auth.uid()));

create policy "chat_settings_update_own" on public.chat_settings
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter publication supabase_realtime add table public.chat_settings;
