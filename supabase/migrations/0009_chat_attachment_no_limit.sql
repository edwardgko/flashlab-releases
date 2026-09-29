-- FlashLab — sacar el límite de tamaño de adjuntos del chat (pedido
-- explícito: sin tope, calidad original). Reemplaza el límite de 50 MB de
-- 0008_chat_attachment_limit.sql.
-- Correr en Supabase Dashboard → SQL Editor → New query → Run.
--
-- OJO: esto solo saca el límite que yo había puesto en el bucket. El propio
-- plan de Supabase (Free/Pro/etc.) puede seguir imponiendo un tope de
-- subida a nivel de proyecto que esto no puede pisar — ver la respuesta en
-- el chat para el detalle de por qué esto importa para el espacio de
-- Storage, no de la base de datos en sí.

update storage.buckets
set file_size_limit = null
where id = 'chat-attachments';
