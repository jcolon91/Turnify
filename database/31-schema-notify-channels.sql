-- ============================================================================
--  Bukéame — Canales de aviso del negocio (31). Idempotente.
--  El negocio decide si recibe sus avisos (nueva cita, depósito por validar) por
--  WhatsApp y/o email. El aviso IN-APP (campana del panel) siempre se mantiene.
--  Default true → no cambia el comportamiento actual; el negocio puede apagarlos.
--  Correr: sudo -u postgres psql -d bukeame -f database/31-schema-notify-channels.sql
-- ============================================================================
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notify_wa    boolean NOT NULL DEFAULT true;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT true;

GRANT SELECT, INSERT, UPDATE, DELETE ON businesses TO bukeame_user;
