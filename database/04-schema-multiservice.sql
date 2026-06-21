-- ============================================================================
--  BUKEAME — Migración: múltiples servicios por cita (Opción A: cita combinada)
--  Idempotente. Correr con: sudo -u postgres psql -d bukeame -f database/04-schema-multiservice.sql
-- ----------------------------------------------------------------------------
--  La cita sigue siendo UNA sola fila. Guardamos:
--   · service_id    → primer servicio (compatibilidad con código existente)
--   · service_name  → combinado "Recorte + Barba + Tinte"
--   · duration_min  → suma de las duraciones
--   · price_cents   → suma de los precios
--   · service_ids   → JSON con el detalle de cada servicio (NUEVO)
-- ============================================================================
BEGIN;

-- Lista detallada de servicios de la cita (para mostrar el desglose)
-- Formato: [{"id":"uuid","name":"Recorte","duration_min":30,"price_cents":2000}, ...]
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;

-- Permisos (bukeame_user ya tiene SELECT/INSERT/UPDATE/DELETE en appointments,
-- pero por si acaso tras añadir columna):
GRANT SELECT, INSERT, UPDATE, DELETE ON appointments TO bukeame_user;
