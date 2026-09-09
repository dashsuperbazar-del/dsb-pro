/* global self, caches, URL, Request, Response, fetch */
const version = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'dsb-pro-shell-' + version;
const scopeRoot = new URL('./', self.registration.scope).toString();

async function precacheShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch(new Request(scopeRoot, { cache: 'reload' }));
  if (!response.ok) throw new Error('Unable to fetch app shell');
  const html = await response.clone().text();
  await cache.put(scopeRoot, response);
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => new URL(match[1], scopeRoot))
    .filter(url => url.origin === self.location.origin)
    .map(url => url.toString());
  if (refs.length) await cache.addAll([...new Set(refs)]);
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
    event.respondWith(
      fetch(request)
        .then(async response => {
          if (response.ok) {
            void caches.open(CACHE).then(cache => cache.put(scopeRoot, response.clone()));
            return response;
          }
          return (await caches.match(scopeRoot)) || response;
        })
        .catch(() => caches.match(scopeRoot).then(hit => hit || Response.error()))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(response => {
      if (response.ok) void caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    }))
  );
});
