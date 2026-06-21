/*!
 * Bukéame — Widget de reservas embebible
 * Uso:
 *   <script src="https://bukeame.com/widget.js" data-slug="tu-negocio" defer></script>
 *
 * Atributos opcionales en la etiqueta <script>:
 *   data-slug      (REQUERIDO) slug del negocio en Bukéame
 *   data-label     texto del botón            (def: "Reservar cita")
 *   data-color     color de fondo del botón   (def: #0E8074, verde Bukéame)
 *   data-position  "inline" | "float"         (def: "inline" si hay data-target; si no, "float")
 *   data-target    selector CSS donde montar el botón (ej: "#reservar")
 *   data-base      origen de Bukéame          (def: el origen del propio widget.js, o https://bukeame.com)
 *
 * El botón y el modal viven en Shadow DOM (aislados del CSS del sitio anfitrión).
 * El modal SIEMPRE se ancla a <body> para que position:fixed referencie al viewport.
 */
(function () {
  'use strict';

  // Evita doble inicialización si el script se incluye dos veces.
  if (window.__bukeameWidget) return;
  window.__bukeameWidget = true;

  // ── Localiza la etiqueta <script> que nos cargó ───────────────────────────
  var self = document.currentScript ||
    document.querySelector('script[src*="widget.js"][data-slug]') ||
    document.querySelector('script[src*="widget.js"]');
  var ds = (self && self.dataset) ? self.dataset : {};

  var slug = (ds.slug || '').trim();
  if (!slug) {
    if (window.console) console.warn('[Bukéame] widget.js: falta data-slug en la etiqueta <script>.');
    return;
  }

  // Origen de Bukéame: el del propio widget.js (funciona en prod y staging) o el dado.
  var base = (ds.base || '').replace(/\/+$/, '');
  if (!base) { try { base = new URL(self.src).origin; } catch (e) { base = ''; } }
  if (!base) base = 'https://bukeame.com';
  // Origen puro para validar mensajes (el iframe siempre reporta solo el origin).
  var baseOrigin; try { baseOrigin = new URL(base).origin; } catch (e) { baseOrigin = base; }

  var label = ds.label || 'Reservar cita';
  // Sanea el color (viene de un data-attribute): solo hex o nombre, para que no
  // pueda romper la cadena CSS e inyectar reglas dentro del Shadow DOM.
  var color = ds.color || '#0E8074';
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color) && !/^[a-zA-Z]+$/.test(color)) color = '#0E8074';

  var target = ds.target ? document.querySelector(ds.target) : null;
  var position = (ds.position || (target ? 'inline' : 'float')).toLowerCase();
  var bookUrl = base + '/negocio.html?slug=' + encodeURIComponent(slug) + '&embed=1';

  function inHead(n) { return !!(n && document.head && document.head.contains(n)); }

  // ── Estilos (dentro del Shadow DOM; aislados del sitio anfitrión) ──────────
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0;font-family:"Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    // Botón
    '.bkm-btn{display:inline-flex;align-items:center;gap:9px;background:' + color + ';color:#fff;',
    '  font-size:15px;font-weight:700;line-height:1;padding:13px 20px;border:0;border-radius:13px;cursor:pointer;',
    '  box-shadow:0 6px 18px rgba(14,128,116,.32);transition:transform .12s ease,box-shadow .12s ease;text-decoration:none}',
    '.bkm-btn:hover{transform:translateY(-1px);box-shadow:0 10px 24px rgba(14,128,116,.4)}',
    '.bkm-btn:active{transform:translateY(0)}',
    '.bkm-btn svg{width:18px;height:18px;flex:none}',
    '.bkm-btn.bkm-float{position:fixed;right:20px;bottom:20px;z-index:2147483000;padding:15px 22px;border-radius:99px}',
    // Modal
    '.bkm-overlay{position:fixed;inset:0;z-index:2147483600;display:none;align-items:center;justify-content:center;',
    '  padding:24px;background:rgba(13,20,16,.62);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}',
    '.bkm-overlay.bkm-open{display:flex}',
    '.bkm-card{position:relative;width:100%;max-width:480px;height:88vh;max-height:760px;background:#fff;',
    '  border-radius:20px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5);display:flex;flex-direction:column;',
    '  animation:bkm-in .22s cubic-bezier(.2,.7,.3,1)}',
    '@keyframes bkm-in{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}',
    '.bkm-bar{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #E1DCCD;background:#F7F4EA;flex:none}',
    '.bkm-bar .bkm-ttl{font-size:14px;font-weight:800;color:#17150F;letter-spacing:-.01em}',
    '.bkm-bar .bkm-ttl i{font-style:normal;color:' + color + '}',
    '.bkm-bar .bkm-sp{flex:1}',
    '.bkm-x{width:34px;height:34px;border:0;border-radius:10px;background:#EDE9DB;color:#17150F;font-size:20px;line-height:1;',
    '  cursor:pointer;display:grid;place-items:center;transition:background .12s}',
    '.bkm-x:hover{background:#E1DCCD}',
    '.bkm-frameWrap{position:relative;flex:1;background:#F1EFE5}',
    '.bkm-frame{width:100%;height:100%;border:0;display:block}',
    '.bkm-load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;',
    '  color:#5E594B;font-size:13.5px;font-weight:600;background:#F1EFE5}',
    '.bkm-load.bkm-hide{display:none}',
    '.bkm-spin{width:18px;height:18px;border:2.5px solid #E1DCCD;border-top-color:' + color + ';border-radius:50%;animation:bkm-rot .8s linear infinite}',
    '@keyframes bkm-rot{to{transform:rotate(360deg)}}',
    '@media(max-width:560px){',
    '  .bkm-overlay{padding:0}',
    '  .bkm-card{max-width:none;height:100%;max-height:none;border-radius:0}',
    '  .bkm-btn.bkm-float{right:14px;bottom:14px}',
    '}'
  ].join('\n');

  var CAL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/></svg>';

  function styleEl() { var s = document.createElement('style'); s.textContent = CSS; return s; }
  function makeHost() { var h = document.createElement('div'); h.setAttribute('data-bukeame-widget', ''); return h; }

  // ── Host del BOTÓN (Shadow DOM) ───────────────────────────────────────────
  var btnHost = makeHost();
  var btnRoot = btnHost.attachShadow ? btnHost.attachShadow({ mode: 'open' }) : null;
  if (!btnRoot) { mountFallback(); return; } // navegador sin Shadow DOM → degradar

  btnRoot.appendChild(styleEl());
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bkm-btn';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML = CAL_ICON + '<span></span>';
  btn.querySelector('span').textContent = label; // texto seguro (no innerHTML)

  // ── Host del MODAL (Shadow DOM) — SIEMPRE en <body> (ancla al viewport) ────
  var modalHost = makeHost();
  var modalRoot = modalHost.attachShadow({ mode: 'open' });
  modalRoot.appendChild(styleEl());
  var overlay = document.createElement('div');
  overlay.className = 'bkm-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Reservar cita');
  overlay.innerHTML =
    '<div class="bkm-card">' +
    '  <div class="bkm-bar"><span class="bkm-ttl">Buk<i>é</i>ame</span><span class="bkm-sp"></span>' +
    '    <button class="bkm-x" type="button" aria-label="Cerrar">&times;</button></div>' +
    '  <div class="bkm-frameWrap">' +
    '    <div class="bkm-load"><span class="bkm-spin"></span> Cargando…</div>' +
    '    <iframe class="bkm-frame" title="Reservar cita" allow="payment"></iframe>' +
    '  </div>' +
    '</div>';

  var frame = overlay.querySelector('.bkm-frame');
  var loader = overlay.querySelector('.bkm-load');
  var closeBtn = overlay.querySelector('.bkm-x');

  // ── Lógica abrir/cerrar ───────────────────────────────────────────────────
  var prevOverflow = '', lastFocus = null;
  function open() {
    if (!frame.src) frame.src = bookUrl;          // carga diferida (solo al abrir)
    loader.classList.remove('bkm-hide');
    overlay.classList.add('bkm-open');
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden'; // bloquea scroll del fondo
    lastFocus = document.activeElement;
    closeBtn.focus();
  }
  function close() {
    overlay.classList.remove('bkm-open');
    document.documentElement.style.overflow = prevOverflow;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('bkm-open')) close();
  });
  frame.addEventListener('load', function () { loader.classList.add('bkm-hide'); });

  // Cierre opcional desde dentro del iframe (fail-closed: valida origen y solo si está abierto).
  window.addEventListener('message', function (e) {
    if (!overlay.classList.contains('bkm-open')) return;
    if (e.origin !== baseOrigin) return;
    var d = e.data;
    if (d === 'bukeame:close' || (d && d.type === 'bukeame:close')) close();
  });

  // ── Monta botón (inline/float) + modal (siempre en body) ──────────────────
  btnRoot.appendChild(btn);
  function mountBtn() {
    if (position === 'inline' && target) { target.appendChild(btnHost); return; }
    if (position === 'inline' && self && self.parentNode && !inHead(self)) {
      self.parentNode.insertBefore(btnHost, self.nextSibling); // justo donde está el <script>
      return;
    }
    btn.classList.add('bkm-float'); // flotante por defecto (o inline imposible: <script> en <head>)
    document.body.appendChild(btnHost);
  }
  function mountAll() {
    document.body.appendChild(modalHost); // el modal SIEMPRE al viewport
    mountBtn();
  }
  if (document.body) mountAll();
  else document.addEventListener('DOMContentLoaded', mountAll);

  // ── Fallback sin Shadow DOM: enlace que abre el booking en pestaña nueva ───
  function mountFallback() {
    function place() {
      var a = document.createElement('a');
      a.textContent = label;
      a.href = base + '/negocio.html?slug=' + encodeURIComponent(slug);
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.cssText = 'display:inline-flex;gap:8px;color:#fff;font:700 15px sans-serif;' +
        'padding:13px 20px;border-radius:13px;text-decoration:none';
      a.style.background = color; // ya saneado
      if (target) target.appendChild(a);
      else if (self && self.parentNode && !inHead(self)) self.parentNode.insertBefore(a, self.nextSibling);
      else if (document.body) document.body.appendChild(a);
    }
    if (document.body) place();
    else document.addEventListener('DOMContentLoaded', place);
  }
})();
