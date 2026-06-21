// ============================================================================
//  BUKEAME · module-admin.js
//  Panel de administrador de plataforma (solo para el dueño: is_platform_admin)
//  Se monta sobre server.js compartiendo helpers. Endpoints:
//    GET /api/admin/overview     → métricas + listas para el tablero completo
//    GET /api/admin/businesses   → lista detallada de negocios (con dueño y plan)
//    GET /api/admin/billing      → quién está por vencer trial / por cobrar
//  Todas las rutas exigen un usuario con is_platform_admin = true.
// ============================================================================

function mount(app, { db, authRequired, h }) {
  const { asyncH, bad, audit, isUuid, notify } = h;

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

  // ── POST /api/admin/businesses/:id/plan ───────────────────────────────────
  // Cambia el plan de un negocio MANUALMENTE (antes de tener Stripe).
  // Útil para: activar Pro/Studio a quien paga por ATH, dar upgrade de prueba,
  // o corregir un plan. Body: { plan_code, months? }
  //   plan_code: 'free' | 'pro' | 'studio' | 'team' | 'grande' | 'ilimitado'
  //   months: cuántos meses dura (default 1). Si es 'free', se ignora.
  const VALID_PLANS = ['free', 'pro', 'studio', 'team', 'grande', 'ilimitado'];
  app.post('/api/admin/businesses/:id/plan', authRequired, adminRequired, asyncH(async (req, res) => {
    const planCode = String(req.body?.plan_code || '').trim().toLowerCase();
    const months = Number.isInteger(req.body?.months) ? req.body.months : 1;
    if (!VALID_PLANS.includes(planCode)) return bad(res, 'Plan inválido. Usa: ' + VALID_PLANS.join(', '));
    if (months < 1 || months > 24) return bad(res, 'Meses debe estar entre 1 y 24');

    // Verificar que el negocio existe
    const biz = await db.query('SELECT id, name FROM businesses WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (!biz.rows[0]) return bad(res, 'Negocio no encontrado', 404);

    let rows;
    if (planCode === 'free') {
      // Bajar a free: sin fecha de vencimiento, status active
      ({ rows } = await db.query(
        `UPDATE subscriptions
            SET plan_code = 'free', status = 'active',
                current_period_start = now(), current_period_end = NULL,
                cancel_at_period_end = false, trial_ends_at = NULL
          WHERE business_id = $1
          RETURNING plan_code, status, current_period_end`,
        [req.params.id]));
    } else {
      // Subir a plan premium: vence en N meses
      ({ rows } = await db.query(
        `UPDATE subscriptions
            SET plan_code = $2::plan_code, status = 'active',
                current_period_start = now(),
                current_period_end = now() + ($3 || ' months')::interval,
                cancel_at_period_end = false, trial_ends_at = NULL
          WHERE business_id = $1
          RETURNING plan_code, status, current_period_end`,
        [req.params.id, planCode, String(months)]));
    }
    if (!rows[0]) return bad(res, 'El negocio no tiene suscripción registrada', 404);
    await audit(req, 'admin.plan.change', 'business', req.params.id, { plan_code: planCode, months });
    res.json({ ok: true, business: biz.rows[0].name, subscription: rows[0] });
  }));

  // ── DELETE /api/admin/businesses/:id ──────────────────────────────────────
  // Borra la cuenta de un negocio (SOFT-delete: marca deleted_at + lo despublica).
  // Reversible a nivel de datos (no hard delete); lo saca del marketplace, del
  // panel del dueño y de todo el producto. Acción sensible → admin + audit.
  app.delete('/api/admin/businesses/:id', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { rows } = await db.query(
      `UPDATE businesses SET deleted_at = now(), is_published = false
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING name`, [req.params.id]);
    if (!rows[0]) return bad(res, 'Negocio no encontrado o ya borrado', 404);
    await audit(req, 'admin.business.delete', 'business', req.params.id, { name: rows[0].name });
    res.json({ ok: true, business: rows[0].name });
  }));

  // ── POST /api/admin/businesses/:id/addons ─────────────────────────────────
  // Conceder o revocar un add-on a un negocio TRAS confirmar el pago manual.
  // Body: { code, action: 'grant' | 'revoke' }   (cierra el bypass de monetización)
  app.post('/api/admin/businesses/:id/addons', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const code = String(req.body?.code || '').trim();
    const action = req.body?.action === 'revoke' ? 'revoke' : 'grant';
    const cat = await db.query(`SELECT name, price_cents FROM addon_catalog WHERE code = $1`, [code]);
    if (!cat.rows[0]) return bad(res, 'Add-on no existe', 404);
    const biz = await db.query(`SELECT id FROM businesses WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!biz.rows[0]) return bad(res, 'Negocio no encontrado', 404);

    let rows;
    if (action === 'revoke') {
      ({ rows } = await db.query(
        `UPDATE addons SET status = 'cancelled', cancelled_at = now()
          WHERE business_id = $1 AND code = $2 RETURNING code, status`,
        [req.params.id, code]));
    } else {
      ({ rows } = await db.query(
        `INSERT INTO addons (business_id, code, price_cents)
         VALUES ($1,$2,$3)
         ON CONFLICT (business_id, code)
         DO UPDATE SET status = 'active', cancelled_at = NULL, price_cents = $3, activated_at = now()
         RETURNING code, status, price_cents`,
        [req.params.id, code, cat.rows[0].price_cents]));
      await notify(req.params.id, 'system', 'Add-on activado',
        `"${cat.rows[0].name}" ya está activo en tu cuenta. ¡Gracias!`, { code });
    }
    await audit(req, 'admin.addon.' + action, 'addon', req.params.id, { code });
    res.json({ ok: true, action, addon: rows[0] || { code, status: 'cancelled' } });
  }));

  // ── POST /api/admin/businesses/:id/featured ───────────────────────────────
  // Conceder destacado por N semanas TRAS confirmar el pago.
  // Body: { weeks, municipality_id?, category_id? }
  app.post('/api/admin/businesses/:id/featured', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const weeks = Number.isInteger(req.body?.weeks) ? req.body.weeks : 0;
    if (weeks < 1 || weeks > 52) return bad(res, 'Semanas entre 1 y 52');
    const biz = await db.query(
      `SELECT id, municipality_id FROM businesses WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!biz.rows[0]) return bad(res, 'Negocio no encontrado', 404);

    const muni = Number.isInteger(req.body?.municipality_id) ? req.body.municipality_id : biz.rows[0].municipality_id;
    let catId = Number.isInteger(req.body?.category_id) ? req.body.category_id : null;
    if (catId === null) {
      const c = await db.query(
        `SELECT category_id FROM business_categories WHERE business_id = $1 ORDER BY category_id LIMIT 1`,
        [req.params.id]);
      catId = c.rows[0]?.category_id || null;
    }
    const { rows } = await db.query(
      `INSERT INTO featured_listings (business_id, municipality_id, category_id, ends_at)
       VALUES ($1, $2, $3, now() + ($4 || ' weeks')::interval) RETURNING id, ends_at`,
      [req.params.id, muni, catId, String(weeks)]);
    await db.query(`UPDATE businesses SET is_featured = true WHERE id = $1`, [req.params.id]);
    await notify(req.params.id, 'system', 'Destacado activado',
      `Tu negocio aparece primero por ${weeks} semana(s). ¡Gracias!`, { weeks });
    await audit(req, 'admin.featured.grant', 'featured', rows[0].id, { weeks });
    res.json({ ok: true, featured: rows[0] });
  }));
}

module.exports = { mount };
