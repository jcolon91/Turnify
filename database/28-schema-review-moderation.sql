-- ============================================================================
--  Bukéame — Moderación de reseñas (UGC) + aceptación de términos (28). Idempotente.
--  Apple Guideline 1.2 / Google UGC: reportar contenido, ocultarlo, y registrar la
--  aceptación del EULA. Reusa reviews.is_published para ocultar (el trigger de rating
--  ya lo respeta); product_reviews no tiene is_published → se filtra por hidden_at.
--  Correr: sudo -u postgres psql -d bukeame -f database/28-schema-review-moderation.sql
-- ============================================================================
BEGIN;

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS reported_at  timestamptz,
  ADD COLUMN IF NOT EXISTS report_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS report_reason text,
  ADD COLUMN IF NOT EXISTS hidden_at    timestamptz;

ALTER TABLE product_reviews
  ADD COLUMN IF NOT EXISTS reported_at  timestamptz,
  ADD COLUMN IF NOT EXISTS report_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS report_reason text,
  ADD COLUMN IF NOT EXISTS hidden_at    timestamptz;

-- Evidencia de aceptación del EULA/Términos (nullable → no afecta filas existentes).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

-- Las columnas heredan los GRANT de la tabla; se re-grant por convención (no-op).
GRANT SELECT, INSERT, UPDATE, DELETE ON reviews          TO bukeame_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_reviews  TO bukeame_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON users            TO bukeame_user;

COMMIT;
