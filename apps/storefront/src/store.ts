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
export type MyOrder = { ref: string; token: string; placedAt: string };

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
  return cart.map((c, n) => (n === i ? { ...c, qty: Math.round((c.qty + line.qty) * 1000) / 1000 } : c));
}
