-- ============================================================================
--  Bukéame — Ciclo de vida de add-ons (22): vigencia + gracia + cancelar-sin-perder.
--    · current_period_end   : hasta cuándo está pagado (vence a los 30 días).
--    · cancel_at_period_end : el negocio canceló la RENOVACIÓN (no el beneficio).
--    · status 'expired'     : lo pone el worker tras periodo + 7 días de gracia.
--  Correr como postgres (ALTER TYPE ADD VALUE NO va en transacción → SIN BEGIN):
--    sudo -u postgres psql -d bukeame -f database/22-schema-addon-lifecycle.sql
--  Idempotente. El backfill da 30 días frescos a los activos para que NADIE pierda
--  acceso al subir (fail-open). subscriptions ya tiene period_end/cancel_at_period_end.
-- ============================================================================
ALTER TABLE addons ADD COLUMN IF NOT EXISTS current_period_end   timestamptz;
ALTER TABLE addons ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;

ALTER TYPE addon_status ADD VALUE IF NOT EXISTS 'expired';

-- Backfill: add-ons activos sin fecha → 30 días frescos desde ahora (no perder acceso).
UPDATE addons
   SET current_period_end = GREATEST(activated_at, now()) + interval '30 days'
 WHERE status = 'active' AND current_period_end IS NULL;

CREATE INDEX IF NOT EXISTS idx_addons_period ON addons(current_period_end) WHERE status = 'active';
