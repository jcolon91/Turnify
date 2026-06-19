// ============================================================================
//  BOOKÉA API — server.js v1.0
//  Express :3001 · PostgreSQL "turnify" · Aislado de wifnix-api (:3000) — totalmente aislado
// ----------------------------------------------------------------------------
//  DEPLOY (VPS 2.24.70.107):
//    mkdir -p /var/www/turnify && cd /var/www/turnify
//    wget <raw github>/server.js <raw>/package.json <raw>/.env.example
//    cp .env.example .env && nano .env        # llena secretos
//    npm install --omit=dev
//    node --check server.js
//    pm2 start server.js --name turnify-api --max-memory-restart 300M
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
  EMAIL_FROM = 'Turnify <citas@turnifypr.com>',
  NODE_ENV = 'production',
} = process.env;

if (!DATABASE_URL || !JWT_SECRET) {
  console.error('FALTA DATABASE_URL o JWT_SECRET en .env'); process.exit(1);
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
app.use(express.json({ limit: '1mb' }));

// --- Uploads (logos de negocios) ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LOGO_DIR   = path.join(UPLOAD_DIR, 'logos');
const COVER_DIR  = path.join(UPLOAD_DIR, 'covers');
try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch (e) { /* ya existe */ }
try { fs.mkdirSync(COVER_DIR, { recursive: true }); } catch (e) { /* ya existe */ }
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
app.use(cors({ origin: origins.length ? origins : true, credentials: false }));

app.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));
const authLimiter   = rateLimit({ windowMs: 15 * 60_000, max: 20,  message: { error: 'Demasiados intentos. Espera 15 minutos.' } });
const publicLimiter = rateLimit({ windowMs: 60_000,      max: 60,  message: { error: 'Vas muy rápido. Intenta en un minuto.' } });

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad    = (res, msg, code = 400) => res.status(code).json({ error: msg });
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

const isStr   = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isPhone = v => typeof v === 'string' && /^\+?[0-9\s\-().]{10,17}$/.test(v);
const normPhone = v => {
  const d = String(v).replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;          // 7871234567 → +17871234567
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return '+' + d;
};
const isEmail = v => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
const isUuid  = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const isDate  = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime  = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

const slugify = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function genReferralCode(name) {
  const base = slugify(name).replace(/-/g, '').slice(0, 10).toUpperCase() || 'BOOKEA';
  return base + '-' + crypto.randomInt(100, 999);
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
  if (phone && !isPhone(phone)) return bad(res, 'Teléfono inválido');

  const hash = await bcrypt.hash(password, 12);
  let user;
  try {
    const { rows } = await db.query(
      `INSERT INTO users (full_name, email, phone, password_hash)
       VALUES ($1,$2,$3,$4) RETURNING id, full_name, email, is_platform_admin`,
      [full_name.trim(), email.toLowerCase(), phone ? normPhone(phone) : null, hash]);
    user = rows[0];
  } catch (e) {
    if (e.code === '23505') return bad(res, 'Ese email o teléfono ya está registrado', 409);
    throw e;
  }
  const refresh = await issueRefresh(user.id, req);
  // Email de bienvenida (no bloquea el registro si Resend falla)
  try {
    const w = emailWelcome(user.full_name);
    sendEmail(user.email, w.subject, w.text, w.html).catch(e => console.error('welcome email:', e.message));
  } catch (e) { console.error('welcome email build:', e.message); }
  res.status(201).json({ user, access_token: signAccess(user), refresh_token: refresh });
}));

app.post('/api/auth/login', authLimiter, asyncH(async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || !isStr(password, 100)) return bad(res, 'Credenciales inválidas', 401);
  const { rows } = await db.query(
    `SELECT id, full_name, email, password_hash, is_platform_admin
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
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
      [u.id, sha256(token), exp]);
    const link = `https://turnifypr.com/reset.html?token=${token}`;
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

app.post('/api/auth/refresh', authLimiter, asyncH(async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!isStr(refresh_token, 200)) return bad(res, 'Refresh token requerido', 401);
  const { rows } = await db.query(
    `SELECT rt.id, rt.user_id, u.full_name, u.is_platform_admin
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()
        AND u.deleted_at IS NULL`, [sha256(refresh_token)]);
  const t = rows[0];
  if (!t) return bad(res, 'Sesión expirada, entra de nuevo', 401);
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

// ============================================================================
//  RUTAS — ONBOARDING Y PERFIL DEL NEGOCIO (100% editable)
// ============================================================================
app.post('/api/businesses', authRequired, asyncH(async (req, res) => {
  const b = req.body || {};
  if (!isStr(b.name, 120)) return bad(res, 'Nombre del negocio requerido');
  if (!b.accept_terms)     return bad(res, 'Debes aceptar los términos y condiciones');

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
    //  · Con referido válido → 15 días de prueba del plan Pro (trialing)
    //  · Sin referido        → plan free normal
    if (referrer) {
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
      await sharp(req.file.buffer)
        .resize(800, 800, { fit: 'cover', position: 'centre' })
        .webp({ quality: 85 })
        .toFile(filepath);
    } catch (e) {
      return bad(res, 'La imagen no se pudo procesar. Prueba con otra.');
    }
    const logoUrl = `/uploads/logos/${filename}`;
    // Borrar el logo anterior si era un archivo nuestro
    const prev = req.business.logo_url;
    if (prev && prev.startsWith('/uploads/logos/')) {
      const prevPath = path.join(__dirname, prev.replace(/^\//, ''));
      fs.unlink(prevPath, () => {});   // silencioso si no existe
    }
    const { rows } = await db.query(
      `UPDATE businesses SET logo_url = $1 WHERE id = $2 RETURNING *`, [logoUrl, req.business.id]);
    await audit(req, 'business.logo', 'business', req.business.id, {});
    res.json({ business: rows[0], logo_url: logoUrl });
  }));

// Quitar el logo del negocio
app.delete('/api/businesses/me/logo', authRequired, businessScope, asyncH(async (req, res) => {
  const prev = req.business.logo_url;
  if (prev && prev.startsWith('/uploads/logos/')) {
    const prevPath = path.join(__dirname, prev.replace(/^\//, ''));
    fs.unlink(prevPath, () => {});
  }
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
      await sharp(req.file.buffer)
        .resize(1600, 400, { fit: 'cover', position: 'centre' })
        .webp({ quality: 84 })
        .toFile(filepath);
    } catch (e) {
      return bad(res, 'La imagen no se pudo procesar. Prueba con otra.');
    }
    const coverUrl = `/uploads/covers/${filename}`;
    const prev = req.business.cover_url;
    if (prev && prev.startsWith('/uploads/covers/')) {
      const prevPath = path.join(__dirname, prev.replace(/^\//, ''));
      fs.unlink(prevPath, () => {});
    }
    const { rows } = await db.query(
      `UPDATE businesses SET cover_url = $1 WHERE id = $2 RETURNING *`, [coverUrl, req.business.id]);
    await audit(req, 'business.cover', 'business', req.business.id, {});
    res.json({ business: rows[0], cover_url: coverUrl });
  }));

// Quitar el banner con imagen (vuelve al patrón predefinido)
app.delete('/api/businesses/me/cover', authRequired, businessScope, asyncH(async (req, res) => {
  const prev = req.business.cover_url;
  if (prev && prev.startsWith('/uploads/covers/')) {
    const prevPath = path.join(__dirname, prev.replace(/^\//, ''));
    fs.unlink(prevPath, () => {});
  }
  const { rows } = await db.query(
    `UPDATE businesses SET cover_url = NULL WHERE id = $1 RETURNING *`, [req.business.id]);
  await audit(req, 'business.cover.delete', 'business', req.business.id, {});
  res.json({ business: rows[0] });
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
      ORDER BY b.is_featured DESC, ${rank} DESC NULLS LAST, b.rating_count DESC
      LIMIT 30`, vals);
  res.json({ results: rows });
}));

// Perfil público (la página SEO turnifypr.com/<slug>)
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

  const [services, staff, hours, reviews] = await Promise.all([
    db.query(`SELECT id, name, description, duration_min, price_cents, deposit_cents, photo_url, is_featured
              FROM services WHERE business_id = $1 AND is_active AND deleted_at IS NULL
              ORDER BY is_featured DESC, sort_order`, [biz.id]),
    db.query(`SELECT id, display_name, bio, avatar_url, specialties, rating_avg, rating_count
              FROM staff WHERE business_id = $1 AND is_active AND deleted_at IS NULL ORDER BY sort_order`, [biz.id]),
    db.query(`SELECT day_of_week, opens, closes FROM business_hours WHERE business_id = $1 ORDER BY day_of_week, opens`, [biz.id]),
    db.query(`SELECT r.rating, r.comment, r.business_reply, r.created_at, c.full_name
              FROM reviews r JOIN clients c ON c.id = r.client_id
              WHERE r.business_id = $1 AND r.is_published ORDER BY r.created_at DESC LIMIT 10`, [biz.id]),
  ]);
  res.json({ business: biz, services: services.rows, staff: staff.rows, hours: hours.rows, reviews: reviews.rows });
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
app.post('/api/public/:slug/appointments', publicLimiter, asyncH(async (req, res) => {
  const { service_id, staff_id, start_iso, full_name, phone, email, client_notes, payment_method } = req.body || {};
  // service_id puede ser uno (string) o varios (array). Normalizamos a lista.
  const serviceIds = (Array.isArray(service_id) ? service_id : String(service_id || '').split(','))
    .map(s => String(s).trim()).filter(isUuid);
  if (!serviceIds.length) return bad(res, 'Servicio requerido');
  if (!isStr(full_name, 120)) return bad(res, 'Tu nombre es requerido');
  if (!isPhone(phone)) return bad(res, 'Tu WhatsApp es requerido para el recordatorio');
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
    const code = (biz.slug.replace(/[^a-z]/g, '').slice(0, 2).toUpperCase() || 'BK') + '-' +
      String(starts.getMonth() + 1).padStart(2, '0') + String(starts.getDate()).padStart(2, '0') +
      '-' + crypto.randomInt(100, 999);

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
app.get('/api/public/appointments/:code', publicLimiter, asyncH(async (req, res) => {
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
app.post('/api/public/appointments/:code/ath-reference', publicLimiter, asyncH(async (req, res) => {
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
app.post('/api/public/appointments/:code/cancel', publicLimiter, asyncH(async (req, res) => {
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

// ============================================================================
//  RUTAS — AGENDA, KPIs, CLIENTES, PAGOS, NOTIFICACIONES, SUSCRIPCIÓN
// ============================================================================
app.get('/api/appointments', authRequired, businessScope, asyncH(async (req, res) => {
  const date = isDate(req.query.date)
    ? req.query.date
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' });
  const { start, end } = dayBounds(date);
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
      ORDER BY a.starts_at`, vals);
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
  const cl = await db.query(
    `INSERT INTO clients (business_id, full_name, phone)
     VALUES ($1,$2,$3)
     ON CONFLICT (business_id, phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`, [req.business.id, full_name.trim(), normPhone(phone)]);
  const code = 'WK-' + String(starts.getMonth() + 1).padStart(2, '0') +
    String(starts.getDate()).padStart(2, '0') + '-' + crypto.randomInt(100, 999);
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
    case 'reminder_24h':
      return `⏰ *Recordatorio — ${biz.name}*\nTu cita es mañana:\n\n💈 ${appt.service_name}\n🗓 ${when}\n\nSi no puedes llegar, avísanos respondiendo aquí. 🙏`;
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

// Plantilla base de emails (marca Turnify, sin emojis)
function emailShell(innerHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F1EFE5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1EFE5;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #E1DCCD;border-radius:18px;overflow:hidden">
        <tr><td style="padding:28px 28px 0 28px">
          <div style="font-size:24px;font-weight:800;letter-spacing:-.02em;color:#17150F">Turn<span style="color:#0E8074">i</span>fy</div>
        </td></tr>
        ${innerHtml}
        <tr><td style="padding:20px 28px 28px 28px;border-top:1px solid #E1DCCD">
          <p style="margin:0;font-size:12px;color:#5E594B;line-height:1.5">Turnify — Tu turno, sin llamadas.<br>Recibiste este correo porque creaste una cuenta en turnifypr.com</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function emailWelcome(name) {
  const first = (name || '').trim().split(' ')[0] || 'Hola';
  const subject = 'Bienvenido a Turnify';
  const text = `Hola ${first},\n\nTu cuenta en Turnify ya está activa. El próximo paso es crear tu negocio para empezar a recibir citas.\n\nEntra aquí: https://turnifypr.com/panel.html\n\n— El equipo de Turnify`;
  const html = emailShell(`
    <tr><td style="padding:20px 28px 0 28px">
      <h1 style="margin:0 0 10px 0;font-size:21px;font-weight:800;color:#17150F">Hola ${first}, tu cuenta ya está activa</h1>
      <p style="margin:0 0 18px 0;font-size:15px;color:#5E594B;line-height:1.6">El próximo paso es crear tu negocio. Configura tus servicios, tu horario y empieza a recibir citas sin llamadas ni mensajes de ida y vuelta.</p>
      <a href="https://turnifypr.com/panel.html" style="display:inline-block;background:#0E8074;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px">Crear mi negocio</a>
    </td></tr>`);
  return { subject, text, html };
}

function emailReset(name, link) {
  const first = (name || '').trim().split(' ')[0] || 'Hola';
  const subject = 'Restablece tu contraseña de Turnify';
  const text = `Hola ${first},\n\nRecibimos una solicitud para restablecer tu contraseña. Abre este enlace (válido por 1 hora):\n\n${link}\n\nSi no fuiste tú, ignora este correo: tu contraseña sigue igual.\n\n— El equipo de Turnify`;
  const html = emailShell(`
    <tr><td style="padding:20px 28px 0 28px">
      <h1 style="margin:0 0 10px 0;font-size:21px;font-weight:800;color:#17150F">Restablece tu contraseña</h1>
      <p style="margin:0 0 18px 0;font-size:15px;color:#5E594B;line-height:1.6">Recibimos una solicitud para cambiar la contraseña de tu cuenta. Este enlace es válido por 1 hora.</p>
      <a href="${link}" style="display:inline-block;background:#0E8074;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px">Crear nueva contraseña</a>
      <p style="margin:18px 0 0 0;font-size:13px;color:#5E594B;line-height:1.6">Si no fuiste tú, ignora este correo. Tu contraseña sigue igual.</p>
    </td></tr>`);
  return { subject, text, html };
}

// Encola recordatorios 24h y 2h (idempotente: marca la cita)
async function queueReminders() {
  for (const [col, tpl, from, to] of [
    ['reminder_24h_sent_at', 'reminder_24h', 23.5, 24.5],
    ['reminder_2h_sent_at',  'reminder_2h',  1.5,  2.5],
  ]) {
    const { rows } = await db.query(
      `UPDATE appointments a SET ${col} = now()
        FROM clients c
       WHERE c.id = a.client_id AND a.status = 'confirmed' AND a.${col} IS NULL
         AND a.starts_at BETWEEN now() + ($1 || ' hours')::interval
                              AND now() + ($2 || ' hours')::interval
       RETURNING a.id, a.business_id, c.phone`, [from, to]);
    for (const r of rows)
      await db.query(
        `INSERT INTO message_log (business_id, appointment_id, channel, recipient, template)
         VALUES ($1,$2,'whatsapp',$3,$4)`, [r.business_id, r.id, r.phone, tpl]);
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
    const text = buildMessage(m.template, {
      biz: { name: m.name, ath_phone: m.ath_phone, address_line: m.address_line },
      appt: m,
    });
    try {
      const out = m.channel === 'whatsapp'
        ? await sendWhatsApp(m.recipient, text)
        : await sendEmail(m.recipient, `Tu cita — ${m.name}`, text.replace(/\*/g, ''));
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
//  MÓDULOS v1.1 (revenue + fidelización)
//  Se montan ANTES del catch-all 404 para que sus rutas resuelvan.
// ============================================================================
const sharedHelpers = {
  asyncH, bad, isStr, isUuid, isEmail, isPhone, normPhone, isDate, audit, notify,
};
try {
  require('./module-revenue').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
  const loyalty = require('./module-loyalty');
  loyalty.mount(app, { db, authRequired, businessScope, h: sharedHelpers });
  loyalty.startWorkers({ db, h: sharedHelpers });
  require('./module-admin').mount(app, { db, authRequired, h: sharedHelpers });
  require('./module-accounting').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
  require('./module-account').mount(app, { db, authRequired, businessScope, h: sharedHelpers });
} catch (e) {
  console.error('⚠ Error montando módulos v1.1:', e.message);
}

// ============================================================================
//  SALUD + ERRORES
// ============================================================================
app.get('/api/health', asyncH(async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true, service: 'turnify-api', ts: new Date().toISOString() });
}));

app.use((req, res) => bad(res, 'Ruta no encontrada', 404));

app.use((err, _req, res, _next) => {
  if (err.code === '23P01') return bad(res, 'Ese turno acaba de ser tomado. Escoge otro.', 409);
  if (err.code === '23505') return bad(res, 'Registro duplicado', 409);
  if (err.type === 'entity.parse.failed') return bad(res, 'JSON inválido', 400);
  console.error(NODE_ENV === 'production' ? err.message : err);
  bad(res, 'Error interno. Intenta de nuevo.', 500);
});

app.listen(PORT, '127.0.0.1', () =>
  console.log(`🟢 turnify-api en http://127.0.0.1:${PORT} (${NODE_ENV})`));
