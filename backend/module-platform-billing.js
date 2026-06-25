// ============================================================================
//  BUKEAME · module-platform-billing.js
//  Cobro de PLATAFORMA por ATH Móvil Business (Evertec) con la cuenta de WIFNIX.
//  Membresía (plan) · add-ons · destacado · presupuesto de anuncios.
// ----------------------------------------------------------------------------
//  FLUJO REST oficial (ATHM-Payment-Button-API) — el MISMO que usa Wifnix y que
//  SÍ abre la app de ATH Móvil. NO usa el botón JS (ese es otro producto):
//    1) POST /payment  { publicToken, total, phoneNumber, ... }  → { ecommerceId, auth_token }
//       → ATH manda una PUSH a la app del que paga (el dueño del negocio).
//    2) El dueño CONFIRMA en su app de ATH Móvil.
//    3) POST /findPayment { ecommerceId, publicToken } (Bearer auth_token)
//       → polling hasta ecommerceStatus === 'CONFIRM'.
//    4) POST /authorization (Bearer auth_token, body vacío) → 'COMPLETED' + referenceNumber.
//
//  Se ENCHUFA al server.js base:
//    require('./module-platform-billing').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
//
//  SEGURIDAD (dinero real) — reglas inviolables:
//   1) El MONTO se calcula SIEMPRE en el servidor (plans / addon_catalog). El pago
//      verificado por ATH DEBE igualar ese monto antes de activar. Nunca se confía
//      en el "total" del cliente.
//   2) IDEMPOTENCIA: cada referenceNumber es único en platform_ath_payments; un 2.º
//      intento con el mismo referenceNumber no reactiva (devuelve already).
//   3) El privateToken vive SOLO en process.env; sólo se usa para /refund. /config no
//      lo expone. El auth_token vive SOLO en el servidor (mapa en memoria), nunca al front.
//   4) /create y /status son authRequired + businessScope: el negocio sólo paga LO SUYO.
//   5) Sólo se activa cuando ATH confirma COMPLETED y el monto coincide.
//   6) Sin secretos hardcodeados; SQL siempre con parámetros $n.
// ============================================================================

const ATH_BASE         = 'https://payments.athmovil.com/api/business-transaction/ecommerce';
const ATH_PAYMENT_URL  = ATH_BASE + '/payment';
const ATH_FIND_URL     = ATH_BASE + '/business/findPayment';
const ATH_AUTH_URL     = ATH_BASE + '/authorization';

// Normaliza un teléfono a 10 dígitos (formato que espera ATH, p.ej. "7875551234").
function athPhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : null;
}

function mount(app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isStr, isUuid, audit, notify } = h;

  // ── Config desde el entorno (secretos sólo en process.env) ─────────────────
  const ATHM_ENV      = process.env.ATHM_ENV || 'production';
  const PUBLIC_TOKEN  = process.env.ATHM_PLATFORM_PUBLIC_TOKEN || '';
  const PRIVATE_TOKEN = process.env.ATHM_PLATFORM_PRIVATE_TOKEN || ''; // sólo para /refund (futuro)
  const enabled       = !!PUBLIC_TOKEN; // el flujo REST de cobro sólo necesita el público

  // Pagos ATH EN CURSO (servidor, en memoria; proceso único PM2). Mapea
  // ecommerceId → { businessId, authToken, kind, refCode, codesArr, campaignId,
  // weeksVal, montoEsperadoCents, createdAt }. TTL corto; se limpia al terminar.
  // Si el server reinicia, se pierde el pendiente: ATH no debita hasta /authorization,
  // así que no se pierde dinero — el dueño sólo reintenta.
  const pendingAth = new Map();
  const PENDING_TTL_MS = 12 * 60 * 1000;
  function gcPending() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [id, v] of pendingAth) if (v.createdAt < cutoff) pendingAth.delete(id);
  }

  // ── Helper genérico POST a ATH (JSON). body puede ser objeto o string ('' p/ authorization).
  async function athPost(url, body, authToken) {
    try {
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
      const payload = typeof body === 'string' ? body : JSON.stringify(body || {});
      const resp = await fetch(url, { method: 'POST', headers, body: payload });
      const json = await resp.json().catch(() => null);
      return { ok: !!(json && json.status === 'success'), data: json && json.data ? json.data : null, raw: json };
    } catch (e) {
      console.error('ath.post', e.message);
      return { ok: false, data: null, raw: null };
    }
  }

  // Crea el pago en ATH (manda push al teléfono). Devuelve { ecommerceId, authToken } o null.
  async function athCreate(cents, phone, metadata1, metadata2, itemName) {
    const dollars = (cents / 100).toFixed(2);
    const body = {
      env: ATHM_ENV,
      publicToken: PUBLIC_TOKEN,
      timeout: '600',
      total: dollars,
      subtotal: dollars,
      tax: '0.00',
      metadata1: String(metadata1 || '').slice(0, 40),
      metadata2: String(metadata2 || '').slice(0, 40),
      phoneNumber: phone,
      items: [{
        name: String(itemName || 'Compra Bukeame').slice(0, 40),
        description: String(itemName || 'Compra Bukeame').slice(0, 40),
        quantity: '1', price: dollars, tax: '0.00', metadata: '',
      }],
    };
    const r = await athPost(ATH_PAYMENT_URL, body);
    if (r.ok && r.data && r.data.ecommerceId && r.data.auth_token)
      return { ecommerceId: r.data.ecommerceId, authToken: r.data.auth_token };
    return null;
  }

  // Consulta el estado del pago. Devuelve la data de ATH (ecommerceStatus, total, ...) o null.
  async function athFind(ecommerceId, authToken) {
    const r = await athPost(ATH_FIND_URL, { ecommerceId, publicToken: PUBLIC_TOKEN }, authToken);
    return r.data;
  }

  // Autoriza (captura) el pago confirmado. Devuelve la data (COMPLETED + referenceNumber) o null.
  async function athAuthorize(authToken) {
    const r = await athPost(ATH_AUTH_URL, '', authToken);
    return r.data;
  }

  // ── MONTO ESPERADO calculado EN EL SERVIDOR (regla 1) ──────────────────────
  // Valida la entrada y devuelve { montoEsperadoCents, refCode, codesArr, weeksVal, title }
  // o lanza un Error con .userMsg/.httpStatus para responder bad().
  async function computeExpected(kind, body) {
    const { code, codes, campaign_id, amount, weeks } = body || {};
    const fail = (msg, status) => { const e = new Error(msg); e.userMsg = msg; e.httpStatus = status || 400; throw e; };

    let codesArr = [], weeksVal = null, refCode, montoEsperadoCents, title;

    if (kind === 'addons') {
      if (!Array.isArray(codes) || codes.length < 1 || codes.length > 10) fail('Selecciona entre 1 y 10 add-ons');
      codesArr = [...new Set(codes.map(c => String(c == null ? '' : c).trim()).filter(c => c && c.length <= 60))];
      if (!codesArr.length) fail('Códigos de add-ons inválidos');
      const a = await db.query(`SELECT code, price_cents FROM addon_catalog WHERE code = ANY($1::text[])`, [codesArr]);
      if (a.rows.length !== codesArr.length) fail('Algún add-on no existe', 404);
      montoEsperadoCents = a.rows.reduce((s, r) => s + r.price_cents, 0);
      refCode = codesArr.join(',');
      title = 'Add-ons (' + codesArr.length + ')';
    } else if (kind === 'ad_budget') {
      if (!isUuid(campaign_id)) fail('Campaña inválida');
      if (!Number.isInteger(amount) || amount <= 0 || amount > 100000000) fail('Monto de presupuesto inválido');
      montoEsperadoCents = amount;
      refCode = campaign_id;
      title = 'Presupuesto de anuncio';
    } else if (kind === 'plan') {
      if (!isStr(code, 60)) fail('Código inválido');
      refCode = code.trim();
      if (refCode === 'free') fail('El plan gratis no se cobra');
      const p = await db.query(`SELECT name, price_monthly_cents FROM plans WHERE code = $1`, [refCode]);
      if (!p.rows[0]) fail('Plan no existe', 404);
      montoEsperadoCents = p.rows[0].price_monthly_cents;
      if (!Number.isInteger(montoEsperadoCents) || montoEsperadoCents <= 0) fail('Este plan no es cobrable');
      title = 'Plan ' + (p.rows[0].name || refCode);
    } else if (kind === 'addon') {
      if (!isStr(code, 60)) fail('Código inválido');
      refCode = code.trim();
      const a = await db.query(`SELECT name, price_cents FROM addon_catalog WHERE code = $1`, [refCode]);
      if (!a.rows[0]) fail('Add-on no existe', 404);
      montoEsperadoCents = a.rows[0].price_cents;
      title = a.rows[0].name || 'Add-on';
    } else if (kind === 'featured') {
      if (!isStr(code, 60) || code.trim() !== 'featured') fail('Código de destacado inválido');
      refCode = 'featured';
      weeksVal = Number.isInteger(weeks) ? weeks : 0;
      if (weeksVal < 1 || weeksVal > 12) fail('Semanas entre 1 y 12');
      const f = await db.query(`SELECT price_cents FROM addon_catalog WHERE code = 'featured'`);
      if (!f.rows[0]) fail('Destacado no disponible', 404);
      montoEsperadoCents = f.rows[0].price_cents * weeksVal;
      title = 'Destacado';
    } else {
      fail('Tipo de cobro inválido');
    }
    return { montoEsperadoCents, refCode, codesArr, weeksVal, title };
  }

  // ── ACTIVAR la compra (mismos patrones SQL que el grant del admin) ─────────
  // Corre dentro de una transacción (client). Devuelve la fila activada. Lanza
  // Error (.userMsg/.httpStatus) en los casos raros de no-encontrado.
  async function activatePurchase(client, business, kind, refCode, codesArr, campaignId, weeksVal, montoEsperadoCents) {
    const fail = (msg, status) => { const e = new Error(msg); e.userMsg = msg; e.httpStatus = status || 404; throw e; };

    if (kind === 'plan') {
      const up = await client.query(
        `UPDATE subscriptions
            SET plan_code = $2::plan_code, status = 'active',
                current_period_start = now(), current_period_end = now() + interval '1 month',
                cancel_at_period_end = false, trial_ends_at = NULL
          WHERE business_id = $1
          RETURNING plan_code, status, current_period_end`,
        [business.id, refCode]);
      if (!up.rows[0]) fail('El negocio no tiene suscripción registrada');
      return up.rows[0];
    }
    if (kind === 'addon') {
      const up = await client.query(
        `INSERT INTO addons (business_id, code, price_cents) VALUES ($1,$2,$3)
         ON CONFLICT (business_id, code)
         DO UPDATE SET status = 'active', cancelled_at = NULL, price_cents = $3, activated_at = now()
         RETURNING code, status, price_cents`,
        [business.id, refCode, montoEsperadoCents]);
      return up.rows[0];
    }
    if (kind === 'addons') {
      const acts = [];
      for (const c of codesArr) {
        const pr = await client.query(`SELECT price_cents FROM addon_catalog WHERE code = $1`, [c]);
        const cents = pr.rows[0] ? pr.rows[0].price_cents : 0;
        const up = await client.query(
          `INSERT INTO addons (business_id, code, price_cents) VALUES ($1,$2,$3)
           ON CONFLICT (business_id, code)
           DO UPDATE SET status = 'active', cancelled_at = NULL, price_cents = $3, activated_at = now()
           RETURNING code, status, price_cents`,
          [business.id, c, cents]);
        acts.push(up.rows[0]);
      }
      return acts;
    }
    if (kind === 'ad_budget') {
      const up = await client.query(
        `UPDATE ad_campaigns
            SET budget_cents = budget_cents + $3,
                status = CASE WHEN status = 'paused' THEN 'active' ELSE status END
          WHERE id = $1 AND business_id = $2
          RETURNING id, status, budget_cents`,
        [campaignId, business.id, montoEsperadoCents]);
      if (!up.rows[0]) fail('Campaña no encontrada');
      return up.rows[0];
    }
    // featured
    const c = await client.query(
      `SELECT category_id FROM business_categories WHERE business_id = $1 ORDER BY category_id LIMIT 1`,
      [business.id]);
    const catId = c.rows[0] ? c.rows[0].category_id : null;
    const fl = await client.query(
      `INSERT INTO featured_listings (business_id, municipality_id, category_id, ends_at)
       VALUES ($1, $2, $3, now() + ($4 || ' weeks')::interval)
       RETURNING id, ends_at`,
      [business.id, business.municipality_id || null, catId, String(weeksVal)]);
    await client.query(`UPDATE businesses SET is_featured = true WHERE id = $1`, [business.id]);
    return fl.rows[0];
  }

  // Registra el pago (idempotente por referenceNumber) y activa la compra en UNA
  // transacción. Devuelve { activated } o { already:true }.
  async function recordAndActivate(business, kind, refCode, codesArr, campaignId, weeksVal, montoEsperadoCents, ecommerceId, referenceNumber, raw) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO platform_ath_payments
             (business_id, provider, ecommerce_id, reference_number, kind, ref_code, weeks, amount_cents, status, raw)
           VALUES ($1,'athmovil',$2,$3,$4,$5,$6,$7,'completed',$8)`,
          [business.id, ecommerceId, referenceNumber, kind, refCode, weeksVal, montoEsperadoCents,
           raw ? JSON.stringify(raw) : null]);
      } catch (e) {
        if (e.code === '23505') { await client.query('ROLLBACK'); return { already: true }; }
        throw e;
      }
      const activated = await activatePurchase(client, business, kind, refCode, codesArr, campaignId, weeksVal, montoEsperadoCents);
      await client.query('COMMIT');
      return { activated };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ==========================================================================
  //  GET /api/billing/ath/config — sólo si ATH está disponible (sin secretos)
  // ==========================================================================
  app.get('/api/billing/ath/config', asyncH(async (_req, res) => {
    res.json({ enabled, env: ATHM_ENV });
  }));

  // ==========================================================================
  //  POST /api/billing/ath/create — inicia el pago (manda push a la app del dueño)
  //  authRequired + businessScope. body: { kind, code?|codes?|campaign_id?, amount?, weeks?, phoneNumber }
  //  → { ecommerceId }
  // ==========================================================================
  app.post('/api/billing/ath/create', authRequired, businessScope, asyncH(async (req, res) => {
    if (!enabled) return bad(res, 'El cobro por ATH Móvil no está disponible', 503);
    gcPending();

    const { kind, phoneNumber } = req.body || {};
    if (!['plan', 'addon', 'addons', 'featured', 'ad_budget'].includes(kind)) return bad(res, 'Tipo de cobro inválido');
    const phone = athPhone(phoneNumber);
    if (!phone) return bad(res, 'Escribe un número de ATH Móvil válido (10 dígitos)');

    let exp;
    try { exp = await computeExpected(kind, req.body); }
    catch (e) { if (e.userMsg) return bad(res, e.userMsg, e.httpStatus); throw e; }

    const created = await athCreate(
      exp.montoEsperadoCents, phone,
      String(req.business.id), kind + ':' + exp.refCode, exp.title);
    if (!created) return bad(res, 'ATH Móvil no aceptó el pago. Verifica el número e intenta de nuevo.', 502);

    pendingAth.set(created.ecommerceId, {
      businessId: req.business.id,
      authToken: created.authToken,
      kind, refCode: exp.refCode, codesArr: exp.codesArr,
      campaignId: kind === 'ad_budget' ? exp.refCode : null,
      weeksVal: exp.weeksVal, montoEsperadoCents: exp.montoEsperadoCents,
      createdAt: Date.now(),
    });
    await audit(req, 'billing.ath.create', 'platform_payment', null,
      { kind, code: exp.refCode, amount_cents: exp.montoEsperadoCents });
    res.json({ ecommerceId: created.ecommerceId, amount_cents: exp.montoEsperadoCents });
  }));

  // ==========================================================================
  //  POST /api/billing/ath/status — polling: consulta ATH y, al confirmar, autoriza
  //  y ACTIVA la compra. authRequired + businessScope. body: { ecommerceId }
  //  → { status: 'pending' | 'completed' | 'cancelled', activated? }
  // ==========================================================================
  app.post('/api/billing/ath/status', authRequired, businessScope, asyncH(async (req, res) => {
    if (!enabled) return bad(res, 'El cobro por ATH Móvil no está disponible', 503);
    const { ecommerceId } = req.body || {};
    if (!isStr(ecommerceId, 200)) return bad(res, 'ecommerceId inválido');

    const pend = pendingAth.get(ecommerceId);
    if (!pend || pend.businessId !== req.business.id) return bad(res, 'Pago no encontrado', 404);

    // 1) Estado actual en ATH.
    const found = await athFind(ecommerceId, pend.authToken);
    const st = found && found.ecommerceStatus;

    if (st === 'CANCEL') { pendingAth.delete(ecommerceId); return res.json({ status: 'cancelled' }); }
    if (st !== 'CONFIRM' && st !== 'COMPLETED') return res.json({ status: 'pending' }); // OPEN / null → seguir

    // 2) Capturar (authorization) si aún no está COMPLETED.
    let fin = found;
    if (st === 'CONFIRM') {
      fin = await athAuthorize(pend.authToken);
      if (!fin || fin.ecommerceStatus !== 'COMPLETED')
        return res.json({ status: 'pending' }); // reintenta en el próximo poll
    }

    // 3) El monto verificado DEBE coincidir con el esperado (regla 1).
    const total = Number(fin.total);
    if (!Number.isFinite(total) || Math.round(total * 100) !== pend.montoEsperadoCents)
      return bad(res, 'El monto del pago no coincide', 400);

    // 4) Registrar (idempotente) + activar.
    let result;
    try {
      result = await recordAndActivate(
        req.business, pend.kind, pend.refCode, pend.codesArr, pend.campaignId,
        pend.weeksVal, pend.montoEsperadoCents, ecommerceId, fin.referenceNumber || ecommerceId, fin);
    } catch (e) {
      if (e.userMsg) return bad(res, e.userMsg, e.httpStatus);
      throw e;
    }
    pendingAth.delete(ecommerceId);

    if (!result.already) {
      await audit(req, 'billing.ath.' + pend.kind, 'platform_payment', null,
        { code: pend.refCode, weeks: pend.weeksVal, amount_cents: pend.montoEsperadoCents, reference_number: fin.referenceNumber });
      await notify(req.business.id, 'payment', 'Pago recibido',
        `Recibimos tu pago de $${(pend.montoEsperadoCents / 100).toFixed(2)} por ATH Móvil. ¡Gracias!`,
        { kind: pend.kind, code: pend.refCode });
    }
    res.json({ status: 'completed', kind: pend.kind, activated: result.activated || null });
  }));

  console.log('  ✓ módulo billing ATH montado (flujo REST: create → poll → authorize)');
}

module.exports = { mount };
