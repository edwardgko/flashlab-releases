-- FlashLab — Finanzas: ingresos y gastos por mes.
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- las migraciones anteriores).
--
-- Una fila = un movimiento. Los que NO se repiten valen solo para su mes
-- (start_month). Los fijos (recurring = true) valen desde start_month hasta
-- end_month inclusive, o para siempre si end_month es null — así el sueldo o
-- el alquiler se cargan una sola vez y aparecen solos cada mes. Editar un
-- fijo desde un mes posterior no reescribe el pasado: el cliente cierra la
-- fila vieja en el mes anterior y abre una nueva (ver saveEntry en
-- src/lib/finance.js).
--
-- Meses como texto 'YYYY-MM' y no como date: el cliente los compara como
-- strings y no hay zona horaria que pueda correr un día 1 al mes anterior.
-- Solo el dueño ve y toca sus filas — no hay nada compartible acá.

create table public.finance_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('income', 'expense')),
  description text not null default '',
  amount numeric(14, 2) not null check (amount >= 0),
  category text,
  start_month text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  recurring boolean not null default false,
  end_month text check (end_month is null or end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_entries_month_range check (end_month is null or end_month >= start_month)
);

create index finance_entries_user_idx on public.finance_entries (user_id);

alter table public.finance_entries enable row level security;

create policy "finance_entries_select_own" on public.finance_entries
  for select using (user_id = (select auth.uid()));

create policy "finance_entries_insert_own" on public.finance_entries
  for insert with check (user_id = (select auth.uid()));

create policy "finance_entries_update_own" on public.finance_entries
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "finance_entries_delete_own" on public.finance_entries
  for delete using (user_id = (select auth.uid()));
