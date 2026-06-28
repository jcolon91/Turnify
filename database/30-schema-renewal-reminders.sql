-- ============================================================================
--  Bukéame — Recordatorios de renovación (30). Idempotente.
--  renew_reminded_on = fecha del último recordatorio enviado (anti-duplicado dentro
--  del día). El worker avisa 3 días y 1 día antes de vencer plan/add-on. Si el negocio
--  renueva, current_period_end se mueve → el recordatorio de 1 día ya no aplica.
--  Correr: sudo -u postgres psql -d bukeame -f database/30-schema-renewal-reminders.sql
-- ============================================================================
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renew_reminded_on date;
ALTER TABLE addons        ADD COLUMN IF NOT EXISTS renew_reminded_on date;

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions TO bukeame_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON addons        TO bukeame_user;
