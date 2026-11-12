/* Service worker — offline app shell. Pri zmene súborov zvýš VERSION. */
const VERSION = 'financie-v6';
const SHELL = [
  './', './index.html', './manifest.json', './css/app.css',
  './js/store.js', './js/parser.js', './js/ui.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' obíde HTTP cache prehliadača (GitHub Pages drží súbory 10 min) → vždy čerstvé súbory
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Navigácie (aj s ?add=…): network-first, offline fallback na index.html
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => caches.match('./index.html', { ignoreSearch: true })));
    return;
  }
  // Vlastné súbory: stale-while-revalidate
  if (url.origin === location.origin) {
    e.respondWith(caches.open(VERSION).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req, { cache: 'no-cache' }).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || fresh;
    }));
    return;
  }
  // pdf.js z CDN: cache-first (aby PDF import fungoval aj offline po prvom použití)
  if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.open(VERSION).then(async cache => {
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
  }
});
