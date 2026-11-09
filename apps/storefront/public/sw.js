// Online shop service worker: caches the app shell only. API calls (prices, stock, orders) always go to the network.
const CACHE = 'dsb-shop-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['./', 'manifest.webmanifest', 'icon.svg']))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Network first for the page (new builds show at once), cache-first for hashed assets.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const c = r.clone();
          caches.open(CACHE).then((x) => x.put('./', c));
          return r;
        })
        .catch(() => caches.match('./')),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((r) => {
          if (r.ok && url.pathname.startsWith('/assets/')) {
            const c = r.clone();
            caches.open(CACHE).then((x) => x.put(req, c));
          }
          return r;
        }),
    ),
  );
});
