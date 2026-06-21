-- ============================================================================
--  BUKEAME — Schema PostgreSQL v1.1  (incremental sobre v1.0)
--  Aplica DESPUÉS del schema base. Añade: gift cards, lealtad, te-toca,
--  lista de espera con oferta 30min, destacados, add-ons, trial 15d premium.
-- ----------------------------------------------------------------------------
--  DEPLOY:  sudo -u postgres psql -d bukeame -f 02-schema-v1.1.sql
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. NUEVOS TIPOS ENUM (idempotente: no falla si ya existen)
-- ============================================================================
DO $$ BEGIN
  CREATE TYPE addon_code AS ENUM ('store_10','store_25','sms','custom_domain','gift_cards','advanced_reports','featured');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE addon_status AS ENUM ('active','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- 'pending' = comprada pero SIN pago confirmado → NO gastable hasta que el negocio confirme.
  CREATE TYPE giftcard_status AS ENUM ('pending','active','redeemed','partial','expired','void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE waitlist_offer_st AS ENUM ('none','offered','accepted','expired','declined');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 1. PLANES — ampliar tiers de equipo (Team/Grande/Ilimitado)
--    (los enum de plan_code no se alteran en caliente; usamos códigos de texto
--     adicionales en una tabla de plan extendida para no romper FKs existentes)
-- ============================================================================
-- En vez de alterar el ENUM (riesgoso), agregamos los tiers como filas nuevas.
-- Si plan_code es ENUM, ampliarlo requiere ALTER TYPE; lo hacemos seguro:
ALTER TYPE plan_code ADD VALUE IF NOT EXISTS 'team';
ALTER TYPE plan_code ADD VALUE IF NOT EXISTS 'grande';
ALTER TYPE plan_code ADD VALUE IF NOT EXISTS 'ilimitado';
COMMIT;  -- ALTER TYPE ADD VALUE debe confirmarse antes de usarse

BEGIN;
INSERT INTO plans (code, name, price_monthly_cents, price_annual_cents, max_staff, max_appts_month, features) VALUES
('team',      'Team',      2999, 29900, 10,  NULL, '{"deposits":true,"waitlist":true,"campaigns":true,"featured":true,"loyalty":true,"reminders":["confirm","24h","2h","due"]}'),
('grande',    'Grande',    4499, 44900, 20,  NULL, '{"deposits":true,"waitlist":true,"campaigns":true,"featured":true,"loyalty":true,"reminders":["confirm","24h","2h","due"]}'),
('ilimitado', 'Ilimitado', 5999, 59900, 9999,NULL, '{"deposits":true,"waitlist":true,"campaigns":true,"featured":true,"loyalty":true,"reminders":["confirm","24h","2h","due"]}')
ON CONFLICT (code) DO NOTHING;

-- Actualizar features de planes existentes con las nuevas capacidades
UPDATE plans SET features = features || '{"loyalty":false,"due_reminder":false,"external_integrations":false,"custom_branding":false}'::jsonb WHERE code = 'free';
UPDATE plans SET features = features || '{"loyalty":false,"due_reminder":true,"external_integrations":true,"custom_branding":true}'::jsonb  WHERE code = 'pro';
UPDATE plans SET features = features || '{"loyalty":true,"due_reminder":true,"external_integrations":true,"custom_branding":true}'::jsonb   WHERE code = 'studio';

-- ============================================================================
-- 2. SUSCRIPCIONES — soporte de trial premium de 15 días (referido)
-- ============================================================================
-- trial_ends_at ya existe. Añadimos de qué plan es el trial y si vino por referido.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS trial_plan_code plan_code,           -- qué plan premium prueba
  ADD COLUMN IF NOT EXISTS trial_from_referral boolean NOT NULL DEFAULT false;

-- Vista: ¿qué features tiene HOY el negocio? (plan real, o trial premium si activo)
CREATE OR REPLACE VIEW v_effective_plan AS
SELECT s.business_id,
       CASE WHEN s.trial_ends_at IS NOT NULL AND s.trial_ends_at > now()
            THEN s.trial_plan_code ELSE s.plan_code END AS effective_plan,
       (s.trial_ends_at IS NOT NULL AND s.trial_ends_at > now()) AS in_trial,
       s.trial_ends_at
FROM subscriptions s;

-- ============================================================================
-- 3. REFERIDOS — $5/mes, UNO por mes, NO acumulable
-- ============================================================================
-- La tabla referrals ya existe. Cambiamos la lógica de descuento:
-- en vez de sumar todos los activos, el descuento es FIJO $5 si tiene ≥1 activo.
DROP VIEW IF EXISTS v_referral_discounts;
CREATE VIEW v_referral_discounts AS
SELECT referrer_business_id AS business_id,
       count(*)                       AS active_referrals,
       CASE WHEN count(*) >= 1 THEN 500 ELSE 0 END AS discount_cents  -- TOPE $5, no acumulable
FROM referrals
WHERE status = 'active'
GROUP BY referrer_business_id;

-- Registro mensual de aplicación del descuento (auditoría: 1 por mes)
CREATE TABLE referral_credits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period_month  date NOT NULL,                    -- primer día del mes
  amount_cents  integer NOT NULL DEFAULT 500,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, period_month)              -- garantiza 1 crédito por mes
);

-- ============================================================================
-- 4. ADD-ONS (funciones a la carta)
-- ============================================================================
CREATE TABLE addons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code          addon_code NOT NULL,
  status        addon_status NOT NULL DEFAULT 'active',
  price_cents   integer NOT NULL,                 -- snapshot del precio al activar
  activated_at  timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz,
  UNIQUE (business_id, code)
);
CREATE INDEX idx_addons_biz ON addons(business_id) WHERE status = 'active';

-- Catálogo de precios de add-ons (editable sin tocar código)
CREATE TABLE addon_catalog (
  code          addon_code PRIMARY KEY,
  name          text NOT NULL,
  price_cents   integer NOT NULL,
  billing       text NOT NULL DEFAULT 'monthly',  -- monthly | weekly
  description   text
);
INSERT INTO addon_catalog (code, name, price_cents, billing, description) VALUES
('store_10',        'Tienda · 10 productos', 499,  'monthly', 'Vende hasta 10 productos en tu página'),
('store_25',        'Tienda · 25 productos', 999,  'monthly', 'Vende hasta 25 productos en tu página'),
('sms',             'Recordatorios SMS',     499,  'monthly', '500 SMS/mes para clientes sin WhatsApp'),
('custom_domain',   'Dominio propio',        499,  'monthly', 'Conecta tudominio.com a tu página'),
('gift_cards',      'Gift cards',            399,  'monthly', 'Vende tarjetas de regalo digitales'),
('advanced_reports','Reportes avanzados',    499,  'monthly', 'Exporta a contabilidad y análisis profundo'),
('featured',        'Destacado en buscador', 999,  'weekly',  'Aparece primero en tu pueblo y categoría')
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- 5. GIFT CARDS (el negocio custodia el dinero; Bukeame lleva el saldo)
-- ============================================================================
CREATE TABLE gift_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code            text NOT NULL UNIQUE,            -- LM-GIFT-7K2P
  initial_cents   integer NOT NULL CHECK (initial_cents > 0),
  balance_cents   integer NOT NULL CHECK (balance_cents >= 0),
  -- fail-closed: una tarjeta nace 'pending' (no gastable) hasta confirmar el pago
  status          giftcard_status NOT NULL DEFAULT 'pending',
  purchaser_name  text,
  purchaser_email citext,
  recipient_name  text,
  recipient_email citext,
  message         text,
  payment_id      uuid REFERENCES payments(id),    -- cómo se pagó la compra
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_gift_biz ON gift_cards(business_id) WHERE status IN ('active','partial');

-- Uso de gift card (cada vez que se aplica a una cita/compra)
CREATE TABLE gift_card_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id  uuid NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 6. PROGRAMA DE LEALTAD ("cada N visitas, 1 gratis" — lo paga el NEGOCIO)
-- ============================================================================
CREATE TABLE loyalty_programs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  is_active       boolean NOT NULL DEFAULT false,
  visits_required smallint NOT NULL DEFAULT 10 CHECK (visits_required BETWEEN 2 AND 50),
  reward_text     text NOT NULL DEFAULT 'Servicio gratis',
  applies_to      jsonb NOT NULL DEFAULT '{"type":"any"}'::jsonb,  -- any | specific service_ids
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_loyalty_upd BEFORE UPDATE ON loyalty_programs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Progreso por cliente (Bukeame es solo el contador)
CREATE TABLE loyalty_progress (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  current_count   smallint NOT NULL DEFAULT 0,
  rewards_earned  smallint NOT NULL DEFAULT 0,
  rewards_redeemed smallint NOT NULL DEFAULT 0,
  last_visit_at   timestamptz,
  UNIQUE (business_id, client_id)
);
CREATE INDEX idx_loyalty_prog ON loyalty_progress(business_id, client_id);

-- Cuando una cita se completa: sube el contador; si llega al tope, gana premio
CREATE OR REPLACE FUNCTION loyalty_on_complete() RETURNS trigger AS $$
DECLARE prog RECORD; req smallint;
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
    SELECT visits_required INTO req FROM loyalty_programs
      WHERE business_id = NEW.business_id AND is_active;
    IF req IS NOT NULL THEN
      INSERT INTO loyalty_progress (business_id, client_id, current_count, last_visit_at)
        VALUES (NEW.business_id, NEW.client_id, 1, now())
      ON CONFLICT (business_id, client_id) DO UPDATE
        SET current_count = loyalty_progress.current_count + 1, last_visit_at = now();
      -- ¿alcanzó el premio?
      UPDATE loyalty_progress
        SET rewards_earned = rewards_earned + 1, current_count = current_count - req
        WHERE business_id = NEW.business_id AND client_id = NEW.client_id
          AND current_count >= req;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_loyalty_complete
  AFTER UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION loyalty_on_complete();

-- ============================================================================
-- 7. RECORDATORIO "TE TOCA" (re-engagement automático)
-- ============================================================================
-- Configuración por negocio: cada cuánto recordar a clientes inactivos
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS due_reminder_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS due_reminder_days smallint NOT NULL DEFAULT 21; -- "te toca" a los X días

-- Control de envío (no spamear: máx 1 cada periodo por cliente)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS due_reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS avg_visit_gap_days smallint;  -- aprende el ritmo del cliente

CREATE INDEX idx_clients_due ON clients(business_id, last_visit_at)
  WHERE last_visit_at IS NOT NULL;

-- ============================================================================
-- 8. LISTA DE ESPERA con OFERTA de 30 min (no pierde su cita base)
-- ============================================================================
-- La tabla waitlist ya existe. Le añadimos el flujo de oferta protegida.
ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS held_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offered_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offer_state waitlist_offer_st NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS position smallint;  -- orden en la fila (FIFO)

-- held_appointment_id      = la cita que YA tiene (jueves) — se protege
-- offered_appointment_id   = el cupo que se liberó (martes) — se le ofrece
-- offer_state              = none | offered | accepted | expired | declined
-- offer_expires_at (ya existe en waitlist v1.0) = ahora() + 30 min al ofertar

CREATE INDEX idx_wait_offer ON waitlist(offer_state, offer_expires_at)
  WHERE offer_state = 'offered';

-- ============================================================================
-- 9. DESTACADOS PAGADOS (featured_listings, por semana)
-- ============================================================================
CREATE TABLE featured_listings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  municipality_id smallint REFERENCES pr_municipalities(id),
  category_id   smallint REFERENCES categories(id),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NOT NULL,
  payment_id    uuid REFERENCES platform_payments(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_featured_active ON featured_listings(municipality_id, category_id, ends_at);

-- ============================================================================
-- 10. PRODUCTOS — límite de 4 fotos por artículo (proteger el server)
-- ============================================================================
CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  price_cents   integer NOT NULL CHECK (price_cents >= 0),
  stock         integer,                          -- NULL = no rastrea inventario
  is_active     boolean NOT NULL DEFAULT true,
  is_featured   boolean NOT NULL DEFAULT false,
  variants      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name:"Tamaño",options:["S","M","L"]}]
  sort_order    smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_products_upd BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_products_biz ON products(business_id) WHERE is_active;

CREATE TABLE product_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url           text NOT NULL,
  sort_order    smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_prodphoto ON product_photos(product_id);

-- ★ LÍMITE DURO: máximo 4 fotos por producto (a nivel de DB)
CREATE OR REPLACE FUNCTION enforce_photo_limit() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM product_photos WHERE product_id = NEW.product_id) >= 4 THEN
    RAISE EXCEPTION 'Máximo 4 fotos por producto' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_photo_limit
  BEFORE INSERT ON product_photos
  FOR EACH ROW EXECUTE FUNCTION enforce_photo_limit();

-- Pedidos de productos (ventas de la tienda)
CREATE TABLE product_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id),
  buyer_name    text NOT NULL,
  buyer_phone   text,
  buyer_email   citext,
  items         jsonb NOT NULL,                   -- [{product_id,name,qty,price_cents,variant}]
  total_cents   integer NOT NULL,
  fulfillment   text NOT NULL DEFAULT 'pickup',   -- pickup | shipping
  payment_id    uuid REFERENCES payments(id),
  gift_card_id  uuid REFERENCES gift_cards(id),
  status        text NOT NULL DEFAULT 'pending',  -- pending | paid | fulfilled | cancelled
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_biz ON product_orders(business_id, created_at DESC);

-- ============================================================================
-- 11. PLAN FREE — bloqueo de integraciones externas (validado en backend)
-- ============================================================================
-- La restricción se aplica en el backend leyendo features->>'external_integrations'.
-- Aquí dejamos documentado el contrato. El plan free:
--   external_integrations=false  → no API keys, no webhooks, no widget, no dominio
--   custom_branding=false        → solo temas/colores predeterminados, no logo propio
-- Los planes pagos: ambos true.

-- Temas predeterminados disponibles para plan free
CREATE TABLE preset_themes (
  id          smallserial PRIMARY KEY,
  name        text NOT NULL,
  accent      text NOT NULL,
  mode        text NOT NULL DEFAULT 'light',
  sort_order  smallint NOT NULL DEFAULT 0
);
INSERT INTO preset_themes (name, accent, mode, sort_order) VALUES
('Marquesina',  '#0E8074', 'light', 1),
('Carbón',      '#17150F', 'light', 2),
('Vino',        '#B0413E', 'light', 3),
('Océano',      '#3E5CB0', 'light', 4),
('Mostaza',     '#8a5a13', 'light', 5),
('Violeta',     '#6D28D9', 'light', 6),
('Noche',       '#0E8074', 'dark',  7),
('Rosa',        '#BE185D', 'light', 8);

-- ============================================================================
-- 12. PERMISOS para bukeame_user en las tablas nuevas
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bukeame_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bukeame_user;

COMMIT;

-- ============================================================================
-- RESUMEN DE LO IMPLEMENTADO v1.1
-- ----------------------------------------------------------------------------
-- · Referidos: $5/mes FIJO (≥1 referido activo), no acumulable, 1 crédito/mes
-- · Trial premium 15 días: v_effective_plan decide features (trial o plan real)
-- · Tiers equipo: team $29.99/10 · grande $44.99/20 · ilimitado $59.99
-- · Add-ons a la carta: tienda, SMS(Telnyx), dominio, gift cards, reportes, featured
-- · Gift cards: negocio custodia $, Bukeame lleva saldo y redenciones
-- · Lealtad: "cada N visitas 1 gratis", lo paga el negocio, trigger automático
-- · Te-toca: recordatorio a inactivos según ritmo del cliente
-- · Lista espera 30min: held (protegida) + offered (nueva) + expira sin perder base
-- · Destacados: por semana, por pueblo+categoría
-- · Productos: máx 4 fotos por DB constraint, variantes, inventario, pedidos
-- · Plan free: external_integrations=false, custom_branding=false, temas preset
-- ============================================================================
