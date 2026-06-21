-- ============================================================================
--  BUKEAME — Reseñas de productos (product_reviews)
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/12-schema-product-reviews.sql
-- ----------------------------------------------------------------------------
--  · product_reviews: una reseña por cliente que compró el producto. La compra
--    se verifica en la API (product_orders pagado/cumplido con buyer_email y el
--    product_id en items); aquí verified=true por defecto.
--  · reviewer_email es citext → comparación case-insensitive del correo.
--  · Índice ÚNICO parcial (product_id, reviewer_email) WHERE email IS NOT NULL:
--    1 reseña por email/producto, sin chocar con filas anónimas (NULL).
--  No requiere ALTER TYPE, así que va todo en una sola transacción.
-- ============================================================================
BEGIN;

-- Tabla de reseñas de productos
CREATE TABLE IF NOT EXISTS product_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid REFERENCES products(id) ON DELETE CASCADE,
  business_id    uuid REFERENCES businesses(id) ON DELETE CASCADE,
  order_id       uuid REFERENCES product_orders(id),
  reviewer_name  text NOT NULL,
  reviewer_email citext,
  rating         smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        text,
  verified       boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Listado de reseñas por producto, más recientes primero
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_created
  ON product_reviews (product_id, created_at DESC);

-- Una sola reseña por email/producto (parcial: ignora reseñas sin email)
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_reviews_product_email
  ON product_reviews (product_id, reviewer_email)
  WHERE reviewer_email IS NOT NULL;

-- Permisos para el rol de la app
GRANT SELECT, INSERT, UPDATE, DELETE ON product_reviews TO bukeame_user;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · La verificación de compra (status IN ('paid','fulfilled') + items @> ...)
--   se hace en la API antes del INSERT; order_id apunta a la orden más reciente
--   que califica. verified=true refleja esa compra confirmada.
-- · ON DELETE CASCADE en product_id/business_id → al borrar el producto o el
--   negocio se eliminan sus reseñas. order_id sin CASCADE (queda la reseña aunque
--   se reorganice la orden; histórico).
-- · reviewer_email citext → requiere la extensión citext (ya habilitada por
--   migraciones previas que la usan).
-- ============================================================================
