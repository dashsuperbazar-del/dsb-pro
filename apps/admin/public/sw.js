/* global self, caches, URL, Request, Response, fetch */
const version = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'dsb-pro-shell-' + version;
const scopeRoot = new URL('./', self.registration.scope).toString();
const shellRoutes = [
  '',
  'signup',
  'join',
  'team',
  'devices',
  'inventory',
  'pos',
  'customers',
  'sales-history',
  'sync',
];

// A real build file: ok, and never the SPA fallback page served under a script/style URL.
const isAsset = (response) =>
  response.ok && !(response.headers.get('content-type') || '').includes('text/html');

// All-or-nothing: everything is fetched and checked BEFORE the new cache is written, and a failed
// write removes the half-filled cache, so a new version never serves a partial shell.
async function precacheShell() {
  const response = await fetch(new Request(scopeRoot, { cache: 'reload' }));
  if (!response.ok) throw new Error('Unable to fetch app shell');
  const html = await response.clone().text();

  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], scopeRoot))
    .filter((url) => url.origin === self.location.origin)
    .map((url) => url.toString());

  // Every built JS/CSS file, including chunks that load on demand (D2), so every screen opens offline.
  const manifest = await fetch(
    new Request(new URL('precache.json', scopeRoot), { cache: 'reload' }),
  );
  if (!manifest.ok) throw new Error('Unable to fetch precache.json');
  const files = (await manifest.json()).map((file) => new URL(file, scopeRoot).toString());

  const urls = [...new Set([...refs, ...files])];
  const fetched = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!isAsset(res)) throw new Error('Unable to fetch ' + url);
      return [url, res];
    }),
  );

  const cache = await caches.open(CACHE);
  try {
    await Promise.all([
      ...shellRoutes.map((route) =>
        cache.put(new URL(route, scopeRoot).toString(), response.clone()),
      ),
      ...fetched.map(([url, res]) => cache.put(url, res)),
    ]);
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
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

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The build marker must always be the deployed one, never a cached copy.
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('/precache.json')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
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
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Built files are content-hashed: the stored copy is right whatever Origin asked (Vary: Origin).
      const hit = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
      if (hit) return hit;
      try {
        const response = await fetch(request);
        if (isAsset(response)) await cache.put(request, response.clone());
        return response;
      } catch {
        return Response.error();
      }
    })(),
  );
});
