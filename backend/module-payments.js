// ============================================================================
//  BUKEAME API — módulo: MÉTODOS DE PAGO (fundación)
//  El negocio conecta SUS cuentas y recibe el dinero directo. Settings + estado.
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base:
//    require('./module-payments').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
//
//  Un solo Stripe Connect cubre tarjetas + Apple Pay + Google Pay + Klarna.
//  PayPal y ATH Móvil van aparte. Cash = toggle. El PROCESAMIENTO real (cargos +
//  webhooks) se implementa luego con las llaves de plataforma en .env.
// ============================================================================

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isPhone, normPhone, audit } = h;

  // Catálogo de proveedores. external=true → requiere onboarding con cuenta externa.
  const PROVIDERS = {
    stripe:    { name: 'Tarjetas · Apple Pay · Google Pay · Klarna', external: true },
    paypal:    { name: 'PayPal',     external: true },
    ath_movil: { name: 'ATH Móvil',  external: false },
    cash:      { name: 'Efectivo',   external: false },
  };
  const ORDER = ['stripe', 'paypal', 'ath_movil', 'cash'];

  // ¿La PLATAFORMA (Bukeame) ya tiene las credenciales para este proveedor?
  const platformReady = (provider) => {
    if (provider === 'stripe') return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CONNECT_CLIENT_ID);
    if (provider === 'paypal') return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);
    return true; // ath_movil / cash no dependen de la plataforma
  };

  // Nunca exponemos el account_ref completo, solo una pista
  const maskRef = (provider, ref) => {
    if (!ref) return null;
    if (provider === 'ath_movil') return '•••• ' + String(ref).slice(-4);
    return String(ref).slice(0, 8) + '••••';
  };

  // Asegura que existan las 4 filas del negocio (idempotente)
  async function ensureRows(businessId) {
    for (const p of ORDER)
      await db.query(
        `INSERT INTO payment_providers (business_id, provider) VALUES ($1,$2)
         ON CONFLICT (business_id, provider) DO NOTHING`, [businessId, p]);
  }

  // ── GET /api/payments/providers — estado de cada método del negocio ────────
  app.get('/api/payments/providers', authRequired, businessScope, asyncH(async (req, res) => {
    await ensureRows(req.business.id);
    const { rows } = await db.query(
      `SELECT provider, is_enabled, status, account_ref, connected_at
         FROM payment_providers WHERE business_id = $1`, [req.business.id]);
    const byCode = {};
    for (const r of rows) byCode[r.provider] = r;
    const providers = ORDER.map(p => {
      const r = byCode[p] || { is_enabled: false, status: 'not_connected', account_ref: null };
      return {
        provider: p,
        name: PROVIDERS[p].name,
        external: PROVIDERS[p].external,
        is_enabled: r.is_enabled,
        status: r.status,
        account_hint: maskRef(p, r.account_ref),
        connected_at: r.connected_at,
        platform_ready: platformReady(p),   // si false, "Conectar" aún no está disponible
      };
    });
    res.json({ providers, ath_phone: req.business.ath_phone || null });
  }));

  // ── PATCH /api/payments/providers/:provider — activar/desactivar (toggle) ──
  app.patch('/api/payments/providers/:provider', authRequired, businessScope, asyncH(async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider]) return bad(res, 'Proveedor inválido', 404);
    const { is_enabled } = req.body || {};
    if (typeof is_enabled !== 'boolean') return bad(res, 'Falta is_enabled');

    await ensureRows(req.business.id);
    const cur = await db.query(
      `SELECT status FROM payment_providers WHERE business_id = $1 AND provider = $2`,
      [req.business.id, provider]);
    if (is_enabled && cur.rows[0]?.status !== 'connected')
      return bad(res, 'Conecta este método antes de activarlo', 409);

    const { rows } = await db.query(
      `UPDATE payment_providers SET is_enabled = $3
         WHERE business_id = $1 AND provider = $2
       RETURNING provider, is_enabled, status`, [req.business.id, provider, is_enabled]);
    await audit(req, 'payment.toggle', 'payment_provider', null, { provider, is_enabled });
    res.json({ provider: rows[0] });
  }));

  // ── POST /api/payments/providers/:provider/connect ─────────────────────────
  app.post('/api/payments/providers/:provider/connect', authRequired, businessScope, asyncH(async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider]) return bad(res, 'Proveedor inválido', 404);
    await ensureRows(req.business.id);

    // Efectivo: no hay cuenta externa, se conecta al instante
    if (provider === 'cash') {
      await db.query(
        `UPDATE payment_providers SET status='connected', is_enabled=true, connected_at=now()
           WHERE business_id = $1 AND provider = 'cash'`, [req.business.id]);
      await audit(req, 'payment.connect', 'payment_provider', null, { provider });
      return res.json({ ok: true, status: 'connected' });
    }

    // ATH Móvil: manual. Guardamos el teléfono (se sincroniza con businesses.ath_phone)
    if (provider === 'ath_movil') {
      const phone = req.body?.ath_phone;
      if (!isPhone(phone)) return bad(res, 'Pon tu número de ATH Móvil (PR/US, 10 dígitos)');
      const norm = normPhone(phone);
      await db.query(`UPDATE businesses SET ath_phone = $2 WHERE id = $1`, [req.business.id, norm]);
      await db.query(
        `UPDATE payment_providers SET status='connected', is_enabled=true, account_ref=$2, connected_at=now()
           WHERE business_id = $1 AND provider = 'ath_movil'`, [req.business.id, norm]);
      await audit(req, 'payment.connect', 'payment_provider', null, { provider });
      return res.json({ ok: true, status: 'connected', ath_phone: norm });
    }

    // Stripe / PayPal: requieren credenciales de plataforma + onboarding (fase de procesamiento)
    if (!platformReady(provider))
      return bad(res, `La conexión con ${PROVIDERS[provider].name.split(' ·')[0]} estará disponible muy pronto — estamos terminando de configurarla.`, 503);

    // TODO (fase de procesamiento, con llaves en .env):
    //   stripe → crear Connected Account + Account Link (onboarding) y devolver la URL;
    //            el webhook account.updated marca status='connected' al quedar charges_enabled.
    //   paypal → PayPal Partner Referrals: generar el action URL de onboarding.
    await db.query(
      `UPDATE payment_providers SET status='pending' WHERE business_id = $1 AND provider = $2`,
      [req.business.id, provider]);
    res.json({ ok: true, status: 'pending', connect_url: null, note: 'Onboarding pendiente de implementación.' });
  }));

  // ── POST /api/payments/providers/:provider/disconnect ──────────────────────
  app.post('/api/payments/providers/:provider/disconnect', authRequired, businessScope, asyncH(async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider]) return bad(res, 'Proveedor inválido', 404);
    await db.query(
      `UPDATE payment_providers
          SET status='not_connected', is_enabled=false, account_ref=NULL, connected_at=NULL
        WHERE business_id = $1 AND provider = $2`, [req.business.id, provider]);
    await audit(req, 'payment.disconnect', 'payment_provider', null, { provider });
    res.json({ ok: true });
  }));

  console.log('  ✓ módulo pagos montado (métodos por negocio: stripe/paypal/ath/cash)');
};
