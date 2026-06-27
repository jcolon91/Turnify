/* Bukéame — Service Worker (PWA). Objetivo: instalable + offline básico, SIN tocar
   datos sensibles. NUNCA cachea /api/ (datos frescos + auth) ni peticiones no-GET.
   Estrategia: navegaciones = network-first (fallback offline); estáticos = cache-first
   con relleno en runtime. Subir bump de CACHE al cambiar archivos para invalidar. */
const CACHE = 'bukeame-v1';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))   // si algo falla, no rompe la instalación
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                         // POST/PATCH/DELETE → red, nunca cache
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // terceros (Stripe, ATH, etc.) → red
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return; // API/subidas → red

  // Navegaciones (HTML): red primero, con fallback al shell si no hay conexión.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match(req).then((c) => c || caches.match('/index.html')))
    );
    return;
  }

  // Estáticos (css/js/img/fuentes): cache primero, y rellena en segundo plano.
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached)
    )
  );
});

// ── Web Push: mostrar la notificación recibida ──────────────────────────────
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || 'Bukéame';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

// Al tocar la notificación: enfoca una pestaña existente o abre la URL.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url.indexOf(url) >= 0 && 'focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
