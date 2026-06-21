-- ============================================================================
--  BUKEAME — Config de proveedores de pago + login social (Google / Apple)
--  Idempotente. Correr: sudo -u postgres psql -d turnify -f database/11-schema-pagos-login-social.sql
-- ----------------------------------------------------------------------------
--  · payment_providers.config: jsonb por proveedor para guardar credenciales/
--    ajustes NO sensibles (p. ej. publishableKey de Stripe, phone de ATH). NUNCA
--    se guarda el privateToken de ATH ni secretos de plataforma; esos viven en .env.
--  · users: auth_provider + google_sub/apple_sub para login social (OAuth/OIDC).
--    El 'sub' es el id estable del proveedor; índices únicos parciales evitan
--    enlazar dos cuentas al mismo Google/Apple sin chocar con filas locales (NULL).
--  No requiere ALTER TYPE, así que va todo en una sola transacción.
-- ============================================================================
BEGIN;

-- Proveedores de pago: asegurar columna de config (extras por proveedor)
ALTER TABLE payment_providers ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Login social en el usuario
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_sub     text;

-- Un 'sub' de proveedor no se puede enlazar a dos cuentas (parcial: ignora NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google ON users(google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_apple  ON users(apple_sub)  WHERE apple_sub  IS NOT NULL;

-- Permisos para el rol de la app
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_providers TO turnify_user;
GRANT SELECT, UPDATE ON users TO turnify_user;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · config (payment_providers) → ya existe en 07-schema-payments.sql; aquí se
--   reasegura por si la tabla se creó sin ella. Ej.: {"publishableKey":"pk_..."}.
-- · auth_provider → 'local' | 'google' | 'apple' (texto libre; la app valida).
-- · google_sub / apple_sub → claim 'sub' del id_token verificado del proveedor.
-- · Las cuentas existentes quedan con auth_provider/google_sub/apple_sub NULL
--   (login local con password tal cual). El enlace social se hace al iniciar
--   sesión con Google/Apple y verificar el id_token vía fetch (sin SDKs nuevos).
-- ============================================================================
