-- ============================================================================
--  Bukéame — Nómina (payroll) real (26). Idempotente.
--  El negocio SOMETE pagos al equipo (paga, horas, % de retención, total, período).
--  Quedan 'pending' en la BD del negocio; el empleado con cuenta vinculada los ve.
--  Al marcarlos 'paid' se registran como GASTO (categoría 'empleados') en contabilidad.
--  Correr: sudo -u postgres psql -d bukeame -f database/26-schema-payroll.sql
-- ============================================================================
CREATE TABLE IF NOT EXISTS payroll_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id       uuid REFERENCES staff(id) ON DELETE SET NULL,
  staff_name     text,                               -- snapshot del nombre del empleado
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  hours_worked   numeric(7,2),                        -- horas trabajadas (opcional)
  gross_cents    integer NOT NULL,                    -- la paga (bruto)
  withhold_pct   numeric(5,2) NOT NULL DEFAULT 0,     -- % de retención (10 = 10%)
  withhold_cents integer NOT NULL DEFAULT 0,          -- cantidad a retener
  net_cents      integer NOT NULL,                    -- total a pagar (bruto - retención)
  status         text NOT NULL DEFAULT 'pending',     -- pending | paid
  notes          text,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_biz   ON payroll_entries (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_staff ON payroll_entries (staff_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_entries TO bukeame_user;
