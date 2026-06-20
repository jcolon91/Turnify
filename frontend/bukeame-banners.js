/* ============================================================================
   BUKEAME — Sistema de banners (compartido)
   Carga con: <script src="bukeame-banners.js"></script>
   Expone:  window.BukeameBanners = { PRESETS, css(), apply(el, theme, coverUrl, name) }
   ----------------------------------------------------------------------------
   · 12 patrones profesionales (gradientes + formas sutiles) para planes FREE
   · Soporta imagen propia (cover_url) para planes PRO+
   · Medidas recomendadas:  Banner 1600x400 (4:1)  ·  Logo 800x800 (cuadrado)
   ============================================================================ */
(function (global) {
  // Lista de presets (id + nombre legible). El orden es el de la galería.
  const PRESETS = [
    { id: 'teal-mesh',     name: 'Marquesina' },
    { id: 'sunset',        name: 'Atardecer' },
    { id: 'ocean',         name: 'Océano' },
    { id: 'violet',        name: 'Violeta' },
    { id: 'rose',          name: 'Coral' },
    { id: 'mango-sun',     name: 'Mango' },
    { id: 'wine-wave',     name: 'Vino' },
    { id: 'forest',        name: 'Bosque' },
    { id: 'carbon-lines',  name: 'Carbón' },
    { id: 'graphite-dots', name: 'Grafito' },
    { id: 'mint',          name: 'Menta' },
    { id: 'sand',          name: 'Arena' },
  ];

  // CSS de todos los patrones (se inyecta una vez por página)
  const CSS = `
.tbanner{position:relative;width:100%;height:100%;background-size:cover;background-position:center;overflow:hidden}
.bnr-teal-mesh{background:repeating-linear-gradient(45deg,rgba(255,255,255,.04) 0 2px,transparent 2px 22px),linear-gradient(135deg,#0E8074 0%,#0A5B52 60%,#11221E 100%)}
.bnr-carbon-lines{background:repeating-linear-gradient(90deg,rgba(159,232,213,.06) 0 1px,transparent 1px 30px),linear-gradient(120deg,#17150F 0%,#26221A 100%)}
.bnr-mango-sun{background:radial-gradient(circle at 78% 30%,rgba(255,255,255,.18) 0%,transparent 38%),linear-gradient(120deg,#EFA12F 0%,#D97706 70%,#9a4d06 100%)}
.bnr-wine-wave{background:radial-gradient(ellipse at 20% 120%,rgba(255,255,255,.12) 0%,transparent 45%),linear-gradient(135deg,#B0413E 0%,#7c2d2b 100%)}
.bnr-ocean{background:radial-gradient(circle at 85% 80%,rgba(255,255,255,.14) 0%,transparent 40%),linear-gradient(135deg,#3E5CB0 0%,#27407c 100%)}
.bnr-violet{background:repeating-linear-gradient(-45deg,rgba(255,255,255,.05) 0 2px,transparent 2px 24px),linear-gradient(135deg,#6D28D9 0%,#4c1d95 100%)}
.bnr-rose{background:radial-gradient(circle at 70% 20%,rgba(255,255,255,.2) 0%,transparent 42%),linear-gradient(120deg,#BE185D 0%,#831843 100%)}
.bnr-forest{background:repeating-linear-gradient(60deg,rgba(255,255,255,.04) 0 2px,transparent 2px 26px),linear-gradient(135deg,#166534 0%,#14532d 100%)}
.bnr-graphite-dots{background-color:#1f2937;background-image:radial-gradient(rgba(255,255,255,.10) 1.2px,transparent 1.2px);background-size:18px 18px}
.bnr-sunset{background:linear-gradient(120deg,#f97316 0%,#db2777 55%,#7c3aed 100%)}
.bnr-mint{background:radial-gradient(circle at 80% 30%,rgba(14,128,116,.18) 0%,transparent 45%),linear-gradient(135deg,#d1fae5 0%,#a7f3d0 100%)}
.bnr-mint .tbanner-name{color:#11221E;text-shadow:none}
.bnr-sand{background:repeating-linear-gradient(90deg,rgba(23,21,15,.04) 0 1px,transparent 1px 28px),linear-gradient(135deg,#F1EFE5 0%,#e0dcc8 100%)}
.bnr-sand .tbanner-name{color:#17150F;text-shadow:none}
.tbanner.has-img::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.35) 0%,transparent 50%)}
.tbanner-name{position:absolute;left:0;right:0;bottom:12px;text-align:center;font-weight:800;font-size:22px;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.4);padding:0 16px;letter-spacing:-.01em}
`;

  let injected = false;
  function injectCss() {
    if (injected) return;
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    injected = true;
  }

  // Saca el id de banner del theme jsonb del negocio
  function bannerId(theme) {
    try {
      const t = (typeof theme === 'string') ? JSON.parse(theme) : (theme || {});
      return t.banner || 'teal-mesh';
    } catch (e) { return 'teal-mesh'; }
  }

  // Aplica el banner a un elemento:
  //   coverUrl  → si el negocio (Pro) subió imagen, se usa esa
  //   theme     → si no, se usa el patrón elegido (free)
  //   name      → opcional, muestra el nombre del negocio sobre el banner
  function apply(el, theme, coverUrl, name) {
    if (!el) return;
    injectCss();
    // limpiar clases previas de banner
    el.className = el.className.replace(/\bbnr-[a-z-]+\b/g, '').trim();
    el.classList.add('tbanner');
    el.style.backgroundImage = '';
    // asegurar que el contenedor tenga altura visible (si no la trae por CSS)
    if (!el.style.height && el.offsetHeight < 20) el.style.height = '150px';
    if (coverUrl) {
      el.classList.add('has-img');
      el.style.backgroundImage = "url('" + coverUrl + "')";
    } else {
      el.classList.add('bnr-' + bannerId(theme));
    }
    if (name) {
      el.innerHTML = '<div class="tbanner-name">' + String(name).replace(/[<>&]/g, '') + '</div>';
    }
  }

  global.BukeameBanners = { PRESETS, css: () => CSS, injectCss, apply, bannerId };
})(window);
