// ============================================================================
//  BUKEAME API — módulo: PROMOCIÓN / ADS
//  Campañas de pago-por-impresión/clic de los negocios (núcleo del sistema).
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base, igual que los otros módulos:
//    require('./module-ads').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
//
//  Reusa los helpers del server base (no los redefine):
//    asyncH, bad, isUuid, audit, publicLimiter
//
//  CICLO DE VIDA de una campaña (status):
//    'paused'   → recién creada / sin presupuesto activo. No se muestra ni gasta.
//    'active'   → con presupuesto disponible (spent < budget). Aparece como
//                 promocionada y cuenta impresiones/clics (que gastan del budget).
//    'depleted' → se agotó el presupuesto (spent >= budget). Deja de mostrarse.
//
//  SEGURIDAD (dinero/gasto): el gasto (spent_cents) lo calcula SIEMPRE el
//  servidor sumando el costo por impresión/clic desde la PROPIA fila de la
//  campaña; nunca se confía en montos del cliente. Sólo cuentan eventos de
//  campañas 'active'. Las rutas del negocio validan que la campaña sea suya.
// ============================================================================

// ── Helpers de datos (también exportados para server.js / module-platform-billing) ──

// getActivePromoted(db, limit): campañas 'active' con presupuesto disponible,
// unidas a su negocio (sólo publicados). Para inyectar como promocionados en el
// buscador. Devuelve campaign_id + datos del negocio.
async function getActivePromoted(db, limit) {
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
  const { rows } = await db.query(
    `SELECT c.id            AS campaign_id,
            b.id            AS business_id,
            b.slug,
            b.name,
            b.logo_url,
            b.municipality_id,
            b.rating_avg,
            b.rating_count
       FROM ad_campaigns c
       JOIN businesses b ON b.id = c.business_id
      WHERE c.status = 'active'
        AND c.spent_cents < c.budget_cents
        AND b.is_published = true
        AND b.deleted_at IS NULL
      ORDER BY c.created_at DESC
      LIMIT $1`, [lim]);
  return rows;
}

// recordConversion(db, campaignId, refId): registra una conversión (p.ej. una
// cita atribuida a la campaña). No gasta presupuesto (las conversiones no cobran).
async function recordConversion(db, campaignId, refId) {
  const { rows } = await db.query(
    `INSERT INTO ad_events (campaign_id, type, ref_id)
     VALUES ($1, 'conversion', $2)
     RETURNING id`, [campaignId, refId || null]);
  return rows[0];
}

// creditBudget(db, campaignId, amountCents): acredita presupuesto a la campaña
// (lo llama el flujo de cobro de plataforma al confirmar el pago). Si estaba
// 'paused', la activa; si ya estaba 'active'/'depleted' conserva/recalcula su
// estado el backend al gastar. Devuelve la fila actualizada.
async function creditBudget(db, campaignId, amountCents) {
  const { rows } = await db.query(
    `UPDATE ad_campaigns
        SET budget_cents = budget_cents + $2,
            status = CASE WHEN status = 'paused' THEN 'active' ELSE status END
      WHERE id = $1
      RETURNING id, business_id, budget_cents, spent_cents, status,
                cost_per_impression_cents, cost_per_click_cents`,
    [campaignId, amountCents]);
  return rows[0];
}

function mount(app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isUuid, audit, publicLimiter } = h;

  // Limitador suave para las rutas públicas (impresión/clic): si el server base
  // lo provee, se usa; si no, middleware no-op para no romper el montaje.
  const pubLimit = typeof publicLimiter === 'function' ? publicLimiter : (_req, _res, next) => next();

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/ads — campañas del negocio con sus métricas (impresiones/clics/conv.)
  //   → { campaigns: [{ id, budget_cents, spent_cents, status,
  //       cost_per_impression_cents, cost_per_click_cents,
  //       impressions, clicks, conversions, ctr }] }
  //   Las métricas son COUNT por type en ad_events; ctr = clicks / impressions.
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/ads', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.id, c.budget_cents, c.spent_cents, c.status,
              c.cost_per_impression_cents, c.cost_per_click_cents,
              COUNT(*) FILTER (WHERE e.type = 'impression')::int AS impressions,
              COUNT(*) FILTER (WHERE e.type = 'click')::int      AS clicks,
              COUNT(*) FILTER (WHERE e.type = 'conversion')::int AS conversions
         FROM ad_campaigns c
         LEFT JOIN ad_events e ON e.campaign_id = c.id
        WHERE c.business_id = $1
        GROUP BY c.id
        ORDER BY c.created_at DESC`, [req.business.id]);

    const campaigns = rows.map(r => ({
      id: r.id,
      budget_cents: r.budget_cents,
      spent_cents: r.spent_cents,
      status: r.status,
      cost_per_impression_cents: r.cost_per_impression_cents,
      cost_per_click_cents: r.cost_per_click_cents,
      impressions: r.impressions,
      clicks: r.clicks,
      conversions: r.conversions,
      ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    }));

    res.json({ campaigns });
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/ads — crea una campaña para el negocio (paused, sin presupuesto)
  //   → { campaign }
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/ads', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `INSERT INTO ad_campaigns (business_id, status, budget_cents)
       VALUES ($1, 'paused', 0)
       RETURNING id, budget_cents, spent_cents, status,
                 cost_per_impression_cents, cost_per_click_cents, created_at`,
      [req.business.id]);
    const campaign = rows[0];
    await audit(req, 'ads.create', 'ad_campaign', campaign.id, {});
    res.json({ campaign });
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/ads/:id/pause — pausa una campaña del negocio
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/ads/:id/pause', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { rows } = await db.query(
      `UPDATE ad_campaigns
          SET status = 'paused'
        WHERE id = $1 AND business_id = $2
        RETURNING id, budget_cents, spent_cents, status,
                  cost_per_impression_cents, cost_per_click_cents`,
      [req.params.id, req.business.id]);
    if (!rows[0]) return bad(res, 'Campaña no encontrada', 404);
    await audit(req, 'ads.pause', 'ad_campaign', rows[0].id, {});
    res.json({ campaign: rows[0] });
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/ads/:id/resume — reactiva una campaña del negocio
  //   Sólo si tiene presupuesto disponible (budget > spent); si no, 400.
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/ads/:id/resume', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');

    // La campaña debe ser del negocio.
    const cur = await db.query(
      `SELECT id, budget_cents, spent_cents FROM ad_campaigns
        WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
    if (!cur.rows[0]) return bad(res, 'Campaña no encontrada', 404);

    // Resume sólo si queda presupuesto.
    if (cur.rows[0].budget_cents <= cur.rows[0].spent_cents)
      return bad(res, 'No queda presupuesto. Acredita presupuesto antes de reactivar.');

    const { rows } = await db.query(
      `UPDATE ad_campaigns
          SET status = 'active'
        WHERE id = $1 AND business_id = $2
        RETURNING id, budget_cents, spent_cents, status,
                  cost_per_impression_cents, cost_per_click_cents`,
      [req.params.id, req.business.id]);
    await audit(req, 'ads.resume', 'ad_campaign', rows[0].id, {});
    res.json({ campaign: rows[0] });
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /api/ads/:id — borra una campaña del negocio (y sus eventos)
  //   Valida pertenencia. Borra ad_events (por ON DELETE CASCADE o explícito)
  //   y la propia campaña. → { ok: true }
  // ──────────────────────────────────────────────────────────────────────────
  app.delete('/api/ads/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // La campaña debe ser del negocio (bloquea la fila durante el borrado).
      const cur = await client.query(
        `SELECT id FROM ad_campaigns
          WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [req.params.id, req.business.id]);
      if (!cur.rows[0]) {
        await client.query('ROLLBACK');
        return bad(res, 'Campaña no encontrada', 404);
      }

      // Borra eventos explícitamente (por si el FK no es ON DELETE CASCADE) y la campaña.
      await client.query(`DELETE FROM ad_events WHERE campaign_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM ad_campaigns WHERE id = $1 AND business_id = $2`,
        [req.params.id, req.business.id]);

      await client.query('COMMIT');
      await audit(req, 'ads.delete', 'ad_campaign', req.params.id, {});
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/public/ads/:id/impression — registra una impresión (SIN auth)
  //   Sólo cuenta si la campaña está 'active'. Inserta ad_event 'impression' y
  //   gasta cost_per_impression_cents del presupuesto; si se agota → 'depleted'.
  //   → { ok: true }
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/public/ads/:id/impression', pubLimit, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Bloquea la fila para que el gasto sea consistente (sólo si está 'active').
      const cur = await client.query(
        `SELECT id, budget_cents, spent_cents, cost_per_impression_cents
           FROM ad_campaigns
          WHERE id = $1 AND status = 'active'
          FOR UPDATE`, [req.params.id]);

      if (!cur.rows[0]) {
        await client.query('ROLLBACK');
        // No es 'active' (o no existe): no se cuenta, pero respondemos ok para
        // no filtrar estado a clientes anónimos.
        return res.json({ ok: true });
      }

      await client.query(
        `INSERT INTO ad_events (campaign_id, type) VALUES ($1, 'impression')`,
        [req.params.id]);

      await client.query(
        `UPDATE ad_campaigns
            SET spent_cents = spent_cents + cost_per_impression_cents,
                status = CASE WHEN spent_cents + cost_per_impression_cents >= budget_cents
                              THEN 'depleted' ELSE status END
          WHERE id = $1`, [req.params.id]);

      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/public/ads/:id/click — registra un clic (SIN auth)
  //   Sólo cuenta si la campaña está 'active'. Inserta ad_event 'click' y gasta
  //   cost_per_click_cents; si se agota → 'depleted'. Devuelve el slug del
  //   negocio de la campaña para que el front redirija.
  //   → { slug }
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/public/ads/:id/click', pubLimit, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Trae también el slug del negocio (para la redirección del front).
      const cur = await client.query(
        `SELECT c.id, c.status, c.budget_cents, c.spent_cents, c.cost_per_click_cents,
                b.slug
           FROM ad_campaigns c
           JOIN businesses b ON b.id = c.business_id
          WHERE c.id = $1
          FOR UPDATE OF c`, [req.params.id]);

      if (!cur.rows[0]) {
        await client.query('ROLLBACK');
        return bad(res, 'Campaña no encontrada', 404);
      }

      const row = cur.rows[0];

      // Sólo cuenta/gasta si está 'active'; si no, devolvemos el slug sin cobrar.
      if (row.status === 'active') {
        await client.query(
          `INSERT INTO ad_events (campaign_id, type) VALUES ($1, 'click')`,
          [req.params.id]);
        await client.query(
          `UPDATE ad_campaigns
              SET spent_cents = spent_cents + cost_per_click_cents,
                  status = CASE WHEN spent_cents + cost_per_click_cents >= budget_cents
                                THEN 'depleted' ELSE status END
            WHERE id = $1`, [req.params.id]);
      }

      await client.query('COMMIT');
      res.json({ slug: row.slug });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  console.log('  ✓ módulo ads montado');
}

module.exports = { mount, getActivePromoted, recordConversion, creditBudget };
