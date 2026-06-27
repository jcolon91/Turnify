-- ============================================================================
--  Bukéame — Añade la profesión/categoría "Waxing" (27). Idempotente.
--  El frontend lee las categorías de GET /api/public/categories (tabla categories),
--  así que con insertar la fila aparece en el selector de profesión (panel "Mi negocio")
--  y en los filtros de búsqueda (buscar.html). Sin GRANT nuevo (categories ya es legible).
--  Correr: sudo -u postgres psql -d bukeame -f database/27-schema-waxing-category.sql
-- ============================================================================
INSERT INTO categories (name_es, name_en, slug, icon, sort_order) VALUES
('Waxing', 'Waxing', 'waxing', 'sparkles', 11)
ON CONFLICT (slug) DO NOTHING;
