-- ============================================================================
--  BUKEAME — Migración: gift cards nacen 'pending' (cierra bypass de monetización)
--  Idempotente. Correr: sudo -u postgres psql -d turnify -f database/09-schema-giftcard-pending.sql
-- ----------------------------------------------------------------------------
--  Antes: la tarjeta se creaba 'active' (DEFAULT) y era gastable AL INSTANTE sin
--  pago confirmado → cualquiera podía acuñar y gastar gift cards gratis.
--  Ahora: nace 'pending' (no gastable). El negocio la activa al confirmar el pago
--  (POST /api/gift-cards/:code/confirm), espejando el flujo de add-ons.
--
--  IMPORTANTE: corre esta migración ANTES de desplegar el código nuevo. El INSERT
--  pasa a usar el valor 'pending'; si el ENUM aún no lo tiene, la compra falla
--  CERRADA (no acuña tarjeta gastable), pero conviene migrar primero.
-- ============================================================================

-- 1) Añadir el valor al ENUM. ADD VALUE debe confirmarse antes de usarse, por eso
--    va fuera de un bloque BEGIN/COMMIT (autocommit). IF NOT EXISTS = idempotente.
ALTER TYPE giftcard_status ADD VALUE IF NOT EXISTS 'pending';

BEGIN;

-- 2) Fail-closed: las tarjetas nuevas nacen 'pending' aunque el código olvide fijarlo.
ALTER TABLE gift_cards ALTER COLUMN status SET DEFAULT 'pending';

-- 3) Índice útil: filtrar/contar gift cards por negocio y estado (multi-tenant:
--    las queries siempre acotan por business_id; complementa idx_gift_biz parcial).
CREATE INDEX IF NOT EXISTS idx_giftcards_biz_status ON gift_cards(business_id, status);

-- Permisos para turnify_user sobre lo que tocamos
GRANT SELECT, INSERT, UPDATE, DELETE ON gift_cards TO turnify_user;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · No tocamos las tarjetas YA existentes: las que estaban 'active' siguen activas.
--   Esta migración sólo cambia el DEFAULT para las que se creen de aquí en adelante.
-- · Redención (POST /api/public/:slug/orders) y los totales outstanding/sold ya
--   filtran por status IN ('active','partial'), así que 'pending' queda excluido
--   automáticamente: no se puede gastar ni cuenta como vendida hasta confirmarse.
-- · gift_cards.payment_id se rellena al confirmar el pago (vínculo de auditoría).
-- ============================================================================
