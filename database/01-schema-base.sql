-- ============================================================================
--  BOOKÉA — Schema PostgreSQL v1.0
--  SaaS de citas multi-tenant + marketplace (Puerto Rico first)
--  DB: turnify · VPS: 2.24.70.107 · Convive aislado de la DB "wifnix"
-- ----------------------------------------------------------------------------
--  DEPLOY (como postgres, una sola vez):
--    sudo -u postgres psql -c "CREATE USER turnify_user WITH PASSWORD 'CAMBIAME';"
--    sudo -u postgres psql -c "CREATE DATABASE turnify OWNER turnify_user;"
--    sudo -u postgres psql -d turnify -f 01-schema-base.sql
--  (los GRANTs para turnify_user están al final del archivo)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. EXTENSIONES
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;        -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;          -- emails case-insensitive
CREATE EXTENSION IF NOT EXISTS pg_trgm;         -- búsqueda difusa (typos)
CREATE EXTENSION IF NOT EXISTS btree_gist;      -- anti doble-booking
CREATE EXTENSION IF NOT EXISTS cube;            -- requerido por earthdistance
CREATE EXTENSION IF NOT EXISTS earthdistance;   -- "cerca de mí"

-- ============================================================================
-- 1. TIPOS ENUM
-- ============================================================================
CREATE TYPE plan_code           AS ENUM ('free','pro','studio');
CREATE TYPE billing_cycle       AS ENUM ('monthly','annual');
CREATE TYPE subscription_status AS ENUM ('trialing','active','past_due','cancelled');
CREATE TYPE appointment_status  AS ENUM ('pending_deposit','confirmed','completed','cancelled_client','cancelled_business','no_show');
CREATE TYPE appointment_source  AS ENUM ('online','walk_in','manual');
CREATE TYPE payment_kind        AS ENUM ('deposit','balance','subscription');
CREATE TYPE payment_method     AS ENUM ('ath_movil','card','cash');
CREATE TYPE payment_status      AS ENUM ('pending','paid','refunded','failed');
CREATE TYPE referral_status     AS ENUM ('pending','active','inactive');
CREATE TYPE msg_channel         AS ENUM ('whatsapp','email');
CREATE TYPE msg_status          AS ENUM ('queued','sent','delivered','failed');
CREATE TYPE waitlist_status     AS ENUM ('waiting','offered','booked','expired');
CREATE TYPE campaign_status     AS ENUM ('draft','scheduled','sending','sent');
CREATE TYPE legal_doc_type      AS ENUM ('terms','privacy');

-- ============================================================================
-- 2. TRIGGER GENÉRICO updated_at
-- ============================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 3. CATÁLOGOS (seeds al final)
-- ============================================================================

-- 78 municipios de PR — filtro limpio en el buscador
CREATE TABLE pr_municipalities (
  id         smallserial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  slug       text NOT NULL UNIQUE
);

-- Categorías de negocio (barbería, salón, nails, spa…)
CREATE TABLE categories (
  id         smallserial PRIMARY KEY,
  name_es    text NOT NULL,
  name_en    text NOT NULL,
  slug       text NOT NULL UNIQUE,
  icon       text,                        -- nombre de ícono UI
  sort_order smallint NOT NULL DEFAULT 0
);

-- Planes de suscripción
CREATE TABLE plans (
  code                 plan_code PRIMARY KEY,
  name                 text    NOT NULL,
  price_monthly_cents  integer NOT NULL,
  price_annual_cents   integer NOT NULL,
  max_staff            smallint NOT NULL,            -- 1, 1, 5
  max_appts_month      integer,                      -- NULL = ilimitado
  features             jsonb   NOT NULL DEFAULT '{}'::jsonb,
  is_active            boolean NOT NULL DEFAULT true
);

-- ============================================================================
-- 4. IDENTIDAD
-- ============================================================================

-- Cuenta de login universal (dueños, staff con acceso, clientes con cuenta).
-- El booking de invitado NO requiere cuenta (ver clients.user_id NULL).
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext UNIQUE,
  phone              text   UNIQUE,                  -- E.164: +17870000000
  password_hash      text,                           -- NULL si entra por OTP WhatsApp
  full_name          text NOT NULL,
  avatar_url         text,
  locale             text NOT NULL DEFAULT 'es',     -- es | en
  is_platform_admin  boolean NOT NULL DEFAULT false, -- tú
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  last_login_at      timestamptz,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_contact_chk CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE TRIGGER trg_users_upd BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Refresh tokens (JWT corto + refresh rotativo; práctica post-pentest)
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,                  -- sha256, nunca el token plano
  user_agent  text,
  ip          inet,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- ============================================================================
-- 5. NEGOCIOS (tenant) — perfil 100% editable
-- ============================================================================
CREATE TABLE businesses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id         uuid NOT NULL REFERENCES users(id),
  slug                  citext NOT NULL UNIQUE,      -- turnifypr.com/<slug>  (SEO)
  name                  text NOT NULL,
  bio                   text,
  -- Contacto / ubicación
  phone                 text,
  whatsapp              text,                        -- a dónde llegan avisos del negocio
  email                 citext,
  address_line          text,
  municipality_id       smallint REFERENCES pr_municipalities(id),
  lat                   double precision,
  lng                   double precision,
  -- Identidad visual (la personalización es el gancho)
  logo_url              text,
  cover_url             text,
  theme                 jsonb NOT NULL DEFAULT '{"accent":"#0E8074","mode":"light"}'::jsonb,
  social                jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {instagram, facebook, tiktok}
  -- Cobros del negocio
  ath_phone             text,                        -- pATH Móvil del negocio
  stripe_account_id     text,                        -- Stripe Connect (depósitos con tarjeta)
  deposit_default_cents integer NOT NULL DEFAULT 500,
  currency              char(3) NOT NULL DEFAULT 'USD',
  -- Políticas (se muestran al cliente y van al ticket)
  cancellation_hours    smallint NOT NULL DEFAULT 24,
  no_show_policy        text,
  booking_lead_min      smallint NOT NULL DEFAULT 60,   -- antelación mínima (min)
  booking_horizon_days  smallint NOT NULL DEFAULT 30,   -- hasta cuántos días adelante
  slot_granularity_min  smallint NOT NULL DEFAULT 15,
  timezone              text NOT NULL DEFAULT 'America/Puerto_Rico',
  -- Marketplace
  is_published          boolean NOT NULL DEFAULT false, -- visible en el buscador
  is_featured           boolean NOT NULL DEFAULT false, -- perk Studio
  rating_avg            numeric(3,2) NOT NULL DEFAULT 0,
  rating_count          integer NOT NULL DEFAULT 0,
  -- Referidos
  referral_code         text NOT NULL UNIQUE,           -- ej. LM-MARQUESINA
  referred_by_business  uuid REFERENCES businesses(id),
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_biz_upd BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Búsqueda y geo
CREATE INDEX idx_biz_name_trgm ON businesses USING gin (name gin_trgm_ops);
CREATE INDEX idx_biz_geo       ON businesses USING gist (ll_to_earth(lat,lng))
  WHERE lat IS NOT NULL AND lng IS NOT NULL;
CREATE INDEX idx_biz_muni      ON businesses(municipality_id) WHERE is_published;
CREATE INDEX idx_biz_featured  ON businesses(is_featured)     WHERE is_published;

-- N:M negocio ↔ categorías (un salón puede ser nails + lash + estética)
CREATE TABLE business_categories (
  business_id uuid     NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id smallint NOT NULL REFERENCES categories(id),
  PRIMARY KEY (business_id, category_id)
);

-- Galería de trabajos
CREATE TABLE gallery_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id    uuid,                                   -- FK luego de crear staff
  url         text NOT NULL,
  caption     text,
  sort_order  smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 6. STAFF Y SERVICIOS — perfiles editables
-- ============================================================================
CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id),            -- NULL = sin login propio
  display_name  text NOT NULL,
  bio           text,
  avatar_url    text,
  specialties   text[],
  calendar_color text NOT NULL DEFAULT '#0E8074',     -- pin/columna en agenda
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    smallint NOT NULL DEFAULT 0,
  rating_avg    numeric(3,2) NOT NULL DEFAULT 0,
  rating_count  integer NOT NULL DEFAULT 0,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_staff_upd BEFORE UPDATE ON staff
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_staff_biz ON staff(business_id) WHERE is_active;

ALTER TABLE gallery_photos
  ADD CONSTRAINT fk_gallery_staff FOREIGN KEY (staff_id)
  REFERENCES staff(id) ON DELETE SET NULL;

CREATE TABLE services (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name           text NOT NULL,
  description    text,
  duration_min   smallint NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  price_cents    integer  NOT NULL CHECK (price_cents >= 0),
  deposit_cents  integer,                              -- NULL → usa default del negocio
  photo_url      text,
  is_active      boolean NOT NULL DEFAULT true,
  is_featured    boolean NOT NULL DEFAULT false,       -- "popular" en el perfil
  sort_order     smallint NOT NULL DEFAULT 0,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_serv_upd BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_serv_biz        ON services(business_id) WHERE is_active;
CREATE INDEX idx_serv_name_trgm  ON services USING gin (name gin_trgm_ops);

-- Qué staff ofrece qué servicio
CREATE TABLE service_staff (
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  staff_id   uuid NOT NULL REFERENCES staff(id)    ON DELETE CASCADE,
  PRIMARY KEY (service_id, staff_id)
);

-- ============================================================================
-- 7. HORARIOS Y BLOQUEOS
-- ============================================================================
-- Varias filas por día = breaks (9-12 y 1-7). day_of_week: 0=domingo…6=sábado
CREATE TABLE business_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens       time NOT NULL,
  closes      time NOT NULL,
  CHECK (closes > opens)
);
CREATE INDEX idx_bhours ON business_hours(business_id, day_of_week);

-- Override por staff (si difiere del negocio)
CREATE TABLE staff_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens       time NOT NULL,
  closes      time NOT NULL,
  CHECK (closes > opens)
);
CREATE INDEX idx_shours ON staff_hours(staff_id, day_of_week);

-- Bloqueos puntuales: vacaciones, almuerzo, evento personal
CREATE TABLE time_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id    uuid REFERENCES staff(id) ON DELETE CASCADE,  -- NULL = todo el negocio
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_blocks ON time_blocks(business_id, starts_at);

-- ============================================================================
-- 8. CLIENTES (CRM por negocio)
-- ============================================================================
-- Invitado: user_id NULL. Si luego crea cuenta con el mismo phone → se vincula.
CREATE TABLE clients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id),
  full_name        text NOT NULL,
  phone            text NOT NULL,                     -- WhatsApp del cliente
  email            citext,
  notes            text,                              -- notas privadas del negocio
  no_show_count    smallint NOT NULL DEFAULT 0,
  total_visits     integer  NOT NULL DEFAULT 0,
  total_spent_cents bigint  NOT NULL DEFAULT 0,
  last_visit_at    timestamptz,
  is_blocked       boolean NOT NULL DEFAULT false,    -- cliente problema
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, phone)
);
CREATE TRIGGER trg_clients_upd BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_clients_biz  ON clients(business_id);
CREATE INDEX idx_clients_name ON clients USING gin (full_name gin_trgm_ops);

-- ============================================================================
-- 9. CITAS — corazón del sistema
-- ============================================================================
CREATE TABLE appointments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id          uuid NOT NULL REFERENCES clients(id),
  staff_id           uuid NOT NULL REFERENCES staff(id),
  service_id         uuid REFERENCES services(id),
  -- Snapshot (los servicios cambian de precio; la cita conserva lo pactado)
  service_name       text     NOT NULL,
  duration_min       smallint NOT NULL,
  price_cents        integer  NOT NULL,
  deposit_cents      integer  NOT NULL DEFAULT 0,
  -- Tiempo
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  -- Estado
  status             appointment_status NOT NULL DEFAULT 'pending_deposit',
  source             appointment_source NOT NULL DEFAULT 'online',
  confirmation_code  text NOT NULL UNIQUE,            -- LM-0611-014 (ticket)
  client_notes       text,                            -- "me dejas el cerquillo recto"
  cancel_reason      text,
  cancelled_at       timestamptz,
  -- Control de recordatorios (cron los marca; no se duplican)
  reminder_24h_sent_at timestamptz,
  reminder_2h_sent_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE TRIGGER trg_appt_upd BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ★ ANTI DOBLE-BOOKING A NIVEL DE BASE DE DATOS:
-- dos citas vivas del mismo staff jamás pueden solaparse, ni con race conditions.
ALTER TABLE appointments ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  )
  WHERE (status IN ('pending_deposit','confirmed'));

CREATE INDEX idx_appt_biz_day  ON appointments(business_id, starts_at);
CREATE INDEX idx_appt_staff    ON appointments(staff_id, starts_at);
CREATE INDEX idx_appt_client   ON appointments(client_id, starts_at DESC);
CREATE INDEX idx_appt_reminders ON appointments(starts_at)
  WHERE status = 'confirmed';

-- ============================================================================
-- 10. PAGOS (depósitos y balances de citas)
-- ============================================================================
CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  client_id       uuid REFERENCES clients(id),
  kind            payment_kind   NOT NULL,
  method          payment_method NOT NULL,
  amount_cents    integer NOT NULL CHECK (amount_cents > 0),
  status          payment_status NOT NULL DEFAULT 'pending',
  external_ref    text,            -- stripe_payment_intent o referencia ATH Móvil
  paid_at         timestamptz,
  refunded_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pay_biz   ON payments(business_id, created_at DESC);
CREATE INDEX idx_pay_appt  ON payments(appointment_id);

-- ============================================================================
-- 11. SUSCRIPCIONES DE PLATAFORMA (tu revenue)
-- ============================================================================
CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  plan_code              plan_code NOT NULL DEFAULT 'free',
  cycle                  billing_cycle NOT NULL DEFAULT 'monthly',
  status                 subscription_status NOT NULL DEFAULT 'active',
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text UNIQUE,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  trial_ends_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_subs_upd BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Pagos de mensualidad/anualidad (Stripe via webhook; ATH anual = manual)
CREATE TABLE platform_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id),
  amount_cents    integer NOT NULL,
  discount_cents  integer NOT NULL DEFAULT 0,         -- referidos aplicados
  method          payment_method NOT NULL,
  status          payment_status NOT NULL DEFAULT 'pending',
  period_start    date,
  period_end      date,
  external_ref    text,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platpay_biz ON platform_payments(business_id, created_at DESC);

-- ============================================================================
-- 12. REFERIDOS ($5/mes por referido activo, acumulable)
-- ============================================================================
CREATE TABLE referrals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  referred_business_id uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  code_used            text NOT NULL,
  status               referral_status NOT NULL DEFAULT 'pending',
  activated_at         timestamptz,    -- primer pago real del referido
  deactivated_at       timestamptz,    -- el referido canceló / bajó a free
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_business_id <> referred_business_id)
);
CREATE INDEX idx_ref_referrer ON referrals(referrer_business_id) WHERE status = 'active';

-- Descuento vigente por negocio (el backend lo sincroniza como coupon en Stripe,
-- con tope = precio del plan; nadie cobra crédito de vuelta)
CREATE VIEW v_referral_discounts AS
SELECT referrer_business_id AS business_id,
       count(*)             AS active_referrals,
       count(*) * 500       AS discount_cents
FROM referrals
WHERE status = 'active'
GROUP BY referrer_business_id;

-- ============================================================================
-- 13. NOTIFICACIONES
-- ============================================================================
-- In-app (la campanita 🔔). Para dueños/staff (scope negocio) o clientes (scope user).
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid REFERENCES businesses(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id)      ON DELETE CASCADE,
  type         text NOT NULL,        -- new_appointment | cancellation | payment | waitlist | system
  title        text NOT NULL,
  body         text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {appointment_id…} para deep-link
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notif_target_chk CHECK (business_id IS NOT NULL OR user_id IS NOT NULL)
);
CREATE INDEX idx_notif_biz  ON notifications(business_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notif_user ON notifications(user_id, created_at DESC)     WHERE read_at IS NULL;

-- Log de TODO lo enviado por WhatsApp/Email (soporte + métrica "$0 en mensajería")
CREATE TABLE message_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,
  channel         msg_channel NOT NULL,
  recipient       text NOT NULL,                 -- phone o email
  template        text NOT NULL,                 -- confirm | reminder_24h | reminder_2h | waitlist_offer | campaign | receipt
  status          msg_status NOT NULL DEFAULT 'queued',
  provider_ref    text,                          -- id Evolution API / Resend
  error           text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_msg_biz  ON message_log(business_id, created_at DESC);
CREATE INDEX idx_msg_appt ON message_log(appointment_id);

-- ============================================================================
-- 14. LISTA DE ESPERA (Studio)
-- ============================================================================
CREATE TABLE waitlist (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id   uuid REFERENCES services(id),
  staff_id     uuid REFERENCES staff(id),        -- NULL = cualquiera
  date_from    date NOT NULL,
  date_to      date NOT NULL,
  status       waitlist_status NOT NULL DEFAULT 'waiting',
  offered_at   timestamptz,
  offer_expires_at timestamptz,                  -- la oferta vence (ej. 30 min)
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from)
);
CREATE INDEX idx_wait_biz ON waitlist(business_id, status, date_from);

-- ============================================================================
-- 15. RESEÑAS VERIFICADAS (solo quien tuvo cita completada)
-- ============================================================================
CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id        uuid REFERENCES staff(id) ON DELETE SET NULL,
  client_id       uuid NOT NULL REFERENCES clients(id),
  appointment_id  uuid NOT NULL UNIQUE REFERENCES appointments(id),  -- 1 reseña por cita
  rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         text,
  business_reply  text,
  replied_at      timestamptz,
  is_published    boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_rev_biz ON reviews(business_id, created_at DESC) WHERE is_published;

-- Mantiene rating_avg/rating_count del negocio al día
CREATE OR REPLACE FUNCTION refresh_business_rating() RETURNS trigger AS $$
DECLARE bid uuid;
BEGIN
  bid := COALESCE(NEW.business_id, OLD.business_id);
  UPDATE businesses b SET
    rating_avg   = COALESCE((SELECT round(avg(rating)::numeric,2) FROM reviews
                             WHERE business_id = bid AND is_published), 0),
    rating_count = (SELECT count(*) FROM reviews
                    WHERE business_id = bid AND is_published)
  WHERE b.id = bid;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_review_rating
  AFTER INSERT OR UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION refresh_business_rating();

-- ============================================================================
-- 16. CAMPAÑAS / BLASTS (Studio)
-- ============================================================================
CREATE TABLE campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          text NOT NULL,
  channel       msg_channel NOT NULL,
  message       text NOT NULL,
  segment       jsonb NOT NULL DEFAULT '{"type":"all"}'::jsonb, -- all | inactive_60d | top_clients
  status        campaign_status NOT NULL DEFAULT 'draft',
  scheduled_at  timestamptz,
  sent_count    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_camp_biz ON campaigns(business_id, created_at DESC);

-- ============================================================================
-- 17. LEGAL — términos y condiciones versionados + aceptación con evidencia
-- ============================================================================
CREATE TABLE legal_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type     legal_doc_type NOT NULL,
  version      text NOT NULL,             -- "1.0", "1.1"…
  locale       text NOT NULL DEFAULT 'es',
  content_md   text NOT NULL,             -- markdown render-eable
  published_at timestamptz,
  UNIQUE (doc_type, version, locale)
);

CREATE TABLE legal_acceptances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES legal_documents(id),
  user_id      uuid REFERENCES users(id),
  business_id  uuid REFERENCES businesses(id),
  ip           inet,
  user_agent   text,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_actor_chk CHECK (user_id IS NOT NULL OR business_id IS NOT NULL)
);
CREATE INDEX idx_legal_acc ON legal_acceptances(document_id);

-- ============================================================================
-- 18. AUDITORÍA DE PLATAFORMA
-- ============================================================================
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  business_id  uuid REFERENCES businesses(id),
  action       text NOT NULL,             -- login | appointment.create | service.update | refund…
  entity       text,
  entity_id    uuid,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_biz  ON audit_log(business_id, created_at DESC);
CREATE INDEX idx_audit_user ON audit_log(actor_user_id, created_at DESC);

-- ============================================================================
-- 19. SEEDS
-- ============================================================================

INSERT INTO plans (code, name, price_monthly_cents, price_annual_cents, max_staff, max_appts_month, features) VALUES
('free',   'Gratis', 0,    0,     1, 30,   '{"deposits":false,"waitlist":false,"campaigns":false,"featured":false,"reminders":["24h"]}'),
('pro',    'Pro',    1499, 14900, 1, NULL, '{"deposits":true, "waitlist":false,"campaigns":false,"featured":false,"reminders":["confirm","24h","2h"]}'),
('studio', 'Studio', 1999, 19900, 5, NULL, '{"deposits":true, "waitlist":true, "campaigns":true, "featured":true, "reminders":["confirm","24h","2h"]}');

INSERT INTO categories (name_es, name_en, slug, icon, sort_order) VALUES
('Barbería',          'Barbershop',      'barberia',      'scissors',   1),
('Salón de belleza',  'Hair salon',      'salon',         'sparkles',   2),
('Uñas',              'Nails',           'unas',          'nail',       3),
('Estética',          'Esthetics',       'estetica',      'face',       4),
('Pestañas y cejas',  'Lashes & brows',  'lashes',        'eye',        5),
('Spa y masajes',     'Spa & massage',   'spa',           'lotus',      6),
('Maquillaje',        'Makeup',          'maquillaje',    'brush',      7),
('Tatuajes',          'Tattoo',          'tattoo',        'pen',        8),
('Pet grooming',      'Pet grooming',    'pet-grooming',  'paw',        9),
('Bienestar y fitness','Wellness & fitness','bienestar',  'heart',      10);

INSERT INTO pr_municipalities (name, slug) VALUES
('Adjuntas','adjuntas'),('Aguada','aguada'),('Aguadilla','aguadilla'),
('Aguas Buenas','aguas-buenas'),('Aibonito','aibonito'),('Añasco','anasco'),
('Arecibo','arecibo'),('Arroyo','arroyo'),('Barceloneta','barceloneta'),
('Barranquitas','barranquitas'),('Bayamón','bayamon'),('Cabo Rojo','cabo-rojo'),
('Caguas','caguas'),('Camuy','camuy'),('Canóvanas','canovanas'),
('Carolina','carolina'),('Cataño','catano'),('Cayey','cayey'),
('Ceiba','ceiba'),('Ciales','ciales'),('Cidra','cidra'),
('Coamo','coamo'),('Comerío','comerio'),('Corozal','corozal'),
('Culebra','culebra'),('Dorado','dorado'),('Fajardo','fajardo'),
('Florida','florida'),('Guánica','guanica'),('Guayama','guayama'),
('Guayanilla','guayanilla'),('Guaynabo','guaynabo'),('Gurabo','gurabo'),
('Hatillo','hatillo'),('Hormigueros','hormigueros'),('Humacao','humacao'),
('Isabela','isabela'),('Jayuya','jayuya'),('Juana Díaz','juana-diaz'),
('Juncos','juncos'),('Lajas','lajas'),('Lares','lares'),
('Las Marías','las-marias'),('Las Piedras','las-piedras'),('Loíza','loiza'),
('Luquillo','luquillo'),('Manatí','manati'),('Maricao','maricao'),
('Maunabo','maunabo'),('Mayagüez','mayaguez'),('Moca','moca'),
('Morovis','morovis'),('Naguabo','naguabo'),('Naranjito','naranjito'),
('Orocovis','orocovis'),('Patillas','patillas'),('Peñuelas','penuelas'),
('Ponce','ponce'),('Quebradillas','quebradillas'),('Rincón','rincon'),
('Río Grande','rio-grande'),('Sabana Grande','sabana-grande'),('Salinas','salinas'),
('San Germán','san-german'),('San Juan','san-juan'),('San Lorenzo','san-lorenzo'),
('San Sebastián','san-sebastian'),('Santa Isabel','santa-isabel'),('Toa Alta','toa-alta'),
('Toa Baja','toa-baja'),('Trujillo Alto','trujillo-alto'),('Utuado','utuado'),
('Vega Alta','vega-alta'),('Vega Baja','vega-baja'),('Vieques','vieques'),
('Villalba','villalba'),('Yabucoa','yabucoa'),('Yauco','yauco');

-- ============================================================================
-- 20. PERMISOS PARA turnify_user (aislado de la DB wifnix)
-- ============================================================================
GRANT USAGE ON SCHEMA public TO turnify_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO turnify_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO turnify_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO turnify_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO turnify_user;

COMMIT;

-- ============================================================================
-- NOTAS DE IMPLEMENTACIÓN (backend)
-- ----------------------------------------------------------------------------
-- · Disponibilidad = business_hours ∩ staff_hours − time_blocks − appointments
--   (query, no tabla; el EXCLUDE garantiza integridad aunque haya carrera).
-- · Búsqueda:  WHERE b.is_published
--              AND (b.name % $q OR EXISTS (servicio % $q))
--              ORDER BY b.is_featured DESC, similarity DESC,
--                       earth_distance(ll_to_earth(b.lat,b.lng), ll_to_earth($lat,$lng))
-- · Referidos: al recibir webhook invoice.paid del referido → status 'active';
--              al cancelar/bajar a free → 'inactive'. Cron sincroniza coupon Stripe
--              del referrer con v_referral_discounts (tope = precio del plan).
-- · Citas free plan: contar appointments del mes vs plans.max_appts_month.
-- ============================================================================
