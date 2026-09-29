-- FlashLab — fix: el índice único de page_shares usaba lower(invited_email)
-- (una expresión), pero el upsert del cliente pide a Postgres resolver el
-- conflicto sobre las columnas literales (page_id, invited_email) — no
-- matchean, y por eso tira "no unique or exclusion constraint matching the
-- ON CONFLICT specification". El cliente ya normaliza el email a minúsculas
-- antes de guardar, así que alcanza con un índice único plano sobre las
-- columnas (sin lower()).

drop index if exists public.page_shares_page_email_uidx;
create unique index page_shares_page_email_uidx on public.page_shares (page_id, invited_email);
