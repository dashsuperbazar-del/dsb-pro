export function toSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'shop';
}

function randomSuffix(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// create_tenant() (supabase/migrations/0007_tenant_lifecycle_rpcs.sql) requires
// a globally-unique slug (tenants_slug_key). The UI only ever asks for a shop
// name (spec §4 "Minimal: shop name only"), so a random suffix is always
// appended rather than asking the user to pick a slug or resolve a collision.
export function makeTenantSlug(name: string): string {
  return `${toSlug(name)}-${randomSuffix(4)}`;
}
