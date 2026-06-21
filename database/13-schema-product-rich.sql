-- ============================================================================
--  BUKEAME — Producto enriquecido (category · tagline · features)
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/13-schema-product-rich.sql
-- ----------------------------------------------------------------------------
--  Rediseño de la Tienda: cada producto gana 3 campos de presentación.
--  · category : categoría para las burbujas/filtros del grid (ej. "Cabello").
--  · tagline  : subtítulo corto bajo el nombre (ej. "Fijación fuerte · acabado mate").
--  · features : arreglo JSON de strings; bullets de características (la API limita a
--               máx 8, cada uno <=120 chars). DEFAULT '[]' → nunca llega NULL.
--  Sólo ALTER TABLE ... ADD COLUMN IF NOT EXISTS, así que va todo en una transacción.
--
--  NOTA DE PERMISOS: NO hace falta re-grant. Los GRANT de tabla ya otorgados a
--  bukeame_user (SELECT/INSERT/UPDATE/DELETE sobre products) cubren automáticamente
--  las columnas nuevas — en Postgres los privilegios a nivel de tabla aplican a todas
--  sus columnas, presentes y futuras. Por eso este archivo se aplica como postgres
--  (DDL) sin tocar permisos.
-- ============================================================================
BEGIN;

-- Categoría para las burbujas/filtros del grid
ALTER TABLE products ADD COLUMN IF NOT EXISTS category text;

-- Subtítulo corto bajo el nombre del producto
ALTER TABLE products ADD COLUMN IF NOT EXISTS tagline  text;

-- Bullets de características (arreglo de strings). DEFAULT '[]' → siempre arreglo.
ALTER TABLE products ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · features es jsonb con DEFAULT '[]'::jsonb y NOT NULL: las filas existentes
--   quedan con un arreglo vacío, nunca NULL. La API sanea/valida el contenido
--   (máx 8 strings, cada uno <=120 chars) antes de guardarlo.
-- · category/tagline son text NULL (opcionales). La API hace trim y guarda NULL
--   cuando llegan vacíos.
-- · Sin re-grant: los privilegios de tabla a bukeame_user ya cubren estas columnas.
-- ============================================================================
