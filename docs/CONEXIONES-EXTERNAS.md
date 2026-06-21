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
| **Stripe Connect** | ⚙️ Necesita setup | **Tú** + cada negocio conecta   | `STRIPE_*` en `.env`                      | Gratis (Stripe cobra % por transacción) |

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

## 5) Stripe Connect — ⚙️ necesita setup (gratis de configurar)

Permite que **cada negocio conecte SU propia cuenta Stripe** (OAuth Standard). El
dinero va **directo al negocio**; Bukéame no lo custodia. Tú configuras la app de
Connect una vez; cada negocio luego pulsa "Conectar con Stripe".

**Pasos (en <https://dashboard.stripe.com/>):**
1. Crea tu cuenta **Stripe** (gratis).
2. Activa **Connect** y elige tipo **Standard**:
   **Settings → Connect** (o <https://dashboard.stripe.com/connect>).
3. En la configuración de Connect, copia el **client_id** (empieza con `ca_...`).
4. Copia tu **Secret key** (empieza con `sk_live_...` en producción) desde
   **Developers → API keys**.
5. En el dashboard de Connect, configura el **Redirect URI**:
   `https://bukeame.com/api/payments/stripe/callback`

**En `.env`:**
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_CONNECT_CLIENT_ID=ca_...
```

Si faltan estas variables, el botón **"Conectar con Stripe"** queda deshabilitado
(el API responde 503). Bukéame no toca el dinero: cada negocio conecta su cuenta.

**Costo:** configurar Connect es gratis; Stripe cobra su comisión por transacción
(la paga el negocio, no Bukéame).

---

## Recordatorio operativo

- Todas las llaves de servidor van en **`backend/.env`** (nunca en GitHub; ya está
  en `.gitignore`). Usa `backend/.env.example` como plantilla.
- Tras cualquier cambio en `.env`, **reinicia el API** para que tome los valores.
- ATH Móvil y PayPal **no** necesitan nada en `.env`: son self-serve desde el panel
  de cada negocio.
