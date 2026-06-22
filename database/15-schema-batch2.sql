-- ============================================================================
--  Bukéame — Esquema batch 2 (15)
--  Correr como postgres (dueño de las tablas). Idempotente.
--
--  Nota: el rol de la app (bukeame_user) no es dueño de las tablas ni tiene
--  permisos DDL ("must be owner"), por eso esto NO se auto-migra al arranque.
--  Las columnas nuevas HEREDAN el GRANT de la tabla — no hace falta re-grant.
--
--  Cambios:
--   - appointments.reminder_2h_sent_at  → marca idempotente del recordatorio 2h.
--     (Los recordatorios pasan a ser SOLO reminder_24h y reminder_2h; se
--      eliminan 48h y 1h del worker.)
--   - businesses.policies (jsonb, arreglo de strings) → políticas editables por
--     el negocio. Se devuelve en GET /api/businesses/me y se acepta en PATCH.
-- ============================================================================
BEGIN;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_2h_sent_at timestamptz;

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS policies jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
