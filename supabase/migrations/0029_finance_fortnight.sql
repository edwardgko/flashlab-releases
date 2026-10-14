-- FlashLab — Finanzas: quincena de cada movimiento.
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- 0028_finance.sql).
--
-- 1 = primera quincena (días 1 a 15), 2 = segunda (16 a fin de mes). Null
-- para lo cargado antes de esta columna: la app lo muestra como "sin
-- quincena" hasta que se edite, en vez de adivinar en cuál cae.

alter table public.finance_entries
  add column fortnight smallint check (fortnight in (1, 2));
