-- FlashLab — notificaciones push en Android (celular cerrado del todo, no
-- solo en segundo plano). Correr en Supabase Dashboard → SQL Editor → New
-- query → Run (después de las migraciones anteriores).
--
-- Un dispositivo = un token de Firebase Cloud Messaging. Un mismo usuario
-- puede tener varios (celular + tablet, o reinstaló la app y le tocó un
-- token nuevo) — por eso `token` es la primary key (no `user_id`): así un
-- upsert por token de re-registro no pisa el de otro dispositivo, y si el
-- mismo token vuelve a aparecer (reinstalación, mismo Firebase App
-- Instance) el upsert simplemente actualiza el dueño y la fecha.
--
-- RLS solo protege contra que un usuario autenticado lea/toque el token de
-- OTRO — la Edge Function que manda el push (send-chat-push) usa la
-- service_role key, que ignora RLS por completo, así que puede leer los
-- tokens de cualquier destinatario para mandarle el push.

create table public.push_tokens (
  token text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null default 'android' check (platform in ('android', 'ios')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index push_tokens_user_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

create policy "push_tokens_select_own" on public.push_tokens
  for select using (user_id = (select auth.uid()));

create policy "push_tokens_insert_own" on public.push_tokens
  for insert with check (user_id = (select auth.uid()));

create policy "push_tokens_update_own" on public.push_tokens
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- al desloguearte en un dispositivo, ese token deja de ser tuyo — sin esto
-- seguirías recibiendo pushes de una cuenta de la que ya cerraste sesión ahí.
create policy "push_tokens_delete_own" on public.push_tokens
  for delete using (user_id = (select auth.uid()));
