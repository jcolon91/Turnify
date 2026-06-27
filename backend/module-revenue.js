// ============================================================================
//  BUKEAME API — módulo A: REVENUE
//  Productos/tienda · Gift cards · Add-ons · Destacados
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base:
//    const revenue = require('./module-revenue');
//    revenue.mount(app, { db, authRequired, businessScope, helpers });
//
//  Reusa los helpers del server base (no los redefine):
//    asyncH, bad, isStr, isUuid, isEmail, isPhone, normPhone, audit, notify
// ============================================================================

const crypto = require('crypto');

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isStr, isUuid, isEmail, isPhone, normPhone, audit, notify, bookingLimiter, publicLimiter, codeLimiter } = h;

  // ---- helpers locales ----
  const cents = v => Number.isInteger(v) && v >= 0 && v <= 100000000; // ≤ $1M
  const posInt = v => Number.isInteger(v) && v > 0;

  // ---- Pago de órdenes de tienda (espeja la infra de depósitos) ----
  const athRest = require('./ath-rest');
  // ecommerceId → { slug, orderId, businessId, authToken, publicToken, expectedCents, createdAt }
  const athOrderPending = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 12 * 60_000;
    for (const [k, v] of athOrderPending) if (v.createdAt < cutoff) athOrderPending.delete(k);
  }, 60_000);

  // Worker: anula las gift cards 'pending' nunca confirmadas tras 7 días, para que no se
  // acumulen pendientes basura en el panel/notificaciones. 'void' = no gastable.
  // Idempotente (solo toca 'pending'); corre cada 6 horas.
  setInterval(async () => {
    try {
      await db.query(`UPDATE gift_cards SET status = 'void', balance_cents = 0
        WHERE status = 'pending' AND created_at < now() - interval '7 days'`);
    } catch (e) { console.error('giftcard cleanup:', e.message); }
  }, 6 * 3600_000);

  // EL ÚNICO lugar donde el inventario se descuenta y la gift card se redime: SOLO al
  // CONFIRMAR el pago (AUTO verificado o MANUAL validado por el negocio). Atómico +
  // idempotente (guard 'committed'; cubre órdenes legacy ya descontadas). FOR UPDATE
  // serializa dos confirmaciones simultáneas (poll AUTO + validar manual).
  // Devuelve { applied | alreadyCommitted | oversell+item | missing }.
  async function confirmOrderPayment(orderId, businessId, opts = {}) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const o = await client.query(
        `SELECT id, items, total_cents, gift_card_id, status, committed
           FROM product_orders WHERE id = $1 AND business_id = $2 FOR UPDATE`, [orderId, businessId]);
      const ord = o.rows[0];
      if (!ord) { await client.query('ROLLBACK'); return { missing: true }; }
      // Guard idempotente: si ya se aplicó stock+gift (o es legacy), solo sella 'paid'.
      if (ord.committed) {
        await client.query(
          `UPDATE product_orders SET status = CASE WHEN status = 'pending' THEN 'paid' ELSE status END,
                  paid_at = COALESCE(paid_at, now()) WHERE id = $1`, [orderId]);
        await client.query('COMMIT');
        return { alreadyCommitted: true };
      }
      // Descontar inventario con el MISMO guard anti-sobreventa que el flujo viejo
      // (stock NULL = ilimitado → nunca bloquea).
      const items = Array.isArray(ord.items) ? ord.items : [];
      for (const it of items) {
        const u = await client.query(
          `UPDATE products SET stock = stock - $1
            WHERE id = $2 AND business_id = $3 AND (stock IS NULL OR stock >= $1)`,
          [it.qty, it.product_id, businessId]);
        if (u.rowCount === 0) { await client.query('ROLLBACK'); return { oversell: true, item: it.name }; }
      }
      // Redimir gift card (si hay) con lock + guard de saldo. CHECK(amount_cents>0) del
      // schema → SOLO insertamos la redención si giftApplied > 0.
      let giftApplied = 0;
      if (ord.gift_card_id) {
        const gl = await client.query(
          `SELECT balance_cents, status FROM gift_cards WHERE id = $1 AND business_id = $2 FOR UPDATE`,
          [ord.gift_card_id, businessId]);
        const gc = gl.rows[0];
        if (gc && ['active', 'partial'].includes(gc.status) && gc.balance_cents > 0) {
          giftApplied = Math.min(gc.balance_cents, ord.total_cents);
          if (giftApplied > 0) {
            await client.query(`INSERT INTO gift_card_redemptions (gift_card_id, amount_cents) VALUES ($1,$2)`,
              [ord.gift_card_id, giftApplied]);
            await client.query(
              `UPDATE gift_cards SET balance_cents = balance_cents - $1,
                  status = CASE WHEN balance_cents - $1 <= 0 THEN 'redeemed' ELSE 'partial' END
                WHERE id = $2 AND balance_cents >= $1`, [giftApplied, ord.gift_card_id]);
          }
        }
      }
      await client.query(
        `UPDATE product_orders SET status = 'paid', paid_at = now(), committed = true WHERE id = $1`, [orderId]);
      await client.query('COMMIT');
      // Si el cobro AUTO se calculó con un estimado de gift distinto del real, avisa al
      // negocio para que cobre/reembolse la diferencia (no bloquea la confirmación).
      if (opts.expectedBalanceDue != null && (ord.total_cents - giftApplied) !== opts.expectedBalanceDue) {
        const diff = (Math.abs((ord.total_cents - giftApplied) - opts.expectedBalanceDue) / 100).toFixed(2);
        try {
          await notify(businessId, 'order', '⚠️ Gift card de orden cambió',
            `La gift card cubrió distinto de lo estimado · diferencia $${diff} · ajusta el cobro`, { order_id: orderId });
        } catch (e) {}
      }
      return { applied: true, giftApplied };
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  // SEGURIDAD (monetización): NINGUNA función paga se concede sin pago confirmado —
  // ni planes, ni add-ons, ni destacado. El cobro es manual (ATH/transferencia) y la
  // función se concede SOLO cuando el admin confirma el dinero recibido vía
  // POST /api/admin/businesses/:id/addons (y .../featured). NO hay flag para saltarlo:
  // "si no pagas, no lo tienes". (El antiguo SELF_SERVE_PAID quedó deprecado.)

  // genera código legible para gift cards: <PREFIJO>-GIFT-XXXX (sin caracteres ambiguos)
  function giftCode(slug) {
    const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin O/0/I/1/L
    let suf = '';
    for (let i = 0; i < 5; i++) suf += alpha[crypto.randomInt(alpha.length)];
    const pre = (slug || 'TF').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || 'TF';
    return `${pre}-GIFT-${suf}`;
  }

  // ¿el negocio tiene un add-on activo? (incluye trial premium para features de plan)
  async function hasAddon(businessId, code) {
    const { rows } = await db.query(
      `SELECT 1 FROM addons WHERE business_id = $1 AND code = $2 AND status = 'active'
         AND (current_period_end IS NULL OR now() <= current_period_end + interval '7 days')`,
      [businessId, code]);
    return !!rows[0];
  }

  // límite de productos según add-ons (suma los tiers activos:
  // store_10 → +10, store_25 → +25; ambos → 35; ninguno → 0)
  async function productLimit(businessId) {
    const { rows } = await db.query(
      `SELECT code FROM addons WHERE business_id = $1 AND status = 'active'
         AND (current_period_end IS NULL OR now() <= current_period_end + interval '7 days')
         AND code IN ('store_10','store_25')`, [businessId]);
    return (rows.some(r => r.code === 'store_10') ? 10 : 0)
         + (rows.some(r => r.code === 'store_25') ? 25 : 0);
  }

  // ==========================================================================
  //  ADD-ONS
  // ==========================================================================
  // Orden de planes (gratis < pro < studio < team < grande < ilimitado).
  const PLAN_ORDER = ['free', 'pro', 'studio', 'team', 'grande', 'ilimitado'];
  // ¿el plan del negocio es >= al mínimo requerido?
  const planAtLeast = (planCode, minCode) => {
    const cur = PLAN_ORDER.indexOf(planCode);
    const min = PLAN_ORDER.indexOf(minCode);
    return cur >= 0 && min >= 0 && cur >= min;
  };

  // "Contabilidad completa" (employee_accounting) va INCLUIDA en planes Pro o
  // superior: cualquier plan distinto de 'free'. El front deshabilita ese add-on
  // cuando accounting_included = true (ya lo tiene por el plan; no se cobra aparte).
  const accountingIncluded = planCode => planCode !== 'free';

  // Add-ons de contabilidad del negocio que NO se ofrecen en el panel del negocio
  // (la contabilidad completa va incluida desde Pro; las de empleados no aplican aquí).
  const ACCOUNTING_ADDON_CODES = ['employee_accounting', 'advanced_reports', 'accounting', 'business_accounting'];

  app.get('/api/addons/catalog', asyncH(async (_req, res) => {
    // Catálogo completo: incluye automáticamente 'payroll' y 'employee_accounting'
    // (migración 17). Mismas columnas que las demás filas de addon_catalog.
    const { rows } = await db.query(
      `SELECT code, name, price_cents, billing, description FROM addon_catalog ORDER BY price_cents`);
    res.json({ catalog: rows });
  }));

  app.get('/api/addons', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT a.code, a.status, a.price_cents, a.activated_at, a.current_period_end,
              a.cancel_at_period_end, c.name, c.billing, c.description
         FROM addons a JOIN addon_catalog c ON c.code = a.code
        WHERE a.business_id = $1 ORDER BY a.activated_at DESC`, [req.business.id]);
    // Catálogo completo (incluye 'payroll' y 'employee_accounting' de la migración 17).
    // CONSISTENCIA con GET /api/account/addons (el que alimenta el panel):
    //   · Excluimos los add-ons de contabilidad del negocio (no se ofrecen aquí;
    //     la contabilidad completa ya viene incluida desde Pro).
    //   · Payroll requiere Studio o superior: en planes inferiores se marca locked.
    const cat = await db.query(
      `SELECT code, name, price_cents, billing, description FROM addon_catalog ORDER BY price_cents`);
    const studioPlus = planAtLeast(req.business.plan_code, 'studio');
    const catalog = cat.rows
      .filter(c => !ACCOUNTING_ADDON_CODES.includes(c.code))
      .map(c => (c.code === 'payroll' && !studioPlus)
        ? { ...c, locked: true, requires_plan: 'studio', locked_reason: 'Disponible desde el plan Studio' }
        : c);
    res.json({
      addons: rows,
      catalog,
      accounting_included: accountingIncluded(req.business.plan_code),
    });
  }));

  app.post('/api/addons/:code/activate', authRequired, businessScope, asyncH(async (req, res) => {
    const code = req.params.code;
    const cat = await db.query(`SELECT * FROM addon_catalog WHERE code = $1`, [code]);
    if (!cat.rows[0]) return bad(res, 'Add-on no existe', 404);

    // plan free no puede activar add-ons que dependan de integraciones externas
    if (code === 'custom_domain' && !(req.business.features?.external_integrations))
      return bad(res, 'El dominio propio requiere un plan pago', 403);

    // La contabilidad completa ya viene incluida en planes Pro o superior:
    // no se cobra como add-on a esos planes (el front también lo deshabilita).
    if (code === 'employee_accounting' && accountingIncluded(req.business.plan_code))
      return bad(res, 'La contabilidad completa ya está incluida en tu plan', 409);

    // Payroll ($9.99) requiere plan Studio o superior. En gratis/pro se rechaza.
    if (code === 'payroll' && !planAtLeast(req.business.plan_code, 'studio'))
      return bad(res, 'Disponible desde el plan Studio', 403);

    const price = cat.rows[0].price_cents;

    // SEGURIDAD: el add-on NO se activa sin pago confirmado. Registramos la solicitud y
    // notificamos; el admin lo activa al recibir el dinero (POST /api/admin/businesses/:id/addons).
    // SIEMPRE 402 → "si no pagas, no lo tienes". La activación real la hace SOLO el admin.
    await audit(req, 'addon.request', 'addon', null, { code, price_cents: price });
    await notify(req.business.id, 'system', 'Solicitud de add-on recibida',
      `Pediste activar "${cat.rows[0].name}". Te lo activamos al confirmar el pago.`, { code });
    return bad(res, `Para activar "${cat.rows[0].name}" ($${(price / 100).toFixed(2)}) confirma el pago. Te lo activamos enseguida.`, 402);
  }));

  // Desactivar = cancelar la RENOVACIÓN, NO el beneficio. El add-on sigue 'active'
  // y el cliente lo conserva hasta el fin del período pagado (+7 días de gracia);
  // el worker lo expira solo después. Esto arregla el bug de pérdida inmediata.
  app.post('/api/addons/:code/cancel', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE addons SET cancel_at_period_end = true
        WHERE business_id = $1 AND code = $2 AND status = 'active'
        RETURNING code, current_period_end`, [req.business.id, req.params.code]);
    if (!rows[0]) return bad(res, 'Add-on no activo', 404);
    await audit(req, 'addon.cancel_renewal', 'addon', null, { code: req.params.code });
    res.json({ ok: true, cancel_at_period_end: true, current_period_end: rows[0].current_period_end,
      note: 'Cancelamos la renovación. El beneficio sigue activo hasta el fin del período pagado.' });
  }));

  // ==========================================================================
  //  PRODUCTOS (tienda) — máx 4 fotos por producto (también forzado en DB)
  // ==========================================================================
  app.get('/api/products', authRequired, businessScope, asyncH(async (req, res) => {
    // El SELECT hace p.* → incluye automáticamente category, tagline y features
    // (jsonb, nunca NULL por el DEFAULT '[]') tras la migración 13. Sumamos por
    // producto: fotos, resumen de calificación (rating_avg 1 decimal / rating_count)
    // y reseñas recientes (hasta 20) desde product_reviews (migración 12).
    const { rows } = await db.query(
      `SELECT p.*, COALESCE(
           (SELECT json_agg(json_build_object('id',ph.id,'url',ph.url,'sort_order',ph.sort_order)
                            ORDER BY ph.sort_order)
              FROM product_photos ph WHERE ph.product_id = p.id), '[]') AS photos,
           (SELECT round(avg(r.rating)::numeric, 1) FROM product_reviews r
              WHERE r.product_id = p.id) AS rating_avg,
           COALESCE((SELECT count(*)::int FROM product_reviews r
              WHERE r.product_id = p.id), 0) AS rating_count,
           COALESCE(
             (SELECT json_agg(rv ORDER BY rv.created_at DESC)
                FROM (SELECT reviewer_name, rating, comment, verified, created_at
                        FROM product_reviews r WHERE r.product_id = p.id
                       ORDER BY created_at DESC LIMIT 20) rv), '[]') AS reviews
         FROM products p
        WHERE p.business_id = $1 AND p.is_active
        ORDER BY p.sort_order, p.created_at`, [req.business.id]);
    // slug del negocio (para que el dueño arme enlaces/preview de la tienda)
    const bz = await db.query(`SELECT slug FROM businesses WHERE id = $1`, [req.business.id]);
    const limit = await productLimit(req.business.id);
    // rating_avg llega como string (numeric de pg) → number con 1 decimal, o null.
    const products = rows.map(p => ({
      ...p,
      rating_avg: p.rating_avg == null ? null : Number(p.rating_avg),
      rating_count: Number(p.rating_count) || 0,
    }));
    res.json({ slug: bz.rows[0]?.slug || null, limit, used: products.length, products });
  }));

  app.post('/api/products', authRequired, businessScope, asyncH(async (req, res) => {
    const { name, description, price_cents, stock, variants, is_featured, photos, category, tagline, features } = req.body || {};
    if (!isStr(name, 120)) return bad(res, 'Nombre del producto requerido');
    if (!cents(price_cents)) return bad(res, 'Precio inválido');
    if (stock != null && (!Number.isInteger(stock) || stock < 0)) return bad(res, 'Inventario inválido');

    // Campos de presentación (tienda enriquecida). category/tagline → null si vacíos.
    const catVal = isStr(category, 60) ? category.trim() || null : null;
    const tagVal = isStr(tagline, 120) ? tagline.trim() || null : null;
    // features: arreglo de strings (<=120 c/u), máx 8; se guarda como JSON en jsonb.
    const featArr = Array.isArray(features)
      ? features.filter(f => isStr(f, 120)).slice(0, 8) : [];

    const limit = await productLimit(req.business.id);
    if (limit === 0)
      return bad(res, 'Activa el add-on de Tienda para vender productos', 403);

    const count = await db.query(
      `SELECT count(*)::int n FROM products WHERE business_id = $1 AND is_active`, [req.business.id]);
    if (count.rows[0].n >= limit)
      return bad(res, `Tu add-on permite ${limit} productos. Sube a 25 para más.`, 403);

    // fotos: máximo 4
    let photoArr = Array.isArray(photos) ? photos.filter(u => isStr(u, 600)) : [];
    if (photoArr.length > 4) return bad(res, 'Máximo 4 fotos por producto');

    // variantes: validar estructura básica
    let vArr = [];
    if (Array.isArray(variants)) {
      for (const v of variants.slice(0, 5)) {
        if (isStr(v?.name, 40) && Array.isArray(v?.options))
          vArr.push({ name: v.name.trim(), options: v.options.slice(0, 20).filter(o => isStr(o, 40)) });
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO products (business_id, name, description, price_cents, stock, variants, is_featured, category, tagline, features)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,false),$8,$9,$10) RETURNING *`,
        [req.business.id, name.trim(), description || null, price_cents,
         Number.isInteger(stock) ? stock : null, JSON.stringify(vArr), is_featured,
         catVal, tagVal, JSON.stringify(featArr)]);
      const prod = rows[0];
      for (let i = 0; i < photoArr.length; i++)
        await client.query(
          `INSERT INTO product_photos (product_id, url, sort_order) VALUES ($1,$2,$3)`,
          [prod.id, photoArr[i], i]);
      await client.query('COMMIT');
      await audit(req, 'product.create', 'product', prod.id);
      res.status(201).json({ product: { ...prod, photos: photoArr } });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === 'check_violation') return bad(res, 'Máximo 4 fotos por producto');
      throw e;
    } finally { client.release(); }
  }));

  app.patch('/api/products/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const allowed = ['name', 'description', 'price_cents', 'stock', 'is_active', 'is_featured', 'sort_order', 'category', 'tagline'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) {
      if (k === 'price_cents' && !cents(req.body[k])) return bad(res, 'Precio inválido');
      vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`);
    }
    if (Array.isArray(req.body?.variants)) {
      const vArr = req.body.variants.slice(0, 5)
        .filter(v => isStr(v?.name, 40) && Array.isArray(v?.options))
        .map(v => ({ name: v.name.trim(), options: v.options.slice(0, 20).filter(o => isStr(o, 40)) }));
      vals.push(JSON.stringify(vArr)); sets.push(`variants = $${vals.length}`);
    }
    if (Array.isArray(req.body?.features)) {
      const fArr = req.body.features.filter(f => isStr(f, 120)).slice(0, 8);
      vals.push(JSON.stringify(fArr)); sets.push(`features = $${vals.length}`);
    }
    if (!sets.length) return bad(res, 'Nada que actualizar');
    vals.push(req.params.id, req.business.id);
    const { rows } = await db.query(
      `UPDATE products SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND business_id = $${vals.length} RETURNING *`, vals);
    if (!rows[0]) return bad(res, 'Producto no encontrado', 404);
    res.json({ product: rows[0] });
  }));

  app.delete('/api/products/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    await db.query(`UPDATE products SET is_active = false WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.business.id]);
    res.json({ ok: true });
  }));

  // fotos: añadir (respeta límite 4) y borrar
  app.post('/api/products/:id/photos', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { url } = req.body || {};
    if (!isStr(url, 600)) return bad(res, 'URL de foto requerida');
    const own = await db.query(`SELECT 1 FROM products WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.business.id]);
    if (!own.rows[0]) return bad(res, 'Producto no encontrado', 404);
    try {
      const { rows } = await db.query(
        `INSERT INTO product_photos (product_id, url,
            sort_order) VALUES ($1,$2,
            (SELECT COALESCE(max(sort_order)+1,0) FROM product_photos WHERE product_id = $1))
         RETURNING id, url, sort_order`, [req.params.id, url]);
      res.status(201).json({ photo: rows[0] });
    } catch (e) {
      if (e.code === 'check_violation') return bad(res, 'Máximo 4 fotos por producto', 409);
      throw e;
    }
  }));

  app.delete('/api/products/:id/photos/:photoId', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id) || !isUuid(req.params.photoId)) return bad(res, 'ID inválido');
    await db.query(
      `DELETE FROM product_photos ph USING products p
        WHERE ph.id = $1 AND ph.product_id = p.id AND p.id = $2 AND p.business_id = $3`,
      [req.params.photoId, req.params.id, req.business.id]);
    res.json({ ok: true });
  }));

  // ==========================================================================
  //  PEDIDOS de productos (público — el cliente compra en la página)
  // ==========================================================================
  app.post('/api/public/:slug/orders', bookingLimiter, asyncH(async (req, res) => {
    const { items, buyer_name, buyer_phone, buyer_email, fulfillment, gift_code, ad_campaign_id, payment_method } = req.body || {};
    if (!isStr(buyer_name, 120)) return bad(res, 'Tu nombre es requerido');
    if (!Array.isArray(items) || !items.length || items.length > 50) return bad(res, 'Carrito inválido');

    const b = await db.query(`SELECT id, slug FROM businesses WHERE slug = $1 AND deleted_at IS NULL`,
      [req.params.slug]);
    const biz = b.rows[0];
    if (!biz) return bad(res, 'Negocio no encontrado', 404);

    // validar cada item contra la DB (nunca confiar en el precio del cliente)
    let total = 0;
    const validItems = [];
    for (const it of items) {
      if (!isUuid(it?.product_id) || !posInt(it?.qty) || it.qty > 99) return bad(res, 'Item inválido');
      const p = await db.query(
        `SELECT id, name, price_cents, stock FROM products
          WHERE id = $1 AND business_id = $2 AND is_active`, [it.product_id, biz.id]);
      if (!p.rows[0]) return bad(res, 'Un producto ya no está disponible', 409);
      const prod = p.rows[0];
      if (prod.stock != null && prod.stock < it.qty)
        return bad(res, `Sin suficiente inventario de ${prod.name}`, 409);
      const line = prod.price_cents * it.qty;
      total += line;
      validItems.push({
        product_id: prod.id, name: prod.name, qty: it.qty,
        price_cents: prod.price_cents, variant: isStr(it.variant, 80) ? it.variant : null,
      });
    }

    // gift card (opcional): validamos existencia/saldo aquí, pero el monto final se
    // recalcula DENTRO de la transacción con bloqueo de fila (anti doble-gasto en carrera).
    let giftId = null;
    if (isStr(gift_code, 40)) {
      const g = await db.query(
        `SELECT id, status FROM gift_cards
          WHERE business_id = $1 AND code = $2`, [biz.id, gift_code.trim().toUpperCase()]);
      if (!g.rows[0] || !['active', 'partial'].includes(g.rows[0].status))
        return bad(res, 'Gift card inválida o sin saldo', 400);
      giftId = g.rows[0].id;
    }

    // El inventario y la gift card NO se mueven al crear: solo al CONFIRMAR el pago
    // (confirmOrderPayment). Aquí solo se valida disponibilidad y se crea 'pending'.
    // Método de pago elegido por el cliente → enum + bandera manual_validate:
    //   ath_business/card = AUTO (paga antes de reservar) · ath_manual/cash = MANUAL
    //   (el negocio valida). Sin método válido → manual (el negocio gestiona).
    const PM = {
      ath_business: { method: 'ath_movil', manual: false },
      card:         { method: 'card',      manual: false },
      ath_manual:   { method: 'ath_movil', manual: true },
      cash:         { method: 'cash',      manual: true },
    };
    const pmSel = PM[payment_method] || { method: null, manual: true };
    let pmMethod = pmSel.method, pmManual = pmSel.manual;

    // Estimado de gift card (lectura, sin redimir): fija el monto a cobrar en AUTO.
    let giftEstimate = 0;
    if (giftId) {
      const gl = await db.query(`SELECT balance_cents FROM gift_cards WHERE id = $1 AND business_id = $2`, [giftId, biz.id]);
      if (gl.rows[0]) giftEstimate = Math.min(gl.rows[0].balance_cents || 0, total);
    }
    const balanceDue = total - giftEstimate;
    // Si hay gift card aplicada → SIEMPRE MANUAL: el negocio confirma (redime la gift +
    // descuenta stock con el saldo REAL bajo lock). Esto elimina la carrera del estimado
    // (cobrar AUTO con un estimado viejo si la gift se gasta en otra orden entremedio) y
    // el caso de gift que cubre todo (cobro $0). Sin gift, AUTO/MANUAL según el método.
    if (giftId || balanceDue <= 0) { pmManual = true; }

    const { rows } = await db.query(
      `INSERT INTO product_orders (business_id, buyer_name, buyer_phone, buyer_email,
          items, total_cents, fulfillment, gift_card_id, status, payment_method, manual_validate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10) RETURNING id`,
      [biz.id, buyer_name.trim(),
       isPhone(buyer_phone) ? normPhone(buyer_phone) : null,
       isEmail(buyer_email) ? buyer_email.toLowerCase() : null,
       JSON.stringify(validItems), total,
       fulfillment === 'shipping' ? 'shipping' : 'pickup', giftId, pmMethod, pmManual]);
    const orderId = rows[0].id;

    await notify(biz.id, 'order', pmManual ? '🛒 Nueva orden — valida el pago' : 'Nueva venta de producto',
      `${buyer_name.trim()} · $${(total / 100).toFixed(2)}`, { order_id: orderId });

    // Atribución de conversión si la compra vino de un anuncio promocionado.
    if (isUuid(ad_campaign_id)) {
      try { await require('./module-ads').recordConversion(db, ad_campaign_id, orderId, biz.id); } catch (e) {}
    }

    res.status(201).json({
      order_id: orderId,
      total_cents: total,
      gift_applied_cents: giftEstimate,
      balance_due_cents: balanceDue,
      payment_method: pmMethod,
      manual_validate: pmManual,
    });
  }));

  // ── Pago AUTO de orden por ATH Móvil (REST) — espeja el depósito de cita ──────
  // El cobro va DIRECTO a la cuenta del negocio (su publicToken). Verifica el monto
  // (== balance_due) y al completar llama confirmOrderPayment (descuenta stock+gift).
  app.post('/api/public/:slug/orders/:id/ath/start', codeLimiter, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { rows } = await db.query(
      `SELECT o.id, o.business_id, o.total_cents, o.gift_card_id, o.status, o.committed, o.buyer_phone,
              pp.config->>'ath_public_token' AS public_token
         FROM product_orders o
         JOIN businesses b ON b.id = o.business_id AND b.slug = $1 AND b.deleted_at IS NULL
         LEFT JOIN payment_providers pp ON pp.business_id = o.business_id
              AND pp.provider = 'ath_movil_business' AND pp.is_enabled
        WHERE o.id = $2`, [req.params.slug, req.params.id]);
    const o = rows[0];
    if (!o) return bad(res, 'Orden no encontrada', 404);
    if (o.committed || o.status !== 'pending') return bad(res, 'Esta orden ya no acepta pago', 409);
    if (!o.public_token) return bad(res, 'Este negocio no tiene ATH Móvil automático', 400);
    // Pedidos con gift card → solo validación manual del negocio (evita la carrera del
    // estimado de gift). El frontend ya los crea manual_validate=true; esto blinda la API.
    if (o.gift_card_id) return bad(res, 'Los pedidos con gift card los confirma el negocio; no se pagan en línea', 400);
    // monto a cobrar = total - gift estimada (lectura)
    let giftEstimate = 0;
    if (o.gift_card_id) {
      const gl = await db.query(`SELECT balance_cents FROM gift_cards WHERE id = $1 AND business_id = $2`, [o.gift_card_id, o.business_id]);
      if (gl.rows[0]) giftEstimate = Math.min(gl.rows[0].balance_cents || 0, o.total_cents);
    }
    const balanceDue = o.total_cents - giftEstimate;
    if (balanceDue <= 0) return bad(res, 'La gift card cubre el total; el negocio confirmará tu pedido', 400);
    const phone = athRest.athPhone(o.buyer_phone);
    if (!phone) return bad(res, 'El teléfono de la orden no sirve para ATH Móvil', 400);

    const created = await athRest.create(
      o.public_token, process.env.ATHM_ENV || 'production',
      balanceDue, phone, String(o.business_id), 'orden:' + req.params.id, 'Compra de productos');
    if (!created) return bad(res, 'ATH Móvil no aceptó el pago. Intenta de nuevo.', 502);
    athOrderPending.set(created.ecommerceId, {
      slug: req.params.slug, orderId: o.id, businessId: o.business_id,
      authToken: created.authToken, publicToken: o.public_token,
      expectedCents: balanceDue, createdAt: Date.now(),
    });
    res.json({ ok: true, ecommerceId: created.ecommerceId });
  }));

  app.post('/api/public/:slug/orders/:id/ath/poll', codeLimiter, asyncH(async (req, res) => {
    const { ecommerceId } = req.body || {};
    if (!isStr(ecommerceId, 200)) return bad(res, 'ecommerceId inválido');
    const pend = athOrderPending.get(ecommerceId);
    if (!pend || pend.slug !== req.params.slug || pend.orderId !== req.params.id)
      return bad(res, 'Pago no encontrado', 404);

    const found = await athRest.find(pend.publicToken, ecommerceId, pend.authToken);
    const st = found && found.ecommerceStatus;
    if (st === 'CANCEL') { athOrderPending.delete(ecommerceId); return res.json({ status: 'cancelled' }); }
    if (st !== 'CONFIRM' && st !== 'COMPLETED') return res.json({ status: 'pending' });
    let fin = found;
    if (st === 'CONFIRM') {
      fin = await athRest.authorize(pend.authToken);
      if (!fin || fin.ecommerceStatus !== 'COMPLETED') return res.json({ status: 'pending' });
    }
    const total = Number(fin.total);
    if (!Number.isFinite(total) || Math.round(total * 100) !== pend.expectedCents)
      return bad(res, 'El monto del pago no coincide', 400);

    const r = await confirmOrderPayment(pend.orderId, pend.businessId, { expectedBalanceDue: pend.expectedCents });
    athOrderPending.delete(ecommerceId);
    if (r.oversell) {
      // El pago entró pero ya no hay inventario → avisar al negocio para reembolsar.
      try {
        await notify(pend.businessId, 'order', '⚠️ Pago de orden sin inventario',
          `Se cobró pero faltó ${r.oversell ? r.item : ''} · contacta al cliente para reembolsar`, { order_id: pend.orderId });
      } catch (e) {}
      return res.json({ status: 'completed', warning: 'stock' });
    }
    try {
      await notify(pend.businessId, 'order', 'Pago de orden recibido',
        `Orden pagada por ATH Móvil`, { order_id: pend.orderId });
    } catch (e) {}
    res.json({ status: 'completed' });
  }));

  // NOTA: el detalle público del producto y la reseña gateada por compra
  // (GET/POST /api/public/:slug/products/:id[/review]) viven en server.js, que
  // registra esas rutas ANTES de montar este módulo. No se redefinen aquí.

  app.get('/api/orders', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, buyer_name, buyer_phone, items, total_cents, fulfillment, status, created_at,
              payment_method, paid_at, manual_validate, committed
         FROM product_orders WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 50`, [req.business.id]);
    res.json({ orders: rows });
  }));

  app.patch('/api/orders/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { status } = req.body || {};
    // 'paid' YA NO se setea a mano: el pago lo confirma confirmOrderPayment (que mueve
    // stock+gift). Aquí solo estados de gestión. Cancelar siempre se permite; preparar/
    // listo/entregado SOLO si la orden está pagada (committed=true) — así no se despacha
    // sin haber confirmado el pago (y descontado inventario).
    if (!['preparing', 'ready', 'fulfilled', 'cancelled'].includes(status)) return bad(res, 'Estado inválido');
    if (status === 'cancelled') {
      await db.query(`UPDATE product_orders SET status = 'cancelled' WHERE id = $1 AND business_id = $2`,
        [req.params.id, req.business.id]);
      return res.json({ ok: true });
    }
    const u = await db.query(
      `UPDATE product_orders SET status = $1 WHERE id = $2 AND business_id = $3 AND committed = true RETURNING id`,
      [status, req.params.id, req.business.id]);
    if (!u.rows[0]) return bad(res, 'La orden debe estar pagada antes de prepararla o entregarla', 409);
    res.json({ ok: true });
  }));

  // negocio: VALIDAR el pago de una orden MANUAL (efectivo / ATH al número). Es el
  // único disparador manual de confirmOrderPayment → descuenta stock + redime gift +
  // marca 'paid'. Idempotente; si ya no hay inventario, queda 'pending' para gestionar.
  app.post('/api/orders/:id/confirm-payment', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const r = await confirmOrderPayment(req.params.id, req.business.id);
    if (r.missing) return bad(res, 'Orden no encontrada', 404);
    if (r.oversell) return bad(res, `Ya no hay inventario suficiente de ${r.item}`, 409);
    await audit(req, 'order.confirm_payment', 'order', req.params.id);
    await notify(req.business.id, 'order', 'Pago de orden validado',
      `La orden quedó pagada y lista para preparar.`, { order_id: req.params.id });
    res.json({ ok: true });
  }));

  // ==========================================================================
  //  GIFT CARDS (negocio custodia el dinero; Bukeame lleva el saldo)
  // ==========================================================================
  // El negocio debe tener el add-on gift_cards activo
  async function requireGiftAddon(req, res, next) {
    if (!(await hasAddon(req.business.id, 'gift_cards')))
      return bad(res, 'Activa el add-on de Gift Cards primero', 403);
    next();
  }

  // pública: comprar una gift card
  app.post('/api/public/:slug/gift-cards', bookingLimiter, asyncH(async (req, res) => {
    const { amount_cents, purchaser_name, purchaser_email, recipient_name, recipient_email, message } = req.body || {};
    if (!cents(amount_cents) || amount_cents < 500) return bad(res, 'Monto mínimo $5');
    if (amount_cents > 50000) return bad(res, 'Monto máximo $500');
    if (!isStr(purchaser_name, 120)) return bad(res, 'Tu nombre es requerido');
    if (!isEmail(purchaser_email)) return bad(res, 'Tu email es requerido para el recibo');

    const b = await db.query(
      `SELECT b.id, b.slug FROM businesses b
         JOIN addons a ON a.business_id = b.id AND a.code = 'gift_cards' AND a.status = 'active'
              AND (a.current_period_end IS NULL OR now() <= a.current_period_end + interval '7 days')
        WHERE b.slug = $1 AND b.deleted_at IS NULL`, [req.params.slug]);
    const biz = b.rows[0];
    if (!biz) return bad(res, 'Este negocio no vende gift cards', 404);

    // ABUSE: tope de gift cards PENDIENTES por comprador/día en este negocio (evita
    // que alguien acumule pendientes basura con emails bien formados pero falsos).
    const cap = await db.query(
      `SELECT count(*)::int n FROM gift_cards
        WHERE business_id = $1 AND status = 'pending' AND purchaser_email = $2
          AND created_at > now() - interval '1 day'`, [biz.id, purchaser_email.toLowerCase()]);
    if (cap.rows[0].n >= 5)
      return bad(res, 'Ya tienes gift cards pendientes de confirmación. Espera a que el negocio las active.', 429);

    // código único (reintenta ante colisión)
    let code;
    for (let i = 0; i < 6; i++) {
      code = giftCode(biz.slug);
      const c = await db.query(`SELECT 1 FROM gift_cards WHERE code = $1`, [code]);
      if (!c.rows[0]) break;
    }
    const expires = new Date(); expires.setFullYear(expires.getFullYear() + 2); // 2 años

    // SEGURIDAD: la tarjeta nace 'pending' (NO gastable). El pago lo cobra el negocio
    // por sus métodos (ATH/efectivo/…); recién al CONFIRMARLO se vuelve 'active' y
    // gastable (POST /api/gift-cards/:code/confirm). Espeja el flujo de add-ons: sin
    // pago confirmado no se concede la función paga. Fijamos 'pending' explícito (no
    // dependemos sólo del DEFAULT) para fallar cerrado aunque el DEFAULT no esté migrado.
    const { rows } = await db.query(
      `INSERT INTO gift_cards (business_id, code, initial_cents, balance_cents, status,
          purchaser_name, purchaser_email, recipient_name, recipient_email, message, expires_at)
       VALUES ($1,$2,$3,$3,'pending',$4,$5,$6,$7,$8,$9)
       RETURNING code, initial_cents, status, expires_at`,
      [biz.id, code, amount_cents, purchaser_name.trim(), purchaser_email.toLowerCase(),
       isStr(recipient_name, 120) ? recipient_name.trim() : null,
       isEmail(recipient_email) ? recipient_email.toLowerCase() : null,
       isStr(message, 300) ? message.trim() : null, expires]);

    await notify(biz.id, 'giftcard', 'Gift card por confirmar',
      `$${(amount_cents / 100).toFixed(2)} · ${purchaser_name.trim()} · confirma el pago para activarla`, { code });

    res.status(201).json({
      gift_card: rows[0],
      note: 'Te enviamos el código. El negocio lo activará al confirmar tu pago.',
    });
  }));

  // pública: consultar saldo de una gift card
  app.get('/api/public/:slug/gift-cards/:code', codeLimiter, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT g.code, g.balance_cents, g.initial_cents, g.status, g.expires_at
         FROM gift_cards g JOIN businesses b ON b.id = g.business_id
        WHERE b.slug = $1 AND g.code = $2`,
      [req.params.slug, req.params.code.toUpperCase()]);
    if (!rows[0]) return bad(res, 'Gift card no encontrada', 404);
    res.json({ gift_card: rows[0] });
  }));

  // negocio: listar gift cards emitidas
  app.get('/api/gift-cards', authRequired, businessScope, requireGiftAddon, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT code, initial_cents, balance_cents, status, purchaser_name, recipient_name,
              expires_at, created_at
         FROM gift_cards WHERE business_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.business.id]);
    // outstanding/sold sólo cuentan tarjetas ya pagadas: 'pending' (sin pago confirmado)
    // queda excluido, así no inflamos "vendido" con tarjetas que aún no se cobraron.
    const totals = await db.query(
      `SELECT COALESCE(sum(balance_cents),0)::int outstanding,
              COALESCE(sum(initial_cents),0)::int sold
         FROM gift_cards WHERE business_id = $1 AND status IN ('active','partial')`, [req.business.id]);
    res.json({ gift_cards: rows, ...totals.rows[0] });
  }));

  // negocio: confirmar el pago de una gift card 'pending' → la activa (gastable).
  // Mientras el cobro es manual (ATH/efectivo), el negocio confirma al recibir el
  // dinero. Espeja el flujo de add-ons: sin pago confirmado NO se concede la función.
  // Opcional: payment_id para dejar el vínculo de auditoría (debe ser del MISMO negocio).
  app.post('/api/gift-cards/:code/confirm', authRequired, businessScope, requireGiftAddon, asyncH(async (req, res) => {
    const { payment_id } = req.body || {};
    // si nos pasan un pago, debe pertenecer a ESTE negocio (anti cross-tenant)
    if (payment_id != null) {
      if (!isUuid(payment_id)) return bad(res, 'payment_id inválido');
      const p = await db.query(
        `SELECT 1 FROM payments WHERE id = $1 AND business_id = $2`, [payment_id, req.business.id]);
      if (!p.rows[0]) return bad(res, 'Pago no encontrado', 404);
    }
    const { rows } = await db.query(
      `UPDATE gift_cards
          SET status = 'active', payment_id = COALESCE($3, payment_id)
        WHERE business_id = $1 AND code = $2 AND status = 'pending'
        RETURNING code, initial_cents, balance_cents, status`,
      [req.business.id, req.params.code.toUpperCase(), payment_id != null ? payment_id : null]);
    if (!rows[0]) return bad(res, 'Gift card no encontrada o ya confirmada', 404);
    await audit(req, 'giftcard.confirm', 'gift_card', null, { code: req.params.code, payment_id: payment_id || null });
    await notify(req.business.id, 'giftcard', 'Gift card activada',
      `La gift card ${rows[0].code} ya está activa.`, { code: rows[0].code });
    res.json({ ok: true, gift_card: rows[0] });
  }));

  // negocio: anular una gift card (fraude, error, o 'pending' que nunca se pagó)
  app.post('/api/gift-cards/:code/void', authRequired, businessScope, requireGiftAddon, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE gift_cards SET status = 'void', balance_cents = 0
        WHERE business_id = $1 AND code = $2 AND status IN ('pending','active','partial')
        RETURNING code`, [req.business.id, req.params.code.toUpperCase()]);
    if (!rows[0]) return bad(res, 'Gift card no encontrada o ya usada', 404);
    await audit(req, 'giftcard.void', 'gift_card', null, { code: req.params.code });
    res.json({ ok: true });
  }));

  // ==========================================================================
  //  DESTACADOS PAGADOS (featured) — por BLOQUE de 3 días, por pueblo+categoría
  // --------------------------------------------------------------------------
  //  Precio: $45 por bloque de 3 días (4500 centavos / 3 días). El parámetro
  //  `weeks` del body representa el número de BLOQUES de 3 días (compatibilidad
  //  con el panel, que sigue enviando `weeks` y multiplica el precio por ese
  //  número). El campo `week_price_cents` que devuelve /status es el precio POR
  //  BLOQUE para que el monto ATH del panel cuadre. No dependemos del catálogo:
  //  el precio del bloque es fijo en el backend (4500) para no requerir cambio
  //  de schema en addon_catalog.
  // ==========================================================================
  const FEATURED_BLOCK_DAYS = 3;
  const FEATURED_BLOCK_CENTS = 4500; // $45 por bloque de 3 días

  app.get('/api/featured/status', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, municipality_id, category_id, starts_at, ends_at
         FROM featured_listings
        WHERE business_id = $1 AND ends_at > now() ORDER BY ends_at DESC`, [req.business.id]);
    // week_price_cents = precio por bloque (3 días); se conserva el nombre del campo
    // por compatibilidad con el panel, que lo usa como precio unitario para el ATH.
    res.json({
      active: rows,
      week_price_cents: FEATURED_BLOCK_CENTS,
      block_price_cents: FEATURED_BLOCK_CENTS,
      block_days: FEATURED_BLOCK_DAYS,
    });
  }));

  app.post('/api/featured/purchase', authRequired, businessScope, asyncH(async (req, res) => {
    // `weeks` = cantidad de bloques de 3 días (lo manda el panel con ese nombre).
    const { weeks } = req.body || {};
    const blocks = weeks;
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > 12) return bad(res, 'Entre 1 y 12 bloques de 3 días');
    if (!req.business.municipality_id) return bad(res, 'Configura el municipio de tu negocio primero');

    const total = FEATURED_BLOCK_CENTS * blocks;
    const days = FEATURED_BLOCK_DAYS * blocks;

    // SEGURIDAD: el destacado afecta a TODO el marketplace. NO se concede sin pago
    // confirmado; el admin lo activa al cobrar (POST /api/admin/businesses/:id/featured).
    // SIEMPRE 402 → "si no pagas, no lo tienes".
    await audit(req, 'featured.request', 'featured', null, { blocks, days, total });
    await notify(req.business.id, 'system', 'Solicitud de destacado recibida',
      `Pediste ${blocks} bloque(s) de 3 días (${days} días) de destacado. Te lo activamos al confirmar el pago.`, { blocks, days });
    return bad(res, `Para destacar tu negocio ${blocks} bloque(s) de 3 días ($${(total / 100).toFixed(2)}) confirma el pago. Te lo activamos enseguida.`, 402);
  }));

  console.log('  ✓ módulo revenue montado (productos, gift cards, add-ons, destacados)');
  return { confirmOrderPayment };
};
