import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import './style.css';
import {
  ShopError,
  getCatalog,
  getCategories,
  getShop,
  orderStatus,
  placeOrder,
  rupees,
  type OrderStatus,
  type Product,
  type Shop,
} from './api';
import {
  addToCart,
  lineEstimate,
  loadCart,
  loadMyOrders,
  loadPending,
  newToken,
  rememberOrder,
  saveCart,
  savePending,
  type CartLine,
} from './store';

// One shop per site: ?shop=<slug> overrides the build default (VITE_SHOP_SLUG).
const SLUG = (
  new URLSearchParams(location.search).get('shop') ||
  (import.meta.env.VITE_SHOP_SLUG as string | undefined) ||
  ''
)
  .toLowerCase()
  .trim();
const STATUS: Record<string, string> = {
  NEW: 'Received',
  CONFIRMED: 'Confirmed by the shop',
  PREPARING: 'Being packed',
  READY: 'Ready',
  DELIVERED: 'Completed',
  CANCELLED: 'Cancelled',
};

function useHash() {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const on = () => setH(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return h;
}

function App() {
  const hash = useHash();
  const [shop, setShop] = useState<Shop | null | undefined>(undefined);
  const [cart, setCart] = useState<CartLine[]>(() => (SLUG ? loadCart(SLUG) : []));
  const [error, setError] = useState('');
  useEffect(() => {
    if (!SLUG) return setShop(null);
    getShop(SLUG).then(setShop, (e: unknown) => {
      setShop(null);
      setError(e instanceof Error ? e.message : String(e));
    });
  }, []);
  useEffect(() => saveCart(SLUG, cart), [cart]);
  if (shop === undefined) return <p class="pad">Loading…</p>;
  if (!shop)
    return (
      <main class="pad">
        <h1>Shop not available</h1>
        <p>{error || 'This shop is not taking online orders right now.'}</p>
      </main>
    );
  const count = cart.length;
  const view = hash.startsWith('#/order/')
    ? 'order'
    : hash === '#/cart'
      ? 'cart'
      : hash === '#/mine'
        ? 'mine'
        : 'shop';
  return (
    <>
      <header class="bar">
        <a href="#/" class="brand">
          {shop.name}
        </a>
        <nav>
          <a href="#/mine">My orders</a>
          <a href="#/cart" class="cart-link" aria-label={`Cart, ${count} items`}>
            Cart {count > 0 && <span class="badge">{count}</span>}
          </a>
        </nav>
      </header>
      {!navigator.onLine && (
        <p class="note warn" role="status">
          You are offline. You can look around, but placing an order needs a connection.
        </p>
      )}
      {view === 'shop' && <Catalog shop={shop} onAdd={(l) => setCart((c) => addToCart(c, l))} />}
      {view === 'cart' && <Checkout shop={shop} cart={cart} setCart={setCart} />}
      {view === 'order' && <Status ref_={decodeURIComponent(hash.slice(8))} />}
      {view === 'mine' && <MyOrders />}
      <footer class="pad muted">
        {shop.contact && <span>Contact: {shop.contact}. </span>}
        {shop.orderHours && <span>Orders: {shop.orderHours}.</span>}
      </footer>
    </>
  );
}

function Catalog({ shop, onAdd }: { shop: Shop; onAdd: (l: CartLine) => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<Product[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState('');
  useEffect(() => void getCategories(shop.slug).then(setCats, () => undefined), []);
  async function load(reset: boolean) {
    setError('');
    try {
      const last = reset ? null : items[items.length - 1];
      const r = await getCatalog(shop.slug, q.trim() || null, cat, last ? { name: last.name, id: last.id } : null);
      const next = r?.items ?? [];
      setItems(reset ? next : [...items, ...next]);
      setMore(!!r?.more);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    const t = setTimeout(() => void load(true), 250);
    return () => clearTimeout(t);
  }, [q, cat]);
  return (
    <main class="pad">
      <input
        type="search"
        class="search"
        placeholder="Search items"
        aria-label="Search items"
        maxLength={60}
        value={q}
        onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
      />
      {cats.length > 0 && (
        <div class="chips" role="list">
          <button type="button" class={cat === null ? 'chip on' : 'chip'} onClick={() => setCat(null)}>
            All
          </button>
          {cats.map((c) => (
            <button
              type="button"
              key={c.id}
              class={cat === c.id ? 'chip on' : 'chip'}
              onClick={() => setCat(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {error && <p class="note warn">{error}</p>}
      {added && (
        <p class="note ok" role="status">
          {added} <a href="#/cart">View cart</a>
        </p>
      )}
      <div class="grid">
        {items.map((p) => (
          <ProductCard
            key={p.id}
            p={p}
            onAdd={(l) => {
              onAdd(l);
              setAdded(`Added ${l.qty} ${l.unit} ${l.name}.`);
            }}
          />
        ))}
      </div>
      {items.length === 0 && !error && <p class="muted">No items found.</p>}
      {more && (
        <button type="button" class="wide" onClick={() => void load(false)}>
          Show more
        </button>
      )}
    </main>
  );
}

function ProductCard({ p, onAdd }: { p: Product; onAdd: (l: CartLine) => void }) {
  const [level, setLevel] = useState(p.units[p.units.length - 1]!.level);
  const [qty, setQty] = useState('1');
  const unit = p.units.find((u) => u.level === level) ?? p.units[0]!;
  const n = Number(qty);
  const ok = Number.isFinite(n) && n > 0 && n <= 10000 && /^\d+(\.\d{1,3})?$/.test(qty);
  return (
    <article class="card">
      <h3>{p.name}</h3>
      {p.category && <small class="muted">{p.category}</small>}
      {p.description && <p class="desc">{p.description}</p>}
      <p class="price">
        {rupees(unit.pricePaise)} <small>/ {unit.unit}</small>
      </p>
      {!p.inStock && <p class="note warn">Out of stock</p>}
      <div class="row">
        {p.units.length > 1 && (
          <select
            aria-label={`Unit for ${p.name}`}
            value={level}
            onChange={(e) => setLevel(Number((e.currentTarget as HTMLSelectElement).value) as 1 | 2 | 3)}
          >
            {p.units.map((u) => (
              <option key={u.level} value={u.level}>
                {u.unit}
              </option>
            ))}
          </select>
        )}
        <input
          class="qty"
          inputMode="decimal"
          aria-label={`Quantity of ${p.name}`}
          value={qty}
          onInput={(e) => setQty((e.currentTarget as HTMLInputElement).value)}
        />
        <button
          type="button"
          class="primary"
          disabled={!p.inStock || !ok}
          onClick={() =>
            onAdd({ itemId: p.id, name: p.name, level: unit.level, unit: unit.unit, pricePaise: unit.pricePaise, qty: n })
          }
        >
          Add
        </button>
      </div>
    </article>
  );
}

function Checkout({
  shop,
  cart,
  setCart,
}: {
  shop: Shop;
  cart: CartLine[];
  setCart: (c: CartLine[]) => void;
}) {
  const [mode, setMode] = useState<'pickup' | 'delivery'>(shop.pickup ? 'pickup' : 'delivery');
  const [slot, setSlot] = useState(shop.deliverySlots[0] ?? '');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sub = useMemo(() => cart.reduce((n, l) => n + lineEstimate(l), 0n), [cart]);
  const free = shop.freeDeliveryAbovePaise !== null && sub >= BigInt(shop.freeDeliveryAbovePaise);
  const fee = mode === 'delivery' && !free ? BigInt(shop.deliveryFeePaise) : 0n;
  const belowMin = sub < BigInt(shop.minOrderPaise);

  async function submit(ev: Event) {
    ev.preventDefault();
    if (trap) return; // bots fill hidden fields
    setError('');
    setBusy(true);
    // The request id and token are saved BEFORE sending, so a lost reply is retried as the same order.
    const pending = loadPending(shop.slug) ?? {
      requestId: crypto.randomUUID(),
      token: newToken(),
      payload: {},
    };
    savePending(shop.slug, pending);
    try {
      const r = await placeOrder({
        slug: shop.slug,
        requestId: pending.requestId,
        token: pending.token,
        fulfilment: mode,
        slot: mode === 'delivery' ? slot || null : null,
        contact: { name: name.trim(), phone: phone.trim(), ...(mode === 'delivery' ? { address: address.trim() } : {}) },
        lines: cart.map((l) => ({ itemId: l.itemId, unitLevel: l.level, qty: String(l.qty) })),
        note: note.trim() || null,
      });
      rememberOrder(shop.slug, { ref: r.ref, token: pending.token, placedAt: new Date().toISOString() });
      savePending(shop.slug, null);
      setCart([]);
      location.hash = `#/order/${r.ref}`;
    } catch (e) {
      // A refusal (not a lost reply) frees the request id for a corrected order.
      if (e instanceof ShopError && !/connection/i.test(e.message)) savePending(shop.slug, null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (cart.length === 0)
    return (
      <main class="pad">
        <h1>Your cart is empty</h1>
        <a href="#/">Browse items</a>
      </main>
    );
  return (
    <main class="pad">
      <h1>Your cart</h1>
      <ul class="lines">
        {cart.map((l, i) => (
          <li key={`${l.itemId}:${l.level}`}>
            <span>
              {l.name} · {l.qty} {l.unit}
            </span>
            <span>{rupees(lineEstimate(l).toString())}</span>
            <button
              type="button"
              aria-label={`Remove ${l.name}`}
              onClick={() => setCart(cart.filter((_, n) => n !== i))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <p>
        Items {rupees(sub.toString())}
        {mode === 'delivery' && <> · Delivery {fee === 0n ? 'free' : rupees(fee.toString())}</>} ·{' '}
        <strong>About {rupees((sub + fee).toString())}</strong>
      </p>
      <p class="muted">The shop confirms the final price when it receives your order.</p>
      {belowMin && <p class="note warn">Minimum order is {rupees(shop.minOrderPaise)}.</p>}
      <form onSubmit={submit}>
        <fieldset>
          <legend>How do you want it?</legend>
          {shop.pickup && (
            <label>
              <input type="radio" checked={mode === 'pickup'} onChange={() => setMode('pickup')} /> Pick up at the
              shop
            </label>
          )}
          {shop.delivery && (
            <label>
              <input type="radio" checked={mode === 'delivery'} onChange={() => setMode('delivery')} /> Deliver to
              me
            </label>
          )}
          {mode === 'pickup' && shop.pickupNote && <p class="muted">{shop.pickupNote}</p>}
          {mode === 'delivery' && shop.deliveryNote && <p class="muted">{shop.deliveryNote}</p>}
          {mode === 'delivery' && shop.deliverySlots.length > 0 && (
            <label>
              Delivery time{' '}
              <select value={slot} onChange={(e) => setSlot((e.currentTarget as HTMLSelectElement).value)}>
                {shop.deliverySlots.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        <label>
          Your name <input required maxLength={80} value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label>
          Phone{' '}
          <input
            required
            type="tel"
            inputMode="tel"
            maxLength={20}
            value={phone}
            onInput={(e) => setPhone((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {mode === 'delivery' && (
          <label>
            Address{' '}
            <textarea
              required
              maxLength={300}
              rows={2}
              value={address}
              onInput={(e) => setAddress((e.currentTarget as HTMLTextAreaElement).value)}
            />
          </label>
        )}
        <label>
          Note for the shop (optional){' '}
          <input maxLength={300} value={note} onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label class="trap" aria-hidden="true">
          Leave empty <input tabIndex={-1} autoComplete="off" value={trap} onInput={(e) => setTrap((e.currentTarget as HTMLInputElement).value)} />
        </label>
        {error && (
          <p class="note warn" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="primary wide" disabled={busy || belowMin || !navigator.onLine}>
          {busy ? 'Placing order…' : 'Place order'}
        </button>
      </form>
    </main>
  );
}

function Status({ ref_ }: { ref_: string }) {
  const mine = loadMyOrders(SLUG).find((o) => o.ref === ref_);
  const [s, setS] = useState<OrderStatus | null | undefined>(undefined);
  useEffect(() => {
    if (!mine) return setS(null);
    const get = () => orderStatus(ref_, mine.token).then(setS, () => undefined);
    void get();
    const t = setInterval(get, 30000);
    return () => clearInterval(t);
  }, [ref_]);
  if (s === undefined) return <p class="pad">Loading…</p>;
  if (!s)
    return (
      <main class="pad">
        <h1>Order {ref_}</h1>
        <p>This order can only be seen on the phone that placed it.</p>
      </main>
    );
  return (
    <main class="pad">
      <h1>Order {s.ref}</h1>
      <p class="status">{STATUS[s.status] ?? s.status}</p>
      {s.cancelReason && <p class="muted">{s.cancelReason}</p>}
      <p>
        {s.fulfilment === 'delivery' ? `Delivery${s.deliverySlot ? `, ${s.deliverySlot}` : ''}` : 'Pickup at the shop'}
        {['NEW', 'CONFIRMED', 'PREPARING', 'READY'].includes(s.status) &&
          ` · held until ${new Date(s.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
      </p>
      <ul class="lines">
        {s.items.map((i, n) => (
          <li key={n}>
            <span>
              {i.name} · {i.qty} {i.unit}
            </span>
            <span>{rupees(i.lineTotalPaise)}</span>
          </li>
        ))}
      </ul>
      {BigInt(s.deliveryFeePaise) > 0n && <p>Delivery {rupees(s.deliveryFeePaise)}</p>}
      <p>
        <strong>Total {rupees(s.totalPaise)}</strong> · pay at {s.fulfilment === 'delivery' ? 'delivery' : 'the shop'}
      </p>
      <p class="muted">Keep this page: it updates by itself. Your order number is {s.ref}.</p>
    </main>
  );
}

function MyOrders() {
  const list = loadMyOrders(SLUG);
  return (
    <main class="pad">
      <h1>My orders</h1>
      {list.length === 0 && <p class="muted">No orders on this phone yet.</p>}
      <ul class="lines">
        {list.map((o) => (
          <li key={o.ref}>
            <a href={`#/order/${o.ref}`}>{o.ref}</a>
            <span class="muted">{new Date(o.placedAt).toLocaleDateString()}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
