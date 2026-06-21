// ============================================================================
//  BUKEAME API — server.js v1.0
//  Express :3001 · PostgreSQL "bukeame" · Aislado de wifnix-api (:3000) — totalmente aislado
// ----------------------------------------------------------------------------
//  DEPLOY (VPS 2.24.70.107):
//    mkdir -p /var/www/bukeame && cd /var/www/bukeame
//    wget <raw github>/server.js <raw>/package.json <raw>/.env.example
//    cp .env.example .env && nano .env        # llena secretos
//    npm install --omit=dev
//    node --check server.js
//    pm2 start server.js --name bukeame-api --max-memory-restart 300M
//    pm2 save
// ============================================================================

require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const multer    = require('multer');
const sharp     = require('sharp');
const path      = require('path');
const fs        = require('fs');
const { Pool }  = require('pg');

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const {
  PORT = 3001,
  DATABASE_URL,
  JWT_SECRET,
  CORS_ORIGINS = '',
  EVOLUTION_API_URL,            // http://localhost:8080  (Evolution API, opcional)
  EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE = 'turnify',
  RESEND_API_KEY,           // emails (opcional)
  EMAIL_FROM = 'Bukeame <citas@bukeame.com>',
  GOOGLE_CLIENT_ID,         // login social Google (opcional)
  APPLE_CLIENT_ID,          // login social Apple — service ID / bundle id (opcional)
  NODE_ENV = 'production',
} = process.env;

if (!DATABASE_URL || !JWT_SECRET) {
  console.error('FALTA DATABASE_URL o JWT_SECRET en .env'); process.exit(1);
}
// El JWT_SECRET débil hace que cualquiera pueda forjar tokens. Exigimos ≥32 chars.
if (JWT_SECRET.length < 32) {
  console.error('JWT_SECRET demasiado corto: usa mínimo 32 caracteres (openssl rand -base64 48)');
  process.exit(1);
}

const TZ_OFFSET = '-04:00';            // PR no observa DST (AST fijo)
const ACCESS_TTL  = '15m';
const REFRESH_DAYS = 30;
const ALIVE = ['pending_deposit','confirmed'];   // citas que ocupan turno

const db = new Pool({ connectionString: DATABASE_URL, max: 10 });

// ----------------------------------------------------------------------------
// APP BASE + SEGURIDAD
// ----------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);             // detrás de Nginx
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// ----------------------------------------------------------------------------
// STRIPE CONNECT — WEBHOOK (cargo DIRECTO en la cuenta del negocio)
// ----------------------------------------------------------------------------
// DEBE registrarse ANTES de express.json para tener el body CRUDO (Stripe firma
// los bytes exactos; cualquier reparse rompe la verificación de firma).
// Gateado por STRIPE_WEBHOOK_SECRET. Sin SDK: firma verificada a mano con crypto.
//
// Verificación de firma (replica stripe.webhooks.constructEvent):
//   1) header 'stripe-signature' = "t=<unix>,v1=<hex>[,v1=<hex>...]"
//   2) signed_payload = `${t}.${rawBody}`  (rawBody = bytes crudos como string)
//   3) esperado = HMAC-SHA256(signed_payload, STRIPE_WEBHOOK_SECRET) en hex
//   4) comparar contra cada v1 con crypto.timingSafeEqual (anti timing-attack)
//   5) anti-replay: rechazar si |now - t| > 5 min
// Si la firma es válida → 200 {received:true} SIEMPRE (aunque el evento no aplique).
// NOTA: asyncH (línea ~139) aún no está inicializado aquí (TDZ por ser `const`
// declarado más abajo); por eso envolvemos el handler con un .catch(next) inline.
app.post('/api/payments/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => Promise.resolve((async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'Webhook no configurado' });

    // express.raw deja el body como Buffer; si no, no podemos verificar firma.
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    const sigHeader = req.get('stripe-signature') || '';
    if (!raw || !sigHeader) return res.status(400).json({ error: 'Firma ausente' });

    // Parse "t=...,v1=...,v1=..." → t (timestamp) y lista de firmas v1.
    let t = null; const v1s = [];
    for (const part of sigHeader.split(',')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i), val = part.slice(i + 1);
      if (k === 't') t = val;
      else if (k === 'v1') v1s.push(val);
    }
    if (!t || !/^\d+$/.test(t) || v1s.length === 0)
      return res.status(400).json({ error: 'Firma inválida' });

    // Anti-replay: la marca de tiempo no puede diferir más de 5 min del reloj actual.
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - Number(t)) > 300)
      return res.status(400).json({ error: 'Firma expirada' });

    // HMAC-SHA256 de `${t}.${rawBody}`; comparación constante contra cada v1.
    const rawStr = raw.toString('utf8');
    const expected = crypto.createHmac('sha256', secret)
      .update(`${t}.${rawStr}`, 'utf8').digest('hex');
    const expBuf = Buffer.from(expected, 'utf8');
    let match = false;
    for (const v1 of v1s) {
      const got = Buffer.from(v1, 'utf8');
      if (got.length === expBuf.length && crypto.timingSafeEqual(got, expBuf)) { match = true; break; }
    }
    if (!match) return res.status(400).json({ error: 'Firma no coincide' });

    // Firma válida → parseamos el evento. A partir de aquí SIEMPRE respondemos 200
    // (aunque el evento no aplique) para que Stripe no reintente en bucle.
    let event;
    try { event = JSON.parse(rawStr); }
    catch { return res.status(400).json({ error: 'JSON inválido' }); }

    const type = event && event.type;
    const obj  = (event && event.data && event.data.object) || {};

    if (type === 'checkout.session.completed' || type === 'payment_intent.succeeded') {
      // confirmation_code viaja en metadata de la sesión y/o del payment_intent.
      const md = obj.metadata || {};
      const code = (md.confirmation_code || '').toString().trim().toUpperCase();
      // En payment_intent.succeeded usamos su id; en checkout.session el payment_intent (o el id de sesión).
      const extRef = obj.payment_intent || obj.id || null;

      if (code) {
        // Busca el depósito de ESTA cita por confirmation_code (cualquier negocio:
        // el code es de alta entropía y único; el webhook es global de la plataforma).
        const { rows } = await db.query(
          `SELECT a.id, a.business_id, a.service_name, a.status,
                  p.id AS payment_id, p.status AS pay_status
             FROM appointments a
             LEFT JOIN payments p ON p.appointment_id = a.id AND p.kind = 'deposit'
            WHERE a.confirmation_code = $1
            LIMIT 1`, [code]);
        const a = rows[0];
        // IDEMPOTENTE: si no existe, ya está pagado o ya está confirmado → no reprocesar.
        if (a && a.pay_status !== 'paid' && a.status !== 'confirmed') {
          if (a.payment_id)
            await db.query(
              `UPDATE payments SET status = 'paid', paid_at = now(), external_ref = $2
                WHERE id = $1 AND status <> 'paid'`,
              [a.payment_id, extRef]);
          await db.query(
            `UPDATE appointments SET status = 'confirmed'
              WHERE id = $1 AND status = 'pending_deposit'`, [a.id]);
          try {
            await notify(a.business_id, 'payment', 'Pago con tarjeta recibido',
              `${a.service_name} · ${extRef || code}`, { appointment_id: a.id });
          } catch (e) { console.error('stripe webhook notify:', e.message); }
        }
      }
    }
    // Firma válida ⇒ 200 siempre (aplique o no el evento).
    return res.json({ received: true });
  })(req, res)).catch(next));

app.use(express.json({ limit: '1mb' }));

// --- Uploads (logos de negocios) ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LOGO_DIR   = path.join(UPLOAD_DIR, 'logos');
const COVER_DIR  = path.join(UPLOAD_DIR, 'covers');
const PORTFOLIO_DIR = path.join(UPLOAD_DIR, 'portfolio');
const STAFF_DIR  = path.join(UPLOAD_DIR, 'staff');
const PRODUCTS_DIR = path.join(UPLOAD_DIR, 'products');
try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch (e) { /* ya existe */ }
try { fs.mkdirSync(COVER_DIR, { recursive: true }); } catch (e) { /* ya existe */ }
try { fs.mkdirSync(STAFF_DIR, { recursive: true }); } catch (e) { /* ya existe */ }
try { fs.mkdirSync(PORTFOLIO_DIR, { recursive: true }); } catch (e) { /* ya existe */ }
try { fs.mkdirSync(PRODUCTS_DIR, { recursive: true }); } catch (e) { /* ya existe */ }

// Borra un archivo de /uploads de forma SEGURA. Toma solo el basename y verifica
// que el path resuelto quede DENTRO del dir permitido → neutraliza path traversal
// (ej. logo_url = "/uploads/logos/../../../.env" ya no puede borrar nada externo).
function safeUnlinkUpload(urlPath, allowedDir) {
  if (!urlPath || typeof urlPath !== 'string') return;
  const resolved = path.resolve(allowedDir, path.basename(urlPath));
  if (resolved !== path.join(path.resolve(allowedDir), path.basename(urlPath))) return;
  if (!resolved.startsWith(path.resolve(allowedDir) + path.sep)) return;
  fs.unlink(resolved, () => {});   // silencioso si no existe
}
// Servir las imágenes subidas como archivos estáticos
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: false }));
// Multer en memoria: validamos tipo y tamaño antes de procesar con sharp
const ALLOWED_IMG = new Set(['image/jpeg', 'image/png', 'image/webp']);
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },   // 5MB máx de entrada
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMG.has(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten imágenes JPG, PNG o WEBP'));
  },
});

const origins = CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
// En producción NUNCA reflejamos cualquier origen: si no hay lista, negamos por
// defecto (evita que un sitio cualquiera consuma el API). En dev sí abrimos.
const corsOrigin = origins.length ? origins : (NODE_ENV === 'production' ? false : true);
if (!origins.length && NODE_ENV === 'production')
  console.warn('⚠ CORS_ORIGINS vacío en producción: el API rechazará peticiones cross-origin.');
// La API pública de reservas (/api/public/*) se puede consumir desde CUALQUIER web de
// negocio: son rutas sin login ni cookies, ya con rate-limit (publicLimiter/bookingLimiter).
// Por eso abrimos CORS a '*' SOLO en ese prefijo. El resto del API (rutas con token) queda
// restringido a CORS_ORIGINS. Un único dispatcher evita cabeceras CORS duplicadas.
const publicCors  = cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], credentials: false });
const privateCors = cors({ origin: corsOrigin, credentials: false });
app.use((req, res, next) =>
  req.path.startsWith('/api/public') ? publicCors(req, res, next) : privateCors(req, res, next));

app.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));
const authLimiter   = rateLimit({ windowMs: 15 * 60_000, max: 20,  message: { error: 'Demasiados intentos. Espera 15 minutos.' } });
// Lockout por cuenta: keyed por email (o IP si no hay email) para frenar fuerza bruta dirigida.
const loginLimiter  = rateLimit({ windowMs: 15 * 60_000, max: 8, keyGenerator: (req) => (req.body && req.body.email) ? ('em:' + String(req.body.email).toLowerCase().trim()) : req.ip, message: { error: 'Demasiados intentos para esta cuenta. Espera 15 minutos.' } });
// Refresh con su propio cubo, separado de login, para que rotar no consuma intentos de login.
const refreshLimiter = rateLimit({ windowMs: 15 * 60_000, max: 60, message: { error: 'Demasiados intentos. Espera 15 minutos.' } });
const publicLimiter = rateLimit({ windowMs: 60_000,      max: 60,  message: { error: 'Vas muy rápido. Intenta en un minuto.' } });
// Endpoints de ticket por código (ver/cancelar/ref ATH): límite duro para que
// nadie pueda enumerar/brute-forcear códigos de confirmación de otros clientes.
const codeLimiter   = rateLimit({ windowMs: 60_000,      max: 10,  message: { error: 'Demasiadas consultas. Intenta en un minuto.' } });
// Creación pública (citas, órdenes, gift cards, lista de espera): anti-spam.
const bookingLimiter = rateLimit({ windowMs: 60_000,     max: 12,  message: { error: 'Demasiadas solicitudes seguidas. Espera un minuto.' } });

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad    = (res, msg, code = 400) => res.status(code).json({ error: msg });
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

const isStr   = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
// Teléfono → E.164 (PR/US, plan norteamericano). Normaliza a +1XXXXXXXXXX.
// Valida 10 dígitos con código de área válido (empieza en 2-9): rechaza typos,
// largos malos y letras. Asegura que WhatsApp/SMS lleguen (número malo = recordatorio perdido).
function toE164(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  let d = String(v).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);   // 1XXXXXXXXXX → XXXXXXXXXX
  if (!/^[2-9]\d{9}$/.test(d)) return null;              // 10 dígitos, área 2-9
  return '+1' + d;
}
const isPhone   = v => toE164(v) !== null;
const normPhone = v => toE164(v);   // null si inválido; todos los callers validan con isPhone antes
const isEmail = v => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
const isUuid  = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const isDate  = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime  = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

const slugify = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function genReferralCode(name) {
  const base = slugify(name).replace(/-/g, '').slice(0, 10).toUpperCase() || 'BUKEAME';
  return base + '-' + crypto.randomInt(100, 999);
}

// Código de confirmación con alta entropía → NO enumerable.
// Formato: <PREFIJO>-MMDD-XXXXX (5 chars de un alfabeto sin O/0/I/1/L = 31^5 ≈ 28M).
// Antes era -NNN (900 combos), brute-forceable. Ahora + el codeLimiter lo cierra.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function confirmCode(prefix, starts) {
  let suf = '';
  for (let i = 0; i < 5; i++) suf += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  const mmdd = String(starts.getMonth() + 1).padStart(2, '0') + String(starts.getDate()).padStart(2, '0');
  return `${prefix || 'BK'}-${mmdd}-${suf}`;
}

async function audit(req, action, entity = null, entityId = null, data = {}) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_user_id, business_id, action, entity, entity_id, data, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user?.id || null, req.business?.id || null, action, entity, entityId, data, req.ip]);
  } catch (e) { console.error('audit:', e.message); }
}

async function notify(businessId, type, title, body, data = {}) {
  await db.query(
    `INSERT INTO notifications (business_id, type, title, body, data)
     VALUES ($1,$2,$3,$4,$5)`, [businessId, type, title, body, data]);
}

// ----------------------------------------------------------------------------
// AUTH — JWT 15min + refresh rotativo (hash en DB)
// ----------------------------------------------------------------------------
function signAccess(user) {
  return jwt.sign({ sub: user.id, adm: !!user.is_platform_admin }, JWT_SECRET, { expiresIn: ACCESS_TTL });
}
async function issueRefresh(userId, req) {
  const token = crypto.randomBytes(48).toString('base64url');
  const exp = new Date(Date.now() + REFRESH_DAYS * 864e5);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, sha256(token), (req.headers['user-agent'] || '').slice(0, 250), req.ip, exp]);
  return token;
}

// Genera y envía un email de verificación (invalida los enlaces previos sin usar).
async function sendVerificationEmail(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + 24 * 3600 * 1000); // 24 horas
  await db.query(`UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
  await db.query(`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
    [user.id, sha256(token), exp]);
  const link = `https://bukeame.com/verificar.html?token=${token}`;
  try {
    const e = emailVerify(user.full_name, link);
    sendEmail(user.email, e.subject, e.text, e.html).catch(err => console.error('verify email:', err.message));
  } catch (err) { console.error('verify email build:', err.message); }
}

const authRequired = asyncH(async (req, res, next) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return bad(res, 'Token requerido', 401);
  let payload;
  try { payload = jwt.verify(h.slice(7), JWT_SECRET); }
  catch { return bad(res, 'Sesión expirada', 401); }
  const { rows } = await db.query(
    `SELECT id, email, phone, full_name, is_platform_admin FROM users
     WHERE id = $1 AND deleted_at IS NULL`, [payload.sub]);
  if (!rows[0]) return bad(res, 'Sesión expirada', 401);
  req.user = rows[0];
  next();
});

// Carga el negocio del dueño (multi-tenant scope)
const businessScope = asyncH(async (req, res, next) => {
  const { rows } = await db.query(
    `SELECT b.*, s.plan_code, p.max_staff, p.max_appts_month, p.features
       FROM businesses b
       JOIN subscriptions s ON s.business_id = b.id
       JOIN plans p ON p.code = s.plan_code
      WHERE b.owner_user_id = $1 AND b.deleted_at IS NULL
      LIMIT 1`, [req.user.id]);
  if (!rows[0]) return bad(res, 'No tienes un negocio registrado todavía', 404);
  req.business = rows[0];
  next();
});

// ============================================================================
//  RUTAS — AUTH
// ============================================================================
app.post('/api/auth/register', authLimiter, asyncH(async (req, res) => {
  const { full_name, email, phone, password } = req.body || {};
  if (!isStr(full_name, 120)) return bad(res, 'Nombre requerido');
  if (!isEmail(email))        return bad(res, 'Email válido requerido');
  if (!isStr(password, 100) || password.length < 8) return bad(res, 'Contraseña mínima de 8 caracteres');
  if (phone && !isPhone(phone)) return bad(res, 'Teléfono inválido (usa un número de PR/US de 10 dígitos)');

  const hash = await bcrypt.hash(password, 12);
  let user;
  try {
    const { rows } = await db.query(
      `INSERT INTO users (full_name, email, phone, password_hash)
       VALUES ($1,$2,$3,$4) RETURNING id, full_name, email, is_platform_admin`,
      [full_name.trim(), email.toLowerCase(), phone ? normPhone(phone) : null, hash]);
    user = rows[0];
  } catch (e) {
    // Mensaje neutral: no confirmamos si fue el email o el teléfono (anti-enumeración).
    if (e.code === '23505') return bad(res, 'No pudimos crear la cuenta con esos datos. ¿Ya tienes cuenta? Inicia sesión.', 409);
    throw e;
  }
  const refresh = await issueRefresh(user.id, req);
  // Email de verificación (da la bienvenida y pide verificar). No bloquea el registro si Resend falla.
  await sendVerificationEmail(user);
  user.email_verified = false;
  res.status(201).json({ user, access_token: signAccess(user), refresh_token: refresh });
}));

app.post('/api/auth/login', authLimiter, loginLimiter, asyncH(async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || !isStr(password, 100)) return bad(res, 'Credenciales inválidas', 401);
  const { rows } = await db.query(
    `SELECT id, full_name, email, password_hash, is_platform_admin,
            email_verified_at IS NOT NULL AS email_verified
       FROM users WHERE email = $1 AND deleted_at IS NULL`, [email.toLowerCase()]);
  const u = rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(password, u.password_hash)))
    return bad(res, 'Credenciales inválidas', 401);
  await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
  const refresh = await issueRefresh(u.id, req);
  delete u.password_hash;
  res.json({ user: u, access_token: signAccess(u), refresh_token: refresh });
}));

// Pedir restablecer contraseña: siempre responde igual (no revela qué emails existen)
app.post('/api/auth/forgot-password', authLimiter, asyncH(async (req, res) => {
  const { email } = req.body || {};
  const generic = { ok: true, message: 'Si ese email está registrado, te enviamos un enlace para restablecer tu contraseña.' };
  if (!isEmail(email)) return res.json(generic);
  const { rows } = await db.query(
    `SELECT id, full_name, email FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [email.toLowerCase()]);
  const u = rows[0];
  if (u) {
    const token = crypto.randomBytes(48).toString('base64url');
    const exp = new Date(Date.now() + 3600 * 1000); // 1 hora
    // Invalida cualquier enlace de reset previo sin usar (solo el último queda válido)
    await db.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.id]);
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
      [u.id, sha256(token), exp]);
    const link = `https://bukeame.com/reset.html?token=${token}`;
    try {
      const e = emailReset(u.full_name, link);
      sendEmail(u.email, e.subject, e.text, e.html).catch(err => console.error('reset email:', err.message));
    } catch (err) { console.error('reset email build:', err.message); }
  }
  return res.json(generic);
}));

// Aplicar nueva contraseña con el token del email
app.post('/api/auth/reset-password', authLimiter, asyncH(async (req, res) => {
  const { token, password } = req.body || {};
  if (!isStr(token, 200)) return bad(res, 'Enlace inválido', 400);
  if (!isStr(password, 100) || password.length < 8) return bad(res, 'Contraseña mínima de 8 caracteres');
  const { rows } = await db.query(
    `SELECT id, user_id FROM password_resets
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [sha256(token)]);
  const pr = rows[0];
  if (!pr) return bad(res, 'El enlace expiró o ya fue usado. Solicita uno nuevo.', 400);
  const hash = await bcrypt.hash(password, 12);
  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, pr.user_id]);
  await db.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [pr.id]);
  // Seguridad: cerrar todas las sesiones activas tras cambiar la contraseña
  await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [pr.user_id]);
  return res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes entrar.' });
}));

app.post('/api/auth/refresh', refreshLimiter, asyncH(async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!isStr(refresh_token, 200)) return bad(res, 'Refresh token requerido', 401);
  // Buscar SIN el filtro revoked_at para detectar reúso de un token ya rotado.
  const { rows } = await db.query(
    `SELECT rt.id, rt.user_id, rt.revoked_at, u.full_name, u.is_platform_admin
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1 AND rt.expires_at > now()
        AND u.deleted_at IS NULL`, [sha256(refresh_token)]);
  const t = rows[0];
  if (!t) return bad(res, 'Sesión expirada, entra de nuevo', 401);
  // Reúso de un token ya revocado = señal de robo: revocar TODAS las sesiones del usuario.
  if (t.revoked_at) {
    await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.user_id]);
    return bad(res, 'Sesión inválida, vuelve a entrar', 401);
  }
  // Rotación: el viejo muere, nace uno nuevo
  await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [t.id]);
  const refresh = await issueRefresh(t.user_id, req);
  res.json({ access_token: signAccess({ id: t.user_id, is_platform_admin: t.is_platform_admin }), refresh_token: refresh });
}));

app.post('/api/auth/logout', authRequired, asyncH(async (req, res) => {
  const { refresh_token } = req.body || {};
  if (isStr(refresh_token, 200))
    await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [sha256(refresh_token)]);
  res.json({ ok: true });
}));

// Datos frescos del usuario autenticado (incluye email_verified para el banner del panel)
app.get('/api/auth/me', authRequired, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, full_name, email, is_platform_admin, email_verified_at IS NOT NULL AS email_verified
       FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.user.id]);
  if (!rows[0]) return bad(res, 'No encontrado', 404);
  res.json({ user: rows[0] });
}));

// Verificar email con el token del correo. Activa el trial Pro pendiente del referido.
app.post('/api/auth/verify-email', authLimiter, asyncH(async (req, res) => {
  const { token } = req.body || {};
  if (!isStr(token, 200)) return bad(res, 'Enlace inválido', 400);
  const { rows } = await db.query(
    `SELECT id, user_id FROM email_verifications
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [sha256(token)]);
  const ev = rows[0];
  if (!ev) return bad(res, 'El enlace expiró o ya fue usado. Pide uno nuevo desde tu panel.', 400);
  await db.query(`UPDATE email_verifications SET used_at = now() WHERE id = $1`, [ev.id]);
  await db.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, [ev.user_id]);
  // Activa el trial Pro pendiente: negocio con referido, en free y sin trial usado aún.
  const up = await db.query(
    `UPDATE subscriptions s
        SET plan_code = 'pro', status = 'trialing', trial_ends_at = now() + interval '15 days'
       FROM businesses b
      WHERE b.id = s.business_id AND b.owner_user_id = $1 AND b.referred_by_business IS NOT NULL
        AND s.plan_code = 'free' AND s.trial_ends_at IS NULL
      RETURNING s.business_id`, [ev.user_id]);
  res.json({ ok: true, email_verified: true, trial_granted: !!up.rows[0] });
}));

// Reenviar el email de verificación (si la cuenta aún no está verificada)
app.post('/api/auth/resend-verification', authLimiter, authRequired, asyncH(async (req, res) => {
  const { rows } = await db.query(`SELECT id, full_name, email, email_verified_at FROM users WHERE id = $1`, [req.user.id]);
  const u = rows[0];
  if (u && !u.email_verified_at) await sendVerificationEmail(u);
  res.json({ ok: true, message: 'Si tu email no estaba verificado, te enviamos un nuevo enlace.' });
}));

// ----------------------------------------------------------------------------
// LOGIN SOCIAL (Google / Apple)
//  El proveedor ya verificó el email → marcamos email_verified_at = now().
//  Upsert por email o por *_sub. password_hash queda NULL (no aplica).
//  Mismo retorno que /login: { user, access_token, refresh_token }.
// ----------------------------------------------------------------------------

// Upsert de usuario social + emisión de tokens. Reusa signAccess / issueRefresh.
async function socialLoginUpsert(req, res, { provider, sub, email, name }) {
  const subCol = provider === 'google' ? 'google_sub' : 'apple_sub';
  const emailLc = email.toLowerCase();
  // Busca por *_sub o por email (para enlazar una cuenta existente al proveedor social).
  const found = await db.query(
    `SELECT id, full_name, email, is_platform_admin FROM users
      WHERE (${subCol} = $1 OR email = $2) AND deleted_at IS NULL
      ORDER BY (${subCol} = $1) DESC LIMIT 1`, [sub, emailLc]);
  let user;
  if (found.rows[0]) {
    // Enlaza el sub + provider y marca el email como verificado (el proveedor ya lo hizo).
    const upd = await db.query(
      `UPDATE users
          SET ${subCol} = $2,
              auth_provider = COALESCE(auth_provider, $3),
              full_name = COALESCE(full_name, $4),
              email_verified_at = COALESCE(email_verified_at, now()),
              last_login_at = now()
        WHERE id = $1
      RETURNING id, full_name, email, is_platform_admin,
                email_verified_at IS NOT NULL AS email_verified`,
      [found.rows[0].id, sub, provider, name || null]);
    user = upd.rows[0];
  } else {
    try {
      const ins = await db.query(
        `INSERT INTO users (full_name, email, password_hash, auth_provider, ${subCol}, email_verified_at, last_login_at)
         VALUES ($1,$2,NULL,$3,$4,now(),now())
         RETURNING id, full_name, email, is_platform_admin,
                   email_verified_at IS NOT NULL AS email_verified`,
        [name || email.split('@')[0], emailLc, provider, sub]);
      user = ins.rows[0];
    } catch (e) {
      if (e.code === '23505') return bad(res, 'No pudimos iniciar sesión con esos datos. Intenta con tu correo y contraseña.', 409);
      throw e;
    }
  }
  const refresh = await issueRefresh(user.id, req);
  res.json({ user, access_token: signAccess(user), refresh_token: refresh });
}

// Config pública: el front muestra los botones solo si vienen los client_id.
app.get('/api/auth/config', (_req, res) => {
  res.json({ google_client_id: GOOGLE_CLIENT_ID || null, apple_client_id: APPLE_CLIENT_ID || null });
});

// Google: verifica el id_token contra tokeninfo (sin SDK, vía fetch).
app.post('/api/auth/google', authLimiter, asyncH(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return bad(res, 'Login con Google no disponible', 503);
  const { id_token } = req.body || {};
  if (!isStr(id_token, 5000)) return bad(res, 'id_token requerido');

  let info;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(id_token));
    if (!r.ok) return bad(res, 'No pudimos verificar tu sesión de Google', 401);
    info = await r.json();
  } catch { return bad(res, 'No pudimos verificar tu sesión de Google', 401); }

  if (info.aud !== GOOGLE_CLIENT_ID) return bad(res, 'Token de Google no válido para esta app', 401);
  const emailVerified = info.email_verified === true || info.email_verified === 'true';
  if (!info.email || !emailVerified || !info.sub) return bad(res, 'Tu cuenta de Google no tiene un email verificado', 401);
  if (!isEmail(info.email)) return bad(res, 'Email de Google inválido', 401);

  return socialLoginUpsert(req, res, { provider: 'google', sub: String(info.sub), email: info.email, name: info.name });
}));

// Apple: verifica el JWT con el JWKS de Apple (RS256 por kid), aud + iss.
app.post('/api/auth/apple', authLimiter, asyncH(async (req, res) => {
  if (!APPLE_CLIENT_ID) return bad(res, 'Login con Apple no disponible', 503);
  const { id_token } = req.body || {};
  if (!isStr(id_token, 5000)) return bad(res, 'id_token requerido');

  // Cabecera del JWT para saber qué kid usar.
  let kid;
  try {
    const hdr = JSON.parse(Buffer.from(id_token.split('.')[0], 'base64url').toString('utf8'));
    kid = hdr.kid;
    if (hdr.alg !== 'RS256' || !kid) return bad(res, 'Token de Apple no válido', 401);
  } catch { return bad(res, 'Token de Apple no válido', 401); }

  // JWKS de Apple → clave pública (PEM) del kid correspondiente.
  let pem;
  try {
    const r = await fetch('https://appleid.apple.com/auth/keys');
    if (!r.ok) return bad(res, 'No pudimos verificar tu sesión de Apple', 401);
    const { keys } = await r.json();
    const jwk = (keys || []).find(k => k.kid === kid);
    if (!jwk) return bad(res, 'No pudimos verificar tu sesión de Apple', 401);
    pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
  } catch { return bad(res, 'No pudimos verificar tu sesión de Apple', 401); }

  let claims;
  try {
    claims = jwt.verify(id_token, pem, {
      algorithms: ['RS256'],
      audience: APPLE_CLIENT_ID,
      issuer: 'https://appleid.apple.com',
    });
  } catch { return bad(res, 'Token de Apple no válido o expirado', 401); }

  if (!claims.sub) return bad(res, 'Token de Apple sin identificador', 401);
  // Apple solo manda el email la primera vez; permitimos enlazar por sub.
  const email = claims.email && isEmail(claims.email) ? claims.email : null;
  if (!email) return bad(res, 'Tu cuenta de Apple no compartió un email; usa tu correo y contraseña.', 401);

  return socialLoginUpsert(req, res, { provider: 'apple', sub: String(claims.sub), email, name: null });
}));

// ============================================================================
//  RUTAS — ONBOARDING Y PERFIL DEL NEGOCIO (100% editable)
// ============================================================================
app.post('/api/businesses', authRequired, asyncH(async (req, res) => {
  const b = req.body || {};
  if (!isStr(b.name, 120)) return bad(res, 'Nombre del negocio requerido');
  if (!b.accept_terms)     return bad(res, 'Debes aceptar los términos y condiciones');
  if (b.phone && !isPhone(b.phone))       return bad(res, 'Teléfono del negocio inválido (usa un número de PR/US de 10 dígitos)');
  if (b.whatsapp && !isPhone(b.whatsapp)) return bad(res, 'WhatsApp del negocio inválido (usa un número de PR/US de 10 dígitos)');

  const exists = await db.query(`SELECT 1 FROM businesses WHERE owner_user_id = $1 AND deleted_at IS NULL`, [req.user.id]);
  if (exists.rows[0]) return bad(res, 'Ya tienes un negocio registrado', 409);

  // slug único
  let slug = slugify(b.name);
  for (let i = 0; i < 5; i++) {
    const c = await db.query(`SELECT 1 FROM businesses WHERE slug = $1`, [slug]);
    if (!c.rows[0]) break;
    slug = slugify(b.name) + '-' + crypto.randomInt(10, 99);
  }

  // referido (opcional)
  let referrer = null;
  if (isStr(b.referral_code, 30)) {
    const r = await db.query(`SELECT id FROM businesses WHERE referral_code = $1`, [b.referral_code.trim().toUpperCase()]);
    referrer = r.rows[0]?.id || null;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO businesses (owner_user_id, slug, name, phone, whatsapp, municipality_id,
                               referral_code, referred_by_business)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, slug, b.name.trim(),
       b.phone ? normPhone(b.phone) : null,
       b.whatsapp ? normPhone(b.whatsapp) : null,
       Number.isInteger(b.municipality_id) ? b.municipality_id : null,
       genReferralCode(b.name), referrer]);
    const biz = rows[0];

    // Suscripción inicial:
    //  · Con referido válido Y email verificado → 15 días de prueba Pro (trialing)
    //  · Si aún no verificó → nace free; el trial se activa al verificar el email
    //    (POST /api/auth/verify-email). Corta el abuso de trials por multicuenta.
    //  · Sin referido → plan free normal
    const uv = await client.query(`SELECT email_verified_at FROM users WHERE id = $1`, [req.user.id]);
    if (referrer && uv.rows[0] && uv.rows[0].email_verified_at) {
      await client.query(
        `INSERT INTO subscriptions (business_id, plan_code, status, trial_ends_at)
         VALUES ($1, 'pro', 'trialing', now() + interval '15 days')`, [biz.id]);
    } else {
      await client.query(
        `INSERT INTO subscriptions (business_id, plan_code) VALUES ($1, 'free')`, [biz.id]);
    }

    if (referrer)
      await client.query(
        `INSERT INTO referrals (referrer_business_id, referred_business_id, code_used)
         VALUES ($1,$2,$3)`, [referrer, biz.id, b.referral_code.trim().toUpperCase()]);

    // evidencia de aceptación de términos (última versión publicada)
    await client.query(
      `INSERT INTO legal_acceptances (document_id, user_id, business_id, ip, user_agent)
       SELECT id, $1, $2, $3, $4 FROM legal_documents
        WHERE doc_type = 'terms' AND published_at IS NOT NULL
        ORDER BY published_at DESC LIMIT 1`,
      [req.user.id, biz.id, req.ip, (req.headers['user-agent'] || '').slice(0, 250)]);

    // categorías iniciales
    if (Array.isArray(b.category_ids))
      for (const cid of b.category_ids.slice(0, 5))
        if (Number.isInteger(cid))
          await client.query(
            `INSERT INTO business_categories VALUES ($1,$2) ON CONFLICT DO NOTHING`, [biz.id, cid]);

    await client.query('COMMIT');
    await audit(req, 'business.create', 'business', biz.id, { slug });
    res.status(201).json({ business: biz });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

app.get('/api/businesses/me', authRequired, businessScope, asyncH(async (req, res) => {
  const [cats, hours] = await Promise.all([
    db.query(`SELECT c.id, c.name_es, c.slug FROM business_categories bc
              JOIN categories c ON c.id = bc.category_id WHERE bc.business_id = $1`, [req.business.id]),
    db.query(`SELECT day_of_week, opens, closes FROM business_hours
              WHERE business_id = $1 ORDER BY day_of_week, opens`, [req.business.id]),
  ]);
  res.json({ business: req.business, categories: cats.rows, hours: hours.rows });
}));

// Perfil editable: solo campos permitidos (whitelist)
// logo_url/cover_url son editables pero VALIDADOS (solo null o una ruta /uploads/...
// segura, ver guard en el PATCH). Antes, al ser texto libre, un dueño podía ponerlos
// en "/uploads/logos/../../.env" y borrar archivos al cambiar/quitar el logo.
const BIZ_EDITABLE = ['name','bio','phone','whatsapp','email','address_line','municipality_id',
  'lat','lng','logo_url','cover_url','theme','social','ath_phone','deposit_default_cents',
  'cancellation_hours','no_show_policy','booking_lead_min','booking_horizon_days',
  'slot_granularity_min','is_published'];

app.patch('/api/businesses/me', authRequired, businessScope, asyncH(async (req, res) => {
  const sets = [], vals = [];
  for (const k of BIZ_EDITABLE) if (k in (req.body || {})) {
    let v = req.body[k];
    if (['phone','whatsapp','ath_phone'].includes(k) && v) {
      if (!isPhone(v)) return bad(res, `${k} inválido`); v = normPhone(v);
    }
    if (k === 'email' && v && !isEmail(v)) return bad(res, 'Email inválido');
    // lat/lng: solo null (limpiar) o número en rango geográfico. Si no es número válido lo ignoramos.
    if (k === 'lat' || k === 'lng') {
      if (v == null) { v = null; }
      else {
        const n = Number(v);
        const max = k === 'lat' ? 90 : 180;
        if (!Number.isFinite(n) || n < -max || n > max) continue;   // ignorar valor inválido
        v = n;
      }
    }
    // logo_url/cover_url: solo null (limpiar) o una ruta nuestra segura → bloquea path traversal
    if ((k === 'logo_url' || k === 'cover_url') && v != null &&
        (typeof v !== 'string' || !/^\/uploads\/(logos|covers)\/[A-Za-z0-9._-]+$/.test(v)))
      return bad(res, `${k} inválido`);
    vals.push(v); sets.push(`${k} = $${vals.length}`);
  }
  if (Array.isArray(req.body?.category_ids)) {
    await db.query(`DELETE FROM business_categories WHERE business_id = $1`, [req.business.id]);
    for (const cid of req.body.category_ids.slice(0, 5))
      if (Number.isInteger(cid))
        await db.query(`INSERT INTO business_categories VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.business.id, cid]);
  }
  if (!sets.length) return res.json({ business: req.business });
  vals.push(req.business.id);
  const { rows } = await db.query(
    `UPDATE businesses SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  await audit(req, 'business.update', 'business', req.business.id, { fields: sets.length });
  res.json({ business: rows[0] });
}));

// Subir / reemplazar el logo del negocio (solo planes de pago)
app.post('/api/businesses/me/logo', authRequired, businessScope,
  (req, res, next) => {
    if (req.business.plan_code === 'free')
      return bad(res, 'El logo personalizado está disponible desde el plan Pro. Sube de plan para personalizar tu página.', 403);
    next();
  },
  (req, res, next) => uploadLogo.single('logo')(req, res, (err) => {
    if (err) return bad(res, err.message || 'Error al subir el logo');
    next();
  }),
  asyncH(async (req, res) => {
    if (!req.file) return bad(res, 'No se recibió ninguna imagen');
    // Procesar: cuadrado 400x400, WEBP optimizado
    const filename = `${req.business.id}-${Date.now()}.webp`;
    const filepath = path.join(LOGO_DIR, filename);
    try {
      await sharp(req.file.buffer, { limitInputPixels: 24000000, failOn: 'error' })
        .resize(800, 800, { fit: 'cover', position: 'centre' })
        .webp({ quality: 85 })
        .toFile(filepath);
    } catch (e) {
      return bad(res, 'La imagen no se pudo procesar. Prueba con otra.');
    }
    const logoUrl = `/uploads/logos/${filename}`;
    // Borrar el logo anterior si era un archivo nuestro (de forma segura)
    safeUnlinkUpload(req.business.logo_url, LOGO_DIR);
    const { rows } = await db.query(
      `UPDATE businesses SET logo_url = $1 WHERE id = $2 RETURNING *`, [logoUrl, req.business.id]);
    await audit(req, 'business.logo', 'business', req.business.id, {});
    res.json({ business: rows[0], logo_url: logoUrl });
  }));

// Quitar el logo del negocio
app.delete('/api/businesses/me/logo', authRequired, businessScope, asyncH(async (req, res) => {
  safeUnlinkUpload(req.business.logo_url, LOGO_DIR);
  const { rows } = await db.query(
    `UPDATE businesses SET logo_url = NULL WHERE id = $1 RETURNING *`, [req.business.id]);
  await audit(req, 'business.logo.delete', 'business', req.business.id, {});
  res.json({ business: rows[0] });
}));

// Subir / reemplazar el BANNER (cover) del negocio — solo planes de pago
// Medida estándar: 1600x400 (4:1). El free usa patrones predefinidos (sin subir).
app.post('/api/businesses/me/cover', authRequired, businessScope,
  (req, res, next) => {
    if (req.business.plan_code === 'free')
      return bad(res, 'El banner con imagen propia está disponible desde el plan Pro. Los planes gratis pueden elegir un diseño predefinido.', 403);
    next();
  },
  (req, res, next) => uploadLogo.single('cover')(req, res, (err) => {
    if (err) return bad(res, err.message || 'Error al subir el banner');
    next();
  }),
  asyncH(async (req, res) => {
    if (!req.file) return bad(res, 'No se recibió ninguna imagen');
    const filename = `${req.business.id}-${Date.now()}.webp`;
    const filepath = path.join(COVER_DIR, filename);
    try {
      await sharp(req.file.buffer, { limitInputPixels: 24000000, failOn: 'error' })
        .resize(1600, 400, { fit: 'cover', position: 'centre' })
        .webp({ quality: 84 })
        .toFile(filepath);
    } catch (e) {
      return bad(res, 'La imagen no se pudo procesar. Prueba con otra.');
    }
    const coverUrl = `/uploads/covers/${filename}`;
    safeUnlinkUpload(req.business.cover_url, COVER_DIR);
    const { rows } = await db.query(
      `UPDATE businesses SET cover_url = $1 WHERE id = $2 RETURNING *`, [coverUrl, req.business.id]);
    await audit(req, 'business.cover', 'business', req.business.id, {});
    res.json({ business: rows[0], cover_url: coverUrl });
  }));

// Quitar el banner con imagen (vuelve al patrón predefinido)
app.delete('/api/businesses/me/cover', authRequired, businessScope, asyncH(async (req, res) => {
  safeUnlinkUpload(req.business.cover_url, COVER_DIR);
  const { rows } = await db.query(
    `UPDATE businesses SET cover_url = NULL WHERE id = $1 RETURNING *`, [req.business.id]);
  await audit(req, 'business.cover.delete', 'business', req.business.id, {});
  res.json({ business: rows[0] });
}));

// ── PORTAFOLIO (galería del negocio) ─────────────────────────────────────────
// Reusa la tabla existente gallery_photos (staff_id NULL = foto del negocio).
// Máx 8 fotos por negocio. Imágenes ≈1200x800 webp 82% en /uploads/portfolio.
const PORTFOLIO_MAX = 8;

// Subir una foto al portafolio
app.post('/api/businesses/me/portfolio', authRequired, businessScope,
  (req, res, next) => uploadLogo.single('photo')(req, res, (err) => {
    if (err) return bad(res, err.message || 'Error al subir la foto');
    next();
  }),
  asyncH(async (req, res) => {
    if (!req.file) return bad(res, 'No se recibió ninguna imagen');
    // Pre-chequeo barato (evita procesar si ya está lleno). El guard REAL contra
    // carreras es el INSERT condicional de abajo.
    const pre = await db.query(`SELECT count(*)::int n FROM gallery_photos WHERE business_id = $1`, [req.business.id]);
    if (pre.rows[0].n >= PORTFOLIO_MAX)
      return bad(res, `El portafolio permite un máximo de ${PORTFOLIO_MAX} fotos. Borra alguna antes de subir más.`, 409);

    const filename = `${req.business.id}-${crypto.randomUUID()}.webp`;
    const filepath = path.join(PORTFOLIO_DIR, filename);
    try {
      await sharp(req.file.buffer, { limitInputPixels: 24000000, failOn: 'error' })
        .resize(1200, 800, { fit: 'cover', position: 'centre' })
        .webp({ quality: 82 })
        .toFile(filepath);
    } catch (e) {
      return bad(res, 'La imagen no se pudo procesar. Prueba con otra.');
    }
    const url = `/uploads/portfolio/${filename}`;
    // INSERT condicional ATÓMICO: solo inserta si aún hay menos de PORTFOLIO_MAX (anti-TOCTOU).
    const { rows } = await db.query(
      `INSERT INTO gallery_photos (business_id, url, sort_order)
       SELECT $1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM gallery_photos WHERE business_id = $1), 1)
        WHERE (SELECT count(*) FROM gallery_photos WHERE business_id = $1) < $3
       RETURNING id, url, sort_order`,
      [req.business.id, url, PORTFOLIO_MAX]);
    if (!rows[0]) {                          // otra subida concurrente llenó el cupo
      safeUnlinkUpload(url, PORTFOLIO_DIR);  // borra el archivo recién escrito
      return bad(res, `El portafolio permite un máximo de ${PORTFOLIO_MAX} fotos. Borra alguna antes de subir más.`, 409);
    }
    await audit(req, 'business.portfolio.add', 'business', req.business.id, {});
    res.status(201).json({ photo: rows[0] });
  }));

// Listar las fotos del portafolio
app.get('/api/businesses/me/portfolio', authRequired, businessScope, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, url, caption, sort_order FROM gallery_photos
      WHERE business_id = $1 ORDER BY sort_order`, [req.business.id]);
  res.json({ photos: rows });
}));

// Borrar una foto del portafolio
app.delete('/api/businesses/me/portfolio/:id', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const { rows } = await db.query(
    `DELETE FROM gallery_photos WHERE id = $1 AND business_id = $2 RETURNING url`,
    [req.params.id, req.business.id]);
  if (!rows[0]) return bad(res, 'Foto no encontrada', 404);
  safeUnlinkUpload(rows[0].url, PORTFOLIO_DIR);
  await audit(req, 'business.portfolio.delete', 'business', req.business.id, {});
  res.json({ ok: true });
}));

// Reemplaza el horario semanal completo: [{day_of_week, opens, closes}, …]
app.put('/api/businesses/me/hours', authRequired, businessScope, asyncH(async (req, res) => {
  const rows = req.body?.hours;
  if (!Array.isArray(rows) || rows.length > 28) return bad(res, 'Formato de horario inválido');
  for (const r of rows)
    if (!Number.isInteger(r.day_of_week) || r.day_of_week < 0 || r.day_of_week > 6 ||
        !isTime(r.opens) || !isTime(r.closes) || r.closes <= r.opens)
      return bad(res, 'Horario inválido (rev. día/horas)');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM business_hours WHERE business_id = $1`, [req.business.id]);
    for (const r of rows)
      await client.query(
        `INSERT INTO business_hours (business_id, day_of_week, opens, closes) VALUES ($1,$2,$3,$4)`,
        [req.business.id, r.day_of_week, r.opens, r.closes]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.json({ ok: true });
}));

// ── Días libres / bloqueos de tiempo ────────────────────────────────────────
// Listar bloqueos futuros del negocio
app.get('/api/blocks', authRequired, businessScope, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT tb.id, tb.staff_id, tb.starts_at, tb.ends_at, tb.reason,
            st.display_name AS staff_name
       FROM time_blocks tb
       LEFT JOIN staff st ON st.id = tb.staff_id
      WHERE tb.business_id = $1 AND tb.ends_at >= now()
        AND COALESCE(tb.reason,'') <> '__OPEN_SLOT__'
      ORDER BY tb.starts_at`, [req.business.id]);
  res.json({ blocks: rows });
}));

// Crear un bloqueo (día libre completo o rango de horas)
app.post('/api/blocks', authRequired, businessScope, asyncH(async (req, res) => {
  const { date, all_day, start_time, end_time, staff_id, reason } = req.body || {};
  if (!isDate(date)) return bad(res, 'Fecha requerida');
  if (staff_id && !isUuid(staff_id)) return bad(res, 'Profesional inválido');
  if (staff_id) {   // el profesional debe ser de ESTE negocio (aislamiento multi-tenant)
    const ok = await db.query(`SELECT 1 FROM staff WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [staff_id, req.business.id]);
    if (!ok.rows[0]) return bad(res, 'Profesional no encontrado', 404);
  }

  let startsAt, endsAt;
  if (all_day) {
    // día completo: de 00:00 a 23:59:59 del día (hora de PR)
    startsAt = new Date(`${date}T00:00:00${TZ_OFFSET}`);
    endsAt   = new Date(`${date}T23:59:59${TZ_OFFSET}`);
  } else {
    if (!isTime(start_time) || !isTime(end_time)) return bad(res, 'Horas inválidas');
    if (end_time <= start_time) return bad(res, 'La hora de fin debe ser después del inicio');
    startsAt = new Date(`${date}T${start_time}:00${TZ_OFFSET}`);
    endsAt   = new Date(`${date}T${end_time}:00${TZ_OFFSET}`);
  }

  const { rows } = await db.query(
    `INSERT INTO time_blocks (business_id, staff_id, starts_at, ends_at, reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.business.id, staff_id || null, startsAt, endsAt, (reason || '').slice(0, 120) || null]);
  await audit(req, 'block.create', 'time_block', rows[0].id);
  res.status(201).json({ block: rows[0] });
}));

// Crear varios bloqueos de DÍA COMPLETO de una vez (Bukéame)
app.post('/api/blocks/batch', authRequired, businessScope, asyncH(async (req, res) => {
  const { dates, staff_id, reason } = req.body || {};
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > 60) {
    return bad(res, 'Debe enviar entre 1 y 60 fechas');
  }
  for (const d of dates) {
    if (!isDate(d)) return bad(res, `Fecha inválida: ${d}`);
  }
  if (staff_id && !isUuid(staff_id)) return bad(res, 'Profesional inválido');
  if (staff_id) {   // el profesional debe ser de ESTE negocio (aislamiento multi-tenant)
    const ok = await db.query(`SELECT 1 FROM staff WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [staff_id, req.business.id]);
    if (!ok.rows[0]) return bad(res, 'Profesional no encontrado', 404);
  }

  const sid = staff_id || null;
  const cleanReason = (reason || '').slice(0, 120) || null;
  const seen = new Set();
  let created = 0;

  for (const date of dates) {
    if (seen.has(date)) continue;   // evita duplicados dentro del mismo request
    seen.add(date);

    // día completo: de 00:00 a 23:59:59 del día (hora de PR), igual que all_day
    const startsAt = new Date(`${date}T00:00:00${TZ_OFFSET}`);
    const endsAt   = new Date(`${date}T23:59:59${TZ_OFFSET}`);

    // Omite si ya existe el bloqueo exacto del día (mismo negocio, staff y rango)
    const dup = await db.query(
      `SELECT 1 FROM time_blocks
        WHERE business_id = $1
          AND staff_id IS NOT DISTINCT FROM $2
          AND starts_at = $3 AND ends_at = $4`,
      [req.business.id, sid, startsAt, endsAt]);
    if (dup.rows[0]) continue;

    const { rows } = await db.query(
      `INSERT INTO time_blocks (business_id, staff_id, starts_at, ends_at, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.business.id, sid, startsAt, endsAt, cleanReason]);
    await audit(req, 'block.create', 'time_block', rows[0].id);
    created++;
  }

  res.status(201).json({ created });
}));

// Borrar un bloqueo
app.delete('/api/blocks/:id', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const { rows } = await db.query(
    `DELETE FROM time_blocks WHERE id = $1 AND business_id = $2 RETURNING id`,
    [req.params.id, req.business.id]);
  if (!rows[0]) return bad(res, 'Bloqueo no encontrado', 404);
  res.json({ ok: true });
}));

// ============================================================================
//  RUTAS — STAFF (límite por plan) Y SERVICIOS
// ============================================================================
app.get('/api/staff', authRequired, businessScope, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM staff WHERE business_id = $1 AND deleted_at IS NULL ORDER BY sort_order, created_at`,
    [req.business.id]);
  res.json({ staff: rows });
}));

app.post('/api/staff', authRequired, businessScope, asyncH(async (req, res) => {
  const { display_name, bio, avatar_url, specialties, calendar_color } = req.body || {};
  if (!isStr(display_name, 80)) return bad(res, 'Nombre del profesional requerido');
  const c = await db.query(
    `SELECT count(*)::int n FROM staff WHERE business_id = $1 AND is_active AND deleted_at IS NULL`,
    [req.business.id]);
  if (c.rows[0].n >= req.business.max_staff)
    return bad(res, `Tu plan ${req.business.plan_code} permite ${req.business.max_staff} profesional(es). Sube a Studio para hasta 5.`, 403);
  const { rows } = await db.query(
    `INSERT INTO staff (business_id, display_name, bio, avatar_url, specialties, calendar_color)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'#0E8074')) RETURNING *`,
    [req.business.id, display_name.trim(), bio || null, avatar_url || null,
     Array.isArray(specialties) ? specialties.slice(0, 10) : null, calendar_color || null]);
  // Ligar el nuevo profesional a los servicios que NO tienen ningún staff asignado
  // (evita que queden servicios huérfanos e invisibles en "Cualquiera").
  await db.query(
    `INSERT INTO service_staff (service_id, staff_id)
     SELECT s.id, $1 FROM services s
      WHERE s.business_id = $2 AND s.is_active AND s.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM service_staff ss WHERE ss.service_id = s.id)
     ON CONFLICT DO NOTHING`, [rows[0].id, req.business.id]);
  await audit(req, 'staff.create', 'staff', rows[0].id);
  res.status(201).json({ staff: rows[0] });
}));

app.patch('/api/staff/:id', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const allowed = ['display_name','bio','avatar_url','specialties','calendar_color','is_active','sort_order'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return bad(res, 'Nada que actualizar');
  vals.push(req.params.id, req.business.id);
  const { rows } = await db.query(
    `UPDATE staff SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND business_id = $${vals.length}
     AND deleted_at IS NULL RETURNING *`, vals);
  if (!rows[0]) return bad(res, 'Profesional no encontrado', 404);
  res.json({ staff: rows[0] });
}));

app.delete('/api/staff/:id', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  await db.query(
    `UPDATE staff SET deleted_at = now(), is_active = false WHERE id = $1 AND business_id = $2`,
    [req.params.id, req.business.id]);
  await audit(req, 'staff.delete', 'staff', req.params.id);
  res.json({ ok: true });
}));

// Subir/reemplazar la foto de un profesional (cuadrado 400x400 webp)
app.post('/api/staff/:id/photo', authRequired, businessScope,
  (req, res, next) => uploadLogo.single('photo')(req, res, (err) => {
    if (err) return bad(res, err.message || 'Error al subir la foto');
    next();
  }),
  asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    if (!req.file) return bad(res, 'No se recibió ninguna imagen');
    const st = await db.query(
      `SELECT id, avatar_url FROM staff WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.business.id]);
    if (!st.rows[0]) return bad(res, 'Profesional no encontrado', 404);
    const filename = `${req.params.id}-${Date.now()}.webp`;
    const filepath = path.join(STAFF_DIR, filename);
    try {
      await sharp(req.file.buffer, { limitInputPixels: 24000000, failOn: 'error' })
        .resize(400, 400, { fit: 'cover', position: 'centre' })
        .webp({ quality: 85 })
        .toFile(filepath);
    } catch (e) {
      return bad(res, 'La imagen no se pudo procesar. Prueba con otra.');
    }
    const url = `/uploads/staff/${filename}`;
    safeUnlinkUpload(st.rows[0].avatar_url, STAFF_DIR);
    const { rows } = await db.query(
      `UPDATE staff SET avatar_url = $1 WHERE id = $2 AND business_id = $3 RETURNING id, avatar_url`,
      [url, req.params.id, req.business.id]);
    await audit(req, 'staff.photo', 'staff', req.params.id, {});
    res.json({ staff: rows[0], avatar_url: url });
  }));

// Quitar la foto de un profesional
app.delete('/api/staff/:id/photo', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const st = await db.query(
    `SELECT avatar_url FROM staff WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
  if (!st.rows[0]) return bad(res, 'Profesional no encontrado', 404);
  safeUnlinkUpload(st.rows[0].avatar_url, STAFF_DIR);
  await db.query(`UPDATE staff SET avatar_url = NULL WHERE id = $1 AND business_id = $2`,
    [req.params.id, req.business.id]);
  res.json({ ok: true });
}));

// ----------------------------------------------------------------------------
// FOTOS DE PRODUCTOS (máx 3) — subida real con sharp (espeja portafolio/staff).
// El módulo revenue maneja fotos por URL (POST /api/products/:id/photos); estas
// rutas suben el archivo, lo procesan a webp y guardan la fila en product_photos.
// ----------------------------------------------------------------------------
const PRODUCT_PHOTO_MAX = 3;
app.post('/api/products/:id/photo', authRequired, businessScope,
  (req, res, next) => uploadLogo.single('photo')(req, res, (err) => {
    if (err) return bad(res, err.message || 'Error al subir la foto');
    next();
  }),
  asyncH(async (req, res) => {
    if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
    if (!req.file) return bad(res, 'No se recibió ninguna imagen');
    // El producto debe ser del negocio
    const own = await db.query(
      `SELECT 1 FROM products WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
    if (!own.rows[0]) return bad(res, 'Producto no encontrado', 404);
    // Pre-chequeo barato (evita procesar si ya hay 3). El guard REAL contra carreras
    // es el INSERT condicional de abajo.
    const pre = await db.query(`SELECT count(*)::int n FROM product_photos WHERE product_id = $1`, [req.params.id]);
    if (pre.rows[0].n >= PRODUCT_PHOTO_MAX)
      return bad(res, 'Máximo 3 fotos por producto', 409);

    const filename = `${req.params.id}-${crypto.randomUUID()}.webp`;
    const filepath = path.join(PRODUCTS_DIR, filename);
    try {
      await sharp(req.file.buffer, { limitInputPixels: 24000000, failOn: 'error' })
        .resize(800, 800, { fit: 'cover', position: 'centre' })
        .webp({ quality: 82 })
        .toFile(filepath);
    } catch (e) {
      return bad(res, 'La imagen no se pudo procesar. Prueba con otra.');
    }
    const url = `/uploads/products/${filename}`;
    // INSERT condicional ATÓMICO: solo inserta si aún hay menos de 3 (anti-TOCTOU).
    const { rows } = await db.query(
      `INSERT INTO product_photos (product_id, url, sort_order)
       SELECT $1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM product_photos WHERE product_id = $1), 0)
        WHERE (SELECT count(*) FROM product_photos WHERE product_id = $1) < $3
       RETURNING id, url, sort_order`,
      [req.params.id, url, PRODUCT_PHOTO_MAX]);
    if (!rows[0]) {                         // otra subida concurrente llenó el cupo
      safeUnlinkUpload(url, PRODUCTS_DIR);  // borra el archivo recién escrito
      return bad(res, 'Máximo 3 fotos por producto', 409);
    }
    await audit(req, 'product.photo.add', 'product', req.params.id, {});
    res.status(201).json({ photo: rows[0] });
  }));

// Borrar una foto de un producto del negocio + su archivo
app.delete('/api/products/:id/photo/:photoId', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id) || !isUuid(req.params.photoId)) return bad(res, 'ID inválido');
  const { rows } = await db.query(
    `DELETE FROM product_photos ph USING products p
      WHERE ph.id = $1 AND ph.product_id = p.id AND p.id = $2 AND p.business_id = $3
      RETURNING ph.url`,
    [req.params.photoId, req.params.id, req.business.id]);
  if (!rows[0]) return bad(res, 'Foto no encontrada', 404);
  safeUnlinkUpload(rows[0].url, PRODUCTS_DIR);
  await audit(req, 'product.photo.delete', 'product', req.params.id, {});
  res.json({ ok: true });
}));

app.put('/api/staff/:id/hours', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const own = await db.query(`SELECT 1 FROM staff WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
  if (!own.rows[0]) return bad(res, 'Profesional no encontrado', 404);
  const rows = req.body?.hours;
  if (!Array.isArray(rows) || rows.length > 28) return bad(res, 'Formato inválido');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM staff_hours WHERE staff_id = $1`, [req.params.id]);
    for (const r of rows) {
      if (!Number.isInteger(r.day_of_week) || !isTime(r.opens) || !isTime(r.closes) || r.closes <= r.opens)
        throw Object.assign(new Error('Horario inválido'), { expose: true });
      await client.query(`INSERT INTO staff_hours (staff_id, day_of_week, opens, closes) VALUES ($1,$2,$3,$4)`,
        [req.params.id, r.day_of_week, r.opens, r.closes]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); if (e.expose) return bad(res, e.message); throw e; }
  finally { client.release(); }
  res.json({ ok: true });
}));

// Servicios
app.get('/api/services', authRequired, businessScope, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT s.*, COALESCE(json_agg(ss.staff_id) FILTER (WHERE ss.staff_id IS NOT NULL),'[]') AS staff_ids
       FROM services s LEFT JOIN service_staff ss ON ss.service_id = s.id
      WHERE s.business_id = $1 AND s.deleted_at IS NULL
      GROUP BY s.id ORDER BY s.sort_order, s.created_at`, [req.business.id]);
  res.json({ services: rows });
}));

app.post('/api/services', authRequired, businessScope, asyncH(async (req, res) => {
  const { name, description, duration_min, price_cents, deposit_cents, photo_url, staff_ids, is_featured } = req.body || {};
  if (!isStr(name, 120)) return bad(res, 'Nombre del servicio requerido');
  if (!Number.isInteger(duration_min) || duration_min < 5 || duration_min > 480) return bad(res, 'Duración entre 5 y 480 min');
  if (!Number.isInteger(price_cents) || price_cents < 0) return bad(res, 'Precio inválido');
  const { rows } = await db.query(
    `INSERT INTO services (business_id, name, description, duration_min, price_cents, deposit_cents, photo_url, is_featured)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,false)) RETURNING *`,
    [req.business.id, name.trim(), description || null, duration_min, price_cents,
     Number.isInteger(deposit_cents) ? deposit_cents : null, photo_url || null, is_featured]);
  if (Array.isArray(staff_ids) && staff_ids.length > 0) {
    for (const sid of staff_ids) if (isUuid(sid))
      await db.query(
        `INSERT INTO service_staff
         SELECT $1, id FROM staff WHERE id = $2 AND business_id = $3
         ON CONFLICT DO NOTHING`, [rows[0].id, sid, req.business.id]);
  } else {
    // Sin staff especificado → ligar a TODO el staff activo (evita servicios huérfanos)
    await db.query(
      `INSERT INTO service_staff
       SELECT $1, id FROM staff WHERE business_id = $2 AND is_active AND deleted_at IS NULL
       ON CONFLICT DO NOTHING`, [rows[0].id, req.business.id]);
  }
  await audit(req, 'service.create', 'service', rows[0].id);
  res.status(201).json({ service: rows[0] });
}));

app.patch('/api/services/:id', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const allowed = ['name','description','duration_min','price_cents','deposit_cents','photo_url','is_active','is_featured','sort_order'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
  if (Array.isArray(req.body?.staff_ids)) {
    await db.query(`DELETE FROM service_staff WHERE service_id = $1`, [req.params.id]);
    for (const sid of req.body.staff_ids) if (isUuid(sid))
      await db.query(
        `INSERT INTO service_staff SELECT $1, id FROM staff WHERE id = $2 AND business_id = $3
         ON CONFLICT DO NOTHING`, [req.params.id, sid, req.business.id]);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id, req.business.id);
  const { rows } = await db.query(
    `UPDATE services SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND business_id = $${vals.length}
     AND deleted_at IS NULL RETURNING *`, vals);
  if (!rows[0]) return bad(res, 'Servicio no encontrado', 404);
  res.json({ service: rows[0] });
}));

app.delete('/api/services/:id', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  await db.query(`UPDATE services SET deleted_at = now(), is_active = false WHERE id = $1 AND business_id = $2`,
    [req.params.id, req.business.id]);
  res.json({ ok: true });
}));

// ============================================================================
//  MOTOR DE DISPONIBILIDAD
//  slots = (staff_hours ?? business_hours) − time_blocks − citas vivas
// ============================================================================
function dayBounds(dateStr) {
  return {
    start: new Date(`${dateStr}T00:00:00${TZ_OFFSET}`),
    end:   new Date(`${dateStr}T23:59:59${TZ_OFFSET}`),
    dow:   new Date(`${dateStr}T12:00:00${TZ_OFFSET}`).getDay(),
  };
}
const overlaps = (aS, aE, bS, bE) => aS < bE && aE > bS;

async function staffDaySlots(biz, staffId, dateStr, durationMin) {
  const { start, end, dow } = dayBounds(dateStr);

  const hours = await db.query(
    `SELECT opens, closes FROM staff_hours WHERE staff_id = $1 AND day_of_week = $2
     UNION ALL
     SELECT opens, closes FROM business_hours
      WHERE business_id = $3 AND day_of_week = $2
        AND NOT EXISTS (SELECT 1 FROM staff_hours WHERE staff_id = $1 AND day_of_week = $2)
     ORDER BY opens`, [staffId, dow, biz.id]);
  if (!hours.rows.length) return [];

  const [blocks, appts, opens] = await Promise.all([
    // bloqueos REALES (excluye las aperturas manuales marcadas con __OPEN_SLOT__)
    db.query(`SELECT starts_at, ends_at FROM time_blocks
              WHERE business_id = $1 AND (staff_id IS NULL OR staff_id = $2)
                AND starts_at < $4 AND ends_at > $3
                AND COALESCE(reason,'') <> '__OPEN_SLOT__'`, [biz.id, staffId, start, end]),
    db.query(`SELECT starts_at, ends_at FROM appointments
              WHERE staff_id = $1 AND status = ANY($2)
                AND starts_at < $4 AND ends_at > $3`, [staffId, ALIVE, start, end]),
    // aperturas manuales del barbero (cupos abiertos "visible para todos")
    db.query(`SELECT starts_at, ends_at FROM time_blocks
              WHERE business_id = $1 AND staff_id = $2 AND reason = '__OPEN_SLOT__'
                AND starts_at < $4 AND ends_at > $3`, [biz.id, staffId, start, end]),
  ]);
  const busy = [...blocks.rows, ...appts.rows]
    .map(r => [new Date(r.starts_at), new Date(r.ends_at)]);

  const leadCutoff = new Date(Date.now() + biz.booking_lead_min * 60_000);
  const step = (biz.slot_granularity_min || 15) * 60_000;
  const dur  = durationMin * 60_000;
  const out = [];

  for (const h of hours.rows) {
    let t = new Date(`${dateStr}T${h.opens.slice(0, 5)}:00${TZ_OFFSET}`).getTime();
    const close = new Date(`${dateStr}T${h.closes.slice(0, 5)}:00${TZ_OFFSET}`).getTime();
    for (; t + dur <= close; t += step) {
      const s = new Date(t), e = new Date(t + dur);
      if (s < leadCutoff) continue;
      if (busy.some(([bS, bE]) => overlaps(s, e, bS, bE))) continue;
      out.push(s.toISOString());
    }
  }

  // añadir cupos abiertos manualmente que caigan FUERA del horario regular
  for (const o of opens.rows) {
    const s = new Date(o.starts_at), e = new Date(o.ends_at);
    if (s < leadCutoff) continue;
    if (e - s < dur) continue;                                   // el cupo cabe el servicio
    if (busy.some(([bS, bE]) => overlaps(s, e, bS, bE))) continue; // no choca con cita
    const iso = s.toISOString();
    if (!out.includes(iso)) out.push(iso);
  }
  out.sort();
  return out;
}

// Staff que ofrecen el servicio, balanceados por carga del día
async function eligibleStaff(bizId, serviceId, dateStr) {
  const { start, end } = dayBounds(dateStr);
  const { rows } = await db.query(
    `SELECT st.id FROM service_staff ss
       JOIN staff st ON st.id = ss.staff_id
       LEFT JOIN appointments a ON a.staff_id = st.id AND a.status = ANY($4)
            AND a.starts_at < $3 AND a.ends_at > $2
      WHERE ss.service_id = $1 AND st.is_active AND st.deleted_at IS NULL
      GROUP BY st.id ORDER BY count(a.id) ASC`,
    [serviceId, start, end, ALIVE]);
  return rows.map(r => r.id);
}

// ============================================================================
//  RUTAS PÚBLICAS — perfil, disponibilidad, booking, ticket, búsqueda
// ============================================================================
app.get('/api/public/categories', asyncH(async (_req, res) => {
  const { rows } = await db.query(`SELECT id, name_es, name_en, slug, icon FROM categories ORDER BY sort_order`);
  res.json({ categories: rows });
}));

app.get('/api/public/municipalities', asyncH(async (_req, res) => {
  const { rows } = await db.query(`SELECT id, name, slug FROM pr_municipalities ORDER BY name`);
  res.json({ municipalities: rows });
}));

// Buscador del marketplace (typo-tolerante + cerca de mí + featured primero)
app.get('/api/public/search', publicLimiter, asyncH(async (req, res) => {
  const { q, category, municipality, lat, lng } = req.query;
  const vals = [], where = [`b.is_published`, `b.deleted_at IS NULL`];
  let rank = `b.rating_avg`;

  if (isStr(q, 80)) {
    vals.push(q.trim());
    where.push(`(b.name % $${vals.length} OR EXISTS (
        SELECT 1 FROM services sv WHERE sv.business_id = b.id AND sv.is_active AND sv.name % $${vals.length}))`);
    rank = `similarity(b.name, $${vals.length})`;
  }
  if (isStr(category, 60))     { vals.push(category);     where.push(`EXISTS (SELECT 1 FROM business_categories bc JOIN categories c ON c.id = bc.category_id WHERE bc.business_id = b.id AND c.slug = $${vals.length})`); }
  if (isStr(municipality, 60)) { vals.push(municipality); where.push(`EXISTS (SELECT 1 FROM pr_municipalities m WHERE m.id = b.municipality_id AND m.slug = $${vals.length})`); }

  let distSel = `NULL::float AS distance_km`;
  const la = parseFloat(lat), lo = parseFloat(lng);
  if (Number.isFinite(la) && Number.isFinite(lo)) {
    vals.push(la, lo);
    distSel = `round((earth_distance(ll_to_earth(b.lat,b.lng), ll_to_earth($${vals.length - 1},$${vals.length})) / 1000)::numeric, 1) AS distance_km`;
  }

  const { rows } = await db.query(
    `SELECT b.id, b.slug, b.name, b.bio, b.logo_url, b.cover_url, b.rating_avg, b.rating_count,
            b.is_featured, m.name AS municipality, ${distSel},
            (SELECT json_agg(json_build_object('name', c.name_es, 'slug', c.slug))
               FROM business_categories bc JOIN categories c ON c.id = bc.category_id
              WHERE bc.business_id = b.id) AS categories
       FROM businesses b
       LEFT JOIN pr_municipalities m ON m.id = b.municipality_id
      WHERE ${where.join(' AND ')}
      ORDER BY (EXISTS (SELECT 1 FROM featured_listings fl WHERE fl.business_id = b.id AND fl.ends_at > now())) DESC,
               ${rank} DESC NULLS LAST, b.rating_count DESC
      LIMIT 30`, vals);
  res.json({ results: rows });
}));

// ----------------------------------------------------------------------------
// PORTADA DE DESCUBRIMIENTO (Bukéame home): featured / nearby / top_rated
// ----------------------------------------------------------------------------
// Público. Modela su SELECT en GET /api/public/search: mismas columnas, distance_km
// vía earth_distance/ll_to_earth cuando hay lat/lng, category = name_es de la
// categoría principal del negocio (subquery a business_categories+categories).
// Resiliente: si alguna lista falla, devuelve [] en vez de tumbar la portada.
app.get('/api/public/discover', publicLimiter, asyncH(async (req, res) => {
  const { lat, lng, municipality } = req.query;
  const la = parseFloat(lat), lo = parseFloat(lng);
  const hasGeo = Number.isFinite(la) && Number.isFinite(lo);

  // Construye un SELECT parametrizado para una de las 3 listas.
  // `extraWhere`/`orderBy` son fragmentos fijos (NO entran datos de usuario).
  // Todos los valores (geo + municipality) van por placeholders.
  const buildList = async (extraWhere, orderBy, limit) => {
    const vals = [];
    const where = [`b.is_published`, `b.deleted_at IS NULL`];

    let distSel = `NULL::float AS distance_km`;
    if (hasGeo) {
      vals.push(la, lo);
      distSel = `round((earth_distance(ll_to_earth(b.lat,b.lng), ll_to_earth($${vals.length - 1},$${vals.length})) / 1000)::numeric, 1) AS distance_km`;
    }
    if (isStr(municipality, 60)) {
      vals.push(municipality);
      where.push(`EXISTS (SELECT 1 FROM pr_municipalities m WHERE m.id = b.municipality_id AND m.slug = $${vals.length})`);
    }
    if (extraWhere) where.push(extraWhere);

    const { rows } = await db.query(
      `SELECT b.slug, b.name, b.logo_url, b.cover_url, b.rating_avg, b.rating_count,
              m.name AS municipality, ${distSel},
              (SELECT c.name_es
                 FROM business_categories bc JOIN categories c ON c.id = bc.category_id
                WHERE bc.business_id = b.id
                ORDER BY c.sort_order
                LIMIT 1) AS category
         FROM businesses b
         LEFT JOIN pr_municipalities m ON m.id = b.municipality_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT ${limit}`, vals);
    return rows;
  };

  // featured: negocios con featured vigente (featured_listings) o flag is_featured.
  const featuredP = buildList(
    `(EXISTS (SELECT 1 FROM featured_listings fl WHERE fl.business_id = b.id AND fl.ends_at > now()) OR b.is_featured)`,
    `(EXISTS (SELECT 1 FROM featured_listings fl WHERE fl.business_id = b.id AND fl.ends_at > now())) DESC,
     b.rating_avg DESC NULLS LAST, b.rating_count DESC`,
    8,
  ).catch(() => []);

  // nearby: sólo si hay geo válida; los más cercanos por distancia.
  const nearbyP = hasGeo
    ? buildList(`b.lat IS NOT NULL AND b.lng IS NOT NULL`, `distance_km ASC NULLS LAST`, 12).catch(() => [])
    : Promise.resolve([]);

  // top_rated: con al menos 1 reseña, mejor promedio primero.
  const topRatedP = buildList(
    `b.rating_count >= 1`,
    `b.rating_avg DESC NULLS LAST, b.rating_count DESC`,
    12,
  ).catch(() => []);

  const [featured, nearby, top_rated] = await Promise.all([featuredP, nearbyP, topRatedP]);
  res.json({ featured, nearby, top_rated });
}));

// Perfil público (la página SEO bukeame.com/<slug>)
app.get('/api/public/:slug', publicLimiter, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.id, b.slug, b.name, b.bio, b.phone, b.whatsapp, b.address_line, b.lat, b.lng,
            b.logo_url, b.cover_url, b.theme, b.social, b.rating_avg, b.rating_count,
            b.cancellation_hours, b.no_show_policy, b.deposit_default_cents, b.booking_horizon_days,
            m.name AS municipality,
            (s.plan_code <> 'free' AND (p.features->>'deposits')::boolean) AS deposits_enabled
       FROM businesses b
       LEFT JOIN pr_municipalities m ON m.id = b.municipality_id
       JOIN subscriptions s ON s.business_id = b.id
       JOIN plans p ON p.code = s.plan_code
      WHERE b.slug = $1 AND b.deleted_at IS NULL`, [req.params.slug]);
  const biz = rows[0];
  if (!biz) return bad(res, 'Negocio no encontrado', 404);

  const [services, staff, hours, reviews, payMethods, products, gallery] = await Promise.all([
    db.query(`SELECT id, name, description, duration_min, price_cents, deposit_cents, photo_url, is_featured
              FROM services WHERE business_id = $1 AND is_active AND deleted_at IS NULL
              ORDER BY is_featured DESC, sort_order`, [biz.id]),
    db.query(`SELECT id, display_name, bio, avatar_url, specialties, rating_avg, rating_count
              FROM staff WHERE business_id = $1 AND is_active AND deleted_at IS NULL ORDER BY sort_order`, [biz.id]),
    db.query(`SELECT day_of_week, opens, closes FROM business_hours WHERE business_id = $1 ORDER BY day_of_week, opens`, [biz.id]),
    db.query(`SELECT r.rating, r.comment, r.business_reply, r.created_at, c.full_name
              FROM reviews r JOIN clients c ON c.id = r.client_id
              WHERE r.business_id = $1 AND r.is_published ORDER BY r.created_at DESC LIMIT 10`, [biz.id]),
    // Métodos de pago que el negocio activó (resiliente si la migración 07/11 aún no corre).
    // Traemos también account_ref + config para armar lo PÚBLICO del checkout.
    db.query(`SELECT provider, account_ref, COALESCE(config, '{}'::jsonb) AS config
                FROM payment_providers
               WHERE business_id = $1 AND is_enabled = true AND status = 'connected'`, [biz.id])
      .catch(() => db.query(`SELECT provider, account_ref FROM payment_providers
               WHERE business_id = $1 AND is_enabled = true AND status = 'connected'`, [biz.id])
        .catch(() => ({ rows: [] }))),
    // Productos activos del negocio con sus fotos + reseñas resumidas (resiliente si
    // las tablas aún no existen). first_photo = la 1ra por sort_order para la tarjeta;
    // rating_avg (1 decimal) / rating_count salen de product_reviews (migración 12).
    db.query(`SELECT p.id, p.name, p.description, p.price_cents, p.stock, p.variants,
                     p.category, p.tagline,
                     COALESCE(
                       (SELECT json_agg(pp.url ORDER BY pp.id)
                          FROM product_photos pp WHERE pp.product_id = p.id),
                       '[]'::json) AS photos,
                     (SELECT pp.url FROM product_photos pp
                        WHERE pp.product_id = p.id
                        ORDER BY pp.sort_order, pp.id LIMIT 1) AS first_photo,
                     COALESCE((SELECT count(*)::int FROM product_reviews r
                        WHERE r.product_id = p.id), 0) AS rating_count,
                     (SELECT round(avg(r.rating)::numeric, 1) FROM product_reviews r
                        WHERE r.product_id = p.id) AS rating_avg
                FROM products p
               WHERE p.business_id = $1 AND p.is_active = true
               ORDER BY p.name`, [biz.id])
      .catch(() =>
        // Fallback si product_reviews aún no existe: trae productos sin el resumen,
        // pero igual con first_photo (que sólo depende de product_photos).
        db.query(`SELECT p.id, p.name, p.description, p.price_cents, p.stock, p.variants,
                         p.category, p.tagline,
                         COALESCE(
                           (SELECT json_agg(pp.url ORDER BY pp.id)
                              FROM product_photos pp WHERE pp.product_id = p.id),
                           '[]'::json) AS photos,
                         (SELECT pp.url FROM product_photos pp
                            WHERE pp.product_id = p.id
                            ORDER BY pp.sort_order, pp.id LIMIT 1) AS first_photo,
                         0 AS rating_count, NULL AS rating_avg
                    FROM products p
                   WHERE p.business_id = $1 AND p.is_active = true
                   ORDER BY p.name`, [biz.id])
          .catch(() => ({ rows: [] }))),
    // Galería / portafolio del negocio (resiliente si la tabla aún no existe)
    db.query(`SELECT url, caption FROM gallery_photos
              WHERE business_id = $1 ORDER BY sort_order`, [biz.id])
      .catch(() => ({ rows: [] })),
  ]);
  // Datos PÚBLICOS para cobrar (solo métodos activos + conectados). El public_token
  // de ATH es público por diseño (va en el botón client-side); es seguro exponerlo.
  // NUNCA hay secretos aquí (ni privateToken de ATH, ni llaves de Stripe).
  const byProv = {};
  for (const r of payMethods.rows) byProv[r.provider] = r;
  const athRow = byProv['ath_movil'];
  const ppRow  = byProv['paypal'];
  const stRow  = byProv['stripe'];
  const payment_config = {
    ath: athRow ? {
      mode: (athRow.config && athRow.config.ath_mode) || 'manual',
      public_token: (athRow.config && athRow.config.ath_public_token) || null,
      phone: athRow.account_ref || null,
    } : null,
    paypal: ppRow ? {
      handle: (ppRow.config && ppRow.config.paypal_handle) || ppRow.account_ref || null,
    } : null,
    stripe: stRow ? {
      payment_link: (stRow.config && stRow.config.stripe_payment_link) || null,
      connected: !!(stRow.config && (stRow.config.stripe_payment_link || stRow.config.stripe_account_id)),
    } : { connected: false },
  };
  res.json({
    business: biz, services: services.rows, staff: staff.rows, hours: hours.rows, reviews: reviews.rows,
    payment_methods: payMethods.rows.map(r => r.provider),
    payment_config,
    // rating_avg llega como string (numeric de pg) → number con 1 decimal, o null.
    products: products.rows.map(p => ({
      ...p,
      rating_avg: p.rating_avg == null ? null : Number(p.rating_avg),
      rating_count: Number(p.rating_count) || 0,
    })),
    gallery: gallery.rows,
  });
}));

// ----------------------------------------------------------------------------
// DETALLE PÚBLICO DE UN PRODUCTO + RESEÑAS
// ----------------------------------------------------------------------------
// GET: ficha del producto, hasta 3 fotos (por sort_order), reseñas (máx 50) y el
// resumen de calificación. 404 si el producto no es del negocio o está inactivo.
app.get('/api/public/:slug/products/:id', publicLimiter, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const b = await db.query(
    `SELECT id FROM businesses WHERE slug = $1 AND deleted_at IS NULL`, [req.params.slug]);
  const biz = b.rows[0];
  if (!biz) return bad(res, 'Negocio no encontrado', 404);

  const prod = await db.query(
    `SELECT id, name, description, price_cents, stock, variants, category, tagline, features
       FROM products WHERE id = $1 AND business_id = $2 AND is_active = true`,
    [req.params.id, biz.id]);
  if (!prod.rows[0]) return bad(res, 'Producto no encontrado', 404);

  const [photos, reviews, summary] = await Promise.all([
    db.query(`SELECT url FROM product_photos WHERE product_id = $1
              ORDER BY sort_order, id LIMIT 3`, [req.params.id]),
    db.query(`SELECT reviewer_name, rating, comment, verified, created_at
                FROM product_reviews WHERE product_id = $1
               ORDER BY created_at DESC LIMIT 50`, [req.params.id]),
    db.query(`SELECT count(*)::int AS rating_count,
                     round(avg(rating)::numeric, 1) AS rating_avg
                FROM product_reviews WHERE product_id = $1`, [req.params.id]),
  ]);
  const sum = summary.rows[0] || { rating_count: 0, rating_avg: null };
  res.json({
    product: prod.rows[0],
    photos: photos.rows,
    reviews: reviews.rows,
    rating_avg: sum.rating_avg == null ? null : Number(sum.rating_avg),
    rating_count: Number(sum.rating_count) || 0,
  });
}));

// POST: dejar una reseña. SOLO quienes compraron el producto (orden pagada/cumplida
// con su email y el product_id en items) pueden reseñar. 1 reseña por email/producto
// (índice único parcial → 409). verified=true porque la compra está confirmada.
app.post('/api/public/:slug/products/:id/review', bookingLimiter, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const { name, email, rating, comment } = req.body || {};
  if (!isStr(name, 120)) return bad(res, 'Tu nombre es requerido');
  if (!isEmail(email)) return bad(res, 'Tu email es requerido');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return bad(res, 'Calificación entre 1 y 5');
  if (comment != null && !isStr(comment, 1000)) return bad(res, 'Comentario inválido');

  const b = await db.query(
    `SELECT id FROM businesses WHERE slug = $1 AND deleted_at IS NULL`, [req.params.slug]);
  const biz = b.rows[0];
  if (!biz) return bad(res, 'Negocio no encontrado', 404);

  // El producto debe ser del negocio y estar activo
  const prod = await db.query(
    `SELECT id FROM products WHERE id = $1 AND business_id = $2 AND is_active = true`,
    [req.params.id, biz.id]);
  if (!prod.rows[0]) return bad(res, 'Producto no encontrado', 404);

  // VERIFICA compra: orden del negocio con buyer_email = email (citext, case-insensitive),
  // status pagado/cumplido, e items que contengan este product_id. Tomamos la más reciente.
  const ord = await db.query(
    `SELECT id FROM product_orders
      WHERE business_id = $1
        AND buyer_email = $2
        AND status IN ('paid','fulfilled')
        AND items @> jsonb_build_array(jsonb_build_object('product_id', $3::text))
      ORDER BY created_at DESC LIMIT 1`,
    [biz.id, email, req.params.id]);
  if (!ord.rows[0])
    return bad(res, 'Solo quienes compraron este producto pueden reseñarlo.', 403);

  try {
    const { rows } = await db.query(
      `INSERT INTO product_reviews
          (product_id, business_id, order_id, reviewer_name, reviewer_email, rating, comment, verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       RETURNING reviewer_name, rating, comment, verified, created_at`,
      [req.params.id, biz.id, ord.rows[0].id, name.trim(), email, rating,
       isStr(comment, 1000) ? comment.trim() : null]);
    res.status(201).json({ review: rows[0] });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'Ya dejaste una reseña de este producto.', 409);
    throw e;
  }
}));

// Disponibilidad: ?service_id=&date=YYYY-MM-DD[&staff_id=]
app.get('/api/public/:slug/availability', publicLimiter, asyncH(async (req, res) => {
  const { service_id, staff_id, date } = req.query;
  // service_id puede ser uno o varios separados por coma: "uuid1,uuid2,uuid3"
  const serviceIds = String(service_id || '').split(',').map(s => s.trim()).filter(isUuid);
  if (!serviceIds.length || !isDate(date)) return bad(res, 'service_id y date requeridos');

  const b = await db.query(`SELECT * FROM businesses WHERE slug = $1 AND deleted_at IS NULL`, [req.params.slug]);
  const biz = b.rows[0];
  if (!biz) return bad(res, 'Negocio no encontrado', 404);

  const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' }));
  const reqDay = new Date(`${date}T12:00:00${TZ_OFFSET}`);
  const horizon = new Date(today.getTime() + biz.booking_horizon_days * 864e5);
  if (reqDay > horizon) return res.json({ slots: [], reason: 'fuera_de_horizonte' });

  // Sumar la duración de TODOS los servicios elegidos
  const sv = await db.query(
    `SELECT id, duration_min FROM services WHERE id = ANY($1) AND business_id = $2 AND is_active`,
    [serviceIds, biz.id]);
  if (!sv.rows.length) return bad(res, 'Servicio no encontrado', 404);
  const dur = sv.rows.reduce((sum, s) => sum + s.duration_min, 0);

  // El staff debe ofrecer TODOS los servicios elegidos. Usamos el primero como
  // referencia para elegibilidad; el bloqueo de tiempo usa la duración total.
  const refService = serviceIds[0];

  let slots;
  if (isUuid(staff_id)) {
    // El staff debe pertenecer a ESTE negocio (no filtrar ocupación de otro tenant)
    const ok = await db.query(`SELECT 1 FROM staff WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`, [staff_id, biz.id]);
    if (!ok.rows[0]) return bad(res, 'Profesional no encontrado', 404);
    slots = await staffDaySlots(biz, staff_id, date, dur);
  } else {
    const ids = await eligibleStaff(biz.id, refService, date);
    const all = new Set();
    for (const id of ids) (await staffDaySlots(biz, id, date, dur)).forEach(s => all.add(s));
    slots = [...all].sort();
  }
  res.json({ date, duration_min: dur, slots });
}));

// CREAR CITA (público, sin cuenta)
app.post('/api/public/:slug/appointments', bookingLimiter, asyncH(async (req, res) => {
  const { service_id, staff_id, start_iso, full_name, phone, email, client_notes, payment_method } = req.body || {};
  // service_id puede ser uno (string) o varios (array). Normalizamos a lista.
  const serviceIds = (Array.isArray(service_id) ? service_id : String(service_id || '').split(','))
    .map(s => String(s).trim()).filter(isUuid);
  if (!serviceIds.length) return bad(res, 'Servicio requerido');
  if (!isStr(full_name, 120)) return bad(res, 'Tu nombre es requerido');
  if (!isPhone(phone)) return bad(res, 'Tu WhatsApp debe ser un número válido de PR/US (10 dígitos) — ahí enviamos el recordatorio');
  const starts = new Date(start_iso || '');
  if (isNaN(starts) || starts < new Date()) return bad(res, 'Horario inválido');

  const b = await db.query(
    `SELECT b.*, (s.plan_code <> 'free' AND (p.features->>'deposits')::boolean) AS deposits_enabled,
            s.plan_code, p.max_appts_month
       FROM businesses b
       JOIN subscriptions s ON s.business_id = b.id
       JOIN plans p ON p.code = s.plan_code
      WHERE b.slug = $1 AND b.deleted_at IS NULL`, [req.params.slug]);
  const biz = b.rows[0];
  if (!biz) return bad(res, 'Negocio no encontrado', 404);

  // límite del plan free
  if (biz.max_appts_month !== null) {
    const c = await db.query(
      `SELECT count(*)::int n FROM appointments
        WHERE business_id = $1 AND date_trunc('month', starts_at) = date_trunc('month', now())
          AND status <> 'cancelled_client' AND status <> 'cancelled_business'`, [biz.id]);
    if (c.rows[0].n >= biz.max_appts_month)
      return bad(res, 'Este negocio alcanzó su límite de citas del mes. Intenta contactarlo directo.', 409);
  }

  // Cargar TODOS los servicios elegidos, preservando el orden de selección
  const svQ = await db.query(
    `SELECT * FROM services WHERE id = ANY($1) AND business_id = $2 AND is_active AND deleted_at IS NULL`,
    [serviceIds, biz.id]);
  if (!svQ.rows.length) return bad(res, 'Servicio no encontrado', 404);
  // Ordenar según el orden en que el cliente los eligió
  const services = serviceIds.map(id => svQ.rows.find(s => s.id === id)).filter(Boolean);
  if (!services.length) return bad(res, 'Servicio no encontrado', 404);

  // Combinar: nombre, duración total, precio total, depósito total
  const service = {
    id: services[0].id,
    name: services.map(s => s.name).join(' + '),
    duration_min: services.reduce((sum, s) => sum + s.duration_min, 0),
    price_cents: services.reduce((sum, s) => sum + s.price_cents, 0),
    deposit_cents: services.reduce((sum, s) => sum + (s.deposit_cents || 0), 0),
  };
  // Detalle para guardar en service_ids (jsonb)
  const serviceDetail = services.map(s => ({
    id: s.id, name: s.name, duration_min: s.duration_min, price_cents: s.price_cents,
  }));

  const ends = new Date(starts.getTime() + service.duration_min * 60_000);
  const dateStr = starts.toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' });

  // candidatos de staff (deben ofrecer el primer servicio como referencia)
  let candidates;
  if (isUuid(staff_id)) {
    const ok = await db.query(
      `SELECT 1 FROM service_staff ss JOIN staff st ON st.id = ss.staff_id
        WHERE ss.service_id = $1 AND ss.staff_id = $2 AND st.is_active`, [service.id, staff_id]);
    if (!ok.rows[0]) return bad(res, 'Ese profesional no ofrece este servicio', 400);
    candidates = [staff_id];
  } else {
    candidates = await eligibleStaff(biz.id, service.id, dateStr);
    if (!candidates.length) return bad(res, 'No hay profesionales para este servicio', 409);
  }

  // valida que el slot exista en la disponibilidad real (con la duración TOTAL)
  const validFor = [];
  for (const id of candidates)
    if ((await staffDaySlots(biz, id, dateStr, service.duration_min)).includes(starts.toISOString()))
      validFor.push(id);
  if (!validFor.length) return bad(res, 'Ese turno ya no está disponible. Escoge otro.', 409);

  const depositsOn = biz.deposits_enabled && payment_method !== undefined;
  const deposit = depositsOn ? (service.deposit_cents ?? biz.deposit_default_cents) : 0;
  const method = payment_method === 'card' ? 'card' : 'ath_movil';
  const phoneN = normPhone(phone);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // upsert cliente del CRM
    const cl = await client.query(
      `INSERT INTO clients (business_id, full_name, phone, email)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (business_id, phone)
       DO UPDATE SET full_name = EXCLUDED.full_name, email = COALESCE(EXCLUDED.email, clients.email)
       RETURNING id, is_blocked`, [biz.id, full_name.trim(), phoneN, isEmail(email) ? email.toLowerCase() : null]);
    if (cl.rows[0].is_blocked) { await client.query('ROLLBACK'); return bad(res, 'No es posible reservar con este negocio', 403); }

    // intenta cada staff candidato; el EXCLUDE constraint resuelve carreras
    let appt = null;
    const code = confirmCode(biz.slug.replace(/[^a-z]/g, '').slice(0, 2).toUpperCase() || 'BK', starts);

    for (const sid of validFor) {
      try {
        const r = await client.query(
          `INSERT INTO appointments (business_id, client_id, staff_id, service_id, service_name,
              duration_min, price_cents, deposit_cents, starts_at, ends_at, status, source,
              confirmation_code, client_notes, service_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'online',$12,$13,$14) RETURNING *`,
          [biz.id, cl.rows[0].id, sid, service.id, service.name, service.duration_min,
           service.price_cents, deposit, starts, ends,
           deposit > 0 ? 'pending_deposit' : 'confirmed', code, (client_notes || '').slice(0, 300) || null,
           JSON.stringify(serviceDetail)]);
        appt = r.rows[0];
        break;
      } catch (e) {
        if (e.code === '23P01') continue;   // ese staff ya fue tomado → prueba el próximo
        throw e;
      }
    }
    if (!appt) { await client.query('ROLLBACK'); return bad(res, 'Ese turno acaba de ser tomado. Escoge otro.', 409); }

    if (deposit > 0)
      await client.query(
        `INSERT INTO payments (business_id, appointment_id, client_id, kind, method, amount_cents)
         VALUES ($1,$2,$3,'deposit',$4,$5)`, [biz.id, appt.id, cl.rows[0].id, method, deposit]);

    // mensajes de confirmación (worker los despacha)
    await client.query(
      `INSERT INTO message_log (business_id, appointment_id, channel, recipient, template)
       VALUES ($1,$2,'whatsapp',$3,'confirm')`, [biz.id, appt.id, phoneN]);
    if (isEmail(email))
      await client.query(
        `INSERT INTO message_log (business_id, appointment_id, channel, recipient, template)
         VALUES ($1,$2,'email',$3,'confirm')`, [biz.id, appt.id, email.toLowerCase()]);

    await client.query('COMMIT');

    const st = await db.query(`SELECT display_name FROM staff WHERE id = $1`, [appt.staff_id]);
    await notify(biz.id, 'new_appointment', '📅 Nueva cita',
      `${full_name.trim()} · ${service.name} · ${starts.toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico', dateStyle: 'short', timeStyle: 'short' })}`,
      { appointment_id: appt.id });

    res.status(201).json({
      appointment: {
        confirmation_code: appt.confirmation_code,
        status: appt.status,
        starts_at: appt.starts_at,
        service_name: appt.service_name,
        staff_name: st.rows[0]?.display_name,
        price_cents: appt.price_cents,
        deposit_cents: appt.deposit_cents,
        payment_method: deposit > 0 ? method : null,
        ath_phone: deposit > 0 && method === 'ath_movil' ? biz.ath_phone : null,
      },
    });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

// Ver cita por código (ticket)
app.get('/api/public/appointments/:code', codeLimiter, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT a.confirmation_code, a.status, a.starts_at, a.service_name, a.price_cents, a.deposit_cents,
            a.client_notes, st.display_name AS staff_name,
            b.name AS business_name, b.slug, b.address_line, b.cancellation_hours, b.ath_phone,
            (SELECT json_build_object('method', p.method, 'status', p.status, 'amount_cents', p.amount_cents)
               FROM payments p WHERE p.appointment_id = a.id AND p.kind = 'deposit' LIMIT 1) AS deposit
       FROM appointments a
       JOIN businesses b ON b.id = a.business_id
       JOIN staff st ON st.id = a.staff_id
      WHERE a.confirmation_code = $1`, [req.params.code.toUpperCase()]);
  if (!rows[0]) return bad(res, 'Cita no encontrada', 404);
  res.json({ appointment: rows[0] });
}));

// Cliente reporta su referencia ATH Móvil → el negocio verifica
app.post('/api/public/appointments/:code/ath-reference', codeLimiter, asyncH(async (req, res) => {
  const { reference } = req.body || {};
  if (!isStr(reference, 60)) return bad(res, 'Referencia requerida');
  const { rows } = await db.query(
    `UPDATE payments p SET external_ref = $1
       FROM appointments a
      WHERE p.appointment_id = a.id AND a.confirmation_code = $2
        AND p.kind = 'deposit' AND p.method = 'ath_movil' AND p.status = 'pending'
      RETURNING a.business_id, a.id, a.service_name`, [reference.trim(), req.params.code.toUpperCase()]);
  if (!rows[0]) return bad(res, 'Cita o depósito no encontrado', 404);
  await notify(rows[0].business_id, 'payment', '💸 Verifica un ATH Móvil',
    `Referencia ${reference.trim()} · ${rows[0].service_name}`, { appointment_id: rows[0].id });
  res.json({ ok: true, message: 'El negocio verificará tu pago y la cita quedará confirmada' });
}));

// Cancelación por el cliente (respeta la política)
app.post('/api/public/appointments/:code/cancel', codeLimiter, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT a.id, a.business_id, a.starts_at, a.status, a.service_name, b.cancellation_hours,
            c.full_name
       FROM appointments a JOIN businesses b ON b.id = a.business_id
       JOIN clients c ON c.id = a.client_id
      WHERE a.confirmation_code = $1`, [req.params.code.toUpperCase()]);
  const a = rows[0];
  if (!a) return bad(res, 'Cita no encontrada', 404);
  if (!ALIVE.includes(a.status)) return bad(res, 'Esta cita ya no se puede cancelar', 409);
  const limit = new Date(new Date(a.starts_at).getTime() - a.cancellation_hours * 3600_000);
  if (new Date() > limit)
    return bad(res, `Las cancelaciones requieren ${a.cancellation_hours}h de anticipación. Contacta al negocio directo.`, 409);
  await db.query(
    `UPDATE appointments SET status = 'cancelled_client', cancelled_at = now(),
            cancel_reason = $2 WHERE id = $1`, [a.id, (req.body?.reason || '').slice(0, 200) || null]);
  await notify(a.business_id, 'cancellation', '❌ Cita cancelada',
    `${a.full_name} canceló ${a.service_name}`, { appointment_id: a.id });
  res.json({ ok: true });
}));

// Confirmación ATH Móvil AUTO (botón client-side con el publicToken del negocio): el cobro ya
// ocurrió DIRECTO hacia la cuenta ATH del negocio. Aquí registramos la referencia, marcamos el
// depósito 'paid' y la cita 'confirmed'. Idempotente. Bukéame no toca el dinero.
app.post('/api/public/:slug/appointments/:code/ath/confirm', codeLimiter, asyncH(async (req, res) => {
  const { reference } = req.body || {};
  if (!isStr(reference, 60)) return bad(res, 'Referencia requerida');
  // La cita debe pertenecer al negocio del slug (aislamiento multi-tenant).
  const { rows } = await db.query(
    `SELECT a.id, a.business_id, a.service_name, a.status,
            p.id AS payment_id, p.status AS pay_status
       FROM appointments a
       JOIN businesses b ON b.id = a.business_id AND b.slug = $1 AND b.deleted_at IS NULL
       LEFT JOIN payments p ON p.appointment_id = a.id AND p.kind = 'deposit' AND p.method = 'ath_movil'
      WHERE a.confirmation_code = $2`, [req.params.slug, req.params.code.toUpperCase()]);
  const a = rows[0];
  if (!a) return bad(res, 'Cita no encontrada', 404);
  // Idempotencia: si ya está pagada/confirmada, responder ok sin re-procesar.
  if (a.pay_status === 'paid' || a.status === 'confirmed')
    return res.json({ ok: true, status: 'confirmed', already: true });
  if (a.payment_id)
    await db.query(`UPDATE payments SET status = 'paid', paid_at = now(), external_ref = $2 WHERE id = $1`,
      [a.payment_id, reference.trim()]);
  await db.query(`UPDATE appointments SET status = 'confirmed' WHERE id = $1 AND status = 'pending_deposit'`, [a.id]);
  await notify(a.business_id, 'payment', 'Pago ATH Móvil recibido',
    `Ref ${reference.trim()} · ${a.service_name}`, { appointment_id: a.id });
  res.json({ ok: true, status: 'confirmed' });
}));

// ============================================================================
//  RUTAS — CLIENTE (usuario sin negocio): sus citas en TODOS los negocios
// ----------------------------------------------------------------------------
// Un CLIENTE es un usuario (tabla users) que NO tiene negocio. Mismo login;
// solo cambia a dónde se le redirige. Cruzamos la tabla clients (por-negocio)
// con su identidad por user_id, email (citext) o phone (E.164) para encontrar
// sus citas en cualquier negocio. Todo parametrizado.
// ============================================================================

// Cláusula de cruce reutilizable: la cita es del usuario si el cliente del
// negocio comparte user_id, email o teléfono con el usuario autenticado.
// $1 = req.user.id (uuid), $2 = req.user.email, $3 = req.user.phone (puede ser null).
const CLIENT_MATCH =
  `(c.user_id = $1 OR c.email = $2 OR ($3::text IS NOT NULL AND c.phone = $3::text))`;

// Las citas del usuario en TODOS los negocios.
app.get('/api/me/appointments', authRequired, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT a.confirmation_code, a.starts_at, a.status, a.service_name,
            a.price_cents, a.deposit_cents,
            st.display_name AS staff_name,
            b.name AS business_name, b.slug, b.logo_url,
            EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id) AS reviewed
       FROM appointments a
       JOIN clients c    ON c.id = a.client_id
       JOIN businesses b ON b.id = a.business_id AND b.deleted_at IS NULL
       LEFT JOIN staff st ON st.id = a.staff_id
      WHERE ${CLIENT_MATCH}
      ORDER BY a.starts_at DESC
      LIMIT 200`,
    [req.user.id, req.user.email, req.user.phone || null]);

  const now = Date.now();
  const upcoming = [], past = [];
  for (const a of rows) {
    const alive = ALIVE.includes(a.status);
    if (alive && new Date(a.starts_at).getTime() >= now) upcoming.push(a);
    else past.push(a);
  }
  // upcoming en orden cronológico ascendente (la más próxima primero);
  // past ya viene DESC (la más reciente primero) por el ORDER BY.
  upcoming.reverse();
  res.json({ upcoming, past });
}));

// El usuario deja una reseña de una de SUS citas (1 por cita, appointment_id UNIQUE).
app.post('/api/appointments/:code/review', authRequired, asyncH(async (req, res) => {
  const rating = req.body?.rating;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5)
    return bad(res, 'La calificación debe ser un número del 1 al 5');
  const comment = typeof req.body?.comment === 'string'
    ? req.body.comment.trim().slice(0, 1000) || null
    : null;

  // Localiza la cita por código y verifica que sea del usuario (mismo cruce).
  const { rows } = await db.query(
    `SELECT a.id AS appointment_id, a.business_id, a.staff_id, a.client_id,
            a.starts_at, a.status
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
      WHERE a.confirmation_code = $4 AND ${CLIENT_MATCH}`,
    [req.user.id, req.user.email, req.user.phone || null, req.params.code.toUpperCase()]);
  const a = rows[0];
  if (!a) return bad(res, 'Cita no encontrada', 404);

  // Solo se puede reseñar una cita que ya pasó o que está completada.
  if (a.status !== 'completed' && new Date(a.starts_at).getTime() >= Date.now())
    return bad(res, 'Solo puedes reseñar una cita que ya ocurrió', 409);

  try {
    await db.query(
      `INSERT INTO reviews (business_id, staff_id, client_id, appointment_id, rating, comment)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.business_id, a.staff_id, a.client_id, a.appointment_id, rating, comment]);
  } catch (e) {
    if (e.code === '23505') return bad(res, 'Ya dejaste una reseña de esta cita.', 409);
    throw e;
  }
  res.status(201).json({ ok: true });
}));

// ============================================================================
//  RUTAS — AGENDA, KPIs, CLIENTES, PAGOS, NOTIFICACIONES, SUSCRIPCIÓN
// ============================================================================
app.get('/api/appointments', authRequired, businessScope, asyncH(async (req, res) => {
  // Modo rango (semana/mes): ?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Modo día (comportamiento original): ?date=YYYY-MM-DD (o hoy si falta)
  const rangeMode = isDate(req.query.from) && isDate(req.query.to);
  let date = null, from = null, to = null, start, end;
  if (rangeMode) {
    from = req.query.from;
    to   = req.query.to;
    if (to < from) return bad(res, 'Rango inválido: to debe ser >= from');
    start = dayBounds(from).start;
    end   = dayBounds(to).end;
  } else {
    date = isDate(req.query.date)
      ? req.query.date
      : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' });
    ({ start, end } = dayBounds(date));
  }
  const vals = [req.business.id, start, end];
  let extra = '';
  if (isUuid(req.query.staff_id)) { vals.push(req.query.staff_id); extra = ` AND a.staff_id = $${vals.length}`; }
  const { rows } = await db.query(
    `SELECT a.*, c.full_name AS client_name, c.phone AS client_phone, c.no_show_count,
            st.display_name AS staff_name, st.calendar_color,
            (SELECT json_build_object('method', p.method, 'status', p.status, 'external_ref', p.external_ref, 'id', p.id)
               FROM payments p WHERE p.appointment_id = a.id AND p.kind = 'deposit' LIMIT 1) AS deposit
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       JOIN staff st ON st.id = a.staff_id
      WHERE a.business_id = $1 AND a.starts_at >= $2 AND a.starts_at <= $3 ${extra}
      ORDER BY a.starts_at
      LIMIT 500`, vals);
  if (rangeMode) return res.json({ from, to, appointments: rows });
  res.json({ date, appointments: rows });
}));

// Cita manual / walk-in desde el panel
app.post('/api/appointments', authRequired, businessScope, asyncH(async (req, res) => {
  const { service_id, staff_id, start_iso, full_name, phone, source } = req.body || {};
  if (!isUuid(service_id) || !isUuid(staff_id)) return bad(res, 'Servicio y profesional requeridos');
  if (!isStr(full_name, 120) || !isPhone(phone)) return bad(res, 'Nombre y teléfono del cliente requeridos');
  const starts = new Date(start_iso || '');
  if (isNaN(starts)) return bad(res, 'Horario inválido');
  const sv = await db.query(`SELECT * FROM services WHERE id = $1 AND business_id = $2`, [service_id, req.business.id]);
  if (!sv.rows[0]) return bad(res, 'Servicio no encontrado', 404);
  const s = sv.rows[0];
  // El staff DEBE ser de este negocio (sin esto se podría inyectar una cita en
  // la agenda del staff de otro tenant vía el constraint global anti-doble-booking).
  const stf = await db.query(
    `SELECT 1 FROM staff WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [staff_id, req.business.id]);
  if (!stf.rows[0]) return bad(res, 'Profesional no encontrado', 404);
  const cl = await db.query(
    `INSERT INTO clients (business_id, full_name, phone)
     VALUES ($1,$2,$3)
     ON CONFLICT (business_id, phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`, [req.business.id, full_name.trim(), normPhone(phone)]);
  const code = confirmCode('WK', starts);
  try {
    const { rows } = await db.query(
      `INSERT INTO appointments (business_id, client_id, staff_id, service_id, service_name,
          duration_min, price_cents, deposit_cents, starts_at, ends_at, status, source, confirmation_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'confirmed',$10,$11) RETURNING *`,
      [req.business.id, cl.rows[0].id, staff_id, s.id, s.name, s.duration_min, s.price_cents,
       starts, new Date(starts.getTime() + s.duration_min * 60_000),
       source === 'walk_in' ? 'walk_in' : 'manual', code]);
    res.status(201).json({ appointment: rows[0] });
  } catch (e) {
    if (e.code === '23P01') return bad(res, 'Ese profesional ya tiene una cita en ese horario', 409);
    throw e;
  }
}));

// Cambiar estado (completed / no_show / cancelled_business) o reagendar
app.patch('/api/appointments/:id', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const a = await db.query(`SELECT * FROM appointments WHERE id = $1 AND business_id = $2`,
    [req.params.id, req.business.id]);
  const appt = a.rows[0];
  if (!appt) return bad(res, 'Cita no encontrada', 404);

  const { status, start_iso } = req.body || {};

  if (start_iso) {   // reagendar
    const starts = new Date(start_iso);
    if (isNaN(starts)) return bad(res, 'Horario inválido');
    try {
      await db.query(`UPDATE appointments SET starts_at = $1, ends_at = $2 WHERE id = $3`,
        [starts, new Date(starts.getTime() + appt.duration_min * 60_000), appt.id]);
    } catch (e) {
      if (e.code === '23P01') return bad(res, 'Choca con otra cita de ese profesional', 409);
      throw e;
    }
  }

  if (status) {
    if (!['completed','no_show','cancelled_business','confirmed'].includes(status)) return bad(res, 'Estado inválido');
    await db.query(`UPDATE appointments SET status = $1::appointment_status,
        cancelled_at = CASE WHEN $1::appointment_status = 'cancelled_business' THEN now() ELSE cancelled_at END
      WHERE id = $2`, [status, appt.id]);
    if (status === 'completed') {
      await db.query(`UPDATE clients SET total_visits = total_visits + 1,
          total_spent_cents = total_spent_cents + $2, last_visit_at = now() WHERE id = $1`,
        [appt.client_id, appt.price_cents]);
      // Registrar el pago de la cita (precio + propina) si se indicó método.
      // Evita duplicar si ya existe un pago 'balance' para esta cita.
      const method = ['cash','ath_movil','card'].includes(req.body?.payment_method) ? req.body.payment_method : null;
      if (method) {
        const tip = Number.isInteger(req.body?.tip_cents) && req.body.tip_cents >= 0 && req.body.tip_cents <= 100000000
          ? req.body.tip_cents : 0;
        const exists = await db.query(
          `SELECT 1 FROM payments WHERE appointment_id = $1 AND kind = 'balance' LIMIT 1`, [appt.id]);
        if (!exists.rows[0]) {
          await db.query(
            `INSERT INTO payments (business_id, appointment_id, client_id, kind, method, amount_cents, tip_cents, status, paid_at)
             VALUES ($1, $2, $3, 'balance', $4::payment_method, $5, $6, 'paid', now())`,
            [req.business.id, appt.id, appt.client_id, method, appt.price_cents, tip]);
        }
      }
    }
    if (status === 'no_show')
      await db.query(`UPDATE clients SET no_show_count = no_show_count + 1 WHERE id = $1`, [appt.client_id]);
  }
  await audit(req, 'appointment.update', 'appointment', appt.id, { status, rescheduled: !!start_iso });
  res.json({ ok: true });
}));

// Confirmar depósito ATH manualmente (el dueño vio el pago en su app ATH)
app.patch('/api/payments/:id/confirm', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const { rows } = await db.query(
    `UPDATE payments SET status = 'paid', paid_at = now()
      WHERE id = $1 AND business_id = $2 AND status = 'pending'
      RETURNING appointment_id`, [req.params.id, req.business.id]);
  if (!rows[0]) return bad(res, 'Pago no encontrado', 404);
  if (rows[0].appointment_id)
    await db.query(`UPDATE appointments SET status = 'confirmed'
      WHERE id = $1 AND status = 'pending_deposit'`, [rows[0].appointment_id]);
  await audit(req, 'payment.confirm', 'payment', req.params.id);
  res.json({ ok: true });
}));

// KPIs del día (el panel del demo)
app.get('/api/dashboard/today', authRequired, businessScope, asyncH(async (req, res) => {
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' });
  const { start, end } = dayBounds(date);
  const [appts, msgs, deps] = await Promise.all([
    db.query(`SELECT count(*) FILTER (WHERE status <> 'cancelled_client' AND status <> 'cancelled_business')::int AS citas,
                     count(*) FILTER (WHERE source = 'walk_in')::int AS walkins,
                     count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
                     COALESCE(sum(price_cents) FILTER (WHERE status = 'completed'),0)::int AS ingresos_cents
       FROM appointments WHERE business_id = $1 AND starts_at BETWEEN $2 AND $3`, [req.business.id, start, end]),
    db.query(`SELECT count(*)::int n FROM message_log
       WHERE business_id = $1 AND channel = 'whatsapp' AND status IN ('sent','delivered')
         AND created_at BETWEEN $2 AND $3`, [req.business.id, start, end]),
    db.query(`SELECT COALESCE(sum(amount_cents),0)::int n FROM payments
       WHERE business_id = $1 AND kind = 'deposit' AND status = 'paid'
         AND paid_at BETWEEN $2 AND $3`, [req.business.id, start, end]),
  ]);
  res.json({ date, ...appts.rows[0], whatsapp_enviados: msgs.rows[0].n, depositos_cents: deps.rows[0].n });
}));

// CRM
app.get('/api/clients', authRequired, businessScope, asyncH(async (req, res) => {
  const vals = [req.business.id];
  let where = '';
  if (isStr(req.query.q, 80)) { vals.push(req.query.q.trim()); where = ` AND (full_name % $2 OR phone LIKE '%' || $2 || '%')`; }
  const { rows } = await db.query(
    `SELECT id, full_name, phone, email, notes, no_show_count, total_visits, total_spent_cents,
            last_visit_at, is_blocked
       FROM clients WHERE business_id = $1 ${where}
      ORDER BY last_visit_at DESC NULLS LAST LIMIT 50`, vals);
  res.json({ clients: rows });
}));

// Perfil completo de un cliente: info + citas próximas/previas + gift cards + lealtad
app.get('/api/clients/:id', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const c = await db.query(
    `SELECT id, full_name, phone, email, notes, no_show_count, total_visits,
            total_spent_cents, last_visit_at, is_blocked, created_at
       FROM clients WHERE id = $1 AND business_id = $2`, [req.params.id, req.business.id]);
  if (!c.rows[0]) return bad(res, 'Cliente no encontrado', 404);
  const client = c.rows[0];

  const [upcoming, past, gifts, loyalty] = await Promise.all([
    // Próximas: citas vivas a futuro
    db.query(
      `SELECT a.id, a.starts_at, a.status, a.service_name, a.price_cents, a.confirmation_code,
              st.display_name AS staff_name
         FROM appointments a LEFT JOIN staff st ON st.id = a.staff_id
        WHERE a.client_id = $1 AND a.business_id = $2
          AND a.status = ANY($3) AND a.starts_at >= now()
        ORDER BY a.starts_at ASC`, [client.id, req.business.id, ALIVE]),
    // Previas: ya pasaron o quedaron cerradas (completed/no_show/cancelled)
    db.query(
      `SELECT a.id, a.starts_at, a.status, a.service_name, a.price_cents,
              st.display_name AS staff_name
         FROM appointments a LEFT JOIN staff st ON st.id = a.staff_id
        WHERE a.client_id = $1 AND a.business_id = $2
          AND (a.starts_at < now() OR a.status IN ('completed','no_show','cancelled_client','cancelled_business'))
        ORDER BY a.starts_at DESC LIMIT 20`, [client.id, req.business.id]),
    // Gift cards ligadas por email (la tabla no tiene client_id)
    client.email
      ? db.query(
          `SELECT code, balance_cents, initial_cents, status, expires_at, created_at,
                  (recipient_email = $2) AS is_recipient
             FROM gift_cards
            WHERE business_id = $1 AND (purchaser_email = $2 OR recipient_email = $2)
            ORDER BY created_at DESC`, [req.business.id, client.email])
      : Promise.resolve({ rows: [] }),
    // Progreso de lealtad del cliente (si el negocio tiene programa)
    db.query(
      `SELECT lp.visits_required, lp.reward_text, lp.is_active,
              COALESCE(pr.current_count,0)    AS current_count,
              COALESCE(pr.rewards_earned,0)   AS rewards_earned,
              COALESCE(pr.rewards_redeemed,0) AS rewards_redeemed
         FROM loyalty_programs lp
         LEFT JOIN loyalty_progress pr ON pr.business_id = lp.business_id AND pr.client_id = $2
        WHERE lp.business_id = $1`, [req.business.id, client.id]),
  ]);

  res.json({
    client,
    upcoming: upcoming.rows,
    past: past.rows,
    gift_cards: gifts.rows,
    loyalty: loyalty.rows[0] || null,
  });
}));

app.patch('/api/clients/:id', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  const allowed = ['full_name','email','notes','is_blocked'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return bad(res, 'Nada que actualizar');
  vals.push(req.params.id, req.business.id);
  const { rows } = await db.query(
    `UPDATE clients SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND business_id = $${vals.length} RETURNING id`, vals);
  if (!rows[0]) return bad(res, 'Cliente no encontrado', 404);
  res.json({ ok: true });
}));

// Notificaciones in-app
app.get('/api/notifications', authRequired, businessScope, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, type, title, body, data, read_at, created_at FROM notifications
      WHERE business_id = $1 ORDER BY created_at DESC LIMIT 40`, [req.business.id]);
  const unread = rows.filter(r => !r.read_at).length;
  res.json({ unread, notifications: rows });
}));
app.patch('/api/notifications/read-all', authRequired, businessScope, asyncH(async (req, res) => {
  await db.query(`UPDATE notifications SET read_at = now() WHERE business_id = $1 AND read_at IS NULL`, [req.business.id]);
  res.json({ ok: true });
}));
app.patch('/api/notifications/:id/read', authRequired, businessScope, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) return bad(res, 'ID inválido');
  await db.query(`UPDATE notifications SET read_at = now() WHERE id = $1 AND business_id = $2`,
    [req.params.id, req.business.id]);
  res.json({ ok: true });
}));

// Mi suscripción + referidos
app.get('/api/subscription', authRequired, businessScope, asyncH(async (req, res) => {
  const [sub, ref] = await Promise.all([
    db.query(`SELECT s.plan_code, s.cycle, s.status, s.current_period_end, p.price_monthly_cents
       FROM subscriptions s JOIN plans p ON p.code = s.plan_code WHERE s.business_id = $1`, [req.business.id]),
    db.query(`SELECT COALESCE(active_referrals,0) AS active_referrals, COALESCE(discount_cents,0) AS discount_cents
       FROM (SELECT 1) x LEFT JOIN v_referral_discounts v ON v.business_id = $1`, [req.business.id]),
  ]);
  const s = sub.rows[0], r = ref.rows[0];
  const price = s.price_monthly_cents;
  res.json({
    plan: s.plan_code, cycle: s.cycle, status: s.status,
    referral_code: req.business.referral_code,
    active_referrals: r.active_referrals,
    discount_cents: Math.min(r.discount_cents, price),
    effective_monthly_cents: Math.max(price - r.discount_cents, 0),
  });
}));

// ============================================================================
//  WORKER — recordatorios + despacho WhatsApp/Email
// ============================================================================
const fmtPR = d => new Date(d).toLocaleString('es-PR',
  { timeZone: 'America/Puerto_Rico', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true });

function buildMessage(template, ctx) {
  const { biz, appt } = ctx;
  const when = appt?.starts_at ? fmtPR(appt.starts_at) : '';
  switch (template) {
    case 'confirm':
      return `✅ *${biz.name}*\nTu cita quedó ${appt.status === 'pending_deposit' ? 'reservada (pendiente de depósito)' : 'confirmada'}:\n\n💈 ${appt.service_name}\n🗓 ${when}\n🎟 Código: ${appt.confirmation_code}\n\n${appt.status === 'pending_deposit' && biz.ath_phone ? `Para confirmar, envía el depósito de $${(appt.deposit_cents / 100).toFixed(2)} por ATH Móvil a ${biz.ath_phone} y responde con tu referencia.\n\n` : ''}Para cancelar o mover tu cita, responde a este mensaje.`;
    case 'reminder_48h':
      return `📅 *${biz.name}*\nTu cita es en 2 días:\n\n💈 ${appt.service_name}\n🗓 ${when}\n\nSi necesitas mover la fecha, este es buen momento para avisarnos. Responde aquí.`;
    case 'reminder_24h':
      return `⏰ *Recordatorio — ${biz.name}*\nTu cita es mañana:\n\n💈 ${appt.service_name}\n🗓 ${when}\n\nSi no puedes llegar, avísanos respondiendo aquí. 🙏`;
    case 'reminder_1h':
      return `🔔 *${biz.name}*\n¡Te esperamos en 1 hora!\n\n💈 ${appt.service_name}\n🗓 ${when}\n📍 ${biz.address_line || ''}`;
    case 'reminder_2h':
      return `🔔 *${biz.name}*\n¡Te esperamos en 2 horas!\n\n💈 ${appt.service_name}\n🗓 ${when}\n📍 ${biz.address_line || ''}`;
    case 'manual_assign':
      return `✅ *${biz.name}*\n¡Te conseguimos turno!\n\n💈 ${appt.service_name}\n🗓 ${when}\n🎟 ${appt.confirmation_code}\n\nNos vemos. Si no puedes, avísanos respondiendo aquí.`;
    case 'waitlist_offer':
      return `⚡ *${biz.name} — ¡se liberó un cupo!*\nTienes *30 minutos* para tomarlo antes de que pase al siguiente.\n\nConfirma aquí: responde *SÍ* para quedártelo. Tu cita actual no se toca hasta que confirmes.`;
    case 'due_reminder':
      return `👋 *${biz.name}*\n¿Listo para tu próxima visita? Ya va siendo hora.\n\nReserva tu turno cuando quieras — aquí mismo. 💈`;
    default:
      return `${biz.name}: actualización de tu cita${appt?.confirmation_code ? ' ' + appt.confirmation_code : ''}`;
  }
}

async function sendWhatsApp(phone, text) {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return { skipped: true };
  const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
    body: JSON.stringify({ number: phone.replace('+', ''), textMessage: { text } }),
  });
  if (!r.ok) throw new Error(`Evolution ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return { id: j?.key?.id || null };
}

async function sendEmail(to, subject, text, html) {
  if (!RESEND_API_KEY) return { skipped: true };
  const payload = { from: EMAIL_FROM, to: [to], subject, text };
  if (html) payload.html = html;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return { id: j?.id || null };
}

// Plantilla base de emails (marca Bukeame, sin emojis)
// innerHtml: contenido (filas <tr>). opts.preheader: texto de vista previa en el inbox.
// opts.footerNote: línea final del pie (por defecto, la de cuenta).
function emailShell(innerHtml, opts = {}) {
  const preheader = opts.preheader || 'Bukeame — Tu turno, sin llamadas.';
  const footerNote = opts.footerNote || 'Recibiste este correo porque creaste una cuenta en bukeame.com';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head><body style="margin:0;padding:0;background:#F1EFE5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#F1EFE5">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1EFE5;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #E1DCCD;border-radius:18px;overflow:hidden;box-shadow:0 1px 3px rgba(23,21,15,.06)">
        <tr><td style="height:4px;background:#0E8074;line-height:4px;font-size:4px">&nbsp;</td></tr>
        <tr><td style="padding:26px 30px 22px 30px;border-bottom:1px solid #EFEADC">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:25px;font-weight:800;letter-spacing:-.02em;color:#17150F;line-height:1">Buk<span style="color:#0E8074">e</span>ame</td>
            <td style="padding-left:12px"><span style="display:inline-block;height:14px;width:1px;background:#D8D2C0;vertical-align:middle"></span></td>
            <td style="padding-left:12px;font-size:12px;color:#0A5B52;font-weight:600;letter-spacing:.01em;vertical-align:middle">Tu turno, sin llamadas</td>
          </tr></table>
        </td></tr>
        ${innerHtml}
        <tr><td style="padding:22px 30px 26px 30px;border-top:1px solid #EFEADC;background:#FBFAF5">
          <p style="margin:0 0 4px 0;font-size:12px;color:#17150F;font-weight:700">Buk<span style="color:#0E8074">e</span>ame</p>
          <p style="margin:0;font-size:12px;color:#7A7464;line-height:1.6">${footerNote}<br><a href="https://bukeame.com" style="color:#0A5B52;text-decoration:none">bukeame.com</a></p>
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px"><tr><td style="padding:14px 30px 0 30px;text-align:center"><p style="margin:0;font-size:11px;color:#A39C88;line-height:1.5">Bukeame, San Juan, Puerto Rico</p></td></tr></table>
    </td></tr>
  </table></body></html>`;
}

function emailWelcome(name) {
  const first = (name || '').trim().split(' ')[0] || 'Hola';
  const subject = 'Bienvenido a Bukeame';
  const text = `Hola ${first},\n\nTu cuenta en Bukeame ya está activa. El próximo paso es crear tu negocio para empezar a recibir citas.\n\nEntra aquí: https://bukeame.com/panel.html\n\n— El equipo de Bukeame`;
  const html = emailShell(`
    <tr><td style="padding:28px 30px 30px 30px">
      <h1 style="margin:0 0 12px 0;font-size:22px;font-weight:800;color:#17150F;line-height:1.3;letter-spacing:-.01em">Hola ${first}, tu cuenta ya está activa</h1>
      <p style="margin:0 0 22px 0;font-size:15px;color:#5E594B;line-height:1.6">El próximo paso es crear tu negocio. Configura tus servicios, tu horario y empieza a recibir citas sin llamadas ni mensajes de ida y vuelta.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#0E8074">
        <a href="https://bukeame.com/panel.html" style="display:inline-block;background:#0E8074;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:12px">Crear mi negocio</a>
      </td></tr></table>
    </td></tr>`, { preheader: 'Tu cuenta en Bukeame ya está activa. Crea tu negocio para empezar a recibir citas.' });
  return { subject, text, html };
}

function emailReset(name, link) {
  const first = (name || '').trim().split(' ')[0] || 'Hola';
  const subject = 'Restablece tu contraseña de Bukeame';
  const text = `Hola ${first},\n\nRecibimos una solicitud para restablecer tu contraseña. Abre este enlace (válido por 1 hora):\n\n${link}\n\nSi no fuiste tú, ignora este correo: tu contraseña sigue igual.\n\n— El equipo de Bukeame`;
  const html = emailShell(`
    <tr><td style="padding:28px 30px 30px 30px">
      <h1 style="margin:0 0 12px 0;font-size:22px;font-weight:800;color:#17150F;line-height:1.3;letter-spacing:-.01em">Hola ${first}, restablece tu contraseña</h1>
      <p style="margin:0 0 22px 0;font-size:15px;color:#5E594B;line-height:1.6">Recibimos una solicitud para cambiar la contraseña de tu cuenta. Este enlace es válido por 1 hora.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#0E8074">
        <a href="${link}" style="display:inline-block;background:#0E8074;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:12px">Crear nueva contraseña</a>
      </td></tr></table>
      <p style="margin:22px 0 0 0;font-size:13px;color:#7A7464;line-height:1.6;padding-top:18px;border-top:1px solid #EFEADC">Si no fuiste tú, ignora este correo. Tu contraseña sigue igual.</p>
    </td></tr>`, { preheader: 'Enlace para restablecer tu contraseña de Bukeame (válido por 1 hora).' });
  return { subject, text, html };
}

function emailVerify(name, link) {
  const first = (name || '').trim().split(' ')[0] || 'Hola';
  const subject = 'Verifica tu email — Bukeame';
  const text = `Hola ${first},\n\nGracias por crear tu cuenta en Bukeame. Verifica tu email para activar tu cuenta (y tu prueba Pro si te refirieron). Abre este enlace (válido por 24 horas):\n\n${link}\n\nSi no creaste esta cuenta, ignora este correo.\n\n— El equipo de Bukeame`;
  const html = emailShell(`
    <tr><td style="padding:28px 30px 30px 30px">
      <h1 style="margin:0 0 12px 0;font-size:22px;font-weight:800;color:#17150F;line-height:1.3;letter-spacing:-.01em">Hola ${first}, verifica tu email</h1>
      <p style="margin:0 0 22px 0;font-size:15px;color:#5E594B;line-height:1.6">Confirma tu correo para activar tu cuenta de Bukeame. Si un negocio te refirió, al verificar se activa tu prueba de 15 días del plan Pro.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#0E8074">
        <a href="${link}" style="display:inline-block;background:#0E8074;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:12px">Verificar mi email</a>
      </td></tr></table>
      <p style="margin:22px 0 0 0;font-size:13px;color:#7A7464;line-height:1.6;padding-top:18px;border-top:1px solid #EFEADC">Este enlace es válido por 24 horas. Si no creaste esta cuenta, ignora este correo.</p>
    </td></tr>`, { preheader: 'Verifica tu email para activar tu cuenta de Bukeame.' });
  return { subject, text, html };
}

// Email HTML elegante para confirmaciones y recordatorios de cita
function emailAppt(template, ctx) {
  const { biz, appt } = ctx;
  const when = appt?.starts_at ? fmtPR(appt.starts_at) : '';
  const svc  = appt?.service_name || 'tu servicio';
  const code = appt?.confirmation_code || '';
  const addr = biz?.address_line || '';
  let title, intro, extra = '';
  switch (template) {
    case 'confirm':
      title = appt.status === 'pending_deposit' ? 'Tu cita está reservada' : 'Tu cita está confirmada';
      intro = appt.status === 'pending_deposit'
        ? 'Tu cita quedó reservada, pendiente de depósito.'
        : 'Tu cita quedó confirmada. Te esperamos.';
      if (appt.status === 'pending_deposit' && biz.ath_phone)
        extra = `Para confirmar, envía el depósito de $${(appt.deposit_cents / 100).toFixed(2)} por ATH Móvil a ${biz.ath_phone} y responde con tu referencia.`;
      break;
    case 'reminder_48h':
      title = 'Tu cita es en 2 días';
      intro = 'Si necesitas mover la fecha, este es buen momento para avisarle al negocio.';
      break;
    case 'reminder_24h':
      title = 'Tu cita es mañana';
      intro = 'Si no puedes llegar, avísale al negocio respondiendo a este correo o por WhatsApp.';
      break;
    case 'reminder_1h':
      title = 'Tu cita es en 1 hora';
      intro = 'Te esperamos. ¡Nos vemos pronto!';
      break;
    case 'manual_assign':
      title = 'Te conseguimos turno';
      intro = 'Si no puedes llegar, avísale al negocio respondiendo aquí.';
      break;
    default:
      title = 'Actualización de tu cita';
      intro = '';
  }
  const subject = `${title} — ${biz.name}`;
  const rowsArr = [
    ['Servicio', svc],
    ['Fecha', when],
    code ? ['Código', code] : null,
    addr ? ['Lugar', addr] : null,
  ].filter(Boolean);
  const rowsHtml = rowsArr.map(([k, v], i) =>
    `<tr><td style="padding:9px 0;font-size:12px;color:#7A7464;width:76px;vertical-align:top;${i ? 'border-top:1px solid #EFEADC' : ''}">${k}</td><td style="padding:9px 0;font-size:14px;font-weight:600;color:#17150F;${i ? 'border-top:1px solid #EFEADC' : ''}">${v}</td></tr>`
  ).join('');
  const html = emailShell(`
    <tr><td style="padding:28px 30px 30px 30px">
      <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:800;color:#17150F;line-height:1.3;letter-spacing:-.01em">${title}</h1>
      <p style="margin:0 0 20px 0;font-size:14px;color:#0A5B52;font-weight:600">${biz.name}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBFAF5;border:1px solid #E1DCCD;border-radius:14px;margin-bottom:18px">
        <tr><td style="padding:6px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table></td></tr>
      </table>
      ${intro ? `<p style="margin:0;font-size:14px;color:#5E594B;line-height:1.6">${intro}</p>` : ''}
      ${extra ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#FCF3E3;border:1px solid #F0D9AE;border-radius:12px"><tr><td style="padding:14px 16px;border-left:3px solid #EFA12F"><p style="margin:0;font-size:14px;color:#17150F;line-height:1.6;font-weight:600">${extra}</p></td></tr></table>` : ''}
    </td></tr>`, {
      preheader: `${title} — ${biz.name}${when ? ' · ' + when : ''}`,
      footerNote: `Recibiste este correo de ${biz.name} a través de Bukeame. Si no esperabas esta cita, puedes ignorarlo.`,
    });
  const text = buildMessage(template, ctx).replace(/\*/g, '');
  return { subject, text, html };
}

// Encola recordatorios 24h y 2h (idempotente: marca la cita)
async function queueReminders() {
  for (const [col, tpl, from, to] of [
    ['reminder_48h_sent_at', 'reminder_48h', 47.5, 48.5],
    ['reminder_24h_sent_at', 'reminder_24h', 23.5, 24.5],
    ['reminder_1h_sent_at',  'reminder_1h',   0.5,  1.5],
  ]) {
    const { rows } = await db.query(
      `UPDATE appointments a SET ${col} = now()
        FROM clients c
       WHERE c.id = a.client_id AND a.status = 'confirmed' AND a.${col} IS NULL
         AND a.starts_at BETWEEN now() + ($1 || ' hours')::interval
                              AND now() + ($2 || ' hours')::interval
       RETURNING a.id, a.business_id, c.phone, c.email`, [from, to]);
    for (const r of rows) {
      await db.query(
        `INSERT INTO message_log (business_id, appointment_id, channel, recipient, template)
         VALUES ($1,$2,'whatsapp',$3,$4)`, [r.business_id, r.id, r.phone, tpl]);
      if (r.email)
        await db.query(
          `INSERT INTO message_log (business_id, appointment_id, channel, recipient, template)
           VALUES ($1,$2,'email',$3,$4)`, [r.business_id, r.id, r.email, tpl]);
    }
  }
}

// Despacha lo queued (máx 20 por ciclo, con reintento implícito al quedar queued)
async function dispatchMessages() {
  const { rows } = await db.query(
    `SELECT m.id, m.channel, m.recipient, m.template, m.appointment_id,
            a.starts_at, a.service_name, a.confirmation_code, a.status, a.deposit_cents,
            b.name, b.ath_phone, b.address_line
       FROM message_log m
       LEFT JOIN appointments a ON a.id = m.appointment_id
       JOIN businesses b ON b.id = m.business_id
      WHERE m.status = 'queued'
      ORDER BY m.created_at LIMIT 20`);
  for (const m of rows) {
    const ctx = {
      biz: { name: m.name, ath_phone: m.ath_phone, address_line: m.address_line },
      appt: m,
    };
    try {
      let out;
      if (m.channel === 'whatsapp') {
        out = await sendWhatsApp(m.recipient, buildMessage(m.template, ctx));
      } else {
        const e = emailAppt(m.template, ctx);
        out = await sendEmail(m.recipient, e.subject, e.text, e.html);
      }
      if (out.skipped) continue;   // proveedor sin configurar: se queda queued
      await db.query(`UPDATE message_log SET status = 'sent', sent_at = now(), provider_ref = $2 WHERE id = $1`,
        [m.id, out.id || null]);
    } catch (e) {
      await db.query(`UPDATE message_log SET status = 'failed', error = $2 WHERE id = $1`,
        [m.id, e.message.slice(0, 200)]);
    }
  }
}

setInterval(() => { queueReminders().catch(e => console.error('reminders:', e.message)); }, 60_000);
setInterval(() => { dispatchMessages().catch(e => console.error('dispatch:', e.message)); }, 20_000);

// ============================================================================
//  ESQUEMA v11 (config jsonb en payment_providers + auth_provider/google_sub/
//  apple_sub en users) → se aplica con `database/11-schema-pagos-login-social.sql`
//  corrido como postgres. NO se auto-migra al arranque: el rol de la app
//  (bukeame_user) no es dueño de las tablas ni tiene permisos DDL ("must be owner").
// ============================================================================

// ============================================================================
//  MÓDULOS v1.1 (revenue + fidelización)
//  Se montan ANTES del catch-all 404 para que sus rutas resuelvan.
// ============================================================================
const sharedHelpers = {
  asyncH, bad, isStr, isUuid, isEmail, isPhone, normPhone, isDate, audit, notify,
  confirmCode, bookingLimiter, codeLimiter, publicLimiter,
};
try {
  require('./module-revenue').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
  const loyalty = require('./module-loyalty');
  loyalty.mount(app, { db, authRequired, businessScope, h: sharedHelpers });
  loyalty.startWorkers({ db, h: sharedHelpers });
  require('./module-admin').mount(app, { db, authRequired, h: sharedHelpers });
  require('./module-accounting').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
  require('./module-account').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
  require('./module-payments').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
} catch (e) {
  console.error('⚠ Error montando módulos v1.1:', e.message);
}

// ============================================================================
//  SALUD + ERRORES
// ============================================================================
app.get('/api/health', asyncH(async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true, service: 'bukeame-api', ts: new Date().toISOString() });
}));

app.use((req, res) => bad(res, 'Ruta no encontrada', 404));

app.use((err, _req, res, _next) => {
  if (err.code === '23P01') return bad(res, 'Ese turno acaba de ser tomado. Escoge otro.', 409);
  if (err.code === '23505') return bad(res, 'Registro duplicado', 409);
  if (err.type === 'entity.parse.failed') return bad(res, 'JSON inválido', 400);
  // Instrumentación: ruta + stack para ubicar errores 500 (ej. el enum payment_status).
  console.error(`[${_req.method} ${_req.originalUrl}]`, err.stack || err.message);
  bad(res, 'Error interno. Intenta de nuevo.', 500);
});

app.listen(PORT, '127.0.0.1', () =>
  console.log(`🟢 bukeame-api en http://127.0.0.1:${PORT} (${NODE_ENV})`));
