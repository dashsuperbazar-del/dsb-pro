/* global fetch, Response, URL, Headers */
// SF7: public item photo for the online shop. Serves a photo ONLY when public_item_image_path says the item is
// published and active in an enabled shop (the database decides; the path never comes from the caller).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9-]{3,40}$/;

function plain(message, status) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return plain('Method not allowed.', 405);
  if (!env.ITEM_IMAGES || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return plain('Not configured.', 503);
  const url = new URL(request.url);
  const shop = (url.searchParams.get('shop') || '').toLowerCase();
  const item = (url.searchParams.get('item') || '').toLowerCase();
  if (!SLUG.test(shop) || !UUID.test(item)) return plain('Not found.', 404);
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/public_item_image_path`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_slug: shop, p_item: item }),
  }).catch(() => null);
  if (!r || !r.ok) return plain('Not found.', 404);
  const path = await r.json().catch(() => null);
  if (typeof path !== 'string' || !path || path.includes('..') || !path.includes('/items/')) return plain('Not found.', 404);
  const object = await env.ITEM_IMAGES.get(path);
  if (!object) return plain('Not found.', 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=3600');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(object.body, { headers });
}
