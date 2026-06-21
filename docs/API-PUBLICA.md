# API pública de reservas — Bukéame

API REST para que cualquier negocio integre **sus** reservas, productos y gift cards en su propia web o app. Es la misma API que usan la página pública de Bukéame y el `widget.js`.

- **Sin login.** Son rutas públicas pensadas para el cliente final. No requieren API key.
- **CORS abierto.** El prefijo `/api/public/*` acepta peticiones `fetch()` desde **cualquier dominio** (`Access-Control-Allow-Origin: *`). El resto del API (rutas con token) queda restringido a Bukéame.
- **Rate limit.** Hay límites anti-spam por IP. Si recibes `429`, baja la frecuencia.
- **Solo lectura + reservas.** Para leer/modificar datos privados (tus citas, clientes, ingresos) hace falta la **API privada con llaves** (Tier 2), aún no disponible.

> ¿No quieres programar? Usa el botón embebible: `<script src="https://bukeame.com/widget.js" data-slug="tu-negocio" defer></script>`. Ver [developers.html](../frontend/developers.html).

---

## Base URL y convenciones

```
https://bukeame.com
```

- **`:slug`** es el identificador de tu negocio (el de `bukeame.com/negocio.html?slug=<slug>`).
- **Dinero** siempre en **centavos** (`price_cents: 2500` = $25.00).
- **Fechas/horas** en **ISO 8601 UTC** (`2026-06-21T17:00:00.000Z`). La zona del negocio es `America/Puerto_Rico`.
- **`Content-Type: application/json`** en los `POST`.
- Errores: código HTTP + `{ "error": "mensaje" }`. Éxito de creación: `201`.

---

## Flujo de reserva (lo esencial)

```
1. GET  /api/public/:slug                         → servicios + staff del negocio
2. GET  /api/public/:slug/availability?...        → horarios disponibles (ISO)
3. POST /api/public/:slug/appointments            → crea la cita, devuelve el código
4. GET  /api/public/appointments/:code            → (opcional) consultar el ticket
```

### Ejemplo completo con `fetch`

```js
const BASE = 'https://bukeame.com';
const slug = 'los-pelaos';

// 1) Servicios del negocio
const info = await fetch(`${BASE}/api/public/${slug}`).then(r => r.json());
const service = info.services[0];           // escoge un servicio

// 2) Disponibilidad para una fecha
const date = '2026-06-25';
const av = await fetch(
  `${BASE}/api/public/${slug}/availability?service_id=${service.id}&date=${date}`
).then(r => r.json());
const slot = av.slots[0];                    // ej: "2026-06-25T17:00:00.000Z"

// 3) Crear la cita
const res = await fetch(`${BASE}/api/public/${slug}/appointments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    service_id: service.id,
    start_iso: slot,
    full_name: 'Juan del Pueblo',
    phone: '7871234567',                     // WhatsApp PR/US, 10 dígitos
    email: 'juan@example.com'                // opcional, para el recibo
  })
}).then(r => r.json());

console.log(res.appointment.confirmation_code);  // ej: "A7K2QD"
```

---

## Endpoints

### `GET /api/public/:slug`
Perfil del negocio con todo lo necesario para construir la pantalla de reserva.

**Respuesta `200`**
```jsonc
{
  "business": {
    "id": "uuid", "slug": "los-pelaos", "name": "Los Pelaos",
    "bio": "…", "phone": "…", "whatsapp": "…", "address_line": "…",
    "logo_url": "…", "cover_url": "…", "rating_avg": 4.8, "rating_count": 53,
    "cancellation_hours": 24, "deposit_default_cents": 500,
    "booking_horizon_days": 60, "deposits_enabled": true, "municipality": "Caguas"
  },
  "services": [
    { "id": "uuid", "name": "Corte", "description": "…",
      "duration_min": 30, "price_cents": 2500, "deposit_cents": 500,
      "photo_url": "…", "is_featured": true }
  ],
  "staff":   [ { "id": "uuid", "display_name": "Carlos", "specialties": [], "rating_avg": 4.9 } ],
  "hours":   [ { "day_of_week": 1, "opens": "09:00", "closes": "18:00" } ],
  "reviews": [ { "rating": 5, "comment": "…", "full_name": "Ana", "created_at": "…" } ],
  "payment_methods": ["stripe", "ath_movil", "cash"],
  "products": [ { "id": "uuid", "name": "Pomada", "price_cents": 1500, "stock": 12, "photos": [] } ]
}
```

### `GET /api/public/:slug/availability`
Horarios libres para uno o varios servicios en una fecha.

**Query**
| Param | Req | Notas |
|---|---|---|
| `service_id` | sí | Un UUID, o varios separados por coma (`uuid1,uuid2`) — suma las duraciones. |
| `date` | sí | `YYYY-MM-DD`. |
| `staff_id` | no | Si lo omites, combina la disponibilidad de todo el staff elegible. |

**Respuesta `200`**
```json
{ "date": "2026-06-25", "duration_min": 30,
  "slots": ["2026-06-25T17:00:00.000Z", "2026-06-25T17:15:00.000Z"] }
```
Si la fecha está fuera del horizonte de reserva: `{ "slots": [], "reason": "fuera_de_horizonte" }`.

### `POST /api/public/:slug/appointments`
Crea una cita. Atómico: si el cupo se toma en el intermedio, devuelve `409` (escoge otro slot).

**Body**
| Campo | Req | Notas |
|---|---|---|
| `service_id` | sí | UUID, array de UUIDs, o coma-separados. |
| `start_iso` | sí | Un valor exacto de `slots` (ISO). Debe ser futuro. |
| `full_name` | sí | Máx 120. |
| `phone` | sí | WhatsApp PR/US, 10 dígitos. Ahí se manda el recordatorio. |
| `staff_id` | no | Si lo omites, asigna un staff elegible automáticamente. |
| `email` | no | Para el recibo por correo. |
| `client_notes` | no | Máx 300. |
| `payment_method` | no | Para el depósito si el negocio lo exige (`ath_movil`, `cash`, …). |

**Respuesta `201`**
```jsonc
{
  "appointment": {
    "confirmation_code": "A7K2QD",
    "status": "confirmed",            // o "pending_deposit" si requiere depósito
    "starts_at": "2026-06-25T17:00:00.000Z",
    "service_name": "Corte",
    "staff_name": "Carlos",
    "price_cents": 2500,
    "deposit_cents": 0,
    "payment_method": null,
    "ath_phone": null                 // si paga depósito por ATH, el número del negocio
  }
}
```
Errores comunes: `400` (datos inválidos), `404` (negocio/servicio), `409` (cupo tomado o límite del plan del negocio).

### `GET /api/public/appointments/:code`
Consulta un ticket por su código de confirmación (case-insensitive).
```json
{ "appointment": { "confirmation_code": "A7K2QD", "status": "confirmed",
  "starts_at": "…", "service_name": "Corte", "staff_name": "Carlos",
  "business_name": "Los Pelaos", "slug": "los-pelaos", "deposit": null } }
```

### `POST /api/public/appointments/:code/cancel`
Cancela respetando la política del negocio (`cancellation_hours`). Body opcional `{ "reason": "…" }`.
`409` si ya pasó la ventana de cancelación o la cita ya no está activa.

### `POST /api/public/appointments/:code/ath-reference`
El cliente reporta la referencia de su pago ATH Móvil para que el negocio la verifique.
Body `{ "reference": "…" }` → `{ "ok": true, "message": "…" }`.

---

## Extras (mismo patrón público)

| Endpoint | Qué hace |
|---|---|
| `GET /api/public/search?q=&category=&municipality=` | Buscar negocios. |
| `GET /api/public/categories` · `GET /api/public/municipalities` | Catálogos para filtros. |
| `POST /api/public/:slug/orders` | Comprar productos (carrito). |
| `POST /api/public/:slug/gift-cards` | Comprar una gift card. |
| `GET /api/public/:slug/gift-cards/:code` | Consultar saldo de una gift card. |
| `POST /api/public/:slug/waitlist` | Unirse a la lista de espera. |

---

## Seguridad y buenas prácticas

- **No expongas nada privado.** Esta API no da acceso a datos de gestión; solo a lo que ya es público en la página del negocio.
- **Valida del lado del negocio.** Los límites (depósitos, política de cancelación, cupos del plan) los aplica Bukéame; tu front solo refleja lo que devuelve la API.
- **Maneja `429`.** Implementa reintentos con espera si haces muchas llamadas.
- **CORS:** funciona desde el navegador del cliente. No necesitas proxy propio para el flujo de reserva.

## Pendiente (Tier 2 — API privada)
Para leer/gestionar tus citas y clientes desde tus sistemas hará falta una **API key por negocio** (con scopes y revocación) + **webhooks**. Esa fase se documentará aparte cuando se implemente.
