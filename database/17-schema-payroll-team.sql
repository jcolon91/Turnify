-- ============================================================================
--  BUKEAME — Migración: add-ons NÓMINA (payroll) + CONTABILIDAD DE EMPLEADO
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/17-schema-payroll-team.sql
-- ----------------------------------------------------------------------------
--  Añade dos add-ons al catálogo:
--    · payroll              → "Nómina (Payroll)"               $9.99/mes
--    · employee_accounting  → "Contabilidad completa (empleado)" $4.99/mes
--  La contabilidad completa va INCLUIDA en planes Pro o superior (no se cobra
--  como add-on a esos planes); el indicador lo expone el backend (module-revenue.js).
--  Además crea staff_invites: códigos para que un empleado se una al negocio.
-- ============================================================================

-- ALTER TYPE ADD VALUE NO puede ir dentro de una transacción (BEGIN/COMMIT):
-- debe confirmarse antes de usarse. Por eso va SOLO al inicio, fuera de bloque.
-- (Mismo patrón que 08-schema-addon-loyalty.sql.)
ALTER TYPE addon_code ADD VALUE IF NOT EXISTS 'payroll';
ALTER TYPE addon_code ADD VALUE IF NOT EXISTS 'employee_accounting';

BEGIN;

-- Catálogo: alta de los dos add-ons. Mismas columnas/valores que las filas
-- existentes (code, name, price_cents, billing, description); billing 'monthly'.
INSERT INTO addon_catalog (code, name, price_cents, billing, description) VALUES
('payroll',             'Nómina (Payroll)',                 999, 'monthly', 'Procesa la nómina de tu equipo desde Bukéame'),
('employee_accounting', 'Contabilidad completa (empleado)', 499, 'monthly', 'Contabilidad completa por empleado (incluida en planes Pro o superior)')
ON CONFLICT (code) DO NOTHING;

-- Invitaciones de empleado: código que el negocio comparte para que un
-- profesional se una al equipo. staff.id y users.id son uuid (01-schema-base.sql).
CREATE TABLE IF NOT EXISTS staff_invites (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id         uuid REFERENCES staff(id) ON DELETE CASCADE,
  code             text UNIQUE NOT NULL,
  expires_at       timestamptz,
  used_at          timestamptz,
  used_by_user_id  uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Búsqueda por código al canjear la invitación.
CREATE INDEX IF NOT EXISTS idx_staff_invites_code ON staff_invites (code);

-- El rol de la app lee/inserta/actualiza/borra invitaciones.
-- El GRANT de tabla cubre todas las columnas; no hace falta re-grant por columna.
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_invites TO bukeame_user;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · 'payroll' y 'employee_accounting' se suman al enum addon_code (junto a
--   store_10, store_25, sms, custom_domain, gift_cards, advanced_reports,
--   featured, loyalty) → ya activables como addons.code.
-- · price_cents: payroll 999 ($9.99), employee_accounting 499 ($4.99). El cobro
--   real lo recalcula SIEMPRE el servidor desde addon_catalog (billing ATH).
-- · La "contabilidad completa" se considera INCLUIDA cuando el plan del negocio
--   es Pro o superior (cualquier plan != 'free'); el front la deshabilita según
--   el flag accounting_included que devuelve GET /api/addons/catalog.
-- · staff_invites.code es UNIQUE; la unicidad real del código la genera el
--   backend al crear la invitación. expires_at/used_at NULL = vigente y sin usar.
-- ============================================================================
