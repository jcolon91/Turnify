# Bukéame

> **Tu turno, sin llamadas.** — Plataforma de reservas de citas + marketplace, hecha en Puerto Rico.

Bukéame es un SaaS de gestión de citas para barberías, salones, spas, uñas y cualquier negocio de servicios. Transparencia radical: cero cargos ocultos, cero comisión por los clientes del negocio, y WhatsApp ilimitado gratis.

Producto de **Wifnix LLC** · Caguas, Puerto Rico.

---

## ¿Por qué Bukéame?

A diferencia de Booksy, Fresha, Vagaro y otros, Bukéame:

- **No cobra comisión por tus clientes.** El negocio conecta su propia cuenta de pago (ATH Móvil, Stripe, PayPal, Klarna) y recibe el dinero directo.
- **WhatsApp ilimitado gratis** — sin límites de SMS, sin costos por mensaje. En PR todo el mundo usa WhatsApp.
- **Precio fijo, sin cargo por silla.** Un salón de 8 personas paga $29.99/mes — en Booksy serían $169.99.
- **Salones multi-especialidad** — barbería + pestañas + uñas en un mismo negocio, cada cliente elige su profesional y ve disponibilidad en vivo.
- **Marketplace local** — los clientes te encuentran por pueblo y categoría.

---

## Estructura del repositorio

```
Bukeame/
├── backend/          API REST en Node.js + Express
│   ├── server.js              Servidor principal (auth, citas, disponibilidad, CRM)
│   ├── module-revenue.js      Productos, gift cards, add-ons, destacados
│   ├── module-loyalty.js      Lealtad, te-toca, lista de espera, control manual
│   ├── package.json
│   └── .env.example           Plantilla de configuración (copiar a .env)
│
├── database/         Esquemas de PostgreSQL
│   ├── 01-schema-base.sql     Tablas base (usuarios, negocios, citas, pagos…)
│   └── 02-schema-v1.1.sql     Features: gift cards, lealtad, lista de espera…
│
├── frontend/         Interfaz web (HTML/CSS/JS, sin framework)
│   ├── index.html             Landing con precios
│   ├── buscar.html            Marketplace / buscador
│   ├── negocio.html           Página pública de un negocio
│   ├── panel.html             Dashboard del negocio
│   ├── espera.html            Lista de espera + control manual del barbero
│   ├── productos.html         Gestión de tienda (máx 4 fotos por producto)
│   ├── ajustes.html           Configuración (pagos, fidelización, integraciones)
│   └── acceso.html            Login / registro
│
└── docs/             Documentación
    ├── DEPLOY.md              Guía de instalación en el servidor (Hostinger VPS)
    └── ARCHITECTURE.md        Decisiones técnicas y de negocio
```

---

## Stack técnico

| Capa | Tecnología |
|---|---|
| Backend | Node.js + Express |
| Base de datos | PostgreSQL 16 |
| Frontend | HTML + CSS + JavaScript (vanilla, sin framework) |
| Auth | JWT (access + refresh rotativo), bcrypt |
| WhatsApp | Evolution API |
| Email | Resend |
| SMS (Fase 2) | Telnyx |
| Proceso | PM2 |
| Servidor web | Nginx (reverse proxy) |

---

## Inicio rápido (local)

> Para instalación en producción (Hostinger VPS), ver [`docs/DEPLOY.md`](docs/DEPLOY.md).

```bash
# 1. Backend
cd backend
npm install
cp .env.example .env          # luego edita .env con tus valores

# 2. Base de datos (PostgreSQL ya instalado y corriendo)
createdb bukeame
psql -d bukeame -f ../database/01-schema-base.sql
psql -d bukeame -f ../database/02-schema-v1.1.sql

# 3. Arrancar
node server.js                # o: pm2 start server.js --name bukeame-api
```

El API queda en `http://localhost:3001`. Verifica con:
```bash
curl http://localhost:3001/api/health
```

---

## Filosofía de precios

| Plan | Staff | Precio |
|---|---|---|
| Gratis | 1 | $0 (30 citas/mes, temas predeterminados) |
| Pro | 1 | $14.99/mes |
| Studio | hasta 5 | $19.99/mes |
| Team | hasta 10 | $29.99/mes |
| Grande | hasta 20 | $44.99/mes |
| Ilimitado | sin límite | $59.99/mes |

**Add-ons a la carta:** tienda de productos, gift cards, dominio propio, reportes avanzados, destacado en buscador.

---

## Licencia

Propiedad de Wifnix LLC. Todos los derechos reservados.

---

*Hecho con orgullo en Puerto Rico 🇵🇷*
