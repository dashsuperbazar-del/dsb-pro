import { afterEach, expect, test, vi } from 'vitest';
import { keepaliveFetch } from './client';

afterEach(() => vi.unstubAllGlobals());

test('set_item_price is sent with keepalive so leaving the page cannot cancel it', async () => {
  const f = vi.fn().mockResolvedValue(new Response('"id"'));
  vi.stubGlobal('fetch', f);
  await keepaliveFetch('http://x.test/rest/v1/rpc/set_item_price', { method: 'POST', body: '{}' });
  expect(f.mock.calls[0][1]).toMatchObject({ method: 'POST', keepalive: true });
});

test('other requests are sent unchanged', async () => {
  const f = vi.fn().mockResolvedValue(new Response('[]'));
  vi.stubGlobal('fetch', f);
  const init = { method: 'POST', body: '{}' };
  await keepaliveFetch('http://x.test/rest/v1/rpc/post_purchase', init);
  await keepaliveFetch('http://x.test/rest/v1/rpc/set_item_price', { method: 'GET' });
  expect(f.mock.calls[0][1]).toBe(init);
  expect(f.mock.calls[1][1]).not.toHaveProperty('keepalive');
});
