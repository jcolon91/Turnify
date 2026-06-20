# Bukéame — ATH Móvil automatizado con el Payment Button API (spec de integración)

> Documento de arquitectura para AUTOMATIZAR el cobro por ATH Móvil usando el
> **ATH Móvil Payment Button API** de Evertec. Hoy ATH Móvil en Bukéame es **manual**:
> el negocio muestra su teléfono, el cliente paga peer-to-peer y el negocio confirma la
> referencia a mano. Este doc describe cómo reemplazar/aumentar ese flujo con el botón
> oficial, manteniendo el modelo de Bukéame: **el dinero le llega directo a la cuenta ATH
> Business del negocio; Bukéame no toca el dinero.**
>
> Hermano de `docs/PAGOS-FASE-PROCESAMIENTO.md` (Stripe Connect + PayPal + membresías).
> La **fundación** (tabla `payment_providers`, `backend/module-payments.js`, sección
> "Pagos" del panel, métodos en `GET /api/public/:slug`) **ya está construida**.

---

## AVISO IMPORTANTE — no hay ambiente de pruebas (sandbox)

> Evertec lo dice explícito en el README: **"We currently do not have a Testing
> environment."** No hay sandbox. Se prueba **solo con cuentas reales**:
>
> - Una **cuenta ATH Business** activa (la del negocio que cobra) con una tarjeta registrada.
> - Una **cuenta ATH Móvil** activa (la del cliente que paga) con **otra tarjeta distinta** —
>   el API rechaza si la tarjeta del cliente es la misma que la del negocio (error `BTRA_0003`).
> - Montos reales y mínimos: **total entre $1.00 y $1,500.00**. Cada prueba mueve dinero de
>   verdad (se recupera con el servicio de **Refund**, que sí existe).
>
> Implicación para Bukéame: **no se puede automatizar la QA**. Hay que coordinar una prueba
> manual con dos teléfonos/tarjetas antes de prender esto en `live`, y el negocio asume que
> sus pruebas iniciales son transacciones reales sobre su propia cuenta.

---

## Visión general — qué es el Payment Button

API REST sobre HTTPS, autenticada con **JWT**, que descompone el cobro en servicios
granulares. El flujo es de **3 pasos** + utilidades:

1. **/payment** — el comercio crea la orden (ticket). Devuelve `ecommerceId` + `auth_token`.
2. El **cliente confirma** el pago desde su app ATH Móvil (push notification a su teléfono).
3. **/authorization** — el comercio ejecuta el cobro (debita los fondos del cliente).

Servicios de soporte: **/findPayment** (consultar estado), **/updatePhoneNumber**
(cambiar el teléfono del cliente), **/refund** (devolver), **/cancel** (cancelar la orden).

Host de producción: **`https://payments.athmovil.com`**. Todo bajo
`/api/business-transaction/ecommerce/...`.

> **A diferencia de Stripe/PayPal, aquí Bukéame SÍ tiene que custodiar un secreto del
> negocio** (su `privateToken`/private key). Stripe Connect y PayPal nunca exponen un
> secreto del comercio (solo un `acct_xxx`/`merchant_id`); ATH Móvil sí. Esa es la
> diferencia clave de seguridad y la razón del CAVEAT y la recomendación al final.

---

## PARTE 1 — Modelo de credenciales (qué es público vs. secreto)

Cada negocio que quiera ATH Móvil automático necesita, en su cuenta ATH Business
(sección Settings de la app ATH Business — el negocio las copia de ahí):

| Credencial | Naturaleza | Dónde vive | Quién la ve |
| --- | --- | --- | --- |
| **Public Token** (`publicToken`) | **Público** | `payment_providers.config` (jsonb) en claro | Server-side; identifica el negocio en cada request. Es seguro guardarlo en claro. |
| **Private Key / Private Token** (`privateToken`) | **SECRETO** | Columna nueva **cifrada en reposo** (ver abajo) | **Solo el server**, descifrado en memoria justo antes de un Refund. **Nunca** al frontend, **nunca** a logs, **nunca** en respuestas de API. |

Notas importantes del API (confirmadas en el README):

- El **`publicToken`** es el identificador del negocio y va en **/payment**, **/findPayment**
  y **/cancel**. Es "público" en el sentido de que no autoriza por sí solo a mover dinero;
  aun así lo tratamos server-side (no hace falta exponerlo en el navegador en nuestro flujo).
- El **`privateToken`** (la "private key" del par público/privado que ATH Business le asigna
  al negocio) **solo aparece en /refund**, junto al `publicToken`. Es el secreto que permite
  devolver dinero → **debe cifrarse**.
- El **`auth_token`** que devuelve **/payment** es un **JWT efímero** por transacción; se usa
  como `Authorization: Bearer <auth_token>` en **/authorization** y **/updatePhoneNumber**.
  No es una credencial del negocio: nace y muere con cada cobro, no se persiste a largo plazo.

> Aclaración de nombres: el README usa indistintamente "private key" (prerequisitos) y
> `privateToken` (payload de /refund). En Bukéame los tratamos como **el mismo secreto** del
> negocio y lo guardamos una sola vez, cifrado.

### Dónde se guarda en el esquema

`payment_providers` ya tiene lo necesario para el token público y un `account_ref`:

- `account_ref` → seguimos guardando el **teléfono ATH** del negocio (como hoy), para el
  fallback manual y para mostrar la pista `•••• 1234`.
- `config` (jsonb) → `{"ath_public_token": "a66ce73d...", "ath_mode": "auto"}`.
  `ath_mode` distingue `'manual'` (lo de hoy) de `'auto'` (Payment Button).

Para el secreto, **migración 09** añade una columna cifrada (no reusar `config`, para no
arriesgar que un `SELECT config` lo filtre):

```sql
-- database/09-schema-ath-movil.sql  (idempotente)
ALTER TABLE payment_providers
  ADD COLUMN IF NOT EXISTS secret_enc bytea;   -- private token cifrado (envelope), NULL si manual
COMMENT ON COLUMN payment_providers.secret_enc IS
  'ATH Móvil privateToken cifrado con AES-256-GCM (nonce||tag||ciphertext). Nunca en claro.';
-- idempotencia del callback de confirmación (ver Parte 6):
CREATE TABLE IF NOT EXISTS ath_events (
  ecommerce_id text PRIMARY KEY,
  status       text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ath_events TO turnify_user;
```

---

## PARTE 2 — Onboarding (el negocio mete sus credenciales ATH en el panel)

Reemplaza/aumenta el `connect` manual del slot `ath_movil` en `module-payments.js`
(`POST /api/payments/providers/ath_movil/connect`). Hoy ese endpoint solo pide el teléfono;
ahora acepta **dos modos**:

- **Modo manual** (lo de hoy, sin cambios): body `{ ath_phone }` → guarda el teléfono,
  `config.ath_mode='manual'`, `status='connected'`. No se guarda ningún secreto.
- **Modo automático** (nuevo): body `{ ath_phone, ath_public_token, ath_private_token }`:
  1. Validar: `isPhone(ath_phone)`; `ath_public_token` y `ath_private_token` no vacíos,
     formato alfanumérico (hex/base de ~40 chars el público), longitud razonable.
  2. **Verificar credenciales reales** antes de marcar `connected`: como no hay endpoint de
     "ping", se hace una **/payment de prueba mínima** (`total: "1.00"`, el propio teléfono
     del negocio) y acto seguido **/cancel** con el `ecommerceId` devuelto. Si /payment
     responde `status:"success"`, las credenciales sirven. Si responde `BTRA_0009/0010`
     (negocio inactivo) o token inválido, se rechaza con un mensaje claro y **no** se guarda.
     *(Esta verificación NO mueve dinero: /payment solo crea el ticket; /cancel lo anula.)*
  3. Guardar: `config = { ath_public_token, ath_mode:'auto' }`, `account_ref = teléfono`,
     **`secret_enc = encrypt(ath_private_token)`** (ver Parte 6), `status='connected'`.
  4. `audit(req, 'payment.connect', ...)` **sin** incluir los tokens en el detalle.

Validación y UX en el panel (`frontend/panel.html`, sección "Pagos", tarjeta `ath_movil`):
hoy hay un input `athInput` (teléfono) y un botón "Conectar". Se añaden **dos campos
opcionales** "Public Token" y "Private Token (secreto)" con un toggle "Automatizar cobros
ATH (avanzado)". Si el negocio los deja vacíos → modo manual de siempre. El private token se
manda una sola vez por HTTPS y **nunca** se vuelve a mostrar (la API de lectura
`GET /payments/providers` jamás lo devuelve; a lo sumo un booleano `ath_auto: true`).

---

## PARTE 3 — Flujo de cobro de una cita (secuencia exacta del API)

Mapea el booking público existente (`POST /api/public/:slug/appointments` en `server.js`),
donde una cita con depósito nace `pending_deposit` y se inserta una fila en `payments`
(`kind='deposit'`, `method='ath_movil'`, `status='pending'`). Hoy esa fila se queda
`pending` hasta que el negocio confirma a mano. Con el Payment Button, el flujo es:

```
Negocio en modo 'auto' y el cliente elige ATH Móvil en el booking:

1. (server) POST /payment
     body: { env:"production", publicToken:<del negocio>, total:<depósito $>,
             phoneNumber:<teléfono del CLIENTE>, metadata1:<confirmation_code>,
             metadata2:<appointment_id>, items:[{name:<servicio>, price, quantity:"1",
             tax:null, metadata:null}], timeout:"600" }
     → respuesta: { ecommerceId, auth_token }
   GUARDAR ecommerceId en payments.external_ref ; cachear auth_token en memoria/temporal
   (vive ~segundos/minutos, ligado al ecommerceId). La cita sigue 'pending_deposit'.

2. El CLIENTE recibe una push en su app ATH Móvil y CONFIRMA el pago.
   (Su estado pasa de OPEN → CONFIRM. Bukéame no controla este paso; el cliente lo hace.)

3. (server) Polling con POST /findPayment { ecommerceId, publicToken } hasta ver
   "ecommerceStatus":"CONFIRM"  (o el cliente apretó "ya pagué" en cita.html).
       - OPEN    → aún no confirma (seguir esperando / mostrar "esperando confirmación")
       - CONFIRM → listo para cobrar → ir al paso 4
       - CANCEL  → expiró o canceló → marcar payments.status='failed', avisar al cliente

4. (server) POST /authorization
       header: Authorization: Bearer <auth_token del paso 1>
       (sin body) → debita los fondos del cliente
     → respuesta: { ecommerceStatus:"COMPLETED", referenceNumber:<txn id>, ... }

5. (server) Al ver COMPLETED:
       UPDATE payments SET status='paid', paid_at=now(),
              external_ref = referenceNumber   -- referencia oficial ATH (la "real")
        WHERE ... (la fila deposit de la cita)
       UPDATE appointments SET status='confirmed' WHERE id = <appointment_id>
   (Reusa exactamente la transición pending_deposit → confirmed que ya existe para el
    ATH manual; solo que ahora la dispara el API en vez del dueño a mano.)
```

Mapeo de identificadores a las tablas existentes:

- `payments.external_ref` = **primero** el `ecommerceId` (ticket interno del flujo), y al
  completar se **reemplaza** por el `referenceNumber` de ATH (el id de transacción definitivo
  que sale en los reportes de ATH Business). *(Alternativa: guardar `ecommerceId` en `config`
  y dejar `external_ref` = `referenceNumber`; cualquiera de las dos sirve, documentar la
  elegida.)*
- `metadata1` = `confirmation_code` de la cita (p.ej. `LM-0611-014`) y `metadata2` =
  `appointment_id`. Así, en el reporte de ATH Business y en cualquier consulta, la
  transacción es rastreable a la cita. **Límite duro: 40 caracteres** por metadata
  (error `BTRA_0038` si se excede) → el UUID de `appointment_id` (36 chars) cabe justo.
- **Estados ATH ↔ Bukéame**: `OPEN`→cita `pending_deposit` (pago `pending`);
  `CONFIRM`→aún `pending` (autorizando); `COMPLETED`→`paid` + cita `confirmed`;
  `CANCEL`→pago `failed`, la cita sigue `pending_deposit` (el cliente puede reintentar).

> **Timeout / expiración**: `/payment` acepta `timeout` entre 120 y 600 s (default 600 =
> 10 min). Si el cliente no confirma en esa ventana, la transacción expira (`CANCEL`,
> error `BTRA_0039` al intentar autorizar tarde). El depósito de la cita debería usar un
> timeout generoso (p.ej. 600) porque el cliente tiene que abrir su app y confirmar.

---

## PARTE 4 — Qué construir

### 4.1 Backend — `backend/module-payments.js` (+ `server.js`)

Un sub-módulo `ath` dentro del módulo de pagos (o `module-ath.js` que se enchufa igual),
con un cliente HTTP fino contra `https://payments.athmovil.com`:

- `athPayment(business, { total, phoneNumber, metadata1, metadata2, items })`
  → POST /payment, devuelve `{ ecommerceId, auth_token }`.
- `athFindPayment(business, ecommerceId)` → POST /findPayment, devuelve `ecommerceStatus`.
- `athAuthorize(authToken)` → POST /authorization con el Bearer, devuelve `referenceNumber`.
- `athUpdatePhone(authToken, ecommerceId, phoneNumber)` → PUT /updatePhoneNumber
  (corregir el teléfono del cliente sin recrear la orden).
- `athRefund(business, referenceNumber, amount, message)` → POST /refund (**aquí se
  descifra `secret_enc`** para obtener el `privateToken`; usar y descartar de inmediato).
- `athCancel(business, ecommerceId)` → POST /cancel.

Endpoints nuevos que consume el frontend público:

- `POST /api/public/:slug/appointments/:code/ath/start` → crea la cita (o reusa la recién
  creada), llama **/payment**, devuelve `{ ecommerceId }` y dispara la push al cliente.
- `GET  /api/public/:slug/appointments/:code/ath/status` → llama **/findPayment**; si
  `CONFIRM`, ejecuta **/authorization** server-side y devuelve el estado final
  (`paid`/`waiting`/`failed`). El frontend hace *poll* a este endpoint.
- (Panel, autenticado) `POST /api/payments/ath/refund` → `athRefund(...)` para que el
  negocio devuelva un depósito desde Bukéame (reusa permisos + 2FA del panel).

> El servidor usa `express.json()` global; estos endpoints son JSON normal (no necesitan
> body crudo como los webhooks de Stripe, porque ATH no manda webhook firmado — Bukéame
> hace polling con /findPayment).

### 4.2 Frontend — `frontend/negocio.html` (booking) y `cita.html` (confirmación)

- `negocio.html` (página de reserva, donde se elige el método): si el negocio tiene
  `ath_movil` activo **en modo auto**, al escoger ATH Móvil se pide el teléfono del cliente,
  se llama a `.../ath/start`, y se muestra **"Abre tu app ATH Móvil y confirma el pago de
  $X"** con un spinner que hace *poll* a `.../ath/status`. Al volver `paid`, redirige a la
  confirmación. (Si el negocio está en **modo manual**, se mantiene EXACTO el flujo actual:
  mostrar el teléfono y pedir la referencia.)
- `cita.html` (página de la cita ya creada): si la cita está `pending_deposit` con ATH auto,
  muestra el botón **"Pagar el depósito con ATH Móvil"** que arranca el mismo flujo
  start→poll→status. Hoy `cita.html` ya distingue `pending_deposit`; se le añade este CTA.

> No hay SDK JS oficial embebible tipo Stripe.js: el "botón" de ATH Móvil en este API es un
> flujo **server-to-server** + push a la app del cliente. El frontend solo orquesta
> (pedir teléfono, mostrar estado, *poll*). La tarjeta del cliente **nunca** toca a Bukéame
> ni al negocio: vive dentro de la app ATH Móvil. Eso es bueno para el alcance PCI.

---

## PARTE 5 — Autenticación, headers y errores (referencia del API)

### JWT / headers por servicio

| Servicio | Método | Auth | Headers clave | Body |
| --- | --- | --- | --- | --- |
| /payment | POST | — (solo `publicToken` en body) | `Content-Type: application/json`, `Accept` | `publicToken`, `total`, `phoneNumber`, `metadata1/2`, `items`, `timeout`, `env` |
| /findPayment | POST | Bearer (auth_token) | `Authorization: Bearer`, `Content-Type` | `ecommerceId`, `publicToken` |
| /authorization | POST | **Bearer (auth_token)** | `Authorization: Bearer <auth_token>`, `Content-Type` | (vacío) |
| /updatePhoneNumber | PUT | Bearer (auth_token) | `Authorization: Bearer`, `Content-Type`, `Host` | `ecommerceId`, `phoneNumber` |
| /refund | POST | **`privateToken` + `publicToken` en body** | `Content-Type`, `Accept`, `Host` | `publicToken`, `privateToken`, `referenceNumber`, `amount`, `message?` |
| /cancel | POST | (`publicToken` en body) | `Content-Type`, `Accept`, `Host` | `ecommerceId`, `publicToken` |

- El **`auth_token`** (JWT) sale de **/payment** y autoriza /authorization, /findPayment y
  /updatePhoneNumber para ESA transacción. Es de vida corta — si expira antes de autorizar,
  da `token.expired` / `BTRA_0402` y hay que recrear la orden.
- **/refund** NO usa el JWT: se autentica con el par `publicToken` + `privateToken` del
  negocio en el cuerpo. **Por eso `privateToken` debe estar cifrado en reposo.**

### Formato de respuesta y errores

Toda respuesta trae `status` (`"success"`/`"error"`), y en error además `message`,
`errorcode` y `data:null`. Errores que el código debe manejar explícitamente:

- `token.invalid.header` / `BTRA_0401` / `BTRA_0403` / `BTRA_0017` → token ausente o inválido.
- `token.expired` / `BTRA_0402` → JWT vencido → recrear orden.
- `BTRA_0003` → tarjeta del cliente == tarjeta del negocio (típico al probar con un solo
  set de tarjetas) → mensaje claro al usuario.
- `BTRA_0004` / `BTRA_0044` / `BTRA_0045` → monto sobre límites (transacción / institución /
  tarjeta).
- `BTRA_0009` / `BTRA_0010` → negocio inactivo → onboarding falla, avisar al dueño.
- `BTRA_0031` (ecommerceId no existe), `BTRA_0032` (no está confirmado),
  `BTRA_0037` (no se puede confirmar cancelada/fallida), `BTRA_0039` (tiempo expiró),
  `BTRA_0053` (referenceNumber no existe en refund).
- `BTRA_0038` → metadata > 40 chars (validar antes de enviar).
- `BTRA_9998` / `BTRA_9999` → error de comunicación / interno → reintentar con backoff y, si
  persiste, caer al fallback manual.

> Los códigos vienen en español e inglés (`error.code.es.BTRA_xxxx` / `...en...`). Bukéame
> mapea el `errorcode` a un mensaje propio en español PR; **no** mostrar el texto crudo del
> API al cliente.

---

## PARTE 6 — Seguridad (obligatorio)

1. **Cifrado del private token (envelope / AES-256-GCM).** El `privateToken` se guarda en
   `payment_providers.secret_enc` cifrado con AES-256-GCM. La llave maestra
   (`ATH_ENC_KEY`, 32 bytes) vive **solo en `.env`** (nunca al repo). Guardar
   `nonce || authTag || ciphertext`. Node `crypto` ya está importado en `server.js`
   (`createCipheriv('aes-256-gcm', key, nonce)`), así que no hace falta dependencia nueva.
   - **Producción seria → KMS**: en vez de una llave fija en `.env`, usar un KMS (AWS KMS /
     similar) en patrón *envelope*: KMS guarda la **KEK**, cifras una **DEK** por secreto.
     El `.env` con una sola llave es el mínimo aceptable; KMS es lo recomendado si el negocio
     escala. Rotación: versionar la llave para poder re-cifrar.
   - **Nunca** loggear el private token ni el `secret_enc`. Descifrar **en memoria**, justo
     antes de /refund, y descartar la variable de inmediato. Excluirlo de todo `SELECT *` que
     vaya a respuestas (`GET /payments/providers` jamás lo devuelve).

2. **HTTPS obligatorio (lo exige el API).** El README es explícito: *"all the exposed
   services from API must be called by using HTTPS protocol"* — sin HTTPS, el API rechaza.
   Bukéame ya corre tras HTTPS; asegurar que las llamadas salientes a
   `payments.athmovil.com` sean `https://` (lo son por host) y validar el certificado
   (no deshabilitar `rejectUnauthorized`).

3. **Idempotencia.** Tabla `ath_events (ecommerce_id PK, status, received_at)`: antes de
   ejecutar /authorization o de marcar `paid`, registrar/consultar el `ecommerceId` para no
   autorizar dos veces ni doble-confirmar la cita si el *poll* se solapa. La autorización debe
   ser idempotente del lado de Bukéame (si ya está `COMPLETED`/`paid`, no reintentar).

4. **Verificación, no confianza ciega.** ATH **no** manda webhook firmado; Bukéame **consulta**
   el estado con **/findPayment** (server-side) antes de dar la cita por confirmada. Nunca
   marcar `paid` por un mensaje del frontend ("ya pagué") sin corroborar con /findPayment.

5. **Re-autenticación / 2FA en el panel** para conectar/desconectar ATH auto y para emitir
   refunds (reusa el guard que ya pide el resto del módulo de pagos). Cambiar credenciales de
   cobro es una acción sensible.

6. **Reusa lo que ya hay**: rate limiting, `audit_log` (sin secretos en el detalle),
   validación de teléfonos (`isPhone`/`normPhone`), y los fixes de seguridad previos.

---

## PARTE 7 — Recomendación honesta: ¿automático o mantener el manual?

**Recomendación: mantener el ATH Móvil MANUAL como default, y ofrecer el automático como
opción avanzada (opt-in) — NO migrar a todos.** Razonamiento:

### A favor del automático (Payment Button)
- **Mejor UX**: el cliente confirma en su app y la cita pasa a `confirmed` sola; el negocio
  no persigue referencias ni confirma a mano. Menos fricción, menos no-shows por depósito
  olvidado.
- **Conciliación limpia**: cada cobro queda con `referenceNumber` y `metadata` atados a la
  cita; aparece como ECOMMERCE en los reportes de ATH Business.
- **Refunds programáticos** desde el panel.

### En contra (y por qué pesa)
- **Obliga a custodiar un secreto del negocio** (`privateToken`). Es justo lo que el modelo
  de Bukéame evita con Stripe/PayPal (allá solo guardamos un `acct_xxx`/`merchant_id`,
  cero secretos). Custodiar private keys de terceros sube el perfil de riesgo, obliga a
  cifrado serio (idealmente KMS) y a responsabilidad legal si hay fuga.
- **No hay sandbox** → QA solo con dinero real y dos tarjetas distintas; integración frágil
  de probar y de soportar.
- **No hay webhook** → Bukéame depende de *polling* (/findPayment), más código y más casos
  borde (timeouts, expiraciones, JWT vencido) que un webhook firmado.
- **El manual ya funciona y no guarda credenciales**: el flujo actual (teléfono + referencia
  por WhatsApp) cubre el caso y tiene riesgo casi nulo.

### Conclusión práctica
1. **Fase 1 — no construir aún el automático.** El manual cumple. Priorizar Stripe Connect
   (Parte 1 del doc hermano), que da tarjetas/Apple Pay/Google Pay con cero custodia de
   secretos y sí tiene sandbox.
2. **Fase 2 — construir el automático como opt-in** para negocios que lo pidan y que
   entiendan el trade-off, **solo si** se implementa el cifrado del private token con KMS
   (no una llave suelta en `.env`) y se documenta la prueba con cuentas reales.
3. Mantener **siempre** el fallback manual disponible (si el API falla con `BTRA_9998/9999`,
   el negocio cobra como hoy).

---

## PARTE 8 — Dónde toca cada cosa en el código actual

- `database/09-schema-ath-movil.sql` → `secret_enc bytea` en `payment_providers` + tabla
  `ath_events`; `GRANT ... TO turnify_user`.
- `backend/module-payments.js` → ampliar `POST /providers/ath_movil/connect` (modo auto con
  validación + cifrado); añadir el cliente HTTP de ATH (o `module-ath.js`).
- `backend/server.js` → endpoints públicos `.../ath/start` y `.../ath/status`; en el booking,
  si el método es `ath_movil` y el negocio está en modo auto, arrancar /payment en vez de
  solo dejar el pago `pending`.
- `frontend/negocio.html` → al elegir ATH auto: pedir teléfono del cliente, llamar start,
  *poll* status, mostrar "confirma en tu app".
- `frontend/cita.html` → CTA "Pagar depósito con ATH Móvil" en citas `pending_deposit`.
- `frontend/panel.html` (sección "Pagos", tarjeta `ath_movil`) → toggle "Automatizar cobros
  ATH" + campos Public/Private token (el secreto se envía una vez y no se vuelve a mostrar).
- `.env` → `ATH_ENC_KEY` (32 bytes, base64) para cifrar el private token. **Nunca al repo.**

---

## PARTE 9 — Orden de implementación sugerido (si se hace la Fase 2)

1. Migración 09 (`secret_enc`, `ath_events`) + helper de cifrado AES-256-GCM (o KMS).
2. Cliente HTTP de ATH (los 6 servicios) con manejo de `errorcode`.
3. Onboarding auto en el panel (connect con validación /payment+/cancel + cifrado).
4. Flujo de cobro: /payment → *poll* /findPayment → /authorization → marcar `paid` +
   `confirmed`, con idempotencia.
5. Refund desde el panel (descifra secret_enc, /refund) con 2FA.
6. **Prueba de punta a punta con cuentas REALES** (ATH Business + ATH Móvil, dos tarjetas)
   antes de prender el modo auto para terceros. Mantener el manual como fallback.
