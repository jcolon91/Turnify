// ============================================================================
//  BUKEAME · module-platform-billing.js
//  Cobro de PLATAFORMA por ATH Móvil Business (Evertec) con la cuenta de WIFNIX.
//  Membresía (plan) · add-ons · destacado — el dinero va a la plataforma.
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base, igual que los otros módulos:
//    require('./module-platform-billing').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
//
//  Reusa los helpers del server base (no los redefine):
//    asyncH, bad, isStr, isUuid, audit, notify
//
//  SEGURIDAD (dinero real, producción) — reglas inviolables:
//   1) El MONTO se calcula SIEMPRE en el servidor (plans / addon_catalog). Tras
//      verificar con ATH se exige Math.round(total*100) === monto_esperado_cents.
//      NUNCA se confía en el "total" del cliente.
//   2) IDEMPOTENCIA: cada referenceNumber se inserta en platform_ath_payments con un
//      índice único; un 2.º intento con el mismo referenceNumber → 409, no reactiva.
//   3) El privateToken vive SOLO en process.env; NUNCA va al frontend, ni se
//      loguea, ni aparece en respuestas. /config expone SÓLO el público.
//   4) /confirm es authRequired + businessScope: el negocio sólo paga LO SUYO
//      (req.business.id).
//   5) Sólo se activa si data.ecommerceStatus === 'COMPLETED'.
//   6) Sin secretos hardcodeados; SQL siempre con parámetros $n.
// ============================================================================

// URL oficial de verificación server-side (producción) — ATH Móvil Business.
const ATH_FIND_PAYMENT_URL =
  'https://payments.athmovil.com/api/business-transaction/ecommerce/business/findPayment';

function mount(app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isStr, audit, notify } = h;

  // ── Config desde el entorno (regla 3 y 6: secretos sólo en process.env) ────
  const ATHM_ENV = process.env.ATHM_ENV || 'production';
  const PUBLIC_TOKEN = process.env.ATHM_PLATFORM_PUBLIC_TOKEN || '';
  const PRIVATE_TOKEN = process.env.ATHM_PLATFORM_PRIVATE_TOKEN || '';
  const enabled = !!(PUBLIC_TOKEN && PRIVATE_TOKEN);

  // ── Helper: verificación SERVER-SIDE del pago con ATH (regla 5) ────────────
  // Hace POST a findPayment con { publicToken, privateToken, ecommerceId }.
  // Devuelve { ok, status, total, referenceNumber, raw }. ok === true SÓLO si
  // data.ecommerceStatus === 'COMPLETED'. Cualquier error de red → ok:false.
  // IMPORTANTE: NUNCA se loguea el privateToken ni el body de la petición.
  async function verifyAthPayment(ecommerceId) {
    try {
      const resp = await fetch(ATH_FIND_PAYMENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          publicToken: PUBLIC_TOKEN,
          privateToken: PRIVATE_TOKEN, // sólo viaja a ATH; nunca al cliente ni al log
          ecommerceId,
        }),
      });
      const json = await resp.json().catch(() => null);
      const data = json && json.data ? json.data : null;
      const completed = !!data && data.ecommerceStatus === 'COMPLETED';
      return {
        ok: completed,
        status: data ? data.ecommerceStatus : null,
        total: data ? Number(data.total) : null,
        referenceNumber: data ? data.referenceNumber : null,
        raw: data || null,
      };
    } catch (e) {
      // Falla cerrado ante error de red (NO se loguea el privateToken).
      console.error('ath.findPayment:', e.message);
      return { ok: false, status: null, total: null, referenceNumber: null, raw: null };
    }
  }

  // ==========================================================================
  //  GET /api/billing/ath/config — SÓLO el token público (regla 3)
  // ==========================================================================
  app.get('/api/billing/ath/config', asyncH(async (_req, res) => {
    res.json({
      enabled,
      env: ATHM_ENV,
      publicToken: enabled ? PUBLIC_TOKEN : null, // el privado JAMÁS sale de aquí
    });
  }));

  // ==========================================================================
  //  POST /api/billing/ath/confirm — verifica el pago y activa la función
  //  authRequired + businessScope (regla 4: sólo activa LO SUYO).
  //  body: { kind:'plan'|'addon'|'featured', code, weeks?, ecommerceId, referenceNumber }
  // ==========================================================================
  app.post('/api/billing/ath/confirm', authRequired, businessScope, asyncH(async (req, res) => {
    if (!enabled) return bad(res, 'El cobro por ATH Móvil no está disponible', 503);

    const { kind, code, weeks, ecommerceId, referenceNumber } = req.body || {};

    // ── Validación de entrada ───────────────────────────────────────────────
    if (!['plan', 'addon', 'featured'].includes(kind)) return bad(res, 'Tipo de cobro inválido');
    if (!isStr(code, 60)) return bad(res, 'Código inválido');
    if (!isStr(ecommerceId, 200)) return bad(res, 'ecommerceId inválido');
    if (!isStr(referenceNumber, 200)) return bad(res, 'referenceNumber inválido');

    let weeksVal = null;
    if (kind === 'featured') {
      weeksVal = Number.isInteger(weeks) ? weeks : 0;
      if (weeksVal < 1 || weeksVal > 12) return bad(res, 'Semanas entre 1 y 12');
    }

    const refCode = code.trim();

    // ── (a) MONTO ESPERADO calculado EN EL SERVIDOR (regla 1) ────────────────
    let montoEsperadoCents;
    if (kind === 'plan') {
      if (refCode === 'free') return bad(res, 'El plan gratis no se cobra');
      const p = await db.query(`SELECT price_monthly_cents FROM plans WHERE code = $1`, [refCode]);
      if (!p.rows[0]) return bad(res, 'Plan no existe', 404);
      montoEsperadoCents = p.rows[0].price_monthly_cents;
      if (!Number.isInteger(montoEsperadoCents) || montoEsperadoCents <= 0)
        return bad(res, 'Este plan no es cobrable', 400);
    } else if (kind === 'addon') {
      const a = await db.query(`SELECT name, price_cents FROM addon_catalog WHERE code = $1`, [refCode]);
      if (!a.rows[0]) return bad(res, 'Add-on no existe', 404);
      montoEsperadoCents = a.rows[0].price_cents;
    } else { // featured
      if (refCode !== 'featured') return bad(res, 'Código de destacado inválido');
      const f = await db.query(`SELECT price_cents FROM addon_catalog WHERE code = 'featured'`);
      if (!f.rows[0]) return bad(res, 'Destacado no disponible', 404);
      montoEsperadoCents = f.rows[0].price_cents * weeksVal;
    }

    // ── (b) Verificar el pago con ATH (regla 5) ──────────────────────────────
    const v = await verifyAthPayment(ecommerceId);
    if (!v.ok) return bad(res, 'No pudimos verificar el pago con ATH Móvil', 402);

    // ── (c) El monto verificado DEBE coincidir con el esperado (regla 1) ─────
    if (Math.round(v.total * 100) !== montoEsperadoCents)
      return bad(res, 'El monto del pago no coincide', 400);

    // ── (d) Transacción: registrar el pago (idempotente) y activar (regla 2) ─
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // INSERT del pago; el índice único (provider, reference_number) garantiza
      // que un 2.º intento con el mismo referenceNumber falle con 23505.
      let payRow;
      try {
        const ins = await client.query(
          `INSERT INTO platform_ath_payments
             (business_id, provider, ecommerce_id, reference_number, kind, ref_code, weeks, amount_cents, status, raw)
           VALUES ($1,'athmovil',$2,$3,$4,$5,$6,$7,'completed',$8)
           RETURNING id`,
          [req.business.id, ecommerceId, referenceNumber, kind, refCode,
           weeksVal, montoEsperadoCents, v.raw ? JSON.stringify(v.raw) : null]);
        payRow = ins.rows[0];
      } catch (e) {
        if (e.code === '23505') {
          await client.query('ROLLBACK');
          return bad(res, 'Este pago ya fue procesado', 409); // idempotente
        }
        throw e;
      }

      // ── ACTIVAR según kind (mismos patrones SQL que module-admin.js) ───────
      let activated;
      if (kind === 'plan') {
        // 1 mes de suscripción (espeja POST /api/admin/businesses/:id/plan, months=1).
        const up = await client.query(
          `UPDATE subscriptions
              SET plan_code = $2::plan_code, status = 'active',
                  current_period_start = now(),
                  current_period_end = now() + interval '1 month',
                  cancel_at_period_end = false, trial_ends_at = NULL
            WHERE business_id = $1
            RETURNING plan_code, status, current_period_end`,
          [req.business.id, refCode]);
        if (!up.rows[0]) {
          await client.query('ROLLBACK');
          return bad(res, 'El negocio no tiene suscripción registrada', 404);
        }
        activated = up.rows[0];
      } else if (kind === 'addon') {
        // INSERT ... ON CONFLICT (espeja el grant de add-on del admin).
        const up = await client.query(
          `INSERT INTO addons (business_id, code, price_cents)
           VALUES ($1,$2,$3)
           ON CONFLICT (business_id, code)
           DO UPDATE SET status = 'active', cancelled_at = NULL, price_cents = $3, activated_at = now()
           RETURNING code, status, price_cents`,
          [req.business.id, refCode, montoEsperadoCents]);
        activated = up.rows[0];
      } else { // featured
        // INSERT featured_listings + marca businesses.is_featured (espeja el admin).
        let catId = null;
        const c = await client.query(
          `SELECT category_id FROM business_categories WHERE business_id = $1 ORDER BY category_id LIMIT 1`,
          [req.business.id]);
        catId = c.rows[0] ? c.rows[0].category_id : null;
        // NOTA: featured_listings.payment_id es FK a la tabla vieja platform_payments,
        // no a platform_ath_payments; por eso lo dejamos NULL (igual que el grant del admin).
        const fl = await client.query(
          `INSERT INTO featured_listings (business_id, municipality_id, category_id, ends_at)
           VALUES ($1, $2, $3, now() + ($4 || ' weeks')::interval)
           RETURNING id, ends_at`,
          [req.business.id, req.business.municipality_id || null, catId, String(weeksVal)]);
        await client.query(`UPDATE businesses SET is_featured = true WHERE id = $1`, [req.business.id]);
        activated = fl.rows[0];
      }

      await client.query('COMMIT');

      // ── (e) Auditoría + notificación ────────────────────────────────────────
      await audit(req, 'billing.ath.' + kind, 'platform_payment', payRow.id,
        { code: refCode, weeks: weeksVal, amount_cents: montoEsperadoCents, reference_number: referenceNumber });
      await notify(req.business.id, 'payment', 'Pago recibido',
        `Recibimos tu pago de $${(montoEsperadoCents / 100).toFixed(2)} por ATH Móvil. ¡Gracias!`,
        { kind, code: refCode });

      res.json({ ok: true, kind, activated });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));

  console.log('  ✓ módulo billing ATH montado');
}

module.exports = { mount };
