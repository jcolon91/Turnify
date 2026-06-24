-- ============================================================================
--  BUKEAME — Solicitudes de categoría (profesión) propuestas por los negocios
--  Idempotente. Correr: sudo -u postgres psql -d bukeame -f database/18-schema-category-requests.sql
-- ----------------------------------------------------------------------------
--  Un negocio puede proponer una categoría/profesión que aún no existe en el
--  catálogo. La solicitud queda 'pending' hasta que un admin de plataforma la
--  apruebe (inserta en categories) o la rechace. La revisa el panel de admin.
--
--  · business_id         : negocio que la propone. ON DELETE CASCADE — si se borra
--                          el negocio, se borran sus solicitudes.
--  · requested_by        : usuario que la pidió (dueño del negocio).
--  · name_es             : nombre en español de la profesión/categoría (requerido).
--  · name_en             : nombre en inglés (opcional; el endpoint usa name_es si falta).
--  · note                : nota opcional del negocio para el admin.
--  · status              : 'pending' (por defecto) | 'approved' | 'rejected'.
--  · created_at          : cuándo se creó la solicitud.
--  · reviewed_at         : cuándo la resolvió el admin (NULL mientras 'pending').
--  · reviewed_by         : admin que la resolvió (NULL mientras 'pending').
--  · created_category_id : id de la categoría creada al aprobar. OJO: categories.id
--                          es smallserial → aquí es smallint (NO uuid).
--
--  NOTA DE PERMISOS: se aplica como postgres (DDL). El GRANT a bukeame_user es a
--  nivel de tabla → cubre automáticamente todas las columnas. Estilo de 16-...sql.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS category_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid REFERENCES businesses(id) ON DELETE CASCADE,
  requested_by        uuid REFERENCES users(id),
  name_es             text NOT NULL,
  name_en             text,
  note                text,
  status              text NOT NULL DEFAULT 'pending',
  created_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_at         timestamptz,
  reviewed_by         uuid REFERENCES users(id),
  created_category_id smallint REFERENCES categories(id)
);

-- Listado del panel admin: pendientes primero / por estado.
CREATE INDEX IF NOT EXISTS idx_category_requests_status
  ON category_requests (status);

-- El rol de la app lee/inserta/actualiza/borra solicitudes.
-- El GRANT de tabla cubre todas las columnas; no hace falta re-grant por columna.
GRANT SELECT, INSERT, UPDATE, DELETE ON category_requests TO bukeame_user;

COMMIT;

-- ============================================================================
-- NOTAS
-- ----------------------------------------------------------------------------
-- · CREATE TABLE / CREATE INDEX IF NOT EXISTS → re-aplicable sin error.
-- · status es texto libre con valores convenidos 'pending'|'approved'|'rejected';
--   el control lo hace el backend (endpoints admin de aprobar/rechazar).
-- · Aprobar una solicitud = INSERT en categories (lo hace el endpoint admin),
--   y aquí sólo se marca status='approved' + reviewed_at + reviewed_by +
--   created_category_id (el id smallint de la categoría recién creada).
-- ============================================================================
