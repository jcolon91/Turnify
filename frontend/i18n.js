/* Bukéame — i18n aditivo y NO destructivo.
   - Default español (igual que hoy). Toggle ES/EN se inyecta junto al de tema.
   - En EN traduce los nodos de texto + placeholder/title/aria-label usando el diccionario T.
   - Lo que no esté en T se queda en español (degradación elegante, nunca rompe el layout).
   - Un MutationObserver traduce el contenido que el JS pinta después.
   - Si este archivo no carga, la página funciona exactamente como antes. */
(function () {
  var LANG_KEY = 'bukeame_lang';
  var translated = false, obs = null;
  var origText = new WeakMap();   // nodo de texto -> valor original (es)
  var origAttr = new WeakMap();   // elemento -> {placeholder,title,aria}

  // Diccionario español -> inglés. Cubre navegación, botones y el flujo público
  // (landing, búsqueda, reserva, acceso). Ampliable: añade pares aquí.
  var T = {
    // --- Navegación / panel ---
    'Agenda':'Schedule','Servicios':'Services','Equipo':'Team','Clientes':'Clients','Lealtad':'Loyalty',
    'Tienda':'Store','Lista de espera':'Waitlist','Órdenes':'Orders','Horario':'Hours','Contabilidad':'Accounting',
    'Mi negocio':'My business','Pagos':'Payments','Promociones':'Promotions','Marketing':'Marketing',
    'Referidos':'Referrals','Mi cuenta':'My account','Kit de marca':'Brand kit','Cerrar sesión':'Log out',
    // --- Acciones / botones ---
    'Reservar':'Book','Reservar ahora':'Book now','Reserva ahora':'Book now','Reserva':'Book',
    'Cancelar':'Cancel','Guardar':'Save','Guardar cambios':'Save changes','Confirmar':'Confirm','Aceptar':'Accept',
    'Buscar':'Search','Crear':'Create','Crear campaña':'Create campaign','Editar':'Edit','Eliminar':'Delete','Borrar':'Delete',
    'Cerrar':'Close','Continuar':'Continue','Volver':'Back','Atrás':'Back','Siguiente':'Next','Anterior':'Previous',
    'Pagar':'Pay','Descargar':'Download','Copiar':'Copy','Imprimir':'Print','Compartir':'Share','Enviar':'Send',
    'Añadir':'Add','Aplicar':'Apply','Ver más':'See more','Ver todo':'See all','Listo':'Done',
    // --- Landing / marca ---
    'Tu turno, sin llamadas':'Your turn, no calls','Reserva en línea':'Book online','Reservar en línea':'Book online',
    'Reserva sin llamadas':'Book without calls','Cerca de ti':'Near you','Buscar negocios':'Find businesses',
    'Para negocios':'For businesses','Empezar gratis':'Start free','Empieza gratis':'Start free','Cómo funciona':'How it works',
    'Sin comisiones':'No commissions','Cero comisiones':'Zero commissions','Recordatorios por WhatsApp':'WhatsApp reminders',
    'Depósitos por ATH Móvil':'ATH Móvil deposits','Barberías y salones':'Barbershops and salons',
    // --- Acceso / cuenta ---
    'Iniciar sesión':'Log in','Crear cuenta':'Sign up','Regístrate':'Sign up','Correo':'Email','Correo electrónico':'Email',
    'Contraseña':'Password','Teléfono':'Phone','Nombre':'Name','Nombre completo':'Full name','Apellido':'Last name',
    '¿Olvidaste tu contraseña?':'Forgot your password?','Recordarme':'Remember me',
    // --- Reserva / negocio ---
    'Servicio':'Service','Profesional':'Professional','Cualquiera':'Anyone','Fecha':'Date','Hora':'Time',
    'Reseñas':'Reviews','Reseña':'Review','Depósito':'Deposit','Total':'Total','Confirmar cita':'Confirm appointment',
    'Tu cita':'Your appointment','Detalles de la cita':'Appointment details','Selecciona un servicio':'Select a service',
    'Selecciona una fecha':'Select a date','Selecciona una hora':'Select a time','Pagar con ATH Móvil':'Pay with ATH Móvil',
    'Pagar con tarjeta':'Pay with card','Efectivo':'Cash','Tarjeta':'Card','Gracias':'Thank you',
    'Tu cita quedó confirmada':'Your appointment is confirmed','Cita confirmada':'Appointment confirmed',
    'Disponible':'Available','No disponible':'Unavailable','min':'min','Duración':'Duration','Precio':'Price','Desde':'From',
    // --- Estados / varios ---
    'Pendiente':'Pending','Confirmada':'Confirmed','Cancelada':'Cancelled','Completada':'Completed','Activo':'Active','Inactivo':'Inactive',
    'Hoy':'Today','Mañana':'Tomorrow','Ayer':'Yesterday','Cargando...':'Loading...','No hay resultados':'No results',
    'Cliente':'Client','Negocio':'Business','Ubicación':'Location','Dirección':'Address','Categoría':'Category','Todos':'All'
  };

  function tr(s) {
    if (s == null) return s;
    var k = s.trim();
    if (!k) return s;
    var v = T[k];
    return v ? s.replace(k, v) : s;
  }

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };
  function walk(root, fn) {
    if (!root || !root.nodeType) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode; if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('[data-no-i18n]')) return NodeFilter.FILTER_REJECT;
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n; while ((n = w.nextNode())) fn(n);
  }
  function txtTo(node, en) {
    if (!origText.has(node)) origText.set(node, node.nodeValue);
    node.nodeValue = en ? tr(origText.get(node)) : origText.get(node);
  }
  function attrsTo(root, en) {
    if (!root.querySelectorAll) return;
    root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(function (el) {
      if (!origAttr.has(el)) origAttr.set(el, {
        placeholder: el.getAttribute('placeholder'), title: el.getAttribute('title'), aria: el.getAttribute('aria-label')
      });
      var o = origAttr.get(el);
      if (o.placeholder != null) el.setAttribute('placeholder', en ? tr(o.placeholder) : o.placeholder);
      if (o.title != null) el.setAttribute('title', en ? tr(o.title) : o.title);
      if (o.aria != null) el.setAttribute('aria-label', en ? tr(o.aria) : o.aria);
    });
  }
  function startObs() {
    if (obs) return;
    obs = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (nd) {
          if (nd.nodeType === 3) txtTo(nd, true);
          else if (nd.nodeType === 1) { walk(nd, function (n) { txtTo(n, true); }); attrsTo(nd, true); }
        });
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  function stopObs() { if (obs) { obs.disconnect(); obs = null; } }

  function setLang(lang) {
    lang = (lang === 'en') ? 'en' : 'es';
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'es');
    document.documentElement.setAttribute('data-lang', lang);
    if (lang === 'en') {
      translated = true;
      walk(document.body, function (n) { txtTo(n, true); });
      attrsTo(document.body, true);
      startObs();
    } else if (translated) {
      stopObs();
      walk(document.body, function (n) { txtTo(n, false); });
      attrsTo(document.body, false);
    }
    document.querySelectorAll('[data-lang-set]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-lang-set') === lang);
    });
  }
  window.__setLang = setLang;

  function injectToggle() {
    if (document.querySelector('.lang-tg')) return;
    var tg = document.createElement('div');
    var host = document.querySelector('.theme-tg');
    tg.className = 'theme-tg lang-tg';
    tg.setAttribute('role', 'group');
    tg.setAttribute('aria-label', 'Idioma / Language');
    tg.innerHTML = '<button type="button" data-lang-set="es">ES</button><button type="button" data-lang-set="en">EN</button>';
    if (host && host.parentNode) { tg.style.marginLeft = '8px'; host.parentNode.insertBefore(tg, host.nextSibling); }
    else {
      tg.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:9999;display:inline-flex;gap:2px;background:var(--card,#12251B);border:1px solid var(--border,rgba(255,255,255,.12));border-radius:99px;padding:3px';
      document.body.appendChild(tg);
    }
    tg.querySelectorAll('[data-lang-set]').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.getAttribute('data-lang-set')); });
    });
  }

  function init() {
    injectToggle();
    var saved = 'es';
    try { saved = localStorage.getItem(LANG_KEY) || 'es'; } catch (e) {}
    setLang(saved);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
