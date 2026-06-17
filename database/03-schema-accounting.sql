-- ============================================================================
-- TURNIFY · Schema de Contabilidad (v1.2)
-- Tabla de gastos manuales del negocio + índices para reportes a escala.
-- Idempotente: se puede correr varias veces sin romper nada.
-- ============================================================================

-- Categorías comunes de gasto (texto libre también permitido en 'category')
DO $$ BEGIN
  CREATE TYPE expense_category AS ENUM (
    'renta', 'productos', 'empleados', 'equipo', 'servicios',
    'mercadeo', 'transporte', 'app', 'otro'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- Gastos del negocio (anotados manualmente por el dueño)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category      expense_category NOT NULL DEFAULT 'otro',
  label         text NOT NULL,                         -- "Renta del local", "Cera y tijeras"
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  spent_on      date NOT NULL DEFAULT CURRENT_DATE,    -- fecha del gasto
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Índice clave para reportes por rango de fechas (escala a millones de filas)
CREATE INDEX IF NOT EXISTS idx_expenses_biz_date
  ON expenses(business_id, spent_on DESC);

-- Trigger de updated_at (reusa la función existente del schema base)
DO $$ BEGIN
  CREATE TRIGGER trg_expenses_upd BEFORE UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- Índices adicionales para acelerar los reportes de INGRESOS
-- (las citas y pagos se consultan mucho por fecha en contabilidad)
-- ----------------------------------------------------------------------------

-- Ingresos "facturados": citas completadas por fecha
CREATE INDEX IF NOT EXISTS idx_appt_biz_status_starts
  ON appointments(business_id, status, starts_at DESC);

-- Ingresos "cobrados": pagos completados por fecha de pago
CREATE INDEX IF NOT EXISTS idx_pay_biz_status_paid
  ON payments(business_id, status, paid_at DESC);

-- Desglose por servicio (agrupar citas por nombre de servicio)
CREATE INDEX IF NOT EXISTS idx_appt_biz_service
  ON appointments(business_id, service_name);
