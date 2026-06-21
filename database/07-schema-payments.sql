-- ============================================================================
--  BUKEAME — Migración: métodos de pago por negocio (fundación)
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/07-schema-payments.sql
-- ----------------------------------------------------------------------------
--  Cada negocio conecta SUS propias cuentas y recibe el dinero directo
--  (Bukeame no toca el dinero). Un solo Stripe Connect cubre tarjetas + Apple Pay
--  + Google Pay + Klarna. PayPal y ATH Móvil van aparte. Cash = solo un toggle.
-- ============================================================================

-- Los ENUM se confirman antes de usarse
DO $$ BEGIN
  CREATE TYPE payment_provider AS ENUM ('stripe','paypal','ath_movil','cash');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE provider_status AS ENUM ('not_connected','pending','connected','error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- payments.method: añadir 'paypal' (klarna/apple_pay/google_pay liquidan como 'card' vía Stripe)
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'paypal';

BEGIN;

-- Config de pago por negocio: una fila por (negocio, proveedor)
CREATE TABLE IF NOT EXISTS payment_providers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider      payment_provider NOT NULL,
  is_enabled    boolean NOT NULL DEFAULT false,           -- el cliente lo ve como opción
  status        provider_status NOT NULL DEFAULT 'not_connected',
  account_ref   text,            -- stripe account id / paypal merchant id / teléfono ATH
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,        -- extras por proveedor
  connected_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_payprov_biz ON payment_providers(business_id);

DO $$ BEGIN
  CREATE TRIGGER trg_payprov_upd BEFORE UPDATE ON payment_providers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_providers TO bukeame_user;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · cash       → status 'connected' al activarse (no hay cuenta externa).
-- · ath_movil  → account_ref = teléfono ATH; se sincroniza con businesses.ath_phone.
-- · stripe     → account_ref = acct_xxx (Stripe Connect). Cubre tarjetas/Apple Pay/
--                Google Pay/Klarna. status 'pending' al iniciar onboarding, 'connected'
--                cuando el webhook account.updated confirma charges_enabled.
-- · paypal     → account_ref = merchant id (PayPal Partner Referrals).
-- · El procesamiento real (cargos + webhooks) se implementa con las credenciales de
--   plataforma en .env: STRIPE_SECRET_KEY, STRIPE_CONNECT_CLIENT_ID, PAYPAL_*.
-- ============================================================================
