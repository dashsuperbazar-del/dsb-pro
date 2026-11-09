// Phone-local state for the public shop, per shop slug: the cart, the order being sent, and this phone's past
// orders (reference + secret token). Nothing here is trusted by the server: prices are re-checked on submit.
export type CartLine = {
  itemId: string;
  name: string;
  level: 1 | 2 | 3;
  unit: string;
  pricePaise: string;
  qty: number;
};
export type Pending = {
  requestId: string;
  token: string;
  payload: Record<string, unknown>;
};
export type MyOrder = {
  ref: string;
  token: string;
  placedAt: string;
  /** Lines as ordered, for "Order again" and "Buy it again" (prices are re-checked by the server). */
  lines?: CartLine[];
  /** Last status seen, for the dot in My orders. */
  status?: string;
};
export type Who = {
  name: string;
  phone: string;
  address: string;
  mode: 'pickup' | 'delivery' | '';
};

const key = (slug: string, what: string) => `dsb-shop:${slug}:${what}`;
function read<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode or full: the cart just does not survive a reload */
  }
}

export const loadCart = (slug: string) => read<CartLine[]>(key(slug, 'cart'), []);
export const saveCart = (slug: string, c: CartLine[]) => write(key(slug, 'cart'), c);
export const loadPending = (slug: string) => read<Pending | null>(key(slug, 'pending'), null);
export const savePending = (slug: string, p: Pending | null) => write(key(slug, 'pending'), p);
export const loadMyOrders = (slug: string) => read<MyOrder[]>(key(slug, 'orders'), []);
export function rememberOrder(slug: string, o: MyOrder) {
  const all = [o, ...loadMyOrders(slug).filter((x) => x.ref !== o.ref)].slice(0, 20);
  write(key(slug, 'orders'), all);
}

/** 32 random bytes as hex: the secret that lets only this phone see the order status. */
export function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Display-only estimate; the server prices the order. Integer paise, rounded like the server. */
export function lineEstimate(l: CartLine): bigint {
  return BigInt(Math.round(l.qty * Number(l.pricePaise)));
}

/** Merge a line into the cart (same item + unit adds up). */
export function addToCart(cart: CartLine[], line: CartLine): CartLine[] {
  const i = cart.findIndex((c) => c.itemId === line.itemId && c.level === line.level);
  if (i < 0) return [...cart, line];
  return cart.map((c, n) =>
    n === i ? { ...c, qty: Math.round((c.qty + line.qty) * 1000) / 1000 } : c,
  );
}

/**
 * UPI deep link (NPCI upi://pay) for the exact order amount: opens GPay / PhonePe / Paytm with everything filled
 * in. The payment goes straight to the shop; nothing here proves it was paid (the shop checks its UPI app).
 */
export function upiPayLink(
  upiId: string,
  payee: string | null,
  totalPaise: string,
  ref: string,
): string {
  const p = BigInt(totalPaise);
  const amount = `${p / 100n}.${String(p % 100n).padStart(2, '0')}`;
  const q = new URLSearchParams({
    pa: upiId,
    pn: payee || 'Shop',
    am: amount,
    cu: 'INR',
    tn: `Order ${ref}`,
  });
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
}

export const loadWho = (slug: string) =>
  read<Who>(key(slug, 'who'), { name: '', phone: '', address: '', mode: '' });
export const saveWho = (slug: string, w: Who) => write(key(slug, 'who'), w);
export function setOrderStatus(slug: string, ref: string, status: string) {
  const all = loadMyOrders(slug).map((o) => (o.ref === ref ? { ...o, status } : o));
  write(key(slug, 'orders'), all);
}
export const loadCatalogCache = <T>(slug: string) =>
  read<{ at: number; items: T[] } | null>(key(slug, 'catalog'), null);
export const saveCatalogCache = <T>(slug: string, items: T[]) =>
  write(key(slug, 'catalog'), { at: Date.now(), items });

/** Indian mobile: 10 digits starting 6-9 (a leading 0 or +91 is dropped). */
export function mobile10(v: string): string | null {
  const d = v.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** Shareable tracking link: the order number and its secret travel in the #fragment (never sent to a server). */
export const trackHash = (ref: string, token: string) => `#/t/${ref}.${token}`;
export function parseTrackHash(h: string): { ref: string; token: string } | null {
  const m = /^#\/t\/([A-Z2-9]{10})\.([0-9a-f]{64})$/.exec(h);
  return m ? { ref: m[1]!, token: m[2]! } : null;
}

/** Steps shown on the tracking page (pickup orders never go out for delivery). */
export function orderSteps(
  status: string,
  delivery: boolean,
): { key: string; label: string; state: 'done' | 'now' | '' }[] {
  const flow: [string, string][] = [
    ['NEW', 'Order placed'],
    ['CONFIRMED', 'Confirmed by shop'],
    ['PREPARING', 'Being packed'],
    ['READY', delivery ? 'Packed and ready' : 'Ready for pickup'],
    ...(delivery ? ([['OUT_FOR_DELIVERY', 'Out for delivery']] as [string, string][]) : []),
    ['DELIVERED', delivery ? 'Delivered' : 'Picked up'],
  ];
  const at = flow.findIndex((f) => f[0] === status);
  return flow.map(([key, label], i) => ({
    key,
    label,
    state: i < at ? 'done' : i === at ? 'now' : '',
  }));
}
