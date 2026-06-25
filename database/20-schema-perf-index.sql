-- ============================================================================
--  Bukéame — Índices de rendimiento (20). Idempotente. Correr como postgres:
--    sudo -u postgres psql -d bukeame -f database/20-schema-perf-index.sql
-- ----------------------------------------------------------------------------
--  · business_categories(category_id): el "buscar por categoría/profesión" en
--    el marketplace recorría la tabla puente sin índice por ese lado (el PK
--    lidera por business_id). Este índice acelera ese browse. No requiere GRANT.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_business_categories_category
  ON business_categories (category_id);
