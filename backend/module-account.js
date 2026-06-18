// ============================================================================
//  TURNIFY API — módulo: MI CUENTA (Account)
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
  const { asyncH, bad, audit } = h;

  // Orden de planes para saber cuáles son "superiores"
  const PLAN_ORDER = ['free', 'pro', 'studio', 'team', 'grande', 'ilimitado'];

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
      // platform_payments (mensualidades a Turnify): se conservan tal cual

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

      // ── 3. Anonimizar nombres de cliente "congelados" en citas ──
      await client.query(
        `UPDATE appointments
            SET client_name = 'Cliente eliminado',
                client_phone = NULL,
                notes = NULL
          WHERE business_id = $1`, [bizId]);

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
