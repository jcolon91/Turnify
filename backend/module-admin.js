// ============================================================================
//  TURNIFY · module-admin.js
//  Panel de administrador de plataforma (solo para el dueño: is_platform_admin)
//  Se monta sobre server.js compartiendo helpers. Endpoints:
//    GET /api/admin/overview     → métricas + listas para el tablero completo
//    GET /api/admin/businesses   → lista detallada de negocios (con dueño y plan)
//    GET /api/admin/billing      → quién está por vencer trial / por cobrar
//  Todas las rutas exigen un usuario con is_platform_admin = true.
// ============================================================================

function mount(app, { db, authRequired, h }) {
  const { asyncH, bad } = h;

  // ── Middleware: exige que el usuario sea admin de plataforma ──────────────
  const adminRequired = asyncH(async (req, res, next) => {
    if (!req.user || !req.user.is_platform_admin) {
      return bad(res, 'Acceso restringido al administrador', 403);
    }
    next();
  });

  // ── GET /api/admin/overview ───────────────────────────────────────────────
  // El tablero completo en una sola llamada: tarjetas de métricas + listas.
  app.get('/api/admin/overview', authRequired, adminRequired, asyncH(async (_req, res) => {
    // Las consultas corren en paralelo para que el tablero cargue rápido.
    const [
      negocios, usuarios, citas, suscripciones,
      ultimosNegocios, porVencer, citasRecientes,
    ] = await Promise.all([
      // Conteo de negocios (totales y por estado de suscripción)
      db.query(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE s.status = 'active')::int   AS activos,
          count(*) FILTER (WHERE s.status = 'trialing')::int AS en_trial,
          count(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelados,
          count(*) FILTER (WHERE s.status = 'past_due')::int AS morosos
        FROM businesses b
        LEFT JOIN subscriptions s ON s.business_id = b.id
        WHERE b.deleted_at IS NULL
      `),
      // Total de usuarios
      db.query(`SELECT count(*)::int AS total FROM users WHERE deleted_at IS NULL`),
      // Total de citas (y las de los últimos 30 días)
      db.query(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE starts_at >= now() - interval '30 days')::int AS ultimos_30d,
          count(*) FILTER (WHERE starts_at >= now())::int AS proximas
        FROM appointments
      `),
      // Desglose por plan
      db.query(`
        SELECT s.plan_code, count(*)::int AS n
        FROM subscriptions s
        JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
        GROUP BY s.plan_code
        ORDER BY n DESC
      `),
      // Últimos 10 negocios registrados
      db.query(`
        SELECT b.id, b.name, b.slug, b.created_at,
               u.full_name AS owner_name, u.email AS owner_email,
               s.plan_code, s.status, s.trial_ends_at
        FROM businesses b
        JOIN users u ON u.id = b.owner_user_id
        LEFT JOIN subscriptions s ON s.business_id = b.id
        WHERE b.deleted_at IS NULL
        ORDER BY b.created_at DESC
        LIMIT 10
      `),
      // Trials que vencen en los próximos 7 días (para cobrar a tiempo)
      db.query(`
        SELECT b.id, b.name, u.full_name AS owner_name, u.email AS owner_email,
               b.whatsapp, s.plan_code, s.trial_ends_at,
               EXTRACT(DAY FROM (s.trial_ends_at - now()))::int AS dias_restantes
        FROM subscriptions s
        JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
        JOIN users u ON u.id = b.owner_user_id
        WHERE s.status = 'trialing'
          AND s.trial_ends_at IS NOT NULL
          AND s.trial_ends_at BETWEEN now() AND now() + interval '7 days'
        ORDER BY s.trial_ends_at ASC
      `),
      // Últimas 10 citas en toda la plataforma
      db.query(`
        SELECT a.id, a.starts_at, a.status,
               b.name AS negocio, c.full_name AS cliente
        FROM appointments a
        JOIN businesses b ON b.id = a.business_id AND b.deleted_at IS NULL
        LEFT JOIN clients c ON c.id = a.client_id
        ORDER BY a.created_at DESC
        LIMIT 10
      `),
    ]);

    res.json({
      metricas: {
        negocios: negocios.rows[0],
        usuarios: usuarios.rows[0].total,
        citas: citas.rows[0],
        por_plan: suscripciones.rows,
      },
      ultimos_negocios: ultimosNegocios.rows,
      por_vencer: porVencer.rows,
      citas_recientes: citasRecientes.rows,
    });
  }));

  // ── GET /api/admin/businesses ─────────────────────────────────────────────
  // Lista completa de negocios con su dueño, plan y actividad.
  app.get('/api/admin/businesses', authRequired, adminRequired, asyncH(async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const { rows } = await db.query(`
      SELECT b.id, b.name, b.slug, b.phone, b.whatsapp, b.created_at,
             u.full_name AS owner_name, u.email AS owner_email,
             s.plan_code, s.status, s.trial_ends_at, s.current_period_end,
             m.name AS municipio,
             (SELECT count(*)::int FROM appointments a WHERE a.business_id = b.id) AS total_citas,
             (SELECT count(*)::int FROM staff st WHERE st.business_id = b.id AND st.deleted_at IS NULL) AS total_staff
      FROM businesses b
      JOIN users u ON u.id = b.owner_user_id
      LEFT JOIN subscriptions s ON s.business_id = b.id
      LEFT JOIN pr_municipalities m ON m.id = b.municipality_id
      WHERE b.deleted_at IS NULL
      ORDER BY b.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json({ businesses: rows, limit, offset });
  }));

  // ── GET /api/admin/billing ────────────────────────────────────────────────
  // Foco en cobros: trials por vencer + suscripciones por renovar + morosos.
  app.get('/api/admin/billing', authRequired, adminRequired, asyncH(async (_req, res) => {
    const [trials, porRenovar, morosos] = await Promise.all([
      db.query(`
        SELECT b.id, b.name, u.full_name AS owner_name, u.email AS owner_email,
               b.whatsapp, s.plan_code, s.trial_ends_at,
               EXTRACT(DAY FROM (s.trial_ends_at - now()))::int AS dias_restantes
        FROM subscriptions s
        JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
        JOIN users u ON u.id = b.owner_user_id
        WHERE s.status = 'trialing' AND s.trial_ends_at IS NOT NULL
        ORDER BY s.trial_ends_at ASC
      `),
      db.query(`
        SELECT b.id, b.name, u.full_name AS owner_name, u.email AS owner_email,
               b.whatsapp, s.plan_code, s.current_period_end,
               EXTRACT(DAY FROM (s.current_period_end - now()))::int AS dias_restantes
        FROM subscriptions s
        JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
        JOIN users u ON u.id = b.owner_user_id
        WHERE s.status = 'active' AND s.current_period_end IS NOT NULL
          AND s.current_period_end BETWEEN now() AND now() + interval '7 days'
        ORDER BY s.current_period_end ASC
      `),
      db.query(`
        SELECT b.id, b.name, u.full_name AS owner_name, u.email AS owner_email,
               b.whatsapp, s.plan_code, s.current_period_end
        FROM subscriptions s
        JOIN businesses b ON b.id = s.business_id AND b.deleted_at IS NULL
        JOIN users u ON u.id = b.owner_user_id
        WHERE s.status = 'past_due'
        ORDER BY s.current_period_end ASC NULLS LAST
      `),
    ]);

    res.json({
      trials_por_vencer: trials.rows,
      por_renovar: porRenovar.rows,
      morosos: morosos.rows,
    });
  }));
  // ── GET /api/admin/referrals ──────────────────────────────────────────────
  // Lista de referidos: pendientes (registrados, aún no pagan) y activos.
  app.get('/api/admin/referrals', authRequired, adminRequired, asyncH(async (_req, res) => {
    const { rows } = await db.query(`
      SELECT r.id, r.status, r.code_used, r.created_at, r.activated_at,
             rb.name  AS referido_nombre,
             rb.id    AS referido_id,
             ru.email AS referido_email,
             pb.name  AS refiere_nombre,
             pb.id    AS refiere_id,
             pu.email AS refiere_email,
             rs.status AS referido_sub_status,
             rs.plan_code AS referido_plan
      FROM referrals r
      JOIN businesses rb ON rb.id = r.referred_business_id
      JOIN users ru ON ru.id = rb.owner_user_id
      JOIN businesses pb ON pb.id = r.referrer_business_id
      JOIN users pu ON pu.id = pb.owner_user_id
      LEFT JOIN subscriptions rs ON rs.business_id = rb.id
      ORDER BY
        CASE r.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
        r.created_at DESC
    `);

    // Resumen de descuentos vigentes por negocio que refiere
    const descuentos = await db.query(`
      SELECT pb.name AS negocio, vd.active_referrals, vd.discount_cents
      FROM v_referral_discounts vd
      JOIN businesses pb ON pb.id = vd.business_id
      ORDER BY vd.discount_cents DESC
    `);

    res.json({
      referrals: rows,
      descuentos_vigentes: descuentos.rows,
    });
  }));

  // ── POST /api/admin/referrals/:id/activate ────────────────────────────────
  // Marca un referido como ACTIVO (cuando el referido pagó su primer mes).
  // Esto activa el crédito de $5/mes del que refirió (vía v_referral_discounts).
  // Hoy se usa manualmente al cobrar; en el futuro Stripe lo llamará solo.
  app.post('/api/admin/referrals/:id/activate', authRequired, adminRequired, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE referrals
          SET status = 'active', activated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, referrer_business_id, referred_business_id`,
      [req.params.id]);
    if (!rows[0]) return bad(res, 'Referido no encontrado o ya estaba activo', 404);
    res.json({ ok: true, referral: rows[0] });
  }));

  // ── POST /api/admin/referrals/:id/deactivate ──────────────────────────────
  // Desactiva un referido (si el referido canceló o bajó a free).
  // Esto remueve el crédito del que refirió.
  app.post('/api/admin/referrals/:id/deactivate', authRequired, adminRequired, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE referrals
          SET status = 'inactive', deactivated_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING id`,
      [req.params.id]);
    if (!rows[0]) return bad(res, 'Referido no encontrado o no estaba activo', 404);
    res.json({ ok: true });
  }));
}

module.exports = { mount };
