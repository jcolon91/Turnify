-- ============================================================================
--  BUKEAME — Pagos de PLATAFORMA por ATH Móvil (membresía · add-ons · destacado)
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/14-schema-platform-payments.sql
-- ----------------------------------------------------------------------------
--  Registra cada cobro que la PLATAFORMA (Wifnix) recibe por ATH Móvil Business
--  cuando un negocio paga su plan, un add-on o el destacado. Es la fuente de
--  IDEMPOTENCIA del cobro: cada referenceNumber de ATH se procesa UNA sola vez
--  (índice único), de modo que un reintento con el mismo referenceNumber NO
--  vuelve a activar la función paga.
--
--  ⚠ NOMBRE: se llama platform_ath_payments (NO platform_payments). Ya existe una
--  tabla platform_payments distinta en 01-schema-base.sql (ledger de suscripción);
--  por eso esta usa un nombre propio para no colisionar.
--
--  · provider          : pasarela (siempre 'athmovil' por ahora).
--  · ecommerce_id       : ecommerceId que devuelve ATH al completar el pago.
--  · reference_number   : referenceNumber de ATH — la clave de idempotencia.
--  · kind               : 'plan' | 'addon' | 'featured' (qué se compró).
--  · ref_code           : plan_code / addon code / 'featured'.
--  · weeks              : semanas de destacado (NULL para plan/addon).
--  · amount_cents       : monto calculado EN EL SERVIDOR (nunca el del cliente).
--  · status             : 'completed' (sólo guardamos pagos ya verificados con ATH).
--  · raw                : respuesta cruda de findPayment (auditoría; SIN tokens).
--
--  NOTA DE SEGURIDAD: aquí NUNCA se guarda el privateToken de ATH. La columna
--  raw guarda sólo la respuesta de verificación (data del pago), no las llaves.
--
--  NOTA DE PERMISOS: se aplica como postgres (DDL). El GRANT a bukeame_user es a
--  nivel de tabla → cubre automáticamente todas las columnas. Estilo de 13-...sql.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS platform_ath_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider         text NOT NULL DEFAULT 'athmovil',
  ecommerce_id     text,
  reference_number text NOT NULL,
  kind             text NOT NULL,
  ref_code         text,
  weeks            smallint,
  amount_cents     integer NOT NULL,
  status           text NOT NULL DEFAULT 'completed',
  raw              jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- IDEMPOTENCIA: un referenceNumber por proveedor sólo se procesa una vez.
-- El INSERT en la confirmación choca con este índice (23505) en el 2.º intento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_ath_payments_ref
  ON platform_ath_payments (provider, reference_number);

-- Listado/auditoría de pagos por negocio, más recientes primero.
CREATE INDEX IF NOT EXISTS idx_platform_ath_payments_biz
  ON platform_ath_payments (business_id, created_at DESC);

-- El rol de la app sólo necesita leer/insertar/actualizar (nunca DELETE).
-- El GRANT de tabla cubre todas las columnas; no hace falta re-grant por columna.
GRANT SELECT, INSERT, UPDATE ON platform_ath_payments TO bukeame_user;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · CREATE ... IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS → re-aplicable.
-- · uq_platform_ath_payments_ref es la garantía de "un pago = una activación".
-- · amount_cents lo fija SIEMPRE el servidor desde nuestras tablas (plans,
--   addon_catalog); jamás se confía en el total que mande el cliente.
-- · raw es jsonb opcional con la respuesta verificada de ATH (sin secretos).
-- ============================================================================
