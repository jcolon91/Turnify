-- ============================================================================
--  Bukéame — Pago de órdenes de tienda (25). Idempotente.
--  El inventario sale del almacén y la gift card se redime SOLO al CONFIRMAR el
--  pago (decisión del dueño). Espeja la infraestructura de depósitos:
--    payment_method  → método elegido por el cliente (mismo ENUM payment_method).
--    paid_at         → cuándo se confirmó el pago.
--    manual_validate → el cliente eligió un método MANUAL (efectivo / ATH al número)
--                      que el NEGOCIO valida; el worker de expiración NO lo cancela.
--    committed       → stock+gift YA aplicados (guard de idempotencia anti doble-
--                      descuento). ÚNICO indicador de que el inventario/gift se movió.
--  NO usa ALTER TYPE: product_orders.status es text libre (no enum); payment_method
--  ya existe como ENUM. Sin problemas de orden/transacción.
--  Correr como postgres:
--    sudo -u postgres psql -d bukeame -f database/25-schema-order-payment.sql
-- ============================================================================
ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS payment_method  payment_method;
ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS paid_at         timestamptz;
ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS manual_validate boolean NOT NULL DEFAULT false;
ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS committed       boolean NOT NULL DEFAULT false;

-- Grandfather (una vez): las órdenes que YA existían se crearon bajo el modelo
-- viejo (descontaban stock + redimían gift AL CREARLAS). Marcamos committed=true
-- para que confirmOrderPayment NUNCA vuelva a descontar/redimir sobre ellas.
UPDATE product_orders SET committed = true WHERE committed = false;

-- Las órdenes legacy que quedaron 'pending' las tramita el negocio a mano (antes
-- no había expiración). Marcarlas manual_validate=true para que el NUEVO worker
-- de expiración de órdenes no las cancele.
UPDATE product_orders SET manual_validate = true WHERE status = 'pending';

-- Las columnas nuevas heredan el GRANT de la tabla; se re-grant por convención.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_orders TO bukeame_user;
