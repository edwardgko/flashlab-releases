-- FlashLab — Fase D: sincronización más viva (opcional)
-- Correr en Supabase Dashboard → SQL Editor → New query → Run (después de
-- 0001/0002/0003).
--
-- Habilita Postgres Changes (Realtime) sobre page_contents: así el cliente
-- puede enterarse si otra persona guardó la página que tenés abierta, sin
-- tener que cerrarla y volver a abrirla. Respeta RLS automáticamente por
-- cliente suscrito (misma policy que ya gobierna el SELECT normal) — no
-- hace falta configuración extra de seguridad acá.

alter publication supabase_realtime add table public.page_contents;
