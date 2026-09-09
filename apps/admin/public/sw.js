/* global self, caches, URL, Request, Response, fetch */
const version = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'dsb-pro-shell-' + version;
const scopeRoot = new URL('./', self.registration.scope).toString();

async function precacheShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch(new Request(scopeRoot, { cache: 'reload' }));
  if (!response.ok) throw new Error('Unable to fetch app shell');
  const html = await response.clone().text();
  await cache.put(scopeRoot, response.clone());

  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => new URL(match[1], scopeRoot))
    .filter(url => url.origin === self.location.origin)
    .map(url => url.toString());

  if (refs.length) await cache.addAll([...new Set(refs)]);
}

async function cachedNavigation(request) {
  const cache = await caches.open(CACHE);
  // Prefer the exact route if it has been visited while online. Fall back to
  // the cached SPA root so arbitrary deep links can still boot offline.
  return (await cache.match(request, { ignoreSearch: true }))
    || (await cache.match(scopeRoot, { ignoreSearch: true }))
    || Response.error();
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
