// Prueba de canales de aviso de Bukéame (email vía Resend + WhatsApp vía Evolution).
// Usa la MISMA config del .env y los MISMOS formatos que producción.
// Uso (en el servidor):
//   cd /var/www/bukeame/backend
//   node test-notify.js tu-correo@ejemplo.com 7875551234
// Puedes pasar solo email, solo teléfono, o ambos.
require('dotenv').config();
const EMAIL = process.argv[2] || '';
const PHONE = process.argv[3] || '';
const {
  RESEND_API_KEY, EMAIL_FROM,
  EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE = 'bukeame',
} = process.env;

(async () => {
  // ── EMAIL (Resend) ────────────────────────────────────────────────────────
  if (!EMAIL || EMAIL.indexOf('@') < 0) {
    console.error('EMAIL    : (omitido — no diste un correo válido)');
  } else if (!RESEND_API_KEY) {
    console.error('EMAIL    : SKIPPED — falta RESEND_API_KEY en .env (por eso NO llegan emails)');
  } else {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY },
        body: JSON.stringify({
          from: EMAIL_FROM, to: [EMAIL],
          subject: 'Prueba Bukéame — el email funciona',
          text: 'Si lees esto, el envío de emails de Bukéame (Resend) está funcionando.',
        }),
      });
      const j = await r.json().catch(() => ({}));
      console.error('EMAIL    :', r.ok ? ('OK ✓  id=' + (j.id || '?') + '  (de: ' + EMAIL_FROM + ')')
        : ('ERROR ' + r.status + '  ' + JSON.stringify(j).slice(0, 300)));
    } catch (e) { console.error('EMAIL    : ERROR de red —', e.message); }
  }

  // ── WHATSAPP (Evolution) ──────────────────────────────────────────────────
  if (!PHONE) {
    console.error('WHATSAPP : (omitido — no diste un teléfono)');
  } else if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.error('WHATSAPP : SKIPPED — falta EVOLUTION_API_URL/KEY en .env (por eso NO llegan WhatsApp)');
  } else {
    try {
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: PHONE.replace('+', ''), text: 'Prueba Bukéame — el WhatsApp funciona ✅' }),
      });
      const t = await r.text();
      console.error('WHATSAPP :', r.ok ? ('OK ✓  (instancia: ' + EVOLUTION_INSTANCE + ')')
        : ('ERROR ' + r.status + '  ' + t.slice(0, 300)));
    } catch (e) { console.error('WHATSAPP : ERROR de red —', e.message); }
  }
})();
