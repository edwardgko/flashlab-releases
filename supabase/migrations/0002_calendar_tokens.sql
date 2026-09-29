-- FlashLab — Login unificado con Google Calendar
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de 0001_pages.sql).
--
-- El refresh_token de Google del client compartido ("Web application", el
-- mismo que ya está cargado en Authentication → Providers → Google) vive acá
-- server-side, nunca en la app de escritorio. Solo la Edge Function
-- `calendar-google-token` la toca, usando la service_role key — por eso la
-- tabla queda con RLS habilitado pero SIN policies: cualquier rol que no sea
-- service_role (que bypassea RLS) tiene acceso cero, ni siquiera de lectura
-- a su propia fila. Ni anon ni authenticated deberían poder leer un
-- refresh_token ajeno al proceso de refresh.

create table public.calendar_google_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);

alter table public.calendar_google_tokens enable row level security;
