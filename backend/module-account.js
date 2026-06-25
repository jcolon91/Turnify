// ============================================================================
//  BUKEAME API — módulo: MI CUENTA (Account)
//  Mi plan (actual + superiores) · Borrado seguro de cuenta
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base:
//    require('./module-account').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
//
//  Reusa helpers del server base: asyncH, bad, audit
//
//  BORRADO DE CUENTA — enfoque legalmente seguro (PR/EEUU):
//    · Datos personales identificables → SE BORRAN (privacidad)
//    · Registros financieros           → SE ANONIMIZAN, no se borran (fiscal 3-7 años)
//    El negocio puede descargar su contabilidad (CSV) ANTES de borrar.
// ============================================================================

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, audit, notify } = h;

  // Orden de planes para saber cuáles son "superiores"
  const PLAN_ORDER = ['free', 'pro', 'studio', 'team', 'grande', 'ilimitado'];

  // Planes válidos para el upgrade self-serve (mismo enum que admin)
  const VALID_PLANS = ['free', 'pro', 'studio', 'team', 'grande', 'ilimitado'];

  // Flag de monetización: 'true' = upgrade/add-ons se activan al instante (pre-Stripe).
  // Cualquier otro valor = queda pendiente hasta confirmar el pago.
  const SELF_SERVE_PAID = process.env.SELF_SERVE_PAID === 'true';

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/account/plan — plan actual + planes superiores con sus beneficios
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/account/plan', authRequired, businessScope, asyncH(async (req, res) => {
    const current = req.business.plan_code;

    // Todos los planes activos
    const plansQ = await db.query(
      `SELECT code, name, price_monthly_cents, price_annual_cents,
              max_staff, max_appts_month, features
         FROM plans WHERE is_active = true`);

    // Estado de la suscripción
    const subQ = await db.query(
      `SELECT plan_code, status, trial_ends_at, current_period_end, created_at
         FROM subscriptions WHERE business_id = $1
         ORDER BY created_at DESC LIMIT 1`, [req.business.id]);

    // Uso del mes actual (citas) para mostrar progreso del límite
    const usageQ = await db.query(
      `SELECT COUNT(*)::int AS n
         FROM appointments
        WHERE business_id = $1
          AND starts_at >= date_trunc('month', now())
          AND status <> 'cancelled_client' AND status <> 'cancelled_business'`,
      [req.business.id]);

    const byCode = {};
    for (const p of plansQ.rows) byCode[p.code] = p;

    const order = (c) => { const i = PLAN_ORDER.indexOf(c); return i < 0 ? 99 : i; };
    const curOrder = order(current);

    // Planes ordenados; marcamos cuál es el actual y cuáles son upgrades
    const plans = plansQ.rows
      .filter(p => PLAN_ORDER.includes(p.code))
      .sort((a, b) => order(a.code) - order(b.code))
      .map(p => ({
        code: p.code,
        name: p.name,
        price_monthly_cents: p.price_monthly_cents,
        price_annual_cents: p.price_annual_cents,
        max_staff: p.max_staff,
        max_appts_month: p.max_appts_month,
        features: p.features,
        is_current: p.code === current,
        is_upgrade: order(p.code) > curOrder,
      }));

    const sub = subQ.rows[0] || null;

    res.json({
      current_code: current,
      current_name: byCode[current] ? byCode[current].name : current,
      subscription: sub ? {
        status: sub.status,
        trial_ends_at: sub.trial_ends_at,
        current_period_end: sub.current_period_end,
        since: sub.created_at,
      } : null,
      usage: {
        appts_this_month: usageQ.rows[0].n,
        max_appts_month: byCode[current] ? byCode[current].max_appts_month : null,
      },
      plans,
    });
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/account/plan — UPGRADE de plan (self-serve)
  //   Body: { plan_code }
  //   · Si SELF_SERVE_PAID === 'true' → aplica el cambio al instante (misma
  //     lógica que POST /api/admin/businesses/:id/plan): para pagos el período
  //     vence en 1 mes; para 'free' queda sin vencimiento. → { ok, plan_code }
  //   · Si NO → registra la solicitud, notifica al negocio y responde 402 con
  //     { pending:true } (el cobro real se activa cuando entre Stripe).
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/account/plan', authRequired, businessScope, asyncH(async (req, res) => {
    const planCode = String(req.body?.plan_code || '').trim().toLowerCase();
    if (!VALID_PLANS.includes(planCode))
      return bad(res, 'Plan inválido. Usa: ' + VALID_PLANS.join(', '));

    // Confirmar que el negocio tiene una suscripción registrada
    const subQ = await db.query(
      `SELECT plan_code FROM subscriptions WHERE business_id = $1`, [req.business.id]);
    if (!subQ.rows[0]) return bad(res, 'El negocio no tiene suscripción registrada', 404);

    // Bajar a 'free' (downgrade) NO requiere pago → aplica al instante.
    if (planCode === 'free') {
      const { rows } = await db.query(
        `UPDATE subscriptions
            SET plan_code = 'free', status = 'active',
                current_period_start = now(), current_period_end = NULL,
                cancel_at_period_end = false, trial_ends_at = NULL
          WHERE business_id = $1
          RETURNING plan_code`,
        [req.business.id]);
      if (!rows[0]) return bad(res, 'El negocio no tiene suscripción registrada', 404);
      await audit(req, 'plan.downgrade', 'business', req.business.id, { plan_code: 'free' });
      return res.json({ ok: true, plan_code: rows[0].plan_code });
    }

    // Subir a un plan DE PAGO NUNCA se aplica solo: requiere pago confirmado. Registramos
    // la solicitud y avisamos; el plan se activa por admin/Stripe tras confirmar el cobro.
    // (NO depende de SELF_SERVE_PAID — los planes nunca suben automáticos sin pago.)
    await audit(req, 'plan.request', 'business', req.business.id, { plan_code: planCode });
    await notify(req.business.id, 'system', 'Solicitud de cambio de plan recibida',
      `Pediste cambiar al plan "${planCode}". Te lo activamos al confirmar el pago.`, { plan_code: planCode });
    return res.status(402).json({ error: 'El cambio a un plan de pago se activa al confirmar el pago.', pending: true });
  }));

  // Helper de rango de plan: ¿el plan del negocio es >= al mínimo requerido?
  // Usa PLAN_ORDER (gratis < pro < studio < team < grande < ilimitado).
  const planAtLeast = (planCode, minCode) => {
    const cur = PLAN_ORDER.indexOf(planCode);
    const min = PLAN_ORDER.indexOf(minCode);
    return cur >= 0 && min >= 0 && cur >= min;
  };

  // Add-ons de CONTABILIDAD del negocio que NO deben ofrecerse en el panel del
  // negocio: la contabilidad completa va INCLUIDA desde el plan Pro, y
  // 'employee_accounting' es SOLO para empleados (no para el panel del negocio).
  // 'advanced_reports' (si existe en el catálogo) sería un duplicado confuso.
  const ACCOUNTING_ADDON_CODES = ['employee_accounting', 'advanced_reports', 'accounting', 'business_accounting'];

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/account/addons — catálogo de add-ons + estado del negocio
  //   → [{ code, name, price_cents, billing, description, is_active }]
  //   is_active = el negocio tiene ese add-on con status 'active'.
  //   REGLAS de negocio (alimenta el panel — loadAddons en panel.html):
  //     · Contabilidad: NO se ofrece como add-on (incluida desde Pro; las de
  //       empleados no van en el panel del negocio) → se EXCLUYE del listado.
  //     · Payroll ($9.99): solo activable desde el plan Studio o superior; en
  //       planes inferiores se devuelve con locked=true para que el panel lo
  //       muestre bloqueado en vez de activable.
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/account/addons', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.code, c.name, c.price_cents, c.billing, c.description,
              (a.code IS NOT NULL) AS is_active
         FROM addon_catalog c
         LEFT JOIN addons a
                ON a.code = c.code
               AND a.business_id = $1
               AND a.status = 'active'
        ORDER BY c.price_cents`, [req.business.id]);

    const studioPlus = planAtLeast(req.business.plan_code, 'studio');

    const addons = rows
      // Excluir cualquier add-on de contabilidad del negocio (no se ofrece aquí).
      .filter(a => !ACCOUNTING_ADDON_CODES.includes(a.code))
      .map(a => {
        // Payroll requiere plan Studio o superior: en planes inferiores se marca
        // bloqueado (locked) con el motivo, para que el panel no permita activarlo.
        if (a.code === 'payroll' && !studioPlus) {
          return { ...a, locked: true, requires_plan: 'studio',
            locked_reason: 'Disponible desde el plan Studio' };
        }
        return a;
      });

    res.json({ addons });
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /api/account — borrado seguro de la cuenta del negocio
  //   Body: { confirm: "BORRAR MI CUENTA" }
  //   Borra datos personales; anonimiza registros financieros.
  // ──────────────────────────────────────────────────────────────────────────
  app.delete('/api/account', authRequired, businessScope, asyncH(async (req, res) => {
    const confirm = (req.body && req.body.confirm) || '';
    if (confirm !== 'BORRAR MI CUENTA')
      return bad(res, 'Debes escribir exactamente: BORRAR MI CUENTA', 400);

    const bizId = req.business.id;
    const userId = req.user.id;

    // Verificar que quien borra es el DUEÑO del negocio
    const own = await db.query(
      `SELECT owner_user_id FROM businesses WHERE id = $1`, [bizId]);
    if (!own.rows[0] || own.rows[0].owner_user_id !== userId)
      return bad(res, 'Solo el dueño puede borrar la cuenta', 403);

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // ── 1. ANONIMIZAR registros financieros (NO se borran, ley fiscal) ──
      // payments: quitar vínculo a cliente/cita identificable, conservar montos
      await client.query(
        `UPDATE payments SET client_id = NULL, external_ref = NULL
          WHERE business_id = $1`, [bizId]);
      // platform_payments (mensualidades a Bukeame): se conservan tal cual

      // ── 2. ANONIMIZAR/eliminar datos personales de CLIENTES del negocio ──
      // Conservamos la fila (para que las stats financieras cuadren) pero
      // borramos lo identificable.
      await client.query(
        `UPDATE clients
            SET full_name = 'Cliente eliminado',
                phone     = 'deleted-' || left(md5(random()::text), 12),
                email     = NULL,
                notes     = NULL,
                user_id   = NULL
          WHERE business_id = $1`, [bizId]);

      // ── 3. (Las citas NO guardan datos personales "congelados": sólo
      //       referencian al cliente por client_id, ya anonimizado arriba.) ──

      // ── 4. BORRAR contenido no-financiero del negocio ──
      // Estas tablas son operativas/personales, no fiscales → se eliminan.
      const toDelete = [
        'gallery_photos', 'product_photos', 'time_blocks', 'waitlist',
        'reviews', 'campaigns', 'notifications', 'message_log',
        'loyalty_progress', 'loyalty_programs', 'gift_card_redemptions',
        'gift_cards', 'addons', 'product_orders', 'products',
        'service_staff', 'services', 'staff_hours', 'staff',
        'business_hours', 'business_categories', 'featured_listings',
      ];
      for (const t of toDelete) {
        // Algunas tablas referencian business_id directo; otras por relación.
        // Borramos sólo las que tienen business_id (las demás caen por CASCADE
        // cuando se borre el negocio si aplica).
        await client.query(
          `DELETE FROM ${t} WHERE business_id = $1`, [bizId]).catch(() => {});
      }

      // ── 5. DESPUBLICAR y anonimizar el NEGOCIO (datos personales) ──
      // Conservamos la fila para integridad de payments, pero la sacamos del
      // marketplace y borramos identidad/contacto.
      await client.query(
        `UPDATE businesses
            SET name = 'Negocio eliminado',
                bio = NULL, phone = NULL, whatsapp = NULL, email = NULL,
                address_line = NULL, lat = NULL, lng = NULL,
                logo_url = NULL, cover_url = NULL,
                social = '{}'::jsonb,
                ath_phone = NULL, stripe_account_id = NULL,
                is_published = false,
                slug = 'deleted-' || left(md5(random()::text), 16),
                deleted_at = now()
          WHERE id = $1`, [bizId]).catch(async (e) => {
            // Si 'deleted_at' no existe en businesses, repetir sin esa columna
            await client.query(
              `UPDATE businesses
                  SET name = 'Negocio eliminado',
                      bio = NULL, phone = NULL, whatsapp = NULL, email = NULL,
                      address_line = NULL, lat = NULL, lng = NULL,
                      logo_url = NULL, cover_url = NULL,
                      social = '{}'::jsonb,
                      ath_phone = NULL, stripe_account_id = NULL,
                      is_published = false,
                      slug = 'deleted-' || left(md5(random()::text), 16)
                WHERE id = $1`, [bizId]);
          });

      // ── 6. CANCELAR suscripción ──
      await client.query(
        `UPDATE subscriptions SET status = 'cancelled'
          WHERE business_id = $1`, [bizId]).catch(() => {});

      // ── 7. BORRAR datos personales del USUARIO dueño ──
      // Soft-delete + anonimización (deleted_at ya existe en users).
      await client.query(
        `UPDATE users
            SET full_name = 'Usuario eliminado',
                email = NULL,
                phone = NULL,
                password_hash = NULL,
                avatar_url = NULL,
                deleted_at = now()
          WHERE id = $1`, [userId]);

      // ── 8. Revocar todas las sesiones (refresh tokens) ──
      await client.query(
        `DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]).catch(() => {});

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await audit(req, 'account.delete', 'business', bizId, { anonymized: true });
    res.json({ ok: true, message: 'Cuenta eliminada. Datos personales borrados; registros financieros anonimizados por requisito fiscal.' });
  }));
};
