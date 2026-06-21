-- ============================================================================
--  BUKEAME — Migración: add-on de LEALTAD + aseguramiento del portafolio
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/08-schema-addon-loyalty.sql
-- ----------------------------------------------------------------------------
--  Añade 'loyalty' al catálogo de add-ons (Premios automáticos tras N visitas),
--  asegura el índice del portafolio (gallery_photos) y otorga permisos.
-- ============================================================================

-- ALTER TYPE ADD VALUE NO puede ir dentro de una transacción (BEGIN/COMMIT):
-- debe confirmarse antes de usarse. Por eso va SOLO al inicio, fuera de bloque.
ALTER TYPE addon_code ADD VALUE IF NOT EXISTS 'loyalty';

BEGIN;

-- Catálogo: alta del add-on de lealtad ($2.99/mes)
INSERT INTO addon_catalog (code, name, price_cents, billing, description) VALUES
('loyalty', 'Lealtad', 299, 'monthly', 'Premios automáticos tras N visitas')
ON CONFLICT (code) DO NOTHING;

-- Portafolio: índice para listar fotos por negocio en orden
CREATE INDEX IF NOT EXISTS idx_gallery_biz ON gallery_photos(business_id, sort_order);

-- Permisos para bukeame_user sobre lo que tocamos
GRANT SELECT, INSERT, UPDATE, DELETE ON addon_catalog TO bukeame_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON gallery_photos TO bukeame_user;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · 'loyalty' se suma al enum addon_code (store_10, store_25, sms, custom_domain,
--   gift_cards, advanced_reports, featured) → ya activable como add-ons.code.
-- · El programa de lealtad y su trigger viven en 02-schema-v1.1.sql; este add-on
--   es la pieza de facturación/catálogo que lo habilita a la carta.
-- · idx_gallery_biz acelera el render del portafolio (gallery_photos) por negocio.
-- ============================================================================
