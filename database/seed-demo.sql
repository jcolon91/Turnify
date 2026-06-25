-- ============================================================================
--  BUKEAME — SEED DE DATOS DEMO (negocio de prueba en producción)
--  Puebla un negocio existente para ver el flujo completo:
--  perfil, panel, agenda, analytics, buscador y ads.
-- ----------------------------------------------------------------------------
--  Correr (como postgres):
--    sudo -u postgres psql -d bukeame -f seed-demo.sql
--
--  SEGURO DE RE-EJECUTAR (idempotente en lo razonable):
--   · Todo va dentro de UN bloque transaccional (DO ... plpgsql).
--   · El negocio NO se hardcodea: se resuelve por el email del dueño
--     'jesucolon91@gmail.com'; si no existe, por slug 'los-pelaos'.
--   · Si no encuentra negocio → RAISE NOTICE y no toca nada.
--   · Servicios/staff/productos/clientes usan claves naturales (nombre/phone)
--     con NOT EXISTS para no duplicar.
--   · Citas, reseñas, órdenes, gastos y ads se borran y re-crean con un tag
--     ('[DEMO]' en notas/labels o confirmation_code 'DEMO-...') para que la
--     segunda corrida deje el mismo estado final, sin chocar con el EXCLUDE
--     anti-doble-booking ni con los UNIQUE.
--
--  Precios en CENTAVOS. Datos en español de Puerto Rico (barbería).
-- ============================================================================

DO $$
DECLARE
  v_biz        uuid;
  v_owner      uuid;

  -- staff
  v_staff_jc   uuid;   -- Jesús (dueño/barbero)
  v_staff_kev  uuid;   -- Kevin
  v_staff_dia  uuid;   -- Diana (estilista)

  -- servicios
  v_srv_corte  uuid;
  v_srv_barba  uuid;
  v_srv_combo  uuid;
  v_srv_tinte  uuid;
  v_srv_diseno uuid;

  -- clientes
  v_cli_user   uuid;   -- el ligado a jesucolon91@gmail.com (si existe el user)
  v_cli_1      uuid;
  v_cli_2      uuid;
  v_cli_3      uuid;
  v_cli_4      uuid;

  -- productos
  v_prod_pom   uuid;
  v_prod_sham  uuid;
  v_prod_gorra uuid;
  v_prod_kit   uuid;

  -- citas (para colgarles reseñas)
  v_appt_c1    uuid;
  v_appt_c2    uuid;
  v_appt_c3    uuid;

  -- ads
  v_camp       uuid;

  v_today      date := current_date;
BEGIN
  -- --------------------------------------------------------------------------
  -- 0. RESOLVER EL NEGOCIO (sin hardcodear UUIDs)
  -- --------------------------------------------------------------------------
  SELECT b.id, b.owner_user_id
    INTO v_biz, v_owner
  FROM businesses b
  JOIN users u ON u.id = b.owner_user_id
  WHERE u.email = 'jesucolon91@gmail.com'
  ORDER BY b.created_at
  LIMIT 1;

  IF v_biz IS NULL THEN
    SELECT b.id, b.owner_user_id
      INTO v_biz, v_owner
    FROM businesses b
    WHERE b.slug = 'los-pelaos'
    LIMIT 1;
  END IF;

  IF v_biz IS NULL THEN
    RAISE NOTICE 'SEED DEMO: no se encontró negocio (ni dueño jesucolon91@gmail.com ni slug los-pelaos). No se hizo nada.';
    RETURN;
  END IF;

  RAISE NOTICE 'SEED DEMO: negocio % (owner %) — poblando datos demo...', v_biz, v_owner;

  -- --------------------------------------------------------------------------
  -- 1. NEGOCIO PUBLICADO + datos de perfil mínimos para que se vea en buscador
  -- --------------------------------------------------------------------------
  UPDATE businesses
     SET is_published = true,
         bio = COALESCE(NULLIF(bio,''), 'Barbería boricua. Cortes limpios, fades, barba y diseño. Reserva fácil por Bukéame.'),
         municipality_id = COALESCE(municipality_id, (SELECT id FROM pr_municipalities WHERE slug = 'caguas')),
         lat = COALESCE(lat, 18.2341),
         lng = COALESCE(lng, -66.0356),
         phone = COALESCE(phone, '+17875551234'),
         whatsapp = COALESCE(whatsapp, '+17875551234')
   WHERE id = v_biz;

  -- Asegurar categoría "Barbería" en el N:M (para que aparezca por categoría)
  INSERT INTO business_categories (business_id, category_id)
  SELECT v_biz, c.id FROM categories c WHERE c.slug = 'barberia'
  ON CONFLICT (business_id, category_id) DO NOTHING;

  -- --------------------------------------------------------------------------
  -- 2. STAFF (display_name + calendar_color)
  -- --------------------------------------------------------------------------
  -- Jesús: si el dueño tiene staff ligado a su user_id, reutilízalo
  SELECT id INTO v_staff_jc FROM staff
   WHERE business_id = v_biz AND display_name = 'Jesús "JC"' LIMIT 1;
  IF v_staff_jc IS NULL THEN
    INSERT INTO staff (business_id, user_id, display_name, bio, calendar_color, specialties, sort_order)
    VALUES (v_biz, v_owner, 'Jesús "JC"', 'Dueño y barbero principal. Fades y diseños.',
            '#0E8074', ARRAY['Fade','Diseño'], 1)
    RETURNING id INTO v_staff_jc;
  END IF;

  SELECT id INTO v_staff_kev FROM staff
   WHERE business_id = v_biz AND display_name = 'Kevin' LIMIT 1;
  IF v_staff_kev IS NULL THEN
    INSERT INTO staff (business_id, display_name, bio, calendar_color, specialties, sort_order)
    VALUES (v_biz, 'Kevin', 'Barbero. Cortes clásicos y barba.', '#B0413E',
            ARRAY['Corte','Barba'], 2)
    RETURNING id INTO v_staff_kev;
  END IF;

  SELECT id INTO v_staff_dia FROM staff
   WHERE business_id = v_biz AND display_name = 'Diana' LIMIT 1;
  IF v_staff_dia IS NULL THEN
    INSERT INTO staff (business_id, display_name, bio, calendar_color, specialties, sort_order)
    VALUES (v_biz, 'Diana', 'Estilista. Tintes y color.', '#6D28D9',
            ARRAY['Tinte','Color'], 3)
    RETURNING id INTO v_staff_dia;
  END IF;

  -- --------------------------------------------------------------------------
  -- 3. SERVICIOS (precios en centavos; depósito donde aplica)
  -- --------------------------------------------------------------------------
  SELECT id INTO v_srv_corte FROM services WHERE business_id = v_biz AND name = 'Corte' AND deleted_at IS NULL LIMIT 1;
  IF v_srv_corte IS NULL THEN
    INSERT INTO services (business_id, name, description, duration_min, price_cents, deposit_cents, is_featured, sort_order)
    VALUES (v_biz, 'Corte', 'Corte de cabello con máquina y tijera.', 30, 1500, 500, true, 1)
    RETURNING id INTO v_srv_corte;
  END IF;

  SELECT id INTO v_srv_barba FROM services WHERE business_id = v_biz AND name = 'Barba' AND deleted_at IS NULL LIMIT 1;
  IF v_srv_barba IS NULL THEN
    INSERT INTO services (business_id, name, description, duration_min, price_cents, deposit_cents, sort_order)
    VALUES (v_biz, 'Barba', 'Perfilado y arreglo de barba con toalla caliente.', 20, 1000, 500, 2)
    RETURNING id INTO v_srv_barba;
  END IF;

  SELECT id INTO v_srv_combo FROM services WHERE business_id = v_biz AND name = 'Corte + Barba' AND deleted_at IS NULL LIMIT 1;
  IF v_srv_combo IS NULL THEN
    INSERT INTO services (business_id, name, description, duration_min, price_cents, deposit_cents, is_featured, sort_order)
    VALUES (v_biz, 'Corte + Barba', 'Combo completo: corte y barba.', 45, 2200, 500, true, 3)
    RETURNING id INTO v_srv_combo;
  END IF;

  SELECT id INTO v_srv_tinte FROM services WHERE business_id = v_biz AND name = 'Tinte' AND deleted_at IS NULL LIMIT 1;
  IF v_srv_tinte IS NULL THEN
    INSERT INTO services (business_id, name, description, duration_min, price_cents, deposit_cents, sort_order)
    VALUES (v_biz, 'Tinte', 'Color/tinte de cabello.', 60, 3500, 1000, 4)
    RETURNING id INTO v_srv_tinte;
  END IF;

  SELECT id INTO v_srv_diseno FROM services WHERE business_id = v_biz AND name = 'Diseño' AND deleted_at IS NULL LIMIT 1;
  IF v_srv_diseno IS NULL THEN
    INSERT INTO services (business_id, name, description, duration_min, price_cents, deposit_cents, sort_order)
    VALUES (v_biz, 'Diseño', 'Líneas y diseño a navaja.', 15, 800, 500, 5)
    RETURNING id INTO v_srv_diseno;
  END IF;

  -- Qué staff ofrece qué servicio (para el buscador/booking)
  INSERT INTO service_staff (service_id, staff_id) VALUES
    (v_srv_corte,  v_staff_jc),  (v_srv_corte,  v_staff_kev),
    (v_srv_barba,  v_staff_jc),  (v_srv_barba,  v_staff_kev),
    (v_srv_combo,  v_staff_jc),  (v_srv_combo,  v_staff_kev),
    (v_srv_tinte,  v_staff_dia),
    (v_srv_diseno, v_staff_jc)
  ON CONFLICT (service_id, staff_id) DO NOTHING;

  -- --------------------------------------------------------------------------
  -- 4. PRODUCTOS (precio + stock; campos rich del schema 13)
  -- --------------------------------------------------------------------------
  SELECT id INTO v_prod_pom FROM products WHERE business_id = v_biz AND name = 'Pomada mate' LIMIT 1;
  IF v_prod_pom IS NULL THEN
    INSERT INTO products (business_id, name, description, price_cents, stock, is_featured, category, tagline, features, sort_order)
    VALUES (v_biz, 'Pomada mate', 'Pomada de fijación fuerte, acabado mate.', 1200, 40, true,
            'Cabello', 'Fijación fuerte · acabado mate',
            '["Fijación fuerte","Acabado mate","Base de agua","4 oz"]'::jsonb, 1)
    RETURNING id INTO v_prod_pom;
  END IF;

  SELECT id INTO v_prod_sham FROM products WHERE business_id = v_biz AND name = 'Shampoo de barba' LIMIT 1;
  IF v_prod_sham IS NULL THEN
    INSERT INTO products (business_id, name, description, price_cents, stock, category, tagline, features, sort_order)
    VALUES (v_biz, 'Shampoo de barba', 'Limpia y suaviza la barba.', 1000, 25,
            'Barba', 'Limpia y suaviza',
            '["Hidratante","Aroma cedro","8 oz"]'::jsonb, 2)
    RETURNING id INTO v_prod_sham;
  END IF;

  SELECT id INTO v_prod_gorra FROM products WHERE business_id = v_biz AND name = 'Gorra Los Pelaos' LIMIT 1;
  IF v_prod_gorra IS NULL THEN
    INSERT INTO products (business_id, name, description, price_cents, stock, category, tagline, features, sort_order)
    VALUES (v_biz, 'Gorra Los Pelaos', 'Gorra bordada con el logo.', 2000, 15,
            'Merch', 'Snapback bordada',
            '["Ajustable","Bordado","Unisex"]'::jsonb, 3)
    RETURNING id INTO v_prod_gorra;
  END IF;

  SELECT id INTO v_prod_kit FROM products WHERE business_id = v_biz AND name = 'Kit de cuidado' LIMIT 1;
  IF v_prod_kit IS NULL THEN
    INSERT INTO products (business_id, name, description, price_cents, stock, is_featured, category, tagline, features, sort_order)
    VALUES (v_biz, 'Kit de cuidado', 'Pomada + shampoo + peine.', 2800, 10, true,
            'Cabello', 'Todo en uno',
            '["Pomada","Shampoo","Peine","Ahorra 15%"]'::jsonb, 4)
    RETURNING id INTO v_prod_kit;
  END IF;

  -- --------------------------------------------------------------------------
  -- 5. CLIENTES (UNIQUE (business_id, phone) → ON CONFLICT seguro)
  --    Uno ligado al user jesucolon91@gmail.com si ese user existe.
  -- --------------------------------------------------------------------------
  SELECT id INTO v_cli_user FROM users WHERE email = 'jesucolon91@gmail.com' LIMIT 1;

  INSERT INTO clients (business_id, user_id, full_name, phone, email, notes)
  VALUES (v_biz, v_cli_user, 'Jesús Colón', '+17875550001', 'jesucolon91@gmail.com', '[DEMO] Cliente con cuenta')
  ON CONFLICT (business_id, phone) DO UPDATE SET user_id = EXCLUDED.user_id
  RETURNING id INTO v_cli_user;
  IF v_cli_user IS NULL THEN
    SELECT id INTO v_cli_user FROM clients WHERE business_id = v_biz AND phone = '+17875550001';
  END IF;

  INSERT INTO clients (business_id, full_name, phone, email, notes)
  VALUES (v_biz, 'Luis Rivera', '+17875550002', 'luis.rivera@example.com', '[DEMO]')
  ON CONFLICT (business_id, phone) DO NOTHING;
  SELECT id INTO v_cli_1 FROM clients WHERE business_id = v_biz AND phone = '+17875550002';

  INSERT INTO clients (business_id, full_name, phone, email, notes)
  VALUES (v_biz, 'María Santos', '+17875550003', 'maria.santos@example.com', '[DEMO]')
  ON CONFLICT (business_id, phone) DO NOTHING;
  SELECT id INTO v_cli_2 FROM clients WHERE business_id = v_biz AND phone = '+17875550003';

  INSERT INTO clients (business_id, full_name, phone, email, notes)
  VALUES (v_biz, 'Pedro Martínez', '+17875550004', 'pedro.martinez@example.com', '[DEMO]')
  ON CONFLICT (business_id, phone) DO NOTHING;
  SELECT id INTO v_cli_3 FROM clients WHERE business_id = v_biz AND phone = '+17875550004';

  INSERT INTO clients (business_id, full_name, phone, email, notes)
  VALUES (v_biz, 'Carmen Ortiz', '+17875550005', 'carmen.ortiz@example.com', '[DEMO]')
  ON CONFLICT (business_id, phone) DO NOTHING;
  SELECT id INTO v_cli_4 FROM clients WHERE business_id = v_biz AND phone = '+17875550005';

  -- --------------------------------------------------------------------------
  -- 6. LIMPIEZA de datos demo previos (para re-ejecutar sin chocar con UNIQUE
  --    de confirmation_code/appointment ni con el EXCLUDE anti-doble-booking).
  --    Reviews tiene FK a appointments → se borran primero.
  -- --------------------------------------------------------------------------
  DELETE FROM reviews
   WHERE business_id = v_biz
     AND appointment_id IN (SELECT id FROM appointments WHERE business_id = v_biz AND confirmation_code LIKE 'DEMO-%');
  DELETE FROM appointments
   WHERE business_id = v_biz AND confirmation_code LIKE 'DEMO-%';
  DELETE FROM product_reviews
   WHERE business_id = v_biz AND reviewer_email LIKE '%@example.com';
  DELETE FROM product_orders
   WHERE business_id = v_biz AND buyer_email LIKE '%@example.com';
  DELETE FROM expenses
   WHERE business_id = v_biz AND label LIKE '[DEMO]%';

  -- --------------------------------------------------------------------------
  -- 7. CITAS — distintos días y estados.
  --    NOTA enum status: pending_deposit, confirmed, completed,
  --    cancelled_client, cancelled_business, no_show (NO existe 'cancelled').
  --    El EXCLUDE anti-doble-booking sólo aplica a pending_deposit/confirmed,
  --    así que las "vivas" se reparten en días/horas que no se solapan por staff.
  --    snapshot: service_name/duration_min/price_cents/deposit_cents obligatorios.
  -- --------------------------------------------------------------------------

  -- (a) PASADAS completadas (alimentan analytics + permiten reseñas)
  INSERT INTO appointments
    (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents, deposit_cents,
     starts_at, ends_at, status, source, confirmation_code, client_notes)
  VALUES
    (v_biz, v_cli_1, v_staff_jc, v_srv_combo, 'Corte + Barba', 45, 2200, 500,
     v_today - interval '14 days' + time '10:00', v_today - interval '14 days' + time '10:45',
     'completed', 'online', 'DEMO-0001', 'Fade bajo')
  RETURNING id INTO v_appt_c1;

  INSERT INTO appointments
    (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents, deposit_cents,
     starts_at, ends_at, status, source, confirmation_code, client_notes)
  VALUES
    (v_biz, v_cli_2, v_staff_kev, v_srv_corte, 'Corte', 30, 1500, 500,
     v_today - interval '10 days' + time '12:00', v_today - interval '10 days' + time '12:30',
     'completed', 'online', 'DEMO-0002', NULL)
  RETURNING id INTO v_appt_c2;

  INSERT INTO appointments
    (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents, deposit_cents,
     starts_at, ends_at, status, source, confirmation_code, client_notes)
  VALUES
    (v_biz, v_cli_user, v_staff_jc, v_srv_corte, 'Corte', 30, 1500, 500,
     v_today - interval '7 days' + time '15:00', v_today - interval '7 days' + time '15:30',
     'completed', 'walk_in', 'DEMO-0003', NULL)
  RETURNING id INTO v_appt_c3;

  INSERT INTO appointments
    (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents, deposit_cents,
     starts_at, ends_at, status, source, confirmation_code)
  VALUES
    (v_biz, v_cli_3, v_staff_dia, v_srv_tinte, 'Tinte', 60, 3500, 1000,
     v_today - interval '5 days' + time '13:00', v_today - interval '5 days' + time '14:00',
     'completed', 'online', 'DEMO-0004');

  -- (b) HOY confirmada
  INSERT INTO appointments
    (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents, deposit_cents,
     starts_at, ends_at, status, source, confirmation_code)
  VALUES
    (v_biz, v_cli_4, v_staff_jc, v_srv_combo, 'Corte + Barba', 45, 2200, 500,
     v_today + time '16:00', v_today + time '16:45',
     'confirmed', 'online', 'DEMO-0005');

  -- (c) FUTURAS confirmadas (distintos días/staff → sin solape)
  INSERT INTO appointments
    (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents, deposit_cents,
     starts_at, ends_at, status, source, confirmation_code)
  VALUES
    (v_biz, v_cli_1, v_staff_jc, v_srv_corte, 'Corte', 30, 1500, 500,
     v_today + interval '2 days' + time '11:00', v_today + interval '2 days' + time '11:30',
     'confirmed', 'online', 'DEMO-0006'),
    (v_biz, v_cli_2, v_staff_kev, v_srv_barba, 'Barba', 20, 1000, 500,
     v_today + interval '3 days' + time '14:00', v_today + interval '3 days' + time '14:20',
     'confirmed', 'online', 'DEMO-0007'),
    (v_biz, v_cli_3, v_staff_dia, v_srv_tinte, 'Tinte', 60, 3500, 1000,
     v_today + interval '4 days' + time '10:00', v_today + interval '4 days' + time '11:00',
     'confirmed', 'online', 'DEMO-0008');

  -- (d) CANCELADA por cliente (enum real cancelled_client)
  INSERT INTO appointments
    (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents, deposit_cents,
     starts_at, ends_at, status, source, confirmation_code, cancel_reason, cancelled_at)
  VALUES
    (v_biz, v_cli_2, v_staff_jc, v_srv_corte, 'Corte', 30, 1500, 500,
     v_today - interval '2 days' + time '09:00', v_today - interval '2 days' + time '09:30',
     'cancelled_client', 'online', 'DEMO-0009', 'Surgió un imprevisto', v_today - interval '3 days');

  -- (e) NO SHOW
  INSERT INTO appointments
    (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents, deposit_cents,
     starts_at, ends_at, status, source, confirmation_code)
  VALUES
    (v_biz, v_cli_4, v_staff_kev, v_srv_corte, 'Corte', 30, 1500, 500,
     v_today - interval '1 days' + time '17:00', v_today - interval '1 days' + time '17:30',
     'no_show', 'online', 'DEMO-0010');

  -- (f) PENDING_DEPOSIT (futura, esperando depósito) — staff/día sin solape
  INSERT INTO appointments
    (business_id, client_id, staff_id, service_id, service_name, duration_min, price_cents, deposit_cents,
     starts_at, ends_at, status, source, confirmation_code)
  VALUES
    (v_biz, v_cli_1, v_staff_kev, v_srv_combo, 'Corte + Barba', 45, 2200, 500,
     v_today + interval '5 days' + time '15:00', v_today + interval '5 days' + time '15:45',
     'pending_deposit', 'online', 'DEMO-0011');

  -- --------------------------------------------------------------------------
  -- 8. RESEÑAS DE CITA (tabla reviews; appointment_id UNIQUE; rating 1-5).
  --    El trigger trg_review_rating recalcula businesses.rating_avg/count.
  -- --------------------------------------------------------------------------
  INSERT INTO reviews (business_id, staff_id, client_id, appointment_id, rating, comment)
  VALUES
    (v_biz, v_staff_jc,  v_cli_1,    v_appt_c1, 5, 'Brutal el fade, quedé como nuevo.'),
    (v_biz, v_staff_kev, v_cli_2,    v_appt_c2, 4, 'Buen corte y rápido.'),
    (v_biz, v_staff_jc,  v_cli_user, v_appt_c3, 5, 'Siempre salgo bien pelao. Recomendado.')
  ON CONFLICT (appointment_id) DO NOTHING;

  -- --------------------------------------------------------------------------
  -- 9. ÓRDENES / VENTAS DE PRODUCTO (product_orders)
  --    items jsonb: [{product_id,name,qty,price_cents}]; status: pending|paid|
  --    fulfilled|cancelled (valores reales del schema).
  -- --------------------------------------------------------------------------
  INSERT INTO product_orders (business_id, client_id, buyer_name, buyer_phone, buyer_email, items, total_cents, fulfillment, status)
  VALUES
    (v_biz, v_cli_1, 'Luis Rivera', '+17875550002', 'luis.rivera@example.com',
     jsonb_build_array(jsonb_build_object('product_id', v_prod_pom, 'name', 'Pomada mate', 'qty', 1, 'price_cents', 1200)),
     1200, 'pickup', 'fulfilled'),
    (v_biz, v_cli_2, 'María Santos', '+17875550003', 'maria.santos@example.com',
     jsonb_build_array(
       jsonb_build_object('product_id', v_prod_kit,  'name', 'Kit de cuidado',  'qty', 1, 'price_cents', 2800),
       jsonb_build_object('product_id', v_prod_sham, 'name', 'Shampoo de barba','qty', 1, 'price_cents', 1000)),
     3800, 'pickup', 'paid'),
    (v_biz, v_cli_3, 'Pedro Martínez', '+17875550004', 'pedro.martinez@example.com',
     jsonb_build_array(jsonb_build_object('product_id', v_prod_gorra, 'name', 'Gorra Los Pelaos', 'qty', 1, 'price_cents', 2000)),
     2000, 'shipping', 'pending');

  -- --------------------------------------------------------------------------
  -- 10. RESEÑAS DE PRODUCTO (product_reviews; rating 1-5; verified default true)
  --     UNIQUE parcial (product_id, reviewer_email) → ON CONFLICT seguro.
  -- --------------------------------------------------------------------------
  INSERT INTO product_reviews (product_id, business_id, reviewer_name, reviewer_email, rating, comment)
  VALUES
    (v_prod_pom, v_biz, 'Luis Rivera',   'luis.rivera@example.com', 5, 'La mejor pomada, dura todo el día.'),
    (v_prod_kit, v_biz, 'María Santos',  'maria.santos@example.com', 4, 'Buen kit, el peine es de calidad.')
  ON CONFLICT (product_id, reviewer_email) WHERE reviewer_email IS NOT NULL DO NOTHING;

  -- --------------------------------------------------------------------------
  -- 11. GASTOS (expenses) — para que la contabilidad muestre números
  --     category es enum expense_category; amount_cents > 0.
  -- --------------------------------------------------------------------------
  INSERT INTO expenses (business_id, category, label, amount_cents, spent_on, notes)
  VALUES
    (v_biz, 'renta',     '[DEMO] Renta del local',        80000, v_today - interval '20 days', 'Mensualidad'),
    (v_biz, 'productos', '[DEMO] Reposición de pomadas',  15000, v_today - interval '12 days', 'Inventario tienda'),
    (v_biz, 'equipo',    '[DEMO] Máquina y cuchillas',    9500,  v_today - interval '8 days',  NULL),
    (v_biz, 'servicios', '[DEMO] Luz y agua',             12000, v_today - interval '4 days',  'Utilidades');

  -- --------------------------------------------------------------------------
  -- 12. ADS (sólo si la tabla ad_campaigns existe)
  --     budget_cents 5000, status 'active' + eventos para métricas.
  -- --------------------------------------------------------------------------
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'ad_campaigns') THEN
    -- Limpia campaña demo previa (y sus eventos por CASCADE)
    DELETE FROM ad_campaigns
     WHERE business_id = v_biz AND budget_cents = 5000 AND status = 'active';

    INSERT INTO ad_campaigns (business_id, budget_cents, spent_cents, cost_per_impression_cents, cost_per_click_cents, status)
    VALUES (v_biz, 5000, 360, 2, 25, 'active')
    RETURNING id INTO v_camp;

    -- Eventos: ~120 impresiones, 6 clics, 1 conversión (números visibles en métricas)
    INSERT INTO ad_events (campaign_id, type, created_at)
    SELECT v_camp, 'impression', now() - (g || ' minutes')::interval
    FROM generate_series(1, 120) g;

    INSERT INTO ad_events (campaign_id, type, created_at)
    SELECT v_camp, 'click', now() - (g * 30 || ' minutes')::interval
    FROM generate_series(1, 6) g;

    INSERT INTO ad_events (campaign_id, type, created_at)
    VALUES (v_camp, 'conversion', now() - interval '2 hours');

    RAISE NOTICE 'SEED DEMO: campaña de ads creada % (budget 5000c, 120 impresiones / 6 clics / 1 conversión).', v_camp;
  ELSE
    RAISE NOTICE 'SEED DEMO: tabla ad_campaigns no existe — se omiten los ads.';
  END IF;

  RAISE NOTICE 'SEED DEMO: listo. Negocio publicado con 5 servicios, 3 staff, 4 productos, 5 clientes, 11 citas, 3 reseñas de cita, 3 órdenes, 2 reseñas de producto, 4 gastos.';
END $$;
