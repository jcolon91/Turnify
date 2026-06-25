-- ============================================================================
--  BUKEAME — Promoción / Ads (campañas de pago-por-impresión/clic de los negocios)
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/19-schema-ads.sql
-- ----------------------------------------------------------------------------
--  Un negocio crea una campaña, le acredita presupuesto (budget) y la pone
--  'active'. Mientras tiene presupuesto disponible (spent < budget) aparece
--  como "promocionado" en el buscador. Cada impresión/clic gasta del budget
--  (cost_per_impression_cents / cost_per_click_cents); al agotarse pasa a
--  'depleted'. El módulo backend (module-ads.js) controla el ciclo de vida.
--
--  ── ad_campaigns ──────────────────────────────────────────────────────────
--  · business_id               : negocio dueño. ON DELETE CASCADE — al borrar el
--                                negocio se borran sus campañas (y sus eventos).
--  · budget_cents              : presupuesto acreditado (en centavos).
--  · spent_cents               : gastado acumulado (impresiones + clics).
--  · cost_per_impression_cents : costo por impresión (CPM unitario). Default 2¢.
--  · cost_per_click_cents      : costo por clic. Default 25¢.
--  · status                    : 'paused' (por defecto) | 'active' | 'depleted'.
--                                El control de estados lo hace el backend.
--  · created_at                : alta de la campaña.
--
--  ── ad_events ─────────────────────────────────────────────────────────────
--  Bitácora de eventos de cada campaña (para impressions/clicks/conversions).
--  · campaign_id : campaña a la que pertenece. ON DELETE CASCADE.
--  · type        : 'impression' | 'click' | 'conversion'.
--  · ref_id      : referencia opcional (p.ej. la cita en una conversión). uuid.
--  · created_at  : cuándo ocurrió el evento.
--
--  NOTA DE PERMISOS: se aplica como postgres (DDL). El GRANT a bukeame_user es a
--  nivel de tabla → cubre automáticamente todas las columnas. Estilo de 18-...sql.
-- ============================================================================
BEGIN;

-- ── Campañas de promoción ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id               uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  budget_cents              int  NOT NULL DEFAULT 0,
  spent_cents               int  NOT NULL DEFAULT 0,
  cost_per_impression_cents int  NOT NULL DEFAULT 2,
  cost_per_click_cents      int  NOT NULL DEFAULT 25,
  status                    text NOT NULL DEFAULT 'paused',
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- Listado de campañas de un negocio (GET /api/ads).
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_business
  ON ad_campaigns (business_id);

-- Selección de promocionados activos con presupuesto (getActivePromoted).
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_status
  ON ad_campaigns (status);

-- ── Eventos de campaña (impresiones / clics / conversiones) ────────────────
CREATE TABLE IF NOT EXISTS ad_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  type        text NOT NULL,
  ref_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Conteos por campaña (impressions/clicks/conversions del GET /api/ads).
CREATE INDEX IF NOT EXISTS idx_ad_events_campaign
  ON ad_events (campaign_id);

-- Conteos por (campaña, tipo) — acelera el COUNT por type de cada campaña.
CREATE INDEX IF NOT EXISTS idx_ad_events_campaign_type
  ON ad_events (campaign_id, type);

-- El rol de la app lee/inserta/actualiza/borra campañas y eventos.
-- El GRANT de tabla cubre todas las columnas; no hace falta re-grant por columna.
GRANT SELECT, INSERT, UPDATE, DELETE ON ad_campaigns TO bukeame_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ad_events     TO bukeame_user;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · CREATE TABLE / CREATE INDEX IF NOT EXISTS → re-aplicable sin error.
-- · status es texto libre con valores convenidos 'paused'|'active'|'depleted';
--   el control lo hace el backend (module-ads.js: pause/resume/depleted).
-- · type es texto libre con valores convenidos 'impression'|'click'|'conversion';
--   los inserta el backend en los endpoints públicos y en recordConversion().
-- · El gasto (spent_cents) lo actualiza SIEMPRE el servidor sumando los costos
--   por impresión/clic desde la propia fila de ad_campaigns (nunca el cliente).
-- ============================================================================
