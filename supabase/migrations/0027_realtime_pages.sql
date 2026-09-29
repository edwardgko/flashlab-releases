-- FlashLab — Realtime sobre `pages` (auto-recarga de bases de datos
-- compartidas).
-- Correr en Supabase Dashboard → SQL Editor → New query → Run.
--
-- La 0004 ya había habilitado Postgres Changes sobre page_contents, que
-- cubre el CONTENIDO de una página (los bloques del editor). Pero las FILAS
-- de una base de datos no viven ahí: cada fila es una página en `pages`, con
-- parent_id apuntando a la base. Sin esta tabla en la publicación, dos
-- personas trabajando sobre el mismo tablero no se enteraban de los cambios
-- de la otra hasta cerrar y volver a abrir la app.
--
-- Cubre todo lo que se ve en un tablero/tabla sin tocar el editor: alta y
-- baja de filas, cambios de propiedad (properties), reordenamientos
-- (order_index), renombres (title), papelera (trashed_at) y cambios de
-- esquema de la base (database_schema).
--
-- Seguridad: Postgres Changes respeta RLS por cliente suscrito — cada quien
-- recibe únicamente los eventos de las filas que ya podría leer con un
-- SELECT normal (mismas policies de 0001 + 0003). No hace falta
-- configuración extra acá.

-- idempotente: correrla dos veces no rompe nada (Postgres tira
-- "relation is already member of publication" si se agrega de nuevo a secas)
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pages'
  ) then
    alter publication supabase_realtime add table public.pages;
  end if;
end
$$;

-- Los eventos de UPDATE/DELETE viajan con la fila VIEJA solo si la tabla
-- tiene replica identity full. Sin esto, un DELETE llega sin parent_id y el
-- filtro `parent_id=eq.<base>` del cliente no lo hace coincidir con nada: la
-- fila borrada por otra persona seguiría en pantalla.
alter table public.pages replica identity full;
