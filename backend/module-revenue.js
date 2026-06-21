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
  const { asyncH, bad, isStr, isUuid, isEmail, isPhone, normPhone, audit, notify, bookingLimiter } = h;

  // ---- helpers locales ----
  const cents = v => Number.isInteger(v) && v >= 0 && v <= 100000000; // ≤ $1M
  const posInt = v => Number.isInteger(v) && v > 0;

  // SEGURIDAD (monetización): por defecto NO se concede una función paga sin confirmar
  // el pago. Mientras el cobro es manual (ATH), el admin la concede tras recibir el
  // dinero vía POST /api/admin/businesses/:id/addons (y .../featured).
  // Si quieres volver al auto-activado sin cobro, pon SELF_SERVE_PAID=true en el .env.
  const SELF_SERVE_PAID = process.env.SELF_SERVE_PAID === 'true';

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
      `SELECT 1 FROM addons WHERE business_id = $1 AND code = $2 AND status = 'active'`,
      [businessId, code]);
    return !!rows[0];
  }

  // límite de productos según add-on (store_10 → 10, store_25 → 25, ninguno → 0)
  async function productLimit(businessId) {
    const { rows } = await db.query(
      `SELECT code FROM addons WHERE business_id = $1 AND status = 'active'
         AND code IN ('store_10','store_25')`, [businessId]);
    if (rows.some(r => r.code === 'store_25')) return 25;
    if (rows.some(r => r.code === 'store_10')) return 10;
    return 0;
  }

  // ==========================================================================
  //  ADD-ONS
  // ==========================================================================
  app.get('/api/addons/catalog', asyncH(async (_req, res) => {
    const { rows } = await db.query(
      `SELECT code, name, price_cents, billing, description FROM addon_catalog ORDER BY price_cents`);
    res.json({ catalog: rows });
  }));

  app.get('/api/addons', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT a.code, a.status, a.price_cents, a.activated_at, c.name, c.billing, c.description
         FROM addons a JOIN addon_catalog c ON c.code = a.code
        WHERE a.business_id = $1 ORDER BY a.activated_at DESC`, [req.business.id]);
    res.json({ addons: rows });
  }));

  app.post('/api/addons/:code/activate', authRequired, businessScope, asyncH(async (req, res) => {
    const code = req.params.code;
    const cat = await db.query(`SELECT * FROM addon_catalog WHERE code = $1`, [code]);
    if (!cat.rows[0]) return bad(res, 'Add-on no existe', 404);

    // plan free no puede activar add-ons que dependan de integraciones externas
    if (code === 'custom_domain' && !(req.business.features?.external_integrations))
      return bad(res, 'El dominio propio requiere un plan pago', 403);

    const price = cat.rows[0].price_cents;

    // SEGURIDAD: sin pago confirmado NO se concede la función paga. Registramos la
    // solicitud; el admin la activa al recibir el dinero (POST /api/admin/businesses/:id/addons).
    if (!SELF_SERVE_PAID) {
      await audit(req, 'addon.request', 'addon', null, { code, price_cents: price });
      await notify(req.business.id, 'system', 'Solicitud de add-on recibida',
        `Pediste activar "${cat.rows[0].name}". Te lo activamos al confirmar el pago.`, { code });
      return bad(res, `Para activar "${cat.rows[0].name}" ($${(price / 100).toFixed(2)}) confirma el pago. Te lo activamos enseguida.`, 402);
    }

    const { rows } = await db.query(
      `INSERT INTO addons (business_id, code, price_cents)
       VALUES ($1,$2,$3)
       ON CONFLICT (business_id, code)
       DO UPDATE SET status = 'active', cancelled_at = NULL, price_cents = $3, activated_at = now()
       RETURNING code, status, price_cents`, [req.business.id, code, price]);
    await audit(req, 'addon.activate', 'addon', null, { code });
    res.status(201).json({ addon: rows[0] });
  }));

  app.post('/api/addons/:code/cancel', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE addons SET status = 'cancelled', cancelled_at = now()
        WHERE business_id = $1 AND code = $2 AND status = 'active'
        RETURNING code`, [req.business.id, req.params.code]);
    if (!rows[0]) return bad(res, 'Add-on no activo', 404);
    await audit(req, 'addon.cancel', 'addon', null, { code: req.params.code });
    res.json({ ok: true, note: 'Activo hasta el fin del período pagado' });
  }));

  // ==========================================================================
  //  PRODUCTOS (tienda) — máx 4 fotos por producto (también forzado en DB)
  // ==========================================================================
  app.get('/api/products', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.*, COALESCE(
           (SELECT json_agg(json_build_object('id',ph.id,'url',ph.url,'sort_order',ph.sort_order)
                            ORDER BY ph.sort_order)
              FROM product_photos ph WHERE ph.product_id = p.id), '[]') AS photos
         FROM products p
        WHERE p.business_id = $1 AND p.is_active
        ORDER BY p.sort_order, p.created_at`, [req.business.id]);
    const limit = await productLimit(req.business.id);
    res.json({ products: rows, limit, used: rows.length });
  }));

  app.post('/api/products', authRequired, businessScope, asyncH(async (req, res) => {
    const { name, description, price_cents, stock, variants, is_featured, photos } = req.body || {};
    if (!isStr(name, 120)) return bad(res, 'Nombre del producto requerido');
    if (!cents(price_cents)) return bad(res, 'Precio inválido');
    if (stock != null && (!Number.isInteger(stock) || stock < 0)) return bad(res, 'Inventario inválido');

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
        `INSERT INTO products (business_id, name, description, price_cents, stock, variants, is_featured)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,false)) RETURNING *`,
        [req.business.id, name.trim(), description || null, price_cents,
         Number.isInteger(stock) ? stock : null, JSON.stringify(vArr), is_featured]);
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
    const allowed = ['name', 'description', 'price_cents', 'stock', 'is_active', 'is_featured', 'sort_order'];
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
    const { items, buyer_name, buyer_phone, buyer_email, fulfillment, gift_code } = req.body || {};
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

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // descontar inventario; si algún producto ya no alcanza, abortar (no sobrevender)
      for (const it of validItems) {
        const u = await client.query(
          `UPDATE products SET stock = stock - $1
            WHERE id = $2 AND (stock IS NULL OR stock >= $1)`, [it.qty, it.product_id]);
        if (u.rowCount === 0) {
          await client.query('ROLLBACK');
          return bad(res, `Sin suficiente inventario de ${it.name}`, 409);
        }
      }

      // Aplicar gift card con BLOQUEO de fila + guard de saldo (anti doble-gasto)
      let giftApplied = 0;
      if (giftId) {
        const gl = await client.query(
          `SELECT balance_cents, status FROM gift_cards
            WHERE id = $1 AND business_id = $2 FOR UPDATE`, [giftId, biz.id]);
        const gc = gl.rows[0];
        if (gc && ['active', 'partial'].includes(gc.status) && gc.balance_cents > 0) {
          giftApplied = Math.min(gc.balance_cents, total);
          await client.query(
            `INSERT INTO gift_card_redemptions (gift_card_id, amount_cents) VALUES ($1,$2)`,
            [giftId, giftApplied]);
          await client.query(
            `UPDATE gift_cards SET balance_cents = balance_cents - $1,
                status = CASE WHEN balance_cents - $1 <= 0 THEN 'redeemed' ELSE 'partial' END
              WHERE id = $2 AND balance_cents >= $1`, [giftApplied, giftId]);
        }
      }

      const { rows } = await client.query(
        `INSERT INTO product_orders (business_id, buyer_name, buyer_phone, buyer_email,
            items, total_cents, fulfillment, gift_card_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id, total_cents`,
        [biz.id, buyer_name.trim(),
         isPhone(buyer_phone) ? normPhone(buyer_phone) : null,
         isEmail(buyer_email) ? buyer_email.toLowerCase() : null,
         JSON.stringify(validItems), total,
         fulfillment === 'shipping' ? 'shipping' : 'pickup', giftId]);

      await client.query('COMMIT');

      await notify(biz.id, 'order', 'Nueva venta de producto',
        `${buyer_name.trim()} · $${(total / 100).toFixed(2)}`, { order_id: rows[0].id });

      res.status(201).json({
        order_id: rows[0].id,
        total_cents: total,
        gift_applied_cents: giftApplied,
        balance_due_cents: total - giftApplied,
      });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }));

  app.get('/api/orders', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, buyer_name, buyer_phone, items, total_cents, fulfillment, status, created_at
         FROM product_orders WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 50`, [req.business.id]);
    res.json({ orders: rows });
  }));

  app.patch('/api/orders/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { status } = req.body || {};
    if (!['paid', 'fulfilled', 'cancelled'].includes(status)) return bad(res, 'Estado inválido');
    await db.query(`UPDATE product_orders SET status = $1 WHERE id = $2 AND business_id = $3`,
      [status, req.params.id, req.business.id]);
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
        WHERE b.slug = $1 AND b.deleted_at IS NULL`, [req.params.slug]);
    const biz = b.rows[0];
    if (!biz) return bad(res, 'Este negocio no vende gift cards', 404);

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
  app.get('/api/public/:slug/gift-cards/:code', asyncH(async (req, res) => {
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
  //  DESTACADOS PAGADOS (featured) — por semana, por pueblo+categoría
  // ==========================================================================
  app.get('/api/featured/status', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, municipality_id, category_id, starts_at, ends_at
         FROM featured_listings
        WHERE business_id = $1 AND ends_at > now() ORDER BY ends_at DESC`, [req.business.id]);
    res.json({ active: rows });
  }));

  app.post('/api/featured/purchase', authRequired, businessScope, asyncH(async (req, res) => {
    const { weeks } = req.body || {};
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) return bad(res, 'Entre 1 y 12 semanas');
    if (!req.business.municipality_id) return bad(res, 'Configura el municipio de tu negocio primero');

    // categoría principal del negocio
    const cat = await db.query(
      `SELECT category_id FROM business_categories WHERE business_id = $1 ORDER BY category_id LIMIT 1`,
      [req.business.id]);
    const price = await db.query(`SELECT price_cents FROM addon_catalog WHERE code = 'featured'`);
    const total = price.rows[0].price_cents * weeks;
    const ends = new Date(Date.now() + weeks * 7 * 864e5);

    // SEGURIDAD: el destacado afecta a TODO el marketplace (sales primero). Sin pago
    // confirmado NO se concede; el admin lo activa al cobrar (POST /api/admin/businesses/:id/featured).
    if (!SELF_SERVE_PAID) {
      await audit(req, 'featured.request', 'featured', null, { weeks, total });
      await notify(req.business.id, 'system', 'Solicitud de destacado recibida',
        `Pediste ${weeks} semana(s) de destacado. Te lo activamos al confirmar el pago.`, { weeks });
      return bad(res, `Para destacar tu negocio ${weeks} semana(s) ($${(total / 100).toFixed(2)}) confirma el pago. Te lo activamos enseguida.`, 402);
    }

    // registramos el destacado como pendiente de pago (el cobro real lo hace Stripe en otra fase)
    const { rows } = await db.query(
      `INSERT INTO featured_listings (business_id, municipality_id, category_id, ends_at)
       VALUES ($1,$2,$3,$4) RETURNING id, ends_at`,
      [req.business.id, req.business.municipality_id, cat.rows[0]?.category_id || null, ends]);
    // marcar negocio como featured mientras esté vigente
    await db.query(`UPDATE businesses SET is_featured = true WHERE id = $1`, [req.business.id]);
    await audit(req, 'featured.purchase', 'featured', rows[0].id, { weeks, total });

    res.status(201).json({
      featured: rows[0],
      total_cents: total,
      note: 'Aparecerás primero en tu pueblo y categoría durante el período.',
    });
  }));

  console.log('  ✓ módulo revenue montado (productos, gift cards, add-ons, destacados)');
};
