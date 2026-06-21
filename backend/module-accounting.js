// ============================================================================
//  BUKEAME API — módulo: CONTABILIDAD (Accounting)
//  Ingresos (facturado + cobrado) · Desglose por servicio · Gastos · Export CSV
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base:
//    require('./module-accounting').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
//
//  Reusa helpers del server base: asyncH, bad, audit
//  Reglas de plan:
//    free  → resumen básico (día/semana), sin desglose por servicio, sin export
//    pro+  → todo: día/semana/mes/año + desglose por servicio + gastos + export CSV
// ============================================================================

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, audit, isUuid } = h;

  const PAID_PLANS = new Set(['pro', 'studio', 'team', 'grande', 'ilimitado']);
  const isPaid = (b) => PAID_PLANS.has(b.plan_code);

  const cents = v => Number.isInteger(v) && v > 0 && v <= 100000000; // ≤ $1M
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  // Resuelve un rango de fechas a partir de un "period" o from/to explícitos.
  // Devuelve { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } (to es exclusivo en queries).
  function resolveRange(period, from, to) {
    if (isDate(from) && isDate(to)) return { from, to };
    const now = new Date();
    const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
    const iso = (dt) => dt.toISOString().slice(0, 10);
    let start, end = new Date(Date.UTC(y, m, d + 1)); // mañana (exclusivo)
    switch (period) {
      case 'day':   start = new Date(Date.UTC(y, m, d)); break;
      case 'week':  start = new Date(Date.UTC(y, m, d - 6)); break;     // últimos 7 días
      case 'month': start = new Date(Date.UTC(y, m, 1)); break;          // mes actual
      case 'year':  start = new Date(Date.UTC(y, 0, 1)); break;          // año actual
      default:      start = new Date(Date.UTC(y, m, d - 6)); break;      // default semana
    }
    return { from: iso(start), to: iso(end) };
  }

  // ── GET /api/accounting/summary?period=day|week|month|year[&from&to] ────────
  app.get('/api/accounting/summary', authRequired, businessScope, asyncH(async (req, res) => {
    const period = String(req.query.period || 'week');
    const paid = isPaid(req.business);

    // Free solo puede day/week
    if (!paid && (period === 'month' || period === 'year'))
      return bad(res, 'Los reportes mensuales y anuales están disponibles desde el plan Pro.', 403);

    const { from, to } = resolveRange(period, req.query.from, req.query.to);
    const bid = req.business.id;

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

    const facturadoTotal = Number(facturado.rows[0].total);
    const cobradoTotal   = Number(cobrado.rows[0].total);
    const gastosManual   = Number(gastos.rows[0].total);
    const gastoApp       = Number(appCost.rows[0].total);
    const gastosTotal    = gastosManual + gastoApp;

    const out = {
      period, from, to,
      ingresos: {
        facturado_cents: facturadoTotal,   // ganancia realizada (citas completadas)
        cobrado_cents:   cobradoTotal,     // todo lo que entró (pagos + propinas)
        propinas_cents:  Number(cobrado.rows[0].propinas),
        citas_completadas: facturado.rows[0].n,
        pagos_registrados: cobrado.rows[0].n,
      },
      gastos: {
        total_cents:   gastosTotal,
        manual_cents:  gastosManual,
        app_cents:     gastoApp,
        cantidad:      gastos.rows[0].n,
      },
      plan_limitado: !paid,
    };

    if (paid) {
      // ── NO REALIZADAS: citas confirmadas que aún no han pasado ──
      const noRealizado = await db.query(
        `SELECT COALESCE(SUM(price_cents),0)::bigint AS total, COUNT(*)::int AS n
           FROM appointments
          WHERE business_id = $1 AND status = 'confirmed'
            AND starts_at >= $2::date AND starts_at < $3::date`,
        [bid, from, to]);

      // ── DEPÓSITOS COBRADOS: pagos kind=deposit no reembolsados ──
      const depositos = await db.query(
        `SELECT COALESCE(SUM(amount_cents),0)::bigint AS total, COUNT(*)::int AS n
           FROM payments
          WHERE business_id = $1 AND kind = 'deposit' AND status = 'paid'
            AND refunded_at IS NULL
            AND paid_at >= $2::date AND paid_at < $3::date`,
        [bid, from, to]);

      // ── CANCELADAS con depósito retenido ──
      const canceladas = await db.query(
        `SELECT COALESCE(SUM(p.amount_cents),0)::bigint AS total, COUNT(DISTINCT a.id)::int AS n
           FROM appointments a
           JOIN payments p ON p.appointment_id = a.id
          WHERE a.business_id = $1
            AND a.status IN ('cancelled_client','cancelled_business')
            AND p.kind = 'deposit' AND p.status = 'paid' AND p.refunded_at IS NULL
            AND a.starts_at >= $2::date AND a.starts_at < $3::date`,
        [bid, from, to]);

      // ── NO-SHOW con depósito retenido ──
      const noShow = await db.query(
        `SELECT COALESCE(SUM(p.amount_cents),0)::bigint AS total, COUNT(DISTINCT a.id)::int AS n
           FROM appointments a
           JOIN payments p ON p.appointment_id = a.id
          WHERE a.business_id = $1 AND a.status = 'no_show'
            AND p.kind = 'deposit' AND p.status = 'paid' AND p.refunded_at IS NULL
            AND a.starts_at >= $2::date AND a.starts_at < $3::date`,
        [bid, from, to]);

      const depositosRetenidos = Number(canceladas.rows[0].total) + Number(noShow.rows[0].total);

      out.detalle = {
        no_realizado_cents: Number(noRealizado.rows[0].total),
        no_realizado_n:     noRealizado.rows[0].n,
        depositos_cents:    Number(depositos.rows[0].total),
        depositos_n:        depositos.rows[0].n,
        canceladas_cents:   Number(canceladas.rows[0].total),
        canceladas_n:       canceladas.rows[0].n,
        no_show_cents:      Number(noShow.rows[0].total),
        no_show_n:          noShow.rows[0].n,
      };

      // Ganancia neta = realizada + depósitos retenidos − gastos
      out.neto_cents = facturadoTotal + depositosRetenidos - gastosTotal;
    } else {
      // Free: neto simple = cobrado − gastos
      out.neto_cents = cobradoTotal - gastosTotal;
    }

    // DESGLOSE POR SERVICIO (solo Pro+)
    if (paid) {
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
      out.por_servicio = porServicio.rows.map(r => ({
        servicio: r.service_name, citas: r.citas, total_cents: Number(r.total_cents),
      }));
    }

    res.json(out);
  }));

  // ── GASTOS: listar / crear / borrar ────────────────────────────────────────
  app.get('/api/accounting/expenses', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isPaid(req.business)) return bad(res, 'El registro de gastos está disponible desde el plan Pro.', 403);
    const { from, to } = resolveRange(String(req.query.period || 'month'), req.query.from, req.query.to);
    const { rows } = await db.query(
      `SELECT id, category, label, amount_cents, spent_on, notes
         FROM expenses
        WHERE business_id = $1 AND spent_on >= $2::date AND spent_on < $3::date
        ORDER BY spent_on DESC, created_at DESC`,
      [req.business.id, from, to]);
    res.json({ expenses: rows, from, to });
  }));

  const VALID_CAT = new Set(['renta','productos','empleados','equipo','servicios','mercadeo','transporte','app','otro']);
  app.post('/api/accounting/expenses', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isPaid(req.business)) return bad(res, 'El registro de gastos está disponible desde el plan Pro.', 403);
    const label = String(req.body?.label || '').trim();
    const amount = req.body?.amount_cents;
    let category = String(req.body?.category || 'otro').trim().toLowerCase();
    const spentOn = req.body?.spent_on;
    if (!label || label.length > 120) return bad(res, 'Describe el gasto (máx 120 caracteres)');
    if (!cents(amount)) return bad(res, 'Monto inválido');
    if (!VALID_CAT.has(category)) category = 'otro';
    const when = isDate(spentOn) ? spentOn : null;
    const { rows } = await db.query(
      `INSERT INTO expenses (business_id, category, label, amount_cents, spent_on, notes)
       VALUES ($1, $2::expense_category, $3, $4, COALESCE($5::date, CURRENT_DATE), $6)
       RETURNING id, category, label, amount_cents, spent_on, notes`,
      [req.business.id, category, label, amount, when, req.body?.notes ? String(req.body.notes).slice(0, 500) : null]);
    await audit(req, 'expense.create', 'business', req.business.id, { amount_cents: amount });
    res.json({ expense: rows[0] });
  }));

  app.delete('/api/accounting/expenses/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    if (!isPaid(req.business)) return bad(res, 'Disponible desde el plan Pro.', 403);
    const { rowCount } = await db.query(
      `DELETE FROM expenses WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.business.id]);
    if (!rowCount) return bad(res, 'Gasto no encontrado', 404);
    res.json({ ok: true });
  }));

  // ── EXPORT CSV (solo Pro+) ─────────────────────────────────────────────────
  // GET /api/accounting/export?from=YYYY-MM-DD&to=YYYY-MM-DD&type=all|income|expenses
  app.get('/api/accounting/export', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isPaid(req.business)) return bad(res, 'La exportación está disponible desde el plan Pro.', 403);
    const from = isDate(req.query.from) ? req.query.from : null;
    const to   = isDate(req.query.to)   ? req.query.to   : null;
    if (!from || !to) return bad(res, 'Indica el rango: from y to (YYYY-MM-DD)');
    const type = String(req.query.type || 'all');
    const bid = req.business.id;

    // Helper para escapar campos CSV
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const money = (c) => (Number(c) / 100).toFixed(2);

    let lines = [];

    if (type === 'all' || type === 'income') {
      // Ingresos cobrados (pagos)
      const pays = await db.query(
        `SELECT p.paid_at, p.amount_cents, COALESCE(p.tip_cents,0) AS tip_cents, p.method, p.kind,
                a.service_name, c.full_name AS cliente
           FROM payments p
           LEFT JOIN appointments a ON a.id = p.appointment_id
           LEFT JOIN clients c ON c.id = p.client_id
          WHERE p.business_id = $1 AND p.status = 'paid'
            AND p.paid_at >= $2::date AND p.paid_at < ($3::date + 1)
          ORDER BY p.paid_at`,
        [bid, from, to]);
      lines.push('INGRESOS (PAGOS COBRADOS)');
      lines.push(['Fecha','Servicio','Cliente','Método','Tipo','Monto USD','Propina USD','Total USD'].map(esc).join(','));
      for (const r of pays.rows) {
        const monto = Number(r.amount_cents), tip = Number(r.tip_cents);
        lines.push([
          r.paid_at ? new Date(r.paid_at).toISOString().slice(0,10) : '',
          r.service_name || '', r.cliente || '', r.method || '', r.kind || '',
          money(monto), money(tip), money(monto + tip),
        ].map(esc).join(','));
      }
      lines.push('');
    }

    if (type === 'all' || type === 'expenses') {
      const exp = await db.query(
        `SELECT spent_on, category, label, amount_cents, notes
           FROM expenses
          WHERE business_id = $1 AND spent_on >= $2::date AND spent_on < ($3::date + 1)
          ORDER BY spent_on`,
        [bid, from, to]);
      lines.push('GASTOS');
      lines.push(['Fecha','Categoría','Descripción','Notas','Monto USD'].map(esc).join(','));
      for (const r of exp.rows) {
        lines.push([
          r.spent_on, r.category, r.label, r.notes || '', money(r.amount_cents),
        ].map(esc).join(','));
      }
      // Gasto de la app
      const appPays = await db.query(
        `SELECT paid_at, (amount_cents - discount_cents) AS net
           FROM platform_payments
          WHERE business_id = $1 AND status = 'paid'
            AND paid_at >= $2::date AND paid_at < ($3::date + 1)
          ORDER BY paid_at`,
        [bid, from, to]);
      for (const r of appPays.rows) {
        lines.push([
          r.paid_at ? new Date(r.paid_at).toISOString().slice(0,10) : '',
          'app', 'Suscripción Bukeame', '', money(r.net),
        ].map(esc).join(','));
      }
      lines.push('');
    }

    const csv = '\uFEFF' + lines.join('\n');   // BOM para que Excel abra acentos bien
    const fname = `bukeame-contabilidad-${from}_a_${to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await audit(req, 'accounting.export', 'business', bid, { from, to, type });
    res.send(csv);
  }));
};
