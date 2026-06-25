-- ============================================================================
--  Bukéame — Marca de validación manual del depósito (24). Idempotente.
--  manual_validate = el cliente eligió un método MANUAL (efectivo o ATH Móvil
--  al número) que el NEGOCIO valida y acepta. Estos depósitos NO los expira el
--  worker de reservas (el profesional puede validar más tarde, hasta la cita).
--  Los AUTOMÁTICOS (ATH Móvil automático) quedan en false: si no se pagan en
--  ~30 min, el worker cancela la reserva y libera el turno. La tarjeta (Stripe)
--  se marca method='card' al lanzar el checkout y tampoco la expira el worker.
--  NO usa ALTER TYPE (sin problema de orden/transacción). El GRANT de la tabla
--  payments a bukeame_user ya cubre la columna nueva.
--  Correr como postgres:
--    sudo -u postgres psql -d bukeame -f database/24-schema-deposit-manual-validate.sql
-- ============================================================================
ALTER TABLE payments ADD COLUMN IF NOT EXISTS manual_validate boolean NOT NULL DEFAULT false;

-- Grandfather (una vez): las reservas pendientes que YA existían se marcan como
-- manuales para que el NUEVO worker de expiración no las cancele (antes de este
-- deploy no había expiración, así que toda reserva pendiente la gestionaba el
-- negocio). Las reservas nuevas nacen en false y sí siguen la regla de expiración.
UPDATE payments SET manual_validate = true WHERE kind = 'deposit' AND status = 'pending';
