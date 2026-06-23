-- ============================================================================
--  BUKEAME — Promo de inicio: Destacado semanal a $45
--  Correr como postgres. Idempotente (re-aplicable sin problema).
-- ----------------------------------------------------------------------------
--  Sube el precio del add-on 'featured' (Destacado en buscador) a $45.00/semana
--  como precio de lanzamiento. El monto del cobro lo recalcula SIEMPRE el
--  servidor desde addon_catalog (módulo de billing ATH), así que con esto basta.
-- ============================================================================
BEGIN;

UPDATE addon_catalog SET price_cents = 4500 WHERE code = 'featured';

COMMIT;
