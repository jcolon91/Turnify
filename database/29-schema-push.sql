-- ============================================================================
--  Bukéame — Web Push (scaffolding) (29). Idempotente.
--  Guarda las suscripciones push del navegador/PWA por usuario. El envío real usa
--  el paquete 'web-push' + llaves VAPID (ver .env). Inerte hasta configurarlo.
--  Correr: sudo -u postgres psql -d bukeame -f database/29-schema-push.sql
-- ============================================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text UNIQUE NOT NULL,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO bukeame_user;
