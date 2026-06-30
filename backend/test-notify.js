// Prueba + DIAGNÓSTICO de canales de aviso de Bukéame (email Resend + WhatsApp Evolution).
// Usa la MISMA config del .env y los MISMOS defaults que el server (server.js usa
// EVOLUTION_INSTANCE || 'turnify'), para que el resultado refleje producción.
// Uso (en el servidor):
//   cd /var/www/bukeame/backend
//   node test-notify.js tu-correo@real.com 7871234567
require('dotenv').config();
const EMAIL = process.argv[2] || '';
const PHONE = process.argv[3] || '';
const {
  RESEND_API_KEY, EMAIL_FROM,
  EVOLUTION_API_URL, EVOLUTION_API_KEY,
} = process.env;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'turnify'; // MISMO default que server.js

(async () => {
  // ── EMAIL (Resend) ──────────────────────────────────────────────────────
  if (!EMAIL || EMAIL.indexOf('@') < 0) {
    console.error('EMAIL    : (omitido — no diste un correo válido)');
  } else if (!RESEND_API_KEY) {
    console.error('EMAIL    : SKIPPED — falta RESEND_API_KEY en .env');
  } else {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY },
        body: JSON.stringify({ from: EMAIL_FROM, to: [EMAIL], subject: 'Prueba Bukéame — email', text: 'Email de Bukéame funciona.' }),
      });
      const j = await r.json().catch(() => ({}));
      console.error('EMAIL    :', r.ok ? ('OK ✓ id=' + (j.id || '?')) : ('ERROR ' + r.status + ' ' + JSON.stringify(j).slice(0, 200)));
    } catch (e) { console.error('EMAIL    : ERROR de red —', e.message); }
  }

  // ── WHATSAPP (Evolution) — con diagnóstico ───────────────────────────────
  console.error('--- WhatsApp / Evolution (diagnóstico) ---');
  console.error('  URL      :', EVOLUTION_API_URL || '(FALTA en .env)');
  console.error('  API KEY  :', EVOLUTION_API_KEY ? 'presente' : '(FALTA en .env)');
  console.error('  INSTANCE :', EVOLUTION_INSTANCE, (process.env.EVOLUTION_INSTANCE ? '' : '(usando default porque .env NO la define)'));

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.error('  >> SKIPPED: sin URL/KEY no se envía NINGÚN WhatsApp. Configúralas en .env.');
    return;
  }
  // 1) ¿la instancia está CONECTADA a WhatsApp? (state debe ser "open")
  try {
    const cs = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${EVOLUTION_INSTANCE}`, { headers: { apikey: EVOLUTION_API_KEY } });
    console.error('  ESTADO   :', cs.status, (await cs.text()).slice(0, 220));
  } catch (e) { console.error('  ESTADO   : ERROR —', e.message); }

  // 2) intentar enviar (muestra la respuesta COMPLETA de Evolution)
  if (PHONE) {
    let num = PHONE.replace(/[^0-9]/g, '');
    if (num.length === 10) num = '1' + num;   // PR/US: anteponer código de país (mismo fix que sendWhatsApp)
    console.error('  ENVIANDO a número:', num);
    try {
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: num, text: 'Prueba Bukéame — WhatsApp' }),
      });
      console.error('  ENVÍO    :', r.status, (await r.text()).slice(0, 400));
    } catch (e) { console.error('  ENVÍO    : ERROR de red —', e.message); }
  } else {
    console.error('  (no diste teléfono → no probé el envío)');
  }
})();
