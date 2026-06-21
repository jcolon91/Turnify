# Conexiones externas — guía para el dueño

Esta guía te dice, en cristiano, **qué cuentas y llaves conseguir** y **dónde ponerlas**
para activar cada integración de Bukéame. Las llaves del servidor van en
`backend/.env` (copiado de `backend/.env.example`). Tras editar `.env`, **reinicia el API**.

> Filosofía Bukéame: **self-serve**. Para cobros (ATH Móvil y PayPal), Bukéame NO
> custodia dinero ni guarda llaves; cada negocio conecta lo suyo desde su panel.
> Las únicas llaves que tú (dueño de la plataforma) consigues son para **login social**
> y **Stripe Connect**.

---

## Tabla: qué funciona YA vs qué necesita setup

| Integración        | ¿Funciona ya? | ¿Quién consigue cuenta/llave?      | ¿Dónde se pone?                          | Costo            |
|--------------------|---------------|-------------------------------------|------------------------------------------|------------------|
| **ATH Móvil (auto)** | ✅ Sí         | Cada **negocio** (su Public Token)  | Panel del negocio (no en `.env`)         | Gratis           |
| **PayPal**         | ✅ Sí         | Cada **negocio** (su PayPal.me)     | Panel del negocio (no en `.env`)         | Gratis           |
| **Google login**   | ⚙️ Necesita setup | **Tú** (dueño plataforma)       | `GOOGLE_CLIENT_ID` en `.env`             | Gratis           |
| **Apple login**    | ⚙️ Necesita setup | **Tú** (Apple Developer)        | `APPLE_CLIENT_ID` en `.env`              | $99/año          |
| **Stripe Connect (auto)** | ⚙️ Necesita setup | **Tú** (setup único) + negocio conecta con OAuth | `STRIPE_*` en `.env`            | Gratis; Bukéame NO cobra comisión (Stripe cobra % por transacción) |

**Resumen:** ATH Móvil y PayPal ya cobran hoy sin que tú toques nada. Google login,
Apple login y Stripe Connect requieren que consigas llaves y las pegues en `.env`.

---

## 1) ATH Móvil (modo "auto") — ✅ funciona ya

**No necesitas ninguna cuenta ATH ni llave de Bukéame.** Es 100% self-serve.

**Lo que hace cada negocio:**
1. Abre su app **ATH Móvil Business** en el celular.
2. Va a **Ajustes → Development**.
3. Copia su **Public Token** (token público, seguro de exponer).
4. En su **panel de Bukéame**, activa el modo "auto" y **pega ese Public Token**.

**Importante:**
- El **Private Token** de ATH **NUNCA** se pide ni se guarda. Bukéame solo usa el público.
- **Los reembolsos los hace el propio negocio** desde su app ATH Móvil Business.
  Bukéame no procesa devoluciones de ATH.
- Bukéame no custodia el dinero: el pago va directo del cliente al ATH del negocio.

**En `.env`:** nada que poner. Ya está listo.

---

## 2) PayPal — ✅ funciona ya

**No requiere llaves de Bukéame.** Self-serve también.

**Lo que hace cada negocio:**
1. Tiene (o crea gratis) su usuario de **PayPal.me** (ej. `paypal.me/minegocio`).
2. En su **panel de Bukéame**, guarda su usuario de PayPal.me.

El cliente paga al enlace PayPal.me del negocio; el dinero va directo a su PayPal.

**En `.env`:** nada que poner. Ya está listo.

---

## 3) Google login — ⚙️ necesita setup (gratis)

Esto lo configuras **tú, una sola vez**, para toda la plataforma.

**Pasos:**
1. Entra a **Google Cloud Console** → <https://console.cloud.google.com/>.
2. Crea (o selecciona) un proyecto.
3. Ve a **APIs & Services → Credentials**.
4. **Create Credentials → OAuth client ID**.
5. Tipo de aplicación: **Web application**.
6. En **Authorized JavaScript origins**, añade: `https://bukeame.com`
   (añade también `https://www.bukeame.com` si usas el www).
7. Crea y **copia el Client ID** (termina en `.apps.googleusercontent.com`).

**En `.env`:**
```
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
```

El servidor verifica el `id_token` contra `oauth2.googleapis.com/tokeninfo`.
El frontend muestra el botón de Google **solo si** esta variable está presente.

**Costo:** gratis.

---

## 4) Apple login — ⚙️ necesita setup (Apple Developer, $99/año)

Requiere una cuenta **Apple Developer** de pago ($99/año).

**Pasos (en <https://developer.apple.com/account/>):**
1. **Certificates, Identifiers & Profiles → Identifiers**.
2. Crea un **App ID** (identificador de la app).
3. Crea un **Services ID** (este es el que se usa como client_id en web). Ej.
   `com.bukeame.web`. Asocia el dominio `bukeame.com` y la URL de retorno.
4. Crea una **Key** para "Sign in with Apple" (te bajas un archivo `.p8`).

**En `.env`:**
```
APPLE_CLIENT_ID=com.bukeame.web
```
(El `APPLE_CLIENT_ID` es el **Services ID**, no el App ID.)

El servidor verifica el JWT con el JWKS de `appleid.apple.com`. El frontend muestra
el botón de Apple **solo si** esta variable está presente.

**Nota sobre el secret de Apple (para verificación de servidor):**
Apple además permite generar un **client secret** firmado con la Key `.p8`
(usando Team ID + Key ID). Hoy **no es obligatorio** para el flujo básico. Si más
adelante hace falta para verificación de servidor más estricta, se documentará y se
añadirá entonces (variables tipo `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`).

**Costo:** $99/año (cuenta Apple Developer).

---

## 5) Stripe Connect (AUTOMÁTICO) — ⚙️ necesita setup (gratis de configurar)

Stripe Connect es el cobro **automático** de Bukéame: el negocio conecta SU propia
cuenta Stripe con **OAuth (pocos clics)** y, de ahí en adelante, cobra con tarjeta
sin tocar nada más. Es un **cargo directo**: el dinero va **100% al negocio**;
**Bukéame NO cobra comisión** y NO custodia el dinero. (Stripe sí cobra su comisión
de procesamiento por transacción, y eso lo paga el negocio.)

Tú, dueño de la plataforma, haces un **setup ÚNICO** (una sola vez, para todo
Bukéame). Después, cada negocio se conecta solo con OAuth desde su panel.

### Setup ÚNICO de plataforma (lo haces tú una vez, en <https://dashboard.stripe.com/>)

1. **Crea la cuenta Stripe de la plataforma** (la cuenta de Bukéame, gratis) y
   **activa Connect** eligiendo tipo **Standard**:
   **Settings → Connect** (o <https://dashboard.stripe.com/connect>).

2. **Copia el Secret key** desde **Developers → API keys**
   (empieza con `sk_live_...` en live, `sk_test_...` en test) →
   pégalo en **`STRIPE_SECRET_KEY`** en `.env`.

3. **En Connect settings**, copia el **client_id** (empieza con `ca_...`) →
   pégalo en **`STRIPE_CONNECT_CLIENT_ID`** en `.env`. En esa misma pantalla,
   **registra el Redirect URI**:
   `https://bukeame.com/api/payments/stripe/callback`

4. **Crea un endpoint de webhook** en Stripe
   (**Developers → Webhooks → Add endpoint**) apuntando a:
   `https://bukeame.com/api/payments/stripe/webhook`
   - Suscribe los eventos **`checkout.session.completed`** y
     **`payment_intent.succeeded`**.
   - **IMPORTANTE:** marca que escuche **eventos de "Connected accounts"**
     (la casilla "Listen to events on Connected accounts"), porque los pagos
     ocurren en las cuentas conectadas de los negocios, no en la de la plataforma.
   - Copia el **Signing secret** del endpoint (empieza con `whsec_...`) →
     pégalo en **`STRIPE_WEBHOOK_SECRET`** en `.env`.

5. **Recuerda probar en modo TEST de Stripe antes de pasar a live.** Usa las llaves
   `sk_test_...` / `ca_...` de test y tarjetas de prueba; cuando todo funcione,
   cambia a las llaves live.

### Lo que hace cada negocio (no es setup tuyo)

Pulsa **"Conectar con Stripe"** en su panel, autoriza con OAuth (pocos clics) y
listo. A partir de ahí cobra con tarjeta y el dinero le llega **directo**.

**En `.env`:**
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_CONNECT_CLIENT_ID=ca_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Si faltan estas variables, el botón **"Conectar con Stripe"** queda deshabilitado
(el API responde 503). Bukéame no toca el dinero: cada negocio conecta su cuenta.

**Costo:** configurar Connect es gratis; **Bukéame no cobra comisión**. Stripe cobra
su comisión de procesamiento por transacción (la paga el negocio, no Bukéame).

---

## Recordatorio operativo

- Todas las llaves de servidor van en **`backend/.env`** (nunca en GitHub; ya está
  en `.gitignore`). Usa `backend/.env.example` como plantilla.
- Tras cualquier cambio en `.env`, **reinicia el API** para que tome los valores.
- ATH Móvil y PayPal **no** necesitan nada en `.env`: son self-serve desde el panel
  de cada negocio.
