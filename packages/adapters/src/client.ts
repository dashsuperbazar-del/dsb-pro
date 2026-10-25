// The only file in this package (and the only file in the whole repo outside
// apps/admin's Phase 0 HealthPanel, which predates this package) allowed to
// import @supabase/supabase-js directly — DSB_PRO_BUILD_PLAN.md §4's adapter
// rule: "no provider name appears outside packages/adapters."
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppDatabase } from '@dsb-pro/db';

export type DsbSupabaseClient = SupabaseClient<AppDatabase>;

let client: DsbSupabaseClient | undefined;

// RPCs whose request must outlive the page: a user who taps "Set price" and immediately leaves or reloads
// must not have the write cancelled by the browser. keepalive lets the request finish after unload
// (small JSON bodies only, well under the 64 KiB keepalive budget).
const KEEPALIVE_RPCS = ['/rest/v1/rpc/set_item_price'];
export function keepaliveFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = (() => {
    try {
      return new URL(href).pathname;
    } catch {
      return href;
    }
  })();
  const keep = (init?.method ?? 'GET').toUpperCase() === 'POST' && KEEPALIVE_RPCS.includes(path);
  return fetch(input, keep ? { ...init, keepalive: true } : init);
}

export function getSupabaseClient(): DsbSupabaseClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set.');
  }

  client = createClient<AppDatabase>(url, anonKey, { global: { fetch: keepaliveFetch } });
  return client;
}

// Test-only escape hatch: vitest specs inject a mock client instead of
// hitting the network. Never called from apps/admin.
export function __setSupabaseClientForTest(mock: DsbSupabaseClient): void {
  client = mock;
}
