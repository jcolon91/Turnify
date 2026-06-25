// ============================================================================
//  BUKEAME · ath-rest.js — Helpers del flujo REST de ATH Móvil (Evertec),
//  PARAMETRIZADOS por publicToken (sirve para cualquier negocio o la plataforma).
//  Mismo flujo PROBADO del cobro de plataforma: create → findPayment → authorize.
//  El privateToken NO se usa aquí (solo para /refund). El que paga NO escribe su
//  número: lo SUPLE el comercio (lo pasa quien llama). Devuelve datos crudos de ATH.
// ============================================================================
const BASE = 'https://payments.athmovil.com/api/business-transaction/ecommerce';
const URL_PAYMENT = BASE + '/payment';
const URL_FIND    = BASE + '/business/findPayment';
const URL_AUTH    = BASE + '/authorization';

// Normaliza a 10 dígitos (formato que espera ATH, p.ej. "7875551234").
function athPhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : null;
}

async function athPost(url, body, authToken) {
  try {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    const payload = typeof body === 'string' ? body : JSON.stringify(body || {});
    const resp = await fetch(url, { method: 'POST', headers, body: payload });
    const json = await resp.json().catch(() => null);
    return { ok: !!(json && json.status === 'success'), data: json && json.data ? json.data : null, raw: json };
  } catch (e) {
    console.error('ath-rest', e.message);
    return { ok: false, data: null, raw: null };
  }
}

// Crea el pago en ATH (manda push al teléfono del que paga). publicToken = cuenta
// que RECIBE el dinero. Devuelve { ecommerceId, authToken } o null.
async function create(publicToken, env, cents, phone, metadata1, metadata2, itemName) {
  const dollars = (cents / 100).toFixed(2);
  const body = {
    env: env || 'production',
    publicToken,
    timeout: '600',
    total: dollars, subtotal: dollars, tax: '0.00',
    metadata1: String(metadata1 || '').slice(0, 40),
    metadata2: String(metadata2 || '').slice(0, 40),
    phoneNumber: phone,
    items: [{
      name: String(itemName || 'Pago').slice(0, 40),
      description: String(itemName || 'Pago').slice(0, 40),
      quantity: '1', price: dollars, tax: '0.00', metadata: '',
    }],
  };
  const r = await athPost(URL_PAYMENT, body);
  if (r.ok && r.data && r.data.ecommerceId && r.data.auth_token)
    return { ecommerceId: r.data.ecommerceId, authToken: r.data.auth_token };
  return null;
}

// Consulta estado. Devuelve data de ATH (ecommerceStatus, total, referenceNumber...) o null.
async function find(publicToken, ecommerceId, authToken) {
  const r = await athPost(URL_FIND, { ecommerceId, publicToken }, authToken);
  return r.data;
}

// Autoriza (captura) el pago confirmado. Body vacío; el auth_token identifica la txn.
async function authorize(authToken) {
  const r = await athPost(URL_AUTH, '', authToken);
  return r.data;
}

module.exports = { athPhone, create, find, authorize };
