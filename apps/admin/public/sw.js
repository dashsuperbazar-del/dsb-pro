/* global self, caches, URL, Request, Response, fetch */
const version = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'dsb-pro-shell-' + version;
const scopeRoot = new URL('./', self.registration.scope).toString();
const shellRoutes = ['', 'signup', 'join', 'team', 'devices', 'inventory', 'pos', 'customers', 'sales-history', 'sync'];

async function precacheShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch(new Request(scopeRoot, { cache: 'reload' }));
  if (!response.ok) throw new Error('Unable to fetch app shell');
  const html = await response.clone().text();
  await Promise.all(shellRoutes.map(route => cache.put(new URL(route, scopeRoot).toString(), response.clone())));

  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => new URL(match[1], scopeRoot))
    .filter(url => url.origin === self.location.origin)
    .map(url => url.toString());

  if (refs.length) await cache.addAll([...new Set(refs)]);
}

async function cachedNavigation(request) {
  const cache = await caches.open(CACHE);
  const exact = await cache.match(request, { ignoreSearch: true });
  if (exact) return exact;

  // A cached Response keeps the URL it was originally fetched from. Chromium
  // can treat a root-URL response differently for an offline deep navigation.
  // Re-materialize the cached SPA shell as a fresh 200 response so arbitrary
  // unvisited app routes still boot with the requested browser URL.
  const root = await cache.match(scopeRoot, { ignoreSearch: true });
  if (!root) return Response.error();
  return new Response(await root.arrayBuffer(), {
    status: 200,
    statusText: 'OK',
    headers: root.headers,
  });
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (!response.ok) return cachedNavigation(request);

        // Cache both the exact SPA route and the root shell. This removes any
        // dependency on the browser's offline navigation error shape.
        const cache = await caches.open(CACHE);
        await Promise.all([
          cache.put(request, response.clone()),
          cache.put(scopeRoot, response.clone()),
        ]);
        return response;
      } catch {
        return cachedNavigation(request);
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return Response.error();
    }
  })());
});
