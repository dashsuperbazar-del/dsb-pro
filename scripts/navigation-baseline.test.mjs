import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedBaselineUrl, requestCategory, summarize } from './navigation-baseline.mjs';

test('nearest-rank quantiles retain slow-tail samples without changing original order', () => {
  const values = [300, 20, 10, 50, 40, 30, 60];
  assert.deepEqual(summarize(values), { count: 7, min: 10, p50: 40, p95: 300, max: 300 });
  assert.deepEqual(values, [300, 20, 10, 50, 40, 30, 60]);
  assert.equal(summarize([0]).p95, 0);
});

test('empty, negative and non-finite samples cannot produce a green timing summary', () => {
  for (const values of [[], [-1], [NaN], [Infinity], [1, -1]])
    assert.throws(() => summarize(values));
});

test('baseline targets allow only explicit disposable app/API ports and literal loopback hosts', () => {
  for (const url of [
    'http://127.0.0.1:4173/',
    'http://localhost:54321/rest/v1/items',
    'http://[::1]:4173/',
  ])
    assert.equal(allowedBaselineUrl(url), true);
  for (const url of [
    'https://dsb-pro.pages.dev/',
    'https://project.supabase.co/',
    'http://localhost.evil.test:4173/',
    'http://127.0.0.1:54322/',
    'http://user:secret@localhost:4173/',
    'file:///tmp/index.html',
    'bad',
  ])
    assert.equal(allowedBaselineUrl(url), false);
});

test('request categories never include query values, tenant IDs, tokens or arbitrary URL paths', () => {
  assert.equal(
    requestCategory('http://localhost:54321/rest/v1/rpc/current_tenant_id?token=secret'),
    'rpc:current_tenant_id',
  );
  assert.equal(
    requestCategory('http://localhost:54321/rest/v1/items?tenant_id=eq.private-id'),
    'table:items',
  );
  assert.equal(
    requestCategory('http://localhost:54321/auth/v1/token?refresh_token=secret'),
    'auth',
  );
  assert.equal(
    requestCategory('http://localhost:54321/storage/private-customer-name'),
    'app-or-other',
  );
});
