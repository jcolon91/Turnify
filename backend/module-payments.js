// ============================================================================
//  BUKEAME API — módulo: MÉTODOS DE PAGO (self-serve, dinero DIRECTO al negocio)
//  El negocio conecta SUS cuentas y recibe el dinero directo. Bukeame NO custodia
//  secretos: solo guarda lo PÚBLICO de cada método en payment_providers.config (jsonb).
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base:
//    require('./module-payments').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
//
//  · ATH Móvil  → manual (teléfono) o auto ("API pública": publicToken NO secreto).
//                 NUNCA pedimos ni guardamos el privateToken (los reembolsos los hace
//                 el negocio en su app ATH Business).
//  · PayPal     → self-serve con el handle de PayPal.me (sin gate de plataforma).
//  · Stripe     → Connect OAuth (Standard), gateado por STRIPE_CONNECT_CLIENT_ID.
//                 El cobro real (cargos + webhooks) se hace luego con las llaves.
//  Sin SDKs nuevos: usamos fetch (Node 18+) para Stripe/Google/Apple/ATH.
// ============================================================================

const crypto = require('crypto');

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isStr, isPhone, normPhone, audit } = h;

  const JWT_SECRET = process.env.JWT_SECRET || '';
  const APP_URL    = (process.env.APP_URL || 'https://bukeame.com').replace(/\/+$/, '');

  // Catálogo de proveedores. external=true → requiere onboarding con cuenta externa.
  const PROVIDERS = {
    stripe:    { name: 'Tarjetas · Apple Pay · Google Pay · Klarna', external: true },
    paypal:    { name: 'PayPal',     external: true },
    ath_movil: { name: 'ATH Móvil',  external: false },
    cash:      { name: 'Efectivo',   external: false },
  };
  const ORDER = ['stripe', 'paypal', 'ath_movil', 'cash'];

  // ¿La PLATAFORMA (Bukeame) ya tiene las credenciales para este proveedor?
  // Stripe sigue gateado (OAuth necesita el client_id + secret de la plataforma).
  // PayPal y ATH Móvil son ahora self-serve (el negocio pone su propio handle/teléfono).
  const platformReady = (provider) => {
    if (provider === 'stripe') return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CONNECT_CLIENT_ID);
    return true; // paypal / ath_movil / cash no dependen de credenciales de plataforma
  };

  // Nunca exponemos el account_ref completo, solo una pista
  const maskRef = (provider, ref) => {
    if (!ref) return null;
    if (provider === 'ath_movil') return '•••• ' + String(ref).slice(-4);
    return String(ref).slice(0, 8) + '••••';
  };

  // Handle de PayPal.me: usuario (letras/números, 1-20) o email. Sin URL, sin espacios.
  const isPaypalHandle = v =>
    typeof v === 'string' && (/^[A-Za-z0-9]{1,20}$/.test(v.trim())
      || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) && v.trim().length <= 254));

  // ── State firmado para el OAuth de Stripe (HMAC-SHA256 con JWT_SECRET) ──────
  // Lleva el business_id + un nonce + expiración corta; se valida al volver.
  function signState(businessId) {
    const payload = `${businessId}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}`;
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
    return Buffer.from(`${payload}.${sig}`).toString('base64url');
  }
  function verifyState(state) {
    try {
      const raw = Buffer.from(String(state), 'base64url').toString('utf8');
      const parts = raw.split('.');
      if (parts.length !== 4) return null;
      const [businessId, ts, nonce, sig] = parts;
      const expect = crypto.createHmac('sha256', JWT_SECRET)
        .update(`${businessId}.${ts}.${nonce}`).digest('base64url');
      const a = Buffer.from(sig), b = Buffer.from(expect);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      if (Date.now() - Number(ts) > 15 * 60 * 1000) return null; // 15 min de validez
      return businessId;
    } catch { return null; }
  }

  // Asegura que existan las 4 filas del negocio (idempotente)
  async function ensureRows(businessId) {
    for (const p of ORDER)
      await db.query(
        `INSERT INTO payment_providers (business_id, provider) VALUES ($1,$2)
         ON CONFLICT (business_id, provider) DO NOTHING`, [businessId, p]);
  }

  // Datos PÚBLICOS de config que la UI necesita (nunca secretos)
  const publicConfig = (provider, cfg = {}) => {
    if (provider === 'ath_movil') return {
      ath_mode: cfg.ath_mode || 'manual',
      ath_public_token: cfg.ath_public_token || null,   // público: va en el botón client-side
    };
    if (provider === 'paypal')  return { paypal_handle: cfg.paypal_handle || null };
    if (provider === 'stripe')  return { stripe_connected: !!cfg.stripe_account_id };
    return {};
  };

  // ── GET /api/payments/providers — estado de cada método del negocio ────────
  app.get('/api/payments/providers', authRequired, businessScope, asyncH(async (req, res) => {
    await ensureRows(req.business.id);
    const { rows } = await db.query(
      `SELECT provider, is_enabled, status, account_ref, config, connected_at
         FROM payment_providers WHERE business_id = $1`, [req.business.id]);
    const byCode = {};
    for (const r of rows) byCode[r.provider] = r;
    const providers = ORDER.map(p => {
      const r = byCode[p] || { is_enabled: false, status: 'not_connected', account_ref: null, config: {} };
      return {
        provider: p,
        name: PROVIDERS[p].name,
        external: PROVIDERS[p].external,
        is_enabled: r.is_enabled,
        status: r.status,
        account_hint: maskRef(p, r.account_ref),
        connected_at: r.connected_at,
        platform_ready: platformReady(p),   // si false, "Conectar" aún no está disponible
        config: publicConfig(p, r.config || {}),  // datos públicos para la UI
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

    // ATH Móvil: dos modos.
    //   · manual → body {ath_phone}: el cliente paga al teléfono y reporta la referencia.
    //   · auto   → body {ath_phone, ath_public_token}: el botón ATH (client-side) cobra
    //              directo a la cuenta del negocio con su publicToken (NO secreto).
    //   NUNCA pedimos ni guardamos el privateToken (reembolsos = app ATH Business).
    if (provider === 'ath_movil') {
      const phone = req.body?.ath_phone;
      if (!isPhone(phone)) return bad(res, 'Pon tu número de ATH Móvil (PR/US, 10 dígitos)');
      const norm = normPhone(phone);

      const rawToken = req.body?.ath_public_token;
      const auto = rawToken !== undefined && rawToken !== null && String(rawToken).trim() !== '';
      let config = { ath_mode: 'manual' };
      if (auto) {
        // El publicToken se usa en el botón client-side; lo validamos como string corto.
        if (!isStr(rawToken, 200)) return bad(res, 'Public token de ATH inválido');
        config = { ath_mode: 'auto', ath_public_token: String(rawToken).trim() };
      }

      await db.query(`UPDATE businesses SET ath_phone = $2 WHERE id = $1`, [req.business.id, norm]);
      await db.query(
        `UPDATE payment_providers
            SET status='connected', is_enabled=true, account_ref=$2,
                config = config || $3::jsonb, connected_at=now()
          WHERE business_id = $1 AND provider = 'ath_movil'`,
        [req.business.id, norm, JSON.stringify(config)]);
      await audit(req, 'payment.connect', 'payment_provider', null, { provider, ath_mode: config.ath_mode });
      return res.json({ ok: true, status: 'connected', ath_phone: norm, ath_mode: config.ath_mode });
    }

    // PayPal: self-serve. El negocio pone su handle de PayPal.me (o email).
    // En el cobro, el cliente va a https://www.paypal.com/paypalme/<handle>/<monto>.
    if (provider === 'paypal') {
      const handle = req.body?.paypal_handle;
      if (!isPaypalHandle(handle)) return bad(res, 'Pon tu usuario de PayPal.me o tu email de PayPal');
      const clean = String(handle).trim();
      await db.query(
        `UPDATE payment_providers
            SET status='connected', is_enabled=true, account_ref=$2,
                config = config || $3::jsonb, connected_at=now()
          WHERE business_id = $1 AND provider = 'paypal'`,
        [req.business.id, clean, JSON.stringify({ paypal_handle: clean })]);
      await audit(req, 'payment.connect', 'payment_provider', null, { provider });
      return res.json({ ok: true, status: 'connected' });
    }

    // Stripe: NO se conecta por aquí. Usa el flujo OAuth: GET /api/payments/stripe/connect.
    if (provider === 'stripe') {
      if (!platformReady('stripe'))
        return bad(res, 'La conexión con Stripe estará disponible muy pronto — estamos terminando de configurarla.', 503);
      return bad(res, 'Conecta Stripe con el botón "Conectar con Stripe" (OAuth).', 409);
    }

    return bad(res, 'Proveedor inválido', 404);
  }));

  // ── POST /api/payments/providers/:provider/disconnect ──────────────────────
  app.post('/api/payments/providers/:provider/disconnect', authRequired, businessScope, asyncH(async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider]) return bad(res, 'Proveedor inválido', 404);
    await db.query(
      `UPDATE payment_providers
          SET status='not_connected', is_enabled=false, account_ref=NULL,
              config='{}'::jsonb, connected_at=NULL
        WHERE business_id = $1 AND provider = $2`, [req.business.id, provider]);
    await audit(req, 'payment.disconnect', 'payment_provider', null, { provider });
    res.json({ ok: true });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  //  STRIPE CONNECT — OAuth Standard (sin SDK, vía fetch a connect.stripe.com)
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /api/payments/stripe/connect — arma la URL OAuth y la devuelve ─────
  app.get('/api/payments/stripe/connect', authRequired, businessScope, asyncH(async (req, res) => {
    if (!platformReady('stripe'))
      return bad(res, 'La conexión con Stripe estará disponible muy pronto.', 503);
    await ensureRows(req.business.id);
    const state = signState(req.business.id);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.STRIPE_CONNECT_CLIENT_ID,
      scope: 'read_write',
      state,
    });
    const url = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
    res.json({ url });
  }));

  // ── GET /api/payments/stripe/callback?code=&state= — intercambia el code ───
  // Público (Stripe redirige aquí sin Bearer); el business_id viaja firmado en state.
  app.get('/api/payments/stripe/callback', asyncH(async (req, res) => {
    const { code, state, error } = req.query || {};
    const redirect = (q) => res.redirect(`${APP_URL}/panel.html?${q}`);

    if (error) return redirect('stripe=denied');
    if (!isStr(code, 512) || !isStr(state, 1024)) return redirect('stripe=error');

    const businessId = verifyState(state);
    if (!businessId) return redirect('stripe=error');

    // Intercambio del code → token (sin SDK: POST x-www-form-urlencoded con fetch)
    let tok;
    try {
      const r = await fetch('https://connect.stripe.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_secret: process.env.STRIPE_SECRET_KEY,
          code: String(code),
          grant_type: 'authorization_code',
        }).toString(),
      });
      tok = await r.json();
      if (!r.ok || !tok || !tok.stripe_user_id) {
        console.error('stripe oauth token:', tok && tok.error_description ? tok.error_description : r.status);
        return redirect('stripe=error');
      }
    } catch (e) {
      console.error('stripe oauth fetch:', e.message);
      return redirect('stripe=error');
    }

    const acct = tok.stripe_user_id; // acct_...
    // El state ya validó el business_id; solo conectamos esa fila.
    await db.query(
      `INSERT INTO payment_providers (business_id, provider) VALUES ($1,'stripe')
         ON CONFLICT (business_id, provider) DO NOTHING`, [businessId]);
    await db.query(
      `UPDATE payment_providers
          SET status='connected', is_enabled=true, account_ref=$2,
              config = config || $3::jsonb, connected_at=now()
        WHERE business_id = $1 AND provider = 'stripe'`,
      [businessId, acct, JSON.stringify({ stripe_account_id: acct })]);
    await db.query(
      `INSERT INTO audit_log (business_id, action, entity, data)
       VALUES ($1,'payment.connect','payment_provider',$2)`,
      [businessId, { provider: 'stripe' }]).catch(() => {});

    return redirect('stripe=ok');
  }));

  // NOTA: la confirmación pública de ATH Móvil
  // (POST /api/public/:slug/appointments/:code/ath/confirm) vive en server.js,
  // que se registra ANTES de montar los módulos. Aquí no se redefine para no
  // duplicar la ruta (Express usaría la primera registrada de todos modos).

  console.log('  ✓ módulo pagos montado (self-serve: stripe OAuth / paypal / ath auto+manual / cash)');
};
