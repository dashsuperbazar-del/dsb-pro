// The only file in this package (and the only file in the whole repo outside
// apps/admin's Phase 0 HealthPanel, which predates this package) allowed to
// import @supabase/supabase-js directly — DSB_PRO_BUILD_PLAN.md §4's adapter
// rule: "no provider name appears outside packages/adapters."
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set.');
  }

  client = createClient(url, anonKey);
  return client;
}

// Test-only escape hatch: vitest specs inject a mock client instead of
// hitting the network. Never called from apps/admin.
export function __setSupabaseClientForTest(mock: SupabaseClient): void {
  client = mock;
}
