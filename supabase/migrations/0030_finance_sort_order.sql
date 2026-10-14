-- FlashLab — Finanzas: orden manual (arrastrar y soltar) de los movimientos.
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- 0029_finance_fortnight.sql).
--
-- Número libre: la lista se ordena de menor a mayor. Al soltar una fila la
-- app le pone el punto medio entre sus dos vecinas, así cambia UNA sola fila
-- y el orden del resto no se toca en ningún otro mes. Lo ya cargado arranca
-- en el orden en que se creó (epoch de created_at), y el default hace lo
-- mismo con lo que inserte una versión vieja de la app que no manda la
-- columna: queda al final, no en null.

alter table public.finance_entries
  add column sort_order double precision default extract(epoch from now());

update public.finance_entries
  set sort_order = extract(epoch from created_at)
  where sort_order is null;
