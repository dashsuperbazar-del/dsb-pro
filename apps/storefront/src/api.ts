// Public shop API: only the anon-callable database functions (mig 0078/0079). No prices, totals or stock are ever
// decided here; the server prices every order. The anon key is public by design.
const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export type Unit = { level: 1 | 2 | 3; unit: string; pricePaise: string };
export type Product = {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  units: Unit[];
  inStock: boolean;
  hasImage?: boolean;
};
export type Shop = {
  slug: string;
  name: string;
  contact: string | null;
  orderHours: string | null;
  pickup: boolean;
  pickupNote: string | null;
  delivery: boolean;
  deliveryFeePaise: string;
  minOrderPaise: string;
  freeDeliveryAbovePaise: string | null;
  deliverySlots: string[];
  deliveryNote: string | null;
  maxLines: number;
  upiId: string | null;
  upiName: string | null;
  minDeliveryPaise?: string;
  open?: boolean;
  closedMessage?: string | null;
  banner?: string | null;
  address?: string | null;
  mapUrl?: string | null;
  licence?: string | null;
};
export type OrderStatus = {
  ref: string;
  status: string;
  fulfilment: 'pickup' | 'delivery';
  deliverySlot: string | null;
  totalPaise: string;
  deliveryFeePaise: string;
  placedAt: string;
  expiresAt: string;
  cancelReason: string | null;
  items: { name: string; unit: string; qty: string; lineTotalPaise: string }[];
};

/** A refusal from the server, with its plain-sentence message (DSB_* code stripped). */
export class ShopError extends Error {}

async function rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${ANON}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ShopError('No connection. Check your internet and try again.');
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = 'Something went wrong. Please try again.';
    try {
      const m = String((JSON.parse(text) as { message?: string }).message ?? '');
      const hit = /DSB_[A-Z_]+:\s*(.+)$/.exec(m);
      if (hit) msg = hit[1]!.charAt(0).toUpperCase() + hit[1]!.slice(1);
    } catch {
      /* keep the generic message */
    }
    throw new ShopError(msg);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export const getShop = (slug: string) => rpc<Shop | null>('public_storefront', { p_slug: slug });
export const getCategories = (slug: string) =>
  rpc<{ id: string; name: string }[]>('public_catalog_categories', { p_slug: slug });
export const getCatalog = (
  slug: string,
  query: string | null,
  category: string | null,
  after: { name: string; id: string } | null,
) =>
  rpc<{ items: Product[]; more: boolean } | null>('public_catalog', {
    p_slug: slug,
    p_query: query,
    p_category: category,
    p_after_name: after?.name ?? null,
    p_after_id: after?.id ?? null,
    p_limit: 50,
  });
export const placeOrder = (args: {
  slug: string;
  requestId: string;
  token: string;
  fulfilment: 'pickup' | 'delivery';
  slot: string | null;
  contact: { name: string; phone: string; address?: string };
  lines: { itemId: string; unitLevel: number; qty: string }[];
  note: string | null;
}) =>
  rpc<{ ref: string; status: string; totalPaise: string; expiresAt: string; replayed: boolean }>(
    'place_order',
    {
      p_slug: args.slug,
      p_request_id: args.requestId,
      p_token: args.token,
      p_fulfilment: args.fulfilment,
      p_delivery_slot: args.slot,
      p_contact: args.contact,
      p_lines: args.lines,
      p_note: args.note,
    },
  );
export const orderStatus = (ref: string, token: string) =>
  rpc<OrderStatus | null>('public_order_status', { p_ref: ref, p_token: token });

export const rupees = (paise: string | number) => {
  const n = BigInt(paise);
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? '−' : ''}₹${(a / 100n).toLocaleString('en-IN')}.${String(a % 100n).padStart(2, '0')}`;
};
export const findOrder = (slug: string, phone: string, ref: string) =>
  rpc<OrderStatus | null>('find_order', { p_slug: slug, p_phone: phone, p_ref: ref });

/** Public photo of a published item (served by the shop app's image endpoint). */
const IMG_BASE = (
  (import.meta.env.VITE_SHOP_IMAGE_BASE as string | undefined) || 'https://dsb-pro.pages.dev'
).replace(/\/$/, '');
export const imageUrl = (slug: string, itemId: string) =>
  `${IMG_BASE}/api/shop-image?shop=${encodeURIComponent(slug)}&item=${encodeURIComponent(itemId)}`;
