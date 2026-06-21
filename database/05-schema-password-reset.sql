-- Tabla para tokens de restablecimiento de contraseña
CREATE TABLE IF NOT EXISTS password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pwreset_token ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_pwreset_user  ON password_resets(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets TO bukeame_user;
