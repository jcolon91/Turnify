-- Columnas de control para los nuevos recordatorios (2 días y 1 hora)
-- La de 24h (reminder_24h_sent_at) ya existe; la de 2h queda sin uso pero no estorba.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_48h_sent_at timestamptz;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_1h_sent_at  timestamptz;
