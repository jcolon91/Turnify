# Bukéame — Fase de procesamiento de pagos (spec de implementación)

> Documento de arquitectura para cuando se abran las cuentas. La **fundación** (slots
> por negocio, tabla `payment_providers`, módulo `module-payments.js`, sección "Pagos"
> en el panel, métodos visibles en la página pública) **ya está construida**. Esto cubre
> la mitad que mueve dinero de verdad.

## Visión general — son DOS sistemas independientes

1. **Pagos de clientes → negocios** (Stripe Connect + PayPal). El **negocio es el
   merchant of record**; el dinero le llega directo a su cuenta. Bukéame solo facilita,
   **no toca el dinero ni guarda llaves secretas** → fuera de "money transmitter".
2. **Membresías: Bukéame → negocios** (Stripe Billing). Bukéame le cobra la suscripción
   mensual a cada negocio en SU propia cuenta de Stripe.

> Importante: **una sola cuenta de Stripe de Bukéame** hace las dos cosas — es la
> *plataforma* Connect (para #1) y a la vez cobra las membresías (para #2). No hacen falta
> dos cuentas.

Paquetes npm: `stripe` (SDK oficial). PayPal: REST API (o `@paypal/paypal-server-sdk`).

---

## PARTE 1 — Stripe Connect (clientes pagan a los negocios)

Modelo: **Connect Standard** (el negocio tiene su propio dashboard de Stripe y Stripe maneja
su KYC/compliance → mínima responsabilidad para Bukéame). Cargos **directos** en la cuenta
conectada, **sin** application fee (cero comisión, según el modelo).

### 1.1 Onboarding (conectar la cuenta del negocio)
Reemplaza el scaffold de `module-payments.js` en `POST /api/payments/providers/stripe/connect`:
```
1. account = stripe.accounts.create({ type:'standard', country:'US', email: dueño })
2. guardar account.id en payment_providers.account_ref (status='pending')
3. link = stripe.accountLinks.create({ account: account.id, type:'account_onboarding',
     refresh_url: https://bukeame.com/panel.html?stripe=refresh,
     return_url:  https://bukeame.com/panel.html?stripe=done })
4. devolver { connect_url: link.url }  → el frontend redirige
```
El frontend (panel "Pagos") abre `connect_url`. Al volver, el webhook confirma.

### 1.2 Confirmar conexión (webhook `account.updated`)
Cuando `account.charges_enabled === true` → `UPDATE payment_providers SET status='connected',
connected_at=now() WHERE account_ref = account.id`. (Recién ahí el negocio puede activarlo.)

### 1.3 Cobrar una cita (PaymentIntent en la cuenta conectada)
En el booking público, cuando el negocio tiene Stripe conectado y el cliente elige tarjeta:
```
pi = stripe.paymentIntents.create({
       amount: deposito_o_total_cents, currency:'usd',
       automatic_payment_methods:{ enabled:true },   // habilita Apple Pay/Google Pay/Klarna
     }, { stripeAccount: account_ref })               // ← cargo DIRECTO en la cuenta del negocio
guardar pi.id en payments.external_ref ; el cliente confirma con el Payment Element (client_secret)
```
- **Apple Pay / Google Pay / Klarna**: automáticos con `automatic_payment_methods` (se prenden
  en el dashboard del negocio; Klarna requiere activarla allí). NO se integran aparte.
- El client_secret va al frontend (un Payment Element de Stripe.js en `cita.html`/`negocio.html`).
  **La tarjeta NUNCA toca tu servidor** → PCI nivel SAQ-A.

### 1.4 Confirmar pago (webhook `payment_intent.succeeded`)
`UPDATE payments SET status='paid', paid_at=now() WHERE external_ref = pi.id` y la cita pasa
de `pending_deposit` → `confirmed`. (Reusa la lógica que ya existe para ATH manual.)

### 1.5 Webhooks de Connect a manejar
`account.updated` · `payment_intent.succeeded` · `payment_intent.payment_failed` · `charge.refunded`.

---

## PARTE 2 — PayPal (clientes pagan a los negocios)

Modelo: **PayPal Commerce Platform / Partner Referrals** (equivalente a Connect).

### 2.1 Onboarding
`POST /api/payments/providers/paypal/connect` → generar un **Partner Referral** (`/v2/customer/
partner-referrals`) con `operations: API_INTEGRATION`, scope de pagos. Devolver el `action_url`
de onboarding. Guardar el `merchant_id` (cuando vuelva) en `payment_providers.account_ref`.

### 2.2 Cobrar
PayPal **Orders v2**: `POST /v2/checkout/orders` con el header `PayPal-Auth-Assertion`
(actuar a nombre del merchant) → `purchase_units[].payee.merchant_id = account_ref`. El cliente
paga con los botones de PayPal (hosted) → `capture`. Guardar el order id en `payments.external_ref`.

### 2.3 Webhooks
`MERCHANT.ONBOARDING.COMPLETED` (marca connected) · `CHECKOUT.ORDER.APPROVED` /
`PAYMENT.CAPTURE.COMPLETED` (marca pagado).

---

## PARTE 3 — Membresías (Bukéame cobra a los negocios) · Stripe Billing

Esto es el pendiente "#5". Usa la cuenta de Stripe de Bukéame **directamente** (no Connect).

### 3.1 Productos y precios (una vez, en el dashboard o por API)
6 Products con su Price recurrente mensual (y anual): `pro $14.99`, `studio $19.99`,
`team $29.99`, `grande $44.99`, `ilimitado $59.99` (free no cobra). Descriptor de tarjeta: **BUKEAME**.

### 3.2 Suscribir un negocio
- Crear `Customer` (email del dueño) → guardar en `subscriptions.stripe_customer_id`.
- `Checkout Session` (`mode:'subscription'`, el Price del plan) → el dueño paga → guardar
  `stripe_subscription_id`. O usar el **Billing Portal** para que gestionen su plan.

### 3.3 Crédito de referidos
Aplicar un **Coupon** de Stripe ($5/mes) al `Customer` del que refiere cuando su referido
pasa a `active` (ya existe la lógica en `referrals` + `v_referral_discounts`; aquí se sincroniza
el coupon). Tope = precio del plan.

### 3.4 Webhooks de Billing
- `invoice.paid` → marcar `subscriptions.status='active'`, extender `current_period_end`,
  insertar fila en `platform_payments` (status='paid'). Disparar `referrals` → 'active' del referido.
- `invoice.payment_failed` → `status='past_due'`.
- `customer.subscription.updated` → sincronizar `plan_code`/`status`.
- `customer.subscription.deleted` → bajar a `free`, desactivar el crédito de referido.

---

## PARTE 4 — Cambios de base de datos (migración 08)

`database/08-schema-payments-processing.sql`:
- Tabla `stripe_events (event_id text PRIMARY KEY, type text, received_at timestamptz)` →
  **idempotencia de webhooks** (ignorar eventos repetidos).
- `payment_providers` ya tiene `account_ref` (acct_xxx / merchant_id) y `config` jsonb → suficiente.
- `subscriptions` ya tiene `stripe_customer_id` / `stripe_subscription_id`.
- `payments` ya tiene `external_ref` (para el payment_intent / order id).
- (Opcional) deprecar `businesses.stripe_account_id` en favor de `payment_providers.account_ref`,
  o mantenerlos sincronizados.
- `GRANT ... TO bukeame_user;`

---

## PARTE 5 — Llaves (.env) — NUNCA al repo

```
# Stripe (plataforma Connect + membresías = la MISMA cuenta)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...        # va al frontend (es pública, OK)
STRIPE_CONNECT_CLIENT_ID=ca_...           # para Connect
STRIPE_WEBHOOK_SECRET=whsec_...           # verificar firma de webhooks

# PayPal (Commerce Platform / Partner)
PAYPAL_CLIENT_ID=...
PAYPAL_SECRET=...
PAYPAL_PARTNER_ID=...
PAYPAL_WEBHOOK_ID=...
PAYPAL_ENV=live                            # o sandbox para pruebas
```
> El código ya chequea estas llaves (`platformReady()` en `module-payments.js`): mientras no
> estén, los slots de Stripe/PayPal muestran "Próximamente". Al ponerlas, se activan solos.

---

## PARTE 6 — Seguridad (obligatorio)

1. **OAuth/Connect, NUNCA guardar secret keys de los negocios.** Solo `acct_xxx`/`merchant_id`.
2. **La tarjeta nunca toca el servidor** — Payment Element / botones PayPal alojados → SAQ-A.
3. **Verificar la firma de TODOS los webhooks** (`stripe.webhooks.constructEvent` con
   `STRIPE_WEBHOOK_SECRET`; PayPal `verify-webhook-signature`). Sin esto, cualquiera falsifica
   un "pago confirmado".
4. **Body crudo para el webhook**: el server usa `express.json()` global; la ruta del webhook
   necesita `express.raw({type:'application/json'})` montada ANTES del json global, o un sub-router.
5. **Idempotencia**: tabla `stripe_events` + `idempotencyKey` al crear PaymentIntents (evita cobros dobles).
6. **2FA + re-autenticación** para conectar/desconectar pagos y cambiar payout.
7. Reusa lo que ya hay: HTTPS, rate limiting, `audit_log`, validación, los fixes de seguridad previos.

---

## PARTE 7 — Orden de implementación sugerido

1. Migración 08 (`stripe_events`).
2. Ruta de **webhooks** con verificación de firma + body crudo (la base de todo).
3. **Membresías** (Parte 3) primero — es tu revenue y es lo más simple (sin Connect).
4. **Stripe Connect** (Parte 1) — onboarding → cobro de cita → Payment Element en el frontend.
5. **PayPal** (Parte 2).
6. Sandbox/pruebas de punta a punta antes de `live`.

---

## PARTE 8 — Dónde toca cada cosa en el código actual

- `backend/module-payments.js` → reemplazar los `TODO` de connect (Stripe/PayPal) por el onboarding real.
- `backend/server.js` → ruta(s) de webhook; en el booking público, crear el PaymentIntent/Order cuando
  el método elegido sea tarjeta/PayPal y el negocio esté conectado.
- `backend/module-account.js` o uno nuevo `module-billing.js` → membresías (Checkout/Billing + webhooks).
- `frontend/cita.html` / `negocio.html` → Payment Element de Stripe.js + botones de PayPal.
- `frontend/panel.html` (sección "Pagos") → ya redirige al `connect_url`; solo recibir el de verdad.
