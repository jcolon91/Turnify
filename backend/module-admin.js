// ============================================================================
//  BUKEAME · module-admin.js
//  Panel de administrador de plataforma (solo para el dueño: is_platform_admin)
//  Se monta sobre server.js compartiendo helpers. Endpoints:
//    GET /api/admin/overview     → métricas + listas para el tablero completo
//    GET /api/admin/businesses   → lista detallada de negocios (con dueño y plan)
//    GET /api/admin/billing      → quién está por vencer trial / por cobrar
//    GET /api/admin/businesses/:id/analytics → ganancias del negocio (admin)
//    GET /api/admin/category-requests        → solicitudes de profesión/categoría
//    POST .../category-requests/:id/approve  → aprueba + crea categoría
//    POST .../category-requests/:id/reject   → rechaza la solicitud
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
        `INSERT INTO addons (business_id, code, price_cents, current_period_end)
         VALUES ($1,$2,$3, now() + interval '30 days')
         ON CONFLICT (business_id, code)
         DO UPDATE SET status = 'active', cancelled_at = NULL, cancel_at_period_end = false,
                       price_cents = $3, activated_at = now(),
                       current_period_end = GREATEST(addons.current_period_end, now()) + interval '30 days'
         RETURNING code, status, price_cents`,
        [req.params.id, code, cat.rows[0].price_cents]));
      await notify(req.params.id, 'system', 'Add-on activado',
        `"${cat.rows[0].name}" ya está activo en tu cuenta. ¡Gracias!`, { code });
    }
    await audit(req, 'admin.addon.' + action, 'addon', req.params.id, { code });
    res.json({ ok: true, action, addon: rows[0] || { code, status: 'cancelled' } });
  }));

  // ── GET /api/admin/addon-catalog ──────────────────────────────────────────
  // Catálogo de add-ons para el modal "Gestionar". Devuelve TODAS las filas del
  // catálogo y, si se pasa ?business_id=, los códigos de add-ons ACTIVOS de ese
  // negocio (para que el modal marque cuáles ya están activados y muestre
  // "Revocar" en lugar de "Activar"). El POST .../addons sigue activando/revocando.
  //   → { addons: [{ code, name, price_cents, description }], activos: [code, …] }
  app.get('/api/admin/addon-catalog', authRequired, adminRequired, asyncH(async (req, res) => {
    const cat = await db.query(
      `SELECT code, name, price_cents, description
         FROM addon_catalog
        ORDER BY price_cents ASC, name ASC`);

    let activos = [];
    const businessId = req.query.business_id;
    if (businessId) {
      if (!isUuid(businessId)) return bad(res, 'business_id inválido');
      const act = await db.query(
        `SELECT code FROM addons WHERE business_id = $1 AND status = 'active'`,
        [businessId]);
      activos = act.rows.map(r => r.code);
    }
    res.json({ addons: cat.rows, activos });
  }));

  // ── POST /api/admin/businesses/:id/featured ───────────────────────────────
  // Conceder destacado por N semanas TRAS confirmar el pago.
  // Body: { weeks, municipality_id?, category_id? }
  // Des-destacar: { weeks: 0 } ó { unfeature: true } → expira destacados vigentes
  // y pone businesses.is_featured = false.
  app.post('/api/admin/businesses/:id/featured', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const weeks = Number.isInteger(req.body?.weeks) ? req.body.weeks : 0;
    const unfeature = req.body?.unfeature === true || weeks === 0;
    if (!unfeature && (weeks < 1 || weeks > 52)) return bad(res, 'Semanas entre 1 y 52');
    const biz = await db.query(
      `SELECT id, municipality_id FROM businesses WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!biz.rows[0]) return bad(res, 'Negocio no encontrado', 404);

    // Des-destacar: expira los listings vigentes y baja la bandera.
    if (unfeature) {
      const upd = await db.query(
        `UPDATE featured_listings SET ends_at = now()
          WHERE business_id = $1 AND ends_at > now()`, [req.params.id]);
      await db.query(`UPDATE businesses SET is_featured = false WHERE id = $1`, [req.params.id]);
      await notify(req.params.id, 'system', 'Destacado retirado',
        'Tu negocio ya no aparece destacado en su municipio y categoría.', {});
      await audit(req, 'admin.featured.revoke', 'business', req.params.id, { expired: upd.rowCount });
      return res.json({ ok: true, unfeatured: true, expired: upd.rowCount });
    }

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

  // ── GET /api/admin/businesses/:id/analytics ───────────────────────────────
  // Ganancias de UN negocio (lo que el dueño ve en su contabilidad), pero desde
  // el panel de plataforma. Como admin NO tiene businessScope, cargamos el
  // negocio por el :id del path. Reusa la lógica de module-accounting.js.
  //   ?period=day|week|month|year  ó  ?from=YYYY-MM-DD&to=YYYY-MM-DD
  // El admin SIEMPRE ve el detalle completo (no aplica el gate de plan free).
  const PAID_PLANS = new Set(['pro', 'studio', 'team', 'grande', 'ilimitado']);
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  // Mismo cálculo de rango que module-accounting.js:26-40 (to es exclusivo).
  function resolveRange(period, from, to) {
    if (isDate(from) && isDate(to)) return { from, to };
    const now = new Date();
    const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
    const iso = (dt) => dt.toISOString().slice(0, 10);
    let start, end = new Date(Date.UTC(y, m, d + 1));
    switch (period) {
      case 'day':   start = new Date(Date.UTC(y, m, d)); break;
      case 'week':  start = new Date(Date.UTC(y, m, d - 6)); break;
      case 'month': start = new Date(Date.UTC(y, m, 1)); break;
      case 'year':  start = new Date(Date.UTC(y, 0, 1)); break;
      default:      start = new Date(Date.UTC(y, m, d - 6)); break;
    }
    return { from: iso(start), to: iso(end) };
  }

  app.get('/api/admin/businesses/:id/analytics', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const biz = await db.query(
      `SELECT b.id, b.name, s.plan_code
         FROM businesses b
         LEFT JOIN subscriptions s ON s.business_id = b.id
        WHERE b.id = $1 AND b.deleted_at IS NULL`, [req.params.id]);
    if (!biz.rows[0]) return bad(res, 'Negocio no encontrado', 404);
    const bid = biz.rows[0].id;
    const paid = PAID_PLANS.has(biz.rows[0].plan_code);
    const period = String(req.query.period || 'month');
    const { from, to } = resolveRange(period, req.query.from, req.query.to);

    // ── INGRESOS REALIZADOS: citas completadas (por starts_at) ──
    const facturado = await db.query(
      `SELECT COALESCE(SUM(price_cents),0)::bigint AS total, COUNT(*)::int AS n
         FROM appointments
        WHERE business_id = $1 AND status = 'completed'
          AND starts_at >= $2::date AND starts_at < $3::date`,
      [bid, from, to]);

    // ── INGRESOS COBRADOS: pagos recibidos + propinas (por paid_at) ──
    const cobrado = await db.query(
      `SELECT COALESCE(SUM(amount_cents + COALESCE(tip_cents,0)),0)::bigint AS total,
              COALESCE(SUM(COALESCE(tip_cents,0)),0)::bigint AS propinas,
              COUNT(*)::int AS n
         FROM payments
        WHERE business_id = $1 AND status = 'paid'
          AND paid_at >= $2::date AND paid_at < $3::date`,
      [bid, from, to]);

    // ── GASTOS anotados ──
    const gastos = await db.query(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS total, COUNT(*)::int AS n
         FROM expenses
        WHERE business_id = $1 AND spent_on >= $2::date AND spent_on < $3::date`,
      [bid, from, to]);

    // ── GASTO DE LA APP (mensualidad a Bukeame) ──
    const appCost = await db.query(
      `SELECT COALESCE(SUM(amount_cents - discount_cents),0)::bigint AS total
         FROM platform_payments
        WHERE business_id = $1 AND status = 'paid'
          AND paid_at >= $2::date AND paid_at < $3::date`,
      [bid, from, to]);

    // ── DEPÓSITOS RETENIDOS: canceladas + no-show con depósito no reembolsado ──
    const canceladas = await db.query(
      `SELECT COALESCE(SUM(p.amount_cents),0)::bigint AS total, COUNT(DISTINCT a.id)::int AS n
         FROM appointments a
         JOIN payments p ON p.appointment_id = a.id
        WHERE a.business_id = $1
          AND a.status IN ('cancelled_client','cancelled_business')
          AND p.kind = 'deposit' AND p.status = 'paid' AND p.refunded_at IS NULL
          AND a.starts_at >= $2::date AND a.starts_at < $3::date`,
      [bid, from, to]);
    const noShow = await db.query(
      `SELECT COALESCE(SUM(p.amount_cents),0)::bigint AS total, COUNT(DISTINCT a.id)::int AS n
         FROM appointments a
         JOIN payments p ON p.appointment_id = a.id
        WHERE a.business_id = $1 AND a.status = 'no_show'
          AND p.kind = 'deposit' AND p.status = 'paid' AND p.refunded_at IS NULL
          AND a.starts_at >= $2::date AND a.starts_at < $3::date`,
      [bid, from, to]);

    // ── DESGLOSE POR SERVICIO (citas completadas) ──
    const porServicio = await db.query(
      `SELECT service_name,
              COUNT(*)::int AS citas,
              COALESCE(SUM(price_cents),0)::bigint AS total_cents
         FROM appointments
        WHERE business_id = $1 AND status = 'completed'
          AND starts_at >= $2::date AND starts_at < $3::date
        GROUP BY service_name
        ORDER BY total_cents DESC`,
      [bid, from, to]);

    const facturadoTotal = Number(facturado.rows[0].total);
    const cobradoTotal   = Number(cobrado.rows[0].total);
    const gastosManual   = Number(gastos.rows[0].total);
    const gastoApp       = Number(appCost.rows[0].total);
    const gastosTotal    = gastosManual + gastoApp;
    const depositosRetenidos = Number(canceladas.rows[0].total) + Number(noShow.rows[0].total);
    // Neto: igual que el dueño Pro = realizado + depósitos retenidos − gastos.
    const neto = facturadoTotal + depositosRetenidos - gastosTotal;

    res.json({
      negocio: biz.rows[0].name,
      plan_code: biz.rows[0].plan_code || null,
      plan_pagado: paid,
      period, from, to,
      ingresos: {
        facturado_cents:   facturadoTotal,
        cobrado_cents:     cobradoTotal,
        propinas_cents:    Number(cobrado.rows[0].propinas),
        citas_completadas: facturado.rows[0].n,
        pagos_registrados: cobrado.rows[0].n,
      },
      depositos_retenidos: {
        total_cents:      depositosRetenidos,
        canceladas_cents: Number(canceladas.rows[0].total),
        canceladas_n:     canceladas.rows[0].n,
        no_show_cents:    Number(noShow.rows[0].total),
        no_show_n:        noShow.rows[0].n,
      },
      gastos: {
        total_cents:  gastosTotal,
        manual_cents: gastosManual,
        app_cents:    gastoApp,
        cantidad:     gastos.rows[0].n,
      },
      neto_cents: neto,
      por_servicio: porServicio.rows.map(r => ({
        servicio: r.service_name, citas: r.citas, total_cents: Number(r.total_cents),
      })),
    });
  }));

  // ── GET /api/admin/category-requests ──────────────────────────────────────
  // Lista de solicitudes de profesión/categoría (join con businesses y users
  // para mostrar quién la pidió). Pendientes primero, luego por fecha desc.
  app.get('/api/admin/category-requests', authRequired, adminRequired, asyncH(async (_req, res) => {
    const { rows } = await db.query(`
      SELECT cr.id, cr.business_id, cr.requested_by, cr.name_es, cr.name_en,
             cr.note, cr.status, cr.created_at, cr.reviewed_at, cr.reviewed_by,
             cr.created_category_id,
             b.name  AS negocio,
             u.email AS solicitante_email
        FROM category_requests cr
        LEFT JOIN businesses b ON b.id = cr.business_id
        LEFT JOIN users u ON u.id = cr.requested_by
       ORDER BY CASE cr.status WHEN 'pending' THEN 0 ELSE 1 END, cr.created_at DESC`);
    res.json({ requests: rows });
  }));

  // ── POST /api/admin/category-requests/:id/approve ─────────────────────────
  // Marca la solicitud como aprobada e inserta la categoría en `categories`
  // si aún no existe (idempotente por slug). Body opcional para editar antes
  // de aprobar: { name_es, name_en, slug, icon }
  app.post('/api/admin/category-requests/:id/approve', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const cr = await db.query(
      `SELECT * FROM category_requests WHERE id = $1 AND status = 'pending'`, [req.params.id]);
    if (!cr.rows[0]) return bad(res, 'Solicitud no encontrada o ya resuelta', 404);

    const nameEs = String(req.body?.name_es || cr.rows[0].name_es || '').trim();
    if (!nameEs || nameEs.length > 60) return bad(res, 'Nombre de la categoría inválido (máx 60 caracteres)');
    // name_en es NOT NULL en categories → si no viene, usa el nombre en español.
    const nameEn = String(req.body?.name_en || cr.rows[0].name_en || nameEs).trim();
    // slug: del body o derivado de name_es (sin acentos, minúsculas, guiones).
    const slug = String(req.body?.slug || nameEs).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return bad(res, 'No se pudo generar un slug válido para la categoría');
    const icon = req.body?.icon ? String(req.body.icon).trim().slice(0, 60) : null;

    // Inserta sin duplicar (slug es UNIQUE). Si ya existe, recuperamos su id.
    const ins = await db.query(
      `INSERT INTO categories (name_es, name_en, slug, icon, sort_order)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(sort_order),0)+1 FROM categories))
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`, [nameEs, nameEn, slug, icon]);
    const catId = ins.rows[0]?.id
      || (await db.query(`SELECT id FROM categories WHERE slug = $1`, [slug])).rows[0]?.id || null;

    await db.query(
      `UPDATE category_requests
          SET status = 'approved', reviewed_at = now(), reviewed_by = $2, created_category_id = $3
        WHERE id = $1`,
      [req.params.id, req.user.id, catId]);
    await audit(req, 'admin.category_request.approve', 'category', String(catId), { slug });
    res.json({ ok: true, category_id: catId, slug });
  }));

  // ── POST /api/admin/category-requests/:id/reject ──────────────────────────
  // Marca la solicitud como rechazada (sin crear categoría).
  app.post('/api/admin/category-requests/:id/reject', authRequired, adminRequired, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { rows } = await db.query(
      `UPDATE category_requests
          SET status = 'rejected', reviewed_at = now(), reviewed_by = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [req.params.id, req.user.id]);
    if (!rows[0]) return bad(res, 'Solicitud no encontrada o ya resuelta', 404);
    await audit(req, 'admin.category_request.reject', 'category_request', req.params.id, {});
    res.json({ ok: true });
  }));
}

module.exports = { mount };
