# Arquitectura y decisiones — Bukéame

Este documento registra las decisiones técnicas y de negocio detrás de Bukéame.

---

## Filosofía central

**Transparencia radical.** Cero cargos ocultos, cero comisión por los clientes del negocio. El negocio conecta su propia cuenta de pago y recibe el dinero directo — Bukéame nunca custodia fondos (menos riesgo legal y regulatorio).

**WhatsApp como caballo de batalla.** En Puerto Rico todo el mundo usa WhatsApp, y no requiere registro 10DLC como el SMS. Es gratis e ilimitado en Bukéame. El SMS queda para Fase 2.

---

## Arquitectura del backend

### Modular, montado sobre un núcleo

```
server.js (núcleo)
├── auth, negocios, citas, disponibilidad, agenda, CRM
├── monta → module-revenue.js   (productos, gift cards, add-ons, destacados)
└── monta → module-loyalty.js   (lealtad, te-toca, lista de espera, control manual)
```

Los módulos se enchufan al `server.js` compartiendo helpers (`asyncH`, `bad`, validadores, `audit`, `notify`). Se montan **antes** del catch-all 404 para que sus rutas resuelvan.

### Seguridad

- **JWT** con access token (15 min) + refresh token rotativo hasheado con SHA-256
- **bcrypt** (12 rondas) para contraseñas
- **Rate limiting** por endpoint
- **Helmet** para headers de seguridad
- **Queries parametrizadas** siempre (nunca concatenación de SQL)
- **Whitelist** de campos en updates (nunca `UPDATE *`)
- Validación estricta de tipos en cada endpoint

---

## Decisiones de negocio clave

### Referidos: $5/mes, no acumulable
Si el negocio tiene ≥1 referido activo, recibe **$5 de descuento fijo** en su mensualidad — sin importar si refiere 1 o 10. Una tabla `referral_credits` garantiza un solo crédito por mes a nivel de base de datos.

### Trial premium de 15 días
Quien llega por un referido obtiene features premium gratis por 15 días, aunque cree cuenta gratuita. La vista `v_effective_plan` decide qué features tiene hoy: las del trial si está activo, o las del plan real si venció.

### Plan gratuito: sin integraciones externas
- `external_integrations = false` → no API keys, no webhooks, no widget, no dominio propio
- `custom_branding = false` → solo los 8 temas predeterminados, no logo propio

Los planes pagos: ambos `true`.

### Productos: máximo 4 fotos
Límite **a nivel de base de datos** (trigger `enforce_photo_limit`), no solo en la app. Imposible saturar el servidor aunque alguien intente saltarse el frontend por la API.

### Gift cards: el negocio custodia el dinero
El cliente compra una gift card y paga por los procesadores del negocio. El dinero va directo al negocio; Bukéame solo lleva el registro del saldo. Esto evita que Bukéame sea responsable de "fondos no reclamados" (regulación de gift cards), trasladando esa carga al negocio.

### Programa de lealtad: lo paga el negocio
"Cada N visitas, 1 gratis." El negocio decide ofrecerlo; Bukéame solo cuenta (trigger `loyalty_on_complete`). Bukéame nunca regala servicios ni paga nada — es el contador automático.

### Lista de espera con oferta protegida de 30 minutos
El flujo más delicado del sistema:

1. Cliente quiere el martes (lleno) → reserva otro día (jueves) **y** entra a la lista de espera
2. Si alguien cancela el martes → se le ofrece el cupo por WhatsApp
3. Tiene **30 minutos** para confirmar
4. Durante esos 30 min, **su cita del jueves NO se toca**
5. Si confirma → se cancela el jueves, queda en martes
6. Si no confirma en 30 min → pierde la oferta, pasa al siguiente, **conserva su jueves intacto**

Implementado con `held_appointment_id` (la cita protegida) + `offered_appointment_id` (el cupo nuevo) + `offer_state` que expira sin tocar nada.

### Control manual del barbero: el humano siempre manda
El barbero ve su lista de espera y puede abrir cupos manualmente, eligiendo entre:
- **"Visible para todos"** → el cupo aparece reservable online
- **"Asignar a un cliente"** → se lo da directo a alguien de la lista

Si asigna manualmente a alguien con una oferta automática pendiente, esa oferta se cancela. El humano siempre tiene override sobre el algoritmo.

---

## Aislamiento en el servidor

Bukéame convive con Wifnix en el mismo VPS pero totalmente separado: carpeta, proceso PM2, puerto, base de datos y usuario distintos. El usuario `turnify_user` no tiene permisos sobre la base de Wifnix. Ver [`DEPLOY.md`](DEPLOY.md).

---

## Pendiente (Fases futuras)

- **Stripe Billing** — cobro automático de mensualidades y activación de referidos por webhook
- **SMS (Telnyx)** — arquitectado en el schema, requiere registro 10DLC antes de activar
- **Procesamiento de pagos con spread** — la "mina de oro" (modelo Square 2.9% + 30¢), pero requiere validación legal de ser payment facilitator antes de tocarlo
