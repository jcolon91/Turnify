-- ============================================================================
--  BUKEAME — Verificación de email (cierra el abuso de trial Pro por multicuenta)
--  Idempotente. Correr: sudo -u postgres psql -d turnify -f database/10-schema-email-verification.sql
-- ----------------------------------------------------------------------------
--  El trial Pro de 15 días por referido ahora se concede SOLO cuando el dueño
--  verifica su email (POST /api/auth/verify-email). Un atacante con cuentas
--  desechables tendría que verificar cada correo, lo que hace inviable el abuso.
--  No bloquea el registro ni el uso básico: solo gatea el trial (y se puede
--  extender a la publicación en el marketplace).
-- ============================================================================
BEGIN;

-- Marca de verificación en el usuario (NULL = sin verificar)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Tokens de verificación (hash, 1 solo uso, expiran a las 24h)
CREATE TABLE IF NOT EXISTS email_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emailverif_token ON email_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_emailverif_user  ON email_verifications(user_id);

-- Permisos para el rol de la app
GRANT SELECT, INSERT, UPDATE, DELETE ON email_verifications TO turnify_user;
GRANT SELECT, UPDATE ON users TO turnify_user;

COMMIT;

-- ============================================================================
-- NOTA: no requiere ALTER TYPE, así que va todo en una transacción.
-- Las cuentas YA existentes quedan con email_verified_at NULL (sin verificar);
-- pueden pedir el enlace desde el panel (POST /api/auth/resend-verification).
-- ============================================================================
