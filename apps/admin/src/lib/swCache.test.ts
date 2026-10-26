// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';

// Runs public/sw.js against stubbed worker globals (D2 review): the worker must never store the SPA
// fallback page under a build-file URL, and a failed install must leave no half-filled cache.
type Listener = (event: unknown) => void;
const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

function boot(fetchImpl: (req: Request) => Promise<Response>) {
  const listeners: Record<string, Listener> = {};
  const stores = new Map<string, Map<string, Response>>();
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      put: vi.fn(async (r: Request | string, res: Response) => {
        m.set(typeof r === 'string' ? r : r.url, res);
      }),
      match: vi.fn(async (r: Request | string) => m.get(typeof r === 'string' ? r : r.url)),
    };
  };
  const caches = {
    open: async (n: string) => open(n),
    delete: vi.fn(async (n: string) => stores.delete(n)),
    keys: async () => [...stores.keys()],
  };
  const self = {
    location: { href: 'https://shop.test/sw.js?v=t', origin: 'https://shop.test' },
    registration: { scope: 'https://shop.test/' },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  new Function('self', 'caches', 'fetch', 'URL', 'Request', 'Response', source)(
    self,
    caches,
    fetchImpl,
    URL,
    Request,
    Response,
  );
  return { listeners, stores };
}
const html = (body = '<script src="/assets/a.js"></script>') =>
  new Response(body, { headers: { 'content-type': 'text/html' } });
const js = () => new Response('x', { headers: { 'content-type': 'text/javascript' } });
const json = (body: string) =>
  new Response(body, { headers: { 'content-type': 'application/json' } });

test('an HTML 200 for a build-file URL is served but never cached', async () => {
  const { listeners, stores } = boot(async () => html('<!doctype html>'));
  let answer: Promise<Response> | undefined;
  listeners.fetch({
    request: new Request('https://shop.test/assets/ghost-1.js'),
    respondWith: (p: Promise<Response>) => (answer = p),
  });
  expect((await answer!).status).toBe(200);
  expect([...(stores.get('dsb-pro-shell-t')?.keys() ?? [])]).toEqual([]);
});

test('a real build file is cached', async () => {
  const { listeners, stores } = boot(async () => js());
  let answer: Promise<Response> | undefined;
  listeners.fetch({
    request: new Request('https://shop.test/assets/real-1.js'),
    respondWith: (p: Promise<Response>) => (answer = p),
  });
  await answer;
  expect([...stores.get('dsb-pro-shell-t')!.keys()]).toEqual([
    'https://shop.test/assets/real-1.js',
  ]);
});

test('install writes nothing when one build file cannot be fetched', async () => {
  const { listeners, stores } = boot(async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/') return html();
    if (path === '/precache.json') return json('["assets/a.js","assets/b.js"]');
    if (path === '/assets/b.js') return html(); // SPA fallback instead of the chunk
    return js();
  });
  let done: Promise<unknown> | undefined;
  listeners.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
  await expect(done).rejects.toThrow('Unable to fetch');
  expect(stores.has('dsb-pro-shell-t')).toBe(false);
});

test('install fills the cache with the shell routes and every build file', async () => {
  const { listeners, stores } = boot(async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/') return html();
    if (path === '/precache.json') return json('["assets/a.js","assets/rare.js"]');
    return js();
  });
  let done: Promise<unknown> | undefined;
  listeners.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  const keys = [...stores.get('dsb-pro-shell-t')!.keys()];
  expect(keys).toContain('https://shop.test/assets/rare.js');
  expect(keys).toContain('https://shop.test/pos');
});
