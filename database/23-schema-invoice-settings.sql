-- ============================================================================
--  Bukéame — Personalización de facturas/recibos del negocio (23). Idempotente.
--  invoice_settings jsonb: { brand_color, legal_name, address_line, footer_note, show_logo }.
--  Lo usa el recibo que le llega al CLIENTE del negocio (depósitos/órdenes).
--  Correr como postgres:
--    sudo -u postgres psql -d bukeame -f database/23-schema-invoice-settings.sql
-- ============================================================================
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS invoice_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
