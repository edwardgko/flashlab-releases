-- FlashLab — subir grabaciones a Google Drive (mismo login unificado)
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de 0002_calendar_tokens.sql).
--
-- Mismo patrón que calendar_google_tokens: el refresh_token del client
-- compartido vive acá server-side, nunca en el .exe. Solo la Edge Function
-- `drive-google-token` la toca con la service_role key — RLS habilitado y
-- sin policies, así que ni anon ni authenticated pueden leer un
-- refresh_token ajeno al proceso de refresh.

create table public.drive_google_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);

alter table public.drive_google_tokens enable row level security;
