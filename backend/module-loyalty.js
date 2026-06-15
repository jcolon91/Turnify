// ============================================================================
//  TURNIFY API — módulo B: FIDELIZACIÓN
//  Lealtad · Te-toca · Lista de espera (oferta 30min) · Control manual barbero
// ----------------------------------------------------------------------------
//  Se ENCHUFA al server.js base:
//    const loyalty = require('./module-loyalty');
//    loyalty.mount(app, { db, authRequired, businessScope, h });
//    loyalty.startWorkers({ db, h });   // cron de ofertas y te-toca
// ============================================================================

const crypto = require('crypto');

module.exports.mount = function (app, ctx) {
  const { db, authRequired, businessScope, h } = ctx;
  const { asyncH, bad, isStr, isUuid, isDate, normPhone, isPhone, audit, notify } = h;

  const ALIVE = ['pending_deposit', 'confirmed'];

  // ==========================================================================
  //  PROGRAMA DE LEALTAD (lo paga el negocio; Turnify solo cuenta)
  // ==========================================================================
  app.get('/api/loyalty', authRequired, businessScope, asyncH(async (req, res) => {
    // requiere feature de plan (Studio+) o estar en trial premium
    const eff = await db.query(`SELECT effective_plan, in_trial FROM v_effective_plan WHERE business_id = $1`,
      [req.business.id]);
    const feat = await db.query(`SELECT (features->>'loyalty')::boolean ok FROM plans WHERE code = $1`,
      [eff.rows[0]?.effective_plan || 'free']);
    const allowed = !!feat.rows[0]?.ok;

    const { rows } = await db.query(`SELECT * FROM loyalty_programs WHERE business_id = $1`, [req.business.id]);
    res.json({ allowed, program: rows[0] || null });
  }));

  app.put('/api/loyalty', authRequired, businessScope, asyncH(async (req, res) => {
    const eff = await db.query(`SELECT effective_plan FROM v_effective_plan WHERE business_id = $1`,
      [req.business.id]);
    const feat = await db.query(`SELECT (features->>'loyalty')::boolean ok FROM plans WHERE code = $1`,
      [eff.rows[0]?.effective_plan || 'free']);
    if (!feat.rows[0]?.ok)
      return bad(res, 'El programa de lealtad está en el plan Studio o superior', 403);

    const { is_active, visits_required, reward_text } = req.body || {};
    if (visits_required != null && (!Number.isInteger(visits_required) || visits_required < 2 || visits_required > 50))
      return bad(res, 'Las visitas requeridas deben estar entre 2 y 50');
    if (reward_text != null && !isStr(reward_text, 120)) return bad(res, 'Texto de premio inválido');

    const { rows } = await db.query(
      `INSERT INTO loyalty_programs (business_id, is_active, visits_required, reward_text)
       VALUES ($1, COALESCE($2,false), COALESCE($3,10), COALESCE($4,'Servicio gratis'))
       ON CONFLICT (business_id) DO UPDATE SET
         is_active = COALESCE($2, loyalty_programs.is_active),
         visits_required = COALESCE($3, loyalty_programs.visits_required),
         reward_text = COALESCE($4, loyalty_programs.reward_text)
       RETURNING *`,
      [req.business.id,
       typeof is_active === 'boolean' ? is_active : null,
       Number.isInteger(visits_required) ? visits_required : null,
       isStr(reward_text, 120) ? reward_text.trim() : null]);
    await audit(req, 'loyalty.update', 'loyalty', null, { is_active });
    res.json({ program: rows[0] });
  }));

  // ver progreso de un cliente (en el perfil del cliente)
  app.get('/api/clients/:id/loyalty', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const [prog, prg] = await Promise.all([
      db.query(`SELECT visits_required, reward_text, is_active FROM loyalty_programs WHERE business_id = $1`,
        [req.business.id]),
      db.query(`SELECT current_count, rewards_earned, rewards_redeemed FROM loyalty_progress
                 WHERE business_id = $1 AND client_id = $2`, [req.business.id, req.params.id]),
    ]);
    res.json({
      program: prog.rows[0] || null,
      progress: prg.rows[0] || { current_count: 0, rewards_earned: 0, rewards_redeemed: 0 },
    });
  }));

  // canjear un premio ganado (el barbero lo marca al dar el servicio gratis)
  app.post('/api/clients/:id/loyalty/redeem', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    const { rows } = await db.query(
      `UPDATE loyalty_progress
          SET rewards_redeemed = rewards_redeemed + 1
        WHERE business_id = $1 AND client_id = $2 AND rewards_earned > rewards_redeemed
        RETURNING rewards_earned, rewards_redeemed`, [req.business.id, req.params.id]);
    if (!rows[0]) return bad(res, 'El cliente no tiene premios disponibles', 409);
    await audit(req, 'loyalty.redeem', 'client', req.params.id);
    res.json({ ok: true, ...rows[0] });
  }));

  // ==========================================================================
  //  RECORDATORIO "TE TOCA" — configuración
  // ==========================================================================
  app.get('/api/due-reminder', authRequired, businessScope, asyncH(async (req, res) => {
    res.json({
      enabled: req.business.due_reminder_enabled,
      days: req.business.due_reminder_days,
    });
  }));

  app.put('/api/due-reminder', authRequired, businessScope, asyncH(async (req, res) => {
    const eff = await db.query(`SELECT effective_plan FROM v_effective_plan WHERE business_id = $1`,
      [req.business.id]);
    const feat = await db.query(`SELECT (features->>'due_reminder')::boolean ok FROM plans WHERE code = $1`,
      [eff.rows[0]?.effective_plan || 'free']);
    if (!feat.rows[0]?.ok)
      return bad(res, 'El recordatorio "te toca" está en el plan Pro o superior', 403);

    const { enabled, days } = req.body || {};
    if (days != null && (!Number.isInteger(days) || days < 7 || days > 120))
      return bad(res, 'Los días deben estar entre 7 y 120');
    const { rows } = await db.query(
      `UPDATE businesses SET
         due_reminder_enabled = COALESCE($2, due_reminder_enabled),
         due_reminder_days = COALESCE($3, due_reminder_days)
        WHERE id = $1 RETURNING due_reminder_enabled, due_reminder_days`,
      [req.business.id, typeof enabled === 'boolean' ? enabled : null,
       Number.isInteger(days) ? days : null]);
    res.json({ enabled: rows[0].due_reminder_enabled, days: rows[0].due_reminder_days });
  }));

  // ==========================================================================
  //  LISTA DE ESPERA
  // ==========================================================================
  // pública: cliente entra a la lista (con o sin cita base protegida)
  app.post('/api/public/:slug/waitlist', asyncH(async (req, res) => {
    const { service_id, staff_id, date_from, date_to, full_name, phone, held_code } = req.body || {};
    if (!isStr(full_name, 120)) return bad(res, 'Tu nombre es requerido');
    if (!isPhone(phone)) return bad(res, 'Tu WhatsApp es requerido');
    if (!isDate(date_from) || !isDate(date_to)) return bad(res, 'Fechas inválidas');
    if (date_to < date_from) return bad(res, 'Rango de fechas inválido');

    const b = await db.query(
      `SELECT b.id FROM businesses b
         JOIN subscriptions s ON s.business_id = b.id
         JOIN plans p ON p.code = s.plan_code
        WHERE b.slug = $1 AND b.deleted_at IS NULL
          AND (p.features->>'waitlist')::boolean = true`, [req.params.slug]);
    const biz = b.rows[0];
    if (!biz) return bad(res, 'Este negocio no tiene lista de espera activa', 404);

    const phoneN = normPhone(phone);
    // cliente del CRM
    const cl = await db.query(
      `INSERT INTO clients (business_id, full_name, phone)
       VALUES ($1,$2,$3) ON CONFLICT (business_id, phone)
       DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
      [biz.id, full_name.trim(), phoneN]);

    // ¿tiene una cita base que proteger? (held_code)
    let heldId = null;
    if (isStr(held_code, 40)) {
      const held = await db.query(
        `SELECT id FROM appointments WHERE business_id = $1 AND confirmation_code = $2
           AND client_id = $3 AND status = ANY($4)`,
        [biz.id, held_code.trim().toUpperCase(), cl.rows[0].id, ALIVE]);
      heldId = held.rows[0]?.id || null;
    }

    // posición FIFO
    const pos = await db.query(
      `SELECT COALESCE(max(position),0)+1 n FROM waitlist
        WHERE business_id = $1 AND status = 'waiting'`, [biz.id]);

    const { rows } = await db.query(
      `INSERT INTO waitlist (business_id, client_id, service_id, staff_id,
          date_from, date_to, held_appointment_id, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, position`,
      [biz.id, cl.rows[0].id,
       isUuid(service_id) ? service_id : null,
       isUuid(staff_id) ? staff_id : null,
       date_from, date_to, heldId, pos.rows[0].n]);

    res.status(201).json({
      waitlist_id: rows[0].id,
      position: rows[0].position,
      protected: !!heldId,
      note: heldId
        ? 'Tu cita actual queda protegida. Si se libera un cupo mejor, te avisamos por WhatsApp.'
        : 'Estás en lista. Si se libera un cupo, te avisamos por WhatsApp.',
    });
  }));

  // negocio: ver lista de espera del día / rango (panel)
  app.get('/api/waitlist', authRequired, businessScope, asyncH(async (req, res) => {
    const { rows } = await db.query(
      `SELECT w.id, w.date_from, w.date_to, w.status, w.offer_state, w.offer_expires_at, w.position,
              c.full_name, c.phone, c.no_show_count,
              s.name AS service_name, s.duration_min, s.price_cents,
              st.display_name AS staff_name,
              w.held_appointment_id IS NOT NULL AS has_held
         FROM waitlist w
         JOIN clients c ON c.id = w.client_id
         LEFT JOIN services s ON s.id = w.service_id
         LEFT JOIN staff st ON st.id = w.staff_id
        WHERE w.business_id = $1 AND w.status IN ('waiting','offered')
        ORDER BY w.position`, [req.business.id]);
    res.json({ waitlist: rows });
  }));

  app.delete('/api/waitlist/:id', authRequired, businessScope, asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    await db.query(`UPDATE waitlist SET status = 'expired'
                     WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
    res.json({ ok: true });
  }));

  // ==========================================================================
  //  CONTROL MANUAL DEL BARBERO — abrir cupo (visible para todos o asignar)
  // ==========================================================================
  // (a) abrir cupo VISIBLE para todos = quitar un bloqueo / extender horario ese día.
  //     Creamos un time_block "negativo" no aplica; en su lugar, el barbero crea
  //     disponibilidad puntual. Modelamos como una cita-hueco reservable: mejor,
  //     simplemente permitimos crear la cita manual (ya existe) o abrir el slot.
  //     Para "visible para todos" basta con que el horario lo permita; si es fuera
  //     de horario, registramos una EXCEPCIÓN de apertura.
  app.post('/api/slots/open', authRequired, businessScope, asyncH(async (req, res) => {
    const { staff_id, start_iso, duration_min, visibility, waitlist_id } = req.body || {};
    if (!isUuid(staff_id)) return bad(res, 'Profesional requerido');
    const starts = new Date(start_iso || '');
    if (isNaN(starts)) return bad(res, 'Horario inválido');
    if (!Number.isInteger(duration_min) || duration_min < 5 || duration_min > 480)
      return bad(res, 'Duración inválida');

    const own = await db.query(`SELECT 1 FROM staff WHERE id = $1 AND business_id = $2 AND is_active`,
      [staff_id, req.business.id]);
    if (!own.rows[0]) return bad(res, 'Profesional no encontrado', 404);

    const ends = new Date(starts.getTime() + duration_min * 60_000);

    // ── VISIBILIDAD: "assign" = asignar directo a un cliente de la lista de espera ──
    if (visibility === 'assign') {
      if (!isUuid(waitlist_id)) return bad(res, 'Falta el cliente de la lista de espera');
      const w = await db.query(
        `SELECT w.*, c.full_name, c.phone, s.name svc, s.duration_min sdur, s.price_cents sprice, s.id sid
           FROM waitlist w JOIN clients c ON c.id = w.client_id
           LEFT JOIN services s ON s.id = w.service_id
          WHERE w.id = $1 AND w.business_id = $2 AND w.status IN ('waiting','offered')`,
        [waitlist_id, req.business.id]);
      if (!w.rows[0]) return bad(res, 'Cliente de lista de espera no encontrado', 404);
      const wl = w.rows[0];

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // HUMANO MANDA: cancelar cualquier oferta automática pendiente de este cliente
        await client.query(
          `UPDATE waitlist SET offer_state = 'declined'
            WHERE business_id = $1 AND client_id = $2 AND offer_state = 'offered' AND id <> $3`,
          [req.business.id, wl.client_id, waitlist_id]);

        const code = 'MAN-' + String(starts.getMonth() + 1).padStart(2, '0') +
          String(starts.getDate()).padStart(2, '0') + '-' + crypto.randomInt(100, 999);
        let appt;
        try {
          const r = await client.query(
            `INSERT INTO appointments (business_id, client_id, staff_id, service_id, service_name,
                duration_min, price_cents, deposit_cents, starts_at, ends_at, status, source, confirmation_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'confirmed','manual',$10) RETURNING *`,
            [req.business.id, wl.client_id, staff_id, wl.sid || null,
             wl.svc || 'Servicio', wl.sdur || duration_min, wl.sprice || 0,
             starts, ends, code]);
          appt = r.rows[0];
        } catch (e) {
          if (e.code === '23P01') { await client.query('ROLLBACK'); return bad(res, 'Ese profesional ya tiene cita en ese horario', 409); }
          throw e;
        }

        // sacar de la lista de espera (ya fue atendido) y soltar su cita base si la tenía
        await client.query(`UPDATE waitlist SET status = 'booked', offered_appointment_id = $2 WHERE id = $1`,
          [waitlist_id, appt.id]);

        await client.query('COMMIT');

        // avisar al cliente por WhatsApp (queue)
        await db.query(
          `INSERT INTO message_log (business_id, appointment_id, channel, recipient, template)
           VALUES ($1,$2,'whatsapp',$3,'manual_assign')`, [req.business.id, appt.id, wl.phone]);

        await audit(req, 'slot.assign', 'appointment', appt.id, { waitlist_id });
        return res.status(201).json({ appointment: appt, assigned_to: wl.full_name });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }

    // ── VISIBILIDAD: "public" = abrir el cupo para que cualquiera lo reserve online ──
    // Si es fuera de horario, registramos una apertura puntual (staff_hours extra ese día
    // no aplica porque es por fecha; usamos un marcador en time_blocks con reason especial).
    // Mejor: creamos una "cita-placeholder abierta" no; en su lugar dejamos constancia y
    // el motor de disponibilidad considerará este rango como abierto vía tabla de aperturas.
    if (visibility === 'public') {
      // registrar apertura puntual
      await db.query(
        `INSERT INTO time_blocks (business_id, staff_id, starts_at, ends_at, reason)
         VALUES ($1,$2,$3,$4,'__OPEN_SLOT__')`,
        [req.business.id, staff_id, starts, ends]);
      // NOTA: el motor de disponibilidad trata reason='__OPEN_SLOT__' como apertura,
      // no como bloqueo (ver parche en server base).
      await audit(req, 'slot.open_public', 'staff', staff_id, { start_iso, duration_min });
      return res.status(201).json({
        ok: true, visibility: 'public',
        note: 'Cupo abierto. Aparecerá disponible para reserva online en ese horario.',
      });
    }

    return bad(res, 'Indica visibility: "public" o "assign"');
  }));

  console.log('  ✓ módulo fidelización montado (lealtad, te-toca, lista espera, control manual)');
};

// ============================================================================
//  WORKERS — ofertas de lista de espera (30 min) y recordatorio te-toca
// ============================================================================
module.exports.startWorkers = function (ctx) {
  const { db } = ctx;
  const ALIVE = ['pending_deposit', 'confirmed'];

  // -- (1) Expirar ofertas vencidas y pasar al siguiente en lista --------------
  async function rotateOffers() {
    // ofertas que pasaron de 30 min sin aceptar → expiran, NO tocan la cita base
    const expired = await db.query(
      `UPDATE waitlist SET offer_state = 'expired', offered_appointment_id = NULL
        WHERE offer_state = 'offered' AND offer_expires_at < now()
        RETURNING id, business_id, offered_appointment_id`);
    // (el cliente conserva su held_appointment_id intacto — no se cancela nada)

    // Para cada cupo que quedó libre otra vez, ofrecer al siguiente en fila.
    // (En esta versión, el cupo liberado se re-detecta por el flujo de cancelación.)
  }

  // -- (2) Cuando se cancela una cita, ofrecer el cupo al primero compatible -----
  //    Esto se dispara por trigger lógico: revisamos citas recién canceladas.
  async function offerFreedSlots() {
    // buscar cancelaciones recientes sin oferta hecha aún
    const freed = await db.query(
      `SELECT a.id, a.business_id, a.staff_id, a.service_id, a.starts_at, a.ends_at
         FROM appointments a
        WHERE a.status IN ('cancelled_client','cancelled_business')
          AND a.cancelled_at > now() - interval '5 minutes'`);

    for (const slot of freed.rows) {
      const slotDate = new Date(slot.starts_at).toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' });
      // primer cliente en lista compatible (fecha en rango, servicio/staff si especificó),
      // que NO tenga ya una oferta activa
      const cand = await db.query(
        `SELECT w.id, w.client_id, c.phone, c.full_name
           FROM waitlist w JOIN clients c ON c.id = w.client_id
          WHERE w.business_id = $1 AND w.status = 'waiting' AND w.offer_state = 'none'
            AND $2::date BETWEEN w.date_from AND w.date_to
            AND (w.service_id IS NULL OR w.service_id = $3)
            AND (w.staff_id IS NULL OR w.staff_id = $4)
          ORDER BY w.position LIMIT 1`,
        [slot.business_id, slotDate, slot.service_id, slot.staff_id]);

      if (cand.rows[0]) {
        const w = cand.rows[0];
        const expires = new Date(Date.now() + 30 * 60_000); // 30 min para confirmar
        await db.query(
          `UPDATE waitlist SET offer_state = 'offered',
               offered_appointment_id = $2, offer_expires_at = $3
            WHERE id = $1`, [w.id, slot.id, expires]);
        // avisar por WhatsApp (queue) — el cliente confirma vía link
        await db.query(
          `INSERT INTO message_log (business_id, channel, recipient, template)
           VALUES ($1,'whatsapp',$2,'waitlist_offer')`, [slot.business_id, w.phone]);
      }
    }
  }

  // -- (3) Recordatorio "te toca" a clientes inactivos --------------------------
  async function dueReminders() {
    const due = await db.query(
      `UPDATE clients c SET due_reminder_sent_at = now()
         FROM businesses b
        WHERE c.business_id = b.id
          AND b.due_reminder_enabled = true
          AND c.last_visit_at IS NOT NULL
          AND c.last_visit_at < now() - (b.due_reminder_days || ' days')::interval
          AND (c.due_reminder_sent_at IS NULL
               OR c.due_reminder_sent_at < now() - (b.due_reminder_days || ' days')::interval)
          AND c.is_blocked = false
        RETURNING c.business_id, c.phone, c.full_name`);
    for (const r of due.rows)
      await db.query(
        `INSERT INTO message_log (business_id, channel, recipient, template)
         VALUES ($1,'whatsapp',$2,'due_reminder')`, [r.business_id, r.phone]);
  }

  setInterval(() => { offerFreedSlots().catch(e => console.error('offers:', e.message)); }, 30_000);
  setInterval(() => { rotateOffers().catch(e => console.error('rotate:', e.message)); }, 60_000);
  setInterval(() => { dueReminders().catch(e => console.error('due:', e.message)); }, 3600_000); // cada hora

  console.log('  ✓ workers de fidelización activos (ofertas 30min, te-toca)');
};
