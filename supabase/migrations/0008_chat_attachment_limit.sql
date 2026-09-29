-- FlashLab — límite de tamaño explícito para adjuntos del chat (antes
-- quedaba en el default del proyecto, sin un número conocido/garantizado).
-- Correr en Supabase Dashboard → SQL Editor → New query → Run.

update storage.buckets
set file_size_limit = 52428800 -- 50 MB
where id = 'chat-attachments';
