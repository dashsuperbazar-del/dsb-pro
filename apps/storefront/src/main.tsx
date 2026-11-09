import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import './style.css';
import {
  ShopError,
  findOrder,
  getCatalog,
  getCategories,
  getShop,
  imageUrl,
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
  loadCatalogCache,
  loadMyOrders,
  loadPending,
  loadWho,
  mobile10,
  newToken,
  orderSteps,
  parseTrackHash,
  rememberOrder,
  saveCart,
  saveCatalogCache,
  savePending,
  saveWho,
  setOrderStatus,
  trackHash,
  upiPayLink,
  type CartLine,
} from './store';

// Public online shop (old DSB shop.html experience on the server-priced order model). One shop per site:
// ?shop=<slug> overrides the build default. Routes live in the #fragment so tracking secrets never reach a server.
const SLUG = (
  new URLSearchParams(location.search).get('shop') ||
  (import.meta.env.VITE_SHOP_SLUG as string | undefined) ||
  ''
)
  .toLowerCase()
  .trim();
const LIVE = ['NEW', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'];
const STATUS: Record<string, string> = {
  NEW: 'Order placed',
  CONFIRMED: 'Confirmed by the shop',
  PREPARING: 'Being packed',
  READY: 'Ready',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Completed',
  CANCELLED: 'Cancelled',
};
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tint = (s: string) =>
  `hsl(${[...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7)} 45% 42%)`;
const initials = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
const defaultUnit = (p: Product) => p.units[p.units.length - 1]!;

function useHash() {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const on = () => {
      setH(location.hash);
      window.scrollTo(0, 0);
    };
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
      setError(err(e));
    });
  }, []);
  useEffect(() => saveCart(SLUG, cart), [cart]);
  if (shop === undefined) return <Skeleton />;
  if (!shop)
    return (
      <main class="pad">
        <h1>Shop not available</h1>
        <p>{error || 'This shop is not taking online orders right now.'}</p>
      </main>
    );
  const track = parseTrackHash(hash);
  const view = track
    ? 'track'
    : hash.startsWith('#/order/')
      ? 'order'
      : (['#/cart', '#/mine', '#/info', '#/find'].find((h) => h === hash) ?? '#/').slice(2) ||
        'shop';
  const count = cart.length;
  const sub = cart.reduce((n, l) => n + lineEstimate(l), 0n);
  return (
    <>
      <header class="bar">
        <a href="#/" class="brand">
          {shop.name}
        </a>
        <nav>
          <a href="#/info" aria-label="Shop information">
            ⓘ
          </a>
          <a href="#/mine">My orders</a>
        </nav>
      </header>
      {shop.open === false && (
        <p class="note warn" role="status">
          {shop.closedMessage || 'The shop is closed right now.'} You can look around; ordering
          opens again soon.
        </p>
      )}
      {!navigator.onLine && (
        <p class="note warn" role="status">
          You are offline. You can look around, but placing an order needs a connection.
        </p>
      )}
      {view === 'shop' && <Home shop={shop} cart={cart} setCart={setCart} />}
      {view === 'cart' && <Checkout shop={shop} cart={cart} setCart={setCart} />}
      {view === 'order' && <MyOrderStatus shop={shop} ref_={decodeURIComponent(hash.slice(8))} />}
      {view === 'track' && <Tracking shop={shop} ref_={track!.ref} token={track!.token} />}
      {view === 'mine' && <MyOrders setCart={setCart} />}
      {view === 'info' && <Info shop={shop} />}
      {view === 'find' && <Find shop={shop} />}
      {count > 0 && view !== 'cart' && (
        <a class="cartbar" href="#/cart">
          <span>
            {count} {count === 1 ? 'item' : 'items'} · {rupees(sub.toString())}
          </span>
          <strong>View basket ›</strong>
        </a>
      )}
    </>
  );
}

function Skeleton() {
  return (
    <main class="pad" aria-busy="true">
      <div class="sk sk-bar" />
      <div class="grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div class="card sk" key={i} style={{ height: '180px' }} />
        ))}
      </div>
    </main>
  );
}

function Thumb({ p, big = false }: { p: Product; big?: boolean }) {
  const [broken, setBroken] = useState(false);
  return p.hasImage && !broken ? (
    <img
      class={big ? 'thumb big' : 'thumb'}
      src={imageUrl(SLUG, p.id)}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  ) : (
    <div
      class={big ? 'thumb big ph' : 'thumb ph'}
      style={{ background: tint(p.name) }}
      aria-hidden="true"
    >
      {initials(p.name)}
    </div>
  );
}

function Stepper({
  p,
  cart,
  setCart,
}: {
  p: Product;
  cart: CartLine[];
  setCart: (c: CartLine[]) => void;
}) {
  const u = defaultUnit(p);
  const line = cart.find((c) => c.itemId === p.id && c.level === u.level);
  const qty = line?.qty ?? 0;
  const set = (q: number) => {
    const n = Math.max(0, Math.min(100, q));
    const rest = cart.filter((c) => !(c.itemId === p.id && c.level === u.level));
    setCart(
      n === 0
        ? rest
        : line
          ? cart.map((c) => (c === line ? { ...c, qty: n } : c))
          : [
              ...rest,
              {
                itemId: p.id,
                name: p.name,
                level: u.level,
                unit: u.unit,
                pricePaise: u.pricePaise,
                qty: n,
              },
            ],
    );
  };
  if (!p.inStock)
    return (
      <button class="add" disabled>
        Out of stock
      </button>
    );
  if (!qty)
    return (
      <button type="button" class="add primary" aria-label={`Add ${p.name}`} onClick={() => set(1)}>
        ADD
      </button>
    );
  return (
    <div class="stepper" role="group" aria-label={`${p.name} quantity`}>
      <button type="button" aria-label={`One less ${p.name}`} onClick={() => set(qty - 1)}>
        −
      </button>
      <span aria-live="polite">{qty}</span>
      <button type="button" aria-label={`One more ${p.name}`} onClick={() => set(qty + 1)}>
        +
      </button>
    </div>
  );
}

function Card({
  p,
  cart,
  setCart,
  onOpen,
}: {
  p: Product;
  cart: CartLine[];
  setCart: (c: CartLine[]) => void;
  onOpen: (p: Product) => void;
}) {
  const u = defaultUnit(p);
  return (
    <article class={p.inStock ? 'card' : 'card out'} data-testid="product">
      <button
        type="button"
        class="cardopen"
        onClick={() => onOpen(p)}
        aria-label={`Details of ${p.name}`}
      >
        <Thumb p={p} />
        <h3>{p.name}</h3>
      </button>
      <p class="price">
        {rupees(u.pricePaise)} <small>/ {u.unit}</small>
      </p>
      <Stepper p={p} cart={cart} setCart={setCart} />
    </article>
  );
}

function Detail({
  p,
  cart,
  setCart,
  onClose,
}: {
  p: Product;
  cart: CartLine[];
  setCart: (c: CartLine[]) => void;
  onClose: () => void;
}) {
  const [level, setLevel] = useState(defaultUnit(p).level);
  const [qty, setQty] = useState('1');
  const u = p.units.find((x) => x.level === level) ?? defaultUnit(p);
  const n = Number(qty);
  const ok = /^\d+(\.\d{1,3})?$/.test(qty) && n > 0 && n <= 10000;
  return (
    <div class="sheetwrap" role="dialog" aria-modal="true" aria-label={p.name} onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <button type="button" class="close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <Thumb p={p} big />
        <h2>{p.name}</h2>
        {p.category && <small class="muted">{p.category}</small>}
        {p.description && <p>{p.description}</p>}
        <p class="price">
          {rupees(u.pricePaise)} <small>/ {u.unit}</small>
        </p>
        {!p.inStock ? (
          <p class="note warn">Out of stock</p>
        ) : (
          <div class="row">
            {p.units.length > 1 && (
              <select
                aria-label={`Unit for ${p.name}`}
                value={level}
                onChange={(e) =>
                  setLevel(Number((e.currentTarget as HTMLSelectElement).value) as 1 | 2 | 3)
                }
              >
                {p.units.map((x) => (
                  <option key={x.level} value={x.level}>
                    {x.unit}
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
              disabled={!ok}
              onClick={() => {
                setCart(
                  addToCart(cart, {
                    itemId: p.id,
                    name: p.name,
                    level: u.level,
                    unit: u.unit,
                    pricePaise: u.pricePaise,
                    qty: n,
                  }),
                );
                onClose();
              }}
            >
              Add to basket
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Home({
  shop,
  cart,
  setCart,
}: {
  shop: Shop;
  cart: CartLine[];
  setCart: (c: CartLine[]) => void;
}) {
  const cached = loadCatalogCache<Product>(shop.slug);
  const [all, setAll] = useState<Product[]>(cached?.items ?? []);
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [found, setFound] = useState<Product[] | null>(null);
  const [open, setOpen] = useState<Product | null>(null);
  const [error, setError] = useState('');
  // The whole published catalog is small for one kirana shop: read it once (pages of 100), keep a copy.
  useEffect(() => {
    void (async () => {
      try {
        const items: Product[] = [];
        let after: { name: string; id: string } | null = null;
        for (let i = 0; i < 20; i++) {
          const r = await getCatalog(shop.slug, null, null, after);
          const page = r?.items ?? [];
          items.push(...page);
          if (!r?.more || !page.length) break;
          after = { name: page[page.length - 1]!.name, id: page[page.length - 1]!.id };
        }
        setAll(items);
        saveCatalogCache(shop.slug, items);
      } catch (e) {
        if (!all.length) setError(err(e));
      }
    })();
    void getCategories(shop.slug).then(setCats, () => undefined);
  }, []);
  useEffect(() => {
    const t = q.trim();
    if (!t && !cat) return setFound(null);
    const tm = setTimeout(() => {
      void getCatalog(shop.slug, t || null, cat, null).then(
        (r) => setFound(r?.items ?? []),
        (e: unknown) => setError(err(e)),
      );
    }, 250);
    return () => clearTimeout(tm);
  }, [q, cat]);
  const byCat = useMemo(() => {
    const m = new Map<string, Product[]>();
    for (const p of all) {
      const k = p.category || 'More items';
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()];
  }, [all]);
  const again = useMemo(() => {
    const ids = new Set<string>();
    for (const o of loadMyOrders(shop.slug)) for (const l of o.lines ?? []) ids.add(l.itemId);
    return all.filter((p) => ids.has(p.id) && p.inStock).slice(0, 12);
  }, [all]);
  const popular = useMemo(
    () => [...all].sort((a, b) => Number(b.inStock) - Number(a.inStock)).slice(0, 12),
    [all],
  );
  const catName = cats.find((c) => c.id === cat)?.name;
  const grid = (items: Product[]) => (
    <div class="grid">
      {items.map((p) => (
        <Card key={p.id} p={p} cart={cart} setCart={setCart} onOpen={setOpen} />
      ))}
    </div>
  );
  const rail = (title: string, items: Product[], see?: () => void) =>
    items.length > 0 && (
      <section class="shelf" key={title}>
        <div class="shelfhead">
          <h2>{title}</h2>
          {see && (
            <button type="button" class="link" onClick={see}>
              See all {items.length} ›
            </button>
          )}
        </div>
        <div class="rail">
          {items.slice(0, 12).map((p) => (
            <Card key={p.id} p={p} cart={cart} setCart={setCart} onOpen={setOpen} />
          ))}
        </div>
      </section>
    );
  return (
    <main class="pad">
      {shop.banner && <p class="banner">{shop.banner}</p>}
      <input
        type="search"
        class="search"
        placeholder="Search items"
        aria-label="Search items"
        maxLength={60}
        value={q}
        onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
      />
      {error && <p class="note warn">{error}</p>}
      {found ? (
        <>
          <p class="crumb">
            <button type="button" class="link" onClick={() => (setCat(null), setQ(''))}>
              ‹ All items
            </button>{' '}
            {catName ?? `“${q.trim()}”`}
          </p>
          {grid(found)}
          {found.length === 0 && <p class="muted">No items found.</p>}
        </>
      ) : (
        <>
          {cats.length > 1 && (
            <>
              <h2 class="secttl">Shop by category</h2>
              <div class="tiles">
                {cats.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    class="tile"
                    style={{ background: tint(c.name) }}
                    onClick={() => setCat(c.id)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </>
          )}
          {rail('Buy it again', again.length >= 2 ? again : [])}
          {rail('Popular right now', popular)}
          {byCat.map(([name, items]) =>
            rail(name, items, () => {
              const c = cats.find((x) => x.name === name);
              if (c) setCat(c.id);
              else setFound(items);
            }),
          )}
          {all.length === 0 && !error && <Skeleton />}
        </>
      )}
      {open && <Detail p={open} cart={cart} setCart={setCart} onClose={() => setOpen(null)} />}
    </main>
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
  const who = loadWho(shop.slug);
  const [mode, setMode] = useState<'pickup' | 'delivery'>(
    who.mode && (who.mode === 'pickup' ? shop.pickup : shop.delivery)
      ? who.mode
      : shop.pickup
        ? 'pickup'
        : 'delivery',
  );
  const [slot, setSlot] = useState(shop.deliverySlots[0] ?? '');
  const [name, setName] = useState(who.name);
  const [phone, setPhone] = useState(who.phone);
  const [address, setAddress] = useState(who.address);
  const [note, setNote] = useState('');
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{
    orderRef: string;
    token: string;
    totalPaise: string;
    feePaise: bigint;
    sub: bigint;
  } | null>(null);
  const sub = useMemo(() => cart.reduce((n, l) => n + lineEstimate(l), 0n), [cart]);
  const free = shop.freeDeliveryAbovePaise !== null && sub >= BigInt(shop.freeDeliveryAbovePaise);
  const fee = mode === 'delivery' && !free ? BigInt(shop.deliveryFeePaise) : 0n;
  const min = BigInt(
    mode === 'delivery' ? (shop.minDeliveryPaise ?? shop.minOrderPaise) : shop.minOrderPaise,
  );
  const closed = shop.open === false;

  async function submit(ev: Event) {
    ev.preventDefault();
    if (trap) return; // bots fill hidden fields
    const ph = mobile10(phone);
    if (name.trim().length < 2) return setError('Enter your name.');
    if (!ph) return setError('Enter a 10-digit mobile number.');
    if (mode === 'delivery' && address.trim().length < 8)
      return setError('Enter the full delivery address.');
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
        contact: {
          name: name.trim(),
          phone: ph,
          ...(mode === 'delivery' ? { address: address.trim() } : {}),
        },
        lines: cart.map((l) => ({ itemId: l.itemId, unitLevel: l.level, qty: String(l.qty) })),
        note: note.trim() || null,
      });
      saveWho(shop.slug, { name: name.trim(), phone: ph, address: address.trim(), mode });
      rememberOrder(shop.slug, {
        ref: r.ref,
        token: pending.token,
        placedAt: new Date().toISOString(),
        lines: cart,
        status: r.status,
      });
      savePending(shop.slug, null);
      setDone({
        orderRef: r.ref,
        token: pending.token,
        totalPaise: r.totalPaise,
        feePaise: fee,
        sub,
      });
      setCart([]);
    } catch (e) {
      // A refusal (not a lost reply) frees the request id for a corrected order.
      if (e instanceof ShopError && !/connection/i.test(e.message)) savePending(shop.slug, null);
      setError(err(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Confirmation shop={shop} {...done} name={name.trim()} />;
  if (cart.length === 0)
    return (
      <main class="pad">
        <h1>Your basket is empty</h1>
        <a href="#/">Browse items</a>
      </main>
    );
  return (
    <main class="pad">
      <h1>Your basket</h1>
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
        {mode === 'delivery' && (
          <> · Delivery {fee === 0n ? 'free' : rupees(fee.toString())}</>
        )} · <strong>About {rupees((sub + fee).toString())}</strong>
      </p>
      <p class="muted">The shop confirms the final price when it receives your order.</p>
      {sub < min && (
        <p class="note warn">
          Minimum order for {mode} is {rupees(min.toString())}.
        </p>
      )}
      <form onSubmit={submit}>
        <fieldset>
          <legend>How do you want it?</legend>
          {shop.pickup && (
            <label>
              <input type="radio" checked={mode === 'pickup'} onChange={() => setMode('pickup')} />{' '}
              Pick up at the shop
            </label>
          )}
          {shop.delivery && (
            <label>
              <input
                type="radio"
                checked={mode === 'delivery'}
                onChange={() => setMode('delivery')}
              />{' '}
              Deliver to me
            </label>
          )}
          {mode === 'pickup' && shop.pickupNote && <p class="muted">{shop.pickupNote}</p>}
          {mode === 'delivery' && shop.deliveryNote && <p class="muted">{shop.deliveryNote}</p>}
          {mode === 'delivery' && shop.deliverySlots.length > 0 && (
            <label>
              Preferred time{' '}
              <select
                value={slot}
                onChange={(e) => setSlot((e.currentTarget as HTMLSelectElement).value)}
              >
                {shop.deliverySlots.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        <label>
          Your name{' '}
          <input
            required
            maxLength={80}
            value={name}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label>
          Mobile number{' '}
          <input
            required
            type="tel"
            inputMode="tel"
            maxLength={16}
            value={phone}
            onInput={(e) => setPhone((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {mode === 'delivery' && (
          <label>
            Delivery address{' '}
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
          <input
            maxLength={300}
            value={note}
            onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="trap" aria-hidden="true">
          Leave empty{' '}
          <input
            tabIndex={-1}
            autoComplete="off"
            value={trap}
            onInput={(e) => setTrap((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {error && (
          <p class="note warn" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          class="primary wide"
          disabled={busy || sub < min || closed || !navigator.onLine}
        >
          {closed ? 'Shop closed' : busy ? 'Placing order…' : 'Place order'}
        </button>
      </form>
    </main>
  );
}

function PayUpi({
  shop,
  ref_,
  totalPaise,
  mode,
}: {
  shop: Shop;
  ref_: string;
  totalPaise: string;
  mode: string;
}) {
  if (!shop.upiId || BigInt(totalPaise) <= 0n) return null;
  return (
    <>
      <a class="button primary wide" href={upiPayLink(shop.upiId, shop.upiName, totalPaise, ref_)}>
        Pay {rupees(totalPaise)} now by UPI
      </a>
      <p class="muted">
        Opens your UPI app with the amount filled in. You can also pay at{' '}
        {mode === 'delivery' ? 'delivery' : 'the shop'}.
      </p>
    </>
  );
}

function Confirmation({
  shop,
  orderRef,
  token,
  totalPaise,
  feePaise,
  sub,
  name,
}: {
  shop: Shop;
  orderRef: string;
  token: string;
  totalPaise: string;
  feePaise: bigint;
  sub: bigint;
  name: string;
}) {
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}${location.pathname}${location.search}${trackHash(orderRef, token)}`;
  return (
    <main class="pad" data-testid="confirmation">
      <p class="okmark" aria-hidden="true">
        ✓
      </p>
      <h1>Order placed</h1>
      <p>
        Thanks {name} — the shop has your order <strong>{orderRef}</strong>.{' '}
        {shop.contact && <>Questions? Call {shop.contact}.</>}
      </p>
      <ul class="lines">
        <li>
          <span>Items (estimate)</span>
          <span>{rupees(sub.toString())}</span>
        </li>
        {feePaise > 0n && (
          <li>
            <span>Delivery</span>
            <span>{rupees(feePaise.toString())}</span>
          </li>
        )}
        <li>
          <strong>Total</strong>
          <strong>{rupees(totalPaise)}</strong>
        </li>
      </ul>
      <PayUpi shop={shop} ref_={orderRef} totalPaise={totalPaise} mode="" />
      <a class="button primary wide" href={trackHash(orderRef, token)}>
        Track this order
      </a>
      <div class="row">
        <a
          class="button"
          href={`https://wa.me/?text=${encodeURIComponent(`My ${shop.name} order ${orderRef}: ${link}`)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Send on WhatsApp
        </a>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(link).then(
              () => setCopied(true),
              () => undefined,
            )
          }
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p class="muted">
        Anyone with this link can see the order status (never your phone or address).
      </p>
      <a href="#/">Back to shop</a>
    </main>
  );
}

function StatusView({ shop, s, shareLink }: { shop: Shop; s: OrderStatus; shareLink?: string }) {
  const delivery = s.fulfilment === 'delivery';
  return (
    <main class="pad" data-testid="tracking">
      <h1>Order {s.ref}</h1>
      {s.status === 'CANCELLED' ? (
        <p class="note warn">Cancelled{s.cancelReason ? `: ${s.cancelReason}` : ''}</p>
      ) : (
        <ol class="steps">
          {orderSteps(s.status, delivery).map((st) => (
            <li key={st.key} class={st.state}>
              <span class="dot">{st.state ? '✓' : ''}</span>
              {st.label}
            </li>
          ))}
        </ol>
      )}
      <p>
        {delivery ? `Delivery${s.deliverySlot ? `, ${s.deliverySlot}` : ''}` : 'Pickup at the shop'}
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
        {BigInt(s.deliveryFeePaise) > 0n && (
          <li>
            <span>Delivery</span>
            <span>{rupees(s.deliveryFeePaise)}</span>
          </li>
        )}
        <li>
          <strong>Total</strong>
          <strong>{rupees(s.totalPaise)}</strong>
        </li>
      </ul>
      {LIVE.includes(s.status) && (
        <PayUpi shop={shop} ref_={s.ref} totalPaise={s.totalPaise} mode={s.fulfilment} />
      )}
      {shareLink && (
        <a
          class="button wide"
          href={`https://wa.me/?text=${encodeURIComponent(`${shop.name} order ${s.ref}: ${shareLink}`)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Share tracking on WhatsApp
        </a>
      )}
      <p class="muted">This page updates by itself.</p>
    </main>
  );
}

function usePoll(get: () => Promise<OrderStatus | null>, deps: unknown[]) {
  const [s, setS] = useState<OrderStatus | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const run = () =>
      get().then(
        (x) => live && setS(x),
        () => live && setS((v) => (v === undefined ? null : v)),
      );
    void run();
    const t = setInterval(run, 30000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, deps);
  return s;
}

function Tracking({ shop, ref_, token }: { shop: Shop; ref_: string; token: string }) {
  const s = usePoll(() => orderStatus(ref_, token), [ref_, token]);
  if (s === undefined) return <Skeleton />;
  if (!s)
    return (
      <main class="pad">
        <h1>Order not found</h1>
        <p>This link may be incomplete. Ask for the link again or use Find my order.</p>
        <a href="#/find">Find my order</a>
      </main>
    );
  return <StatusView shop={shop} s={s} shareLink={location.href} />;
}

function MyOrderStatus({ shop, ref_ }: { shop: Shop; ref_: string }) {
  const mine = loadMyOrders(SLUG).find((o) => o.ref === ref_);
  const s = usePoll(async () => {
    if (!mine) return null;
    const x = await orderStatus(ref_, mine.token);
    if (x) setOrderStatus(SLUG, ref_, x.status);
    return x;
  }, [ref_]);
  if (s === undefined) return <Skeleton />;
  if (!s)
    return (
      <main class="pad">
        <h1>Order {ref_}</h1>
        <p>This order is not saved on this phone. Use Find my order with your mobile number.</p>
        <a href="#/find">Find my order</a>
      </main>
    );
  return (
    <StatusView
      shop={shop}
      s={s}
      shareLink={`${location.origin}${location.pathname}${location.search}${trackHash(mine!.ref, mine!.token)}`}
    />
  );
}

function MyOrders({ setCart }: { setCart: (c: CartLine[]) => void }) {
  const [list, setList] = useState(() => loadMyOrders(SLUG));
  // Refresh the status dots once when the list opens.
  useEffect(() => {
    void Promise.all(
      list.map((o) =>
        orderStatus(o.ref, o.token).then(
          (s) => s && setOrderStatus(SLUG, o.ref, s.status),
          () => undefined,
        ),
      ),
    ).then(() => setList(loadMyOrders(SLUG)));
  }, []);
  return (
    <main class="pad">
      <h1>My orders</h1>
      {list.length === 0 && (
        <p class="muted">No orders on this phone yet. Orders you place here appear in this list.</p>
      )}
      <ul class="lines">
        {list.map((o) => (
          <li key={o.ref}>
            <span>
              <span
                class={`sdot ${o.status && LIVE.includes(o.status) ? 'live' : ''}`}
                aria-hidden="true"
              />
              <a href={`#/order/${o.ref}`}>{o.ref}</a>{' '}
              <small class="muted">{STATUS[o.status ?? ''] ?? ''}</small>
              <br />
              <small class="muted">{new Date(o.placedAt).toLocaleDateString()}</small>
            </span>
            {o.lines && o.lines.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setCart(o.lines!);
                  location.hash = '#/cart';
                }}
              >
                Order again
              </button>
            )}
          </li>
        ))}
      </ul>
      <a href="#/find">Ordered on another phone? Find my order</a>
    </main>
  );
}

function Find({ shop }: { shop: Shop }) {
  const [phone, setPhone] = useState(loadWho(shop.slug).phone);
  const [ref, setRef] = useState('');
  const [msg, setMsg] = useState('');
  const [s, setS] = useState<OrderStatus | null>(null);
  async function go(ev: Event) {
    ev.preventDefault();
    const ph = mobile10(phone);
    if (!ph) return setMsg('Enter the 10-digit mobile number used for the order.');
    if (!/^[A-Za-z2-9]{10}$/.test(ref.trim()))
      return setMsg('Enter the 10-character order number.');
    setMsg('');
    try {
      const r = await findOrder(shop.slug, ph, ref.trim().toUpperCase());
      if (!r) setMsg('No order matches that mobile number and order number.');
      setS(r);
    } catch (e) {
      setMsg(err(e));
    }
  }
  if (s) return <StatusView shop={shop} s={s} />;
  return (
    <main class="pad">
      <h1>Find my order</h1>
      <form onSubmit={go}>
        <label>
          Mobile number{' '}
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onInput={(e) => setPhone((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label>
          Order number{' '}
          <input
            value={ref}
            maxLength={10}
            onInput={(e) => setRef((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {msg && <p class="note warn">{msg}</p>}
        <button type="submit" class="primary wide">
          Find
        </button>
      </form>
    </main>
  );
}

function Info({ shop }: { shop: Shop }) {
  return (
    <main class="pad">
      <h1>{shop.name}</h1>
      <p>
        <span class={shop.open === false ? 'pill off' : 'pill on'}>
          {shop.open === false ? 'Closed right now' : 'Open for orders'}
        </span>
      </p>
      {shop.address && (
        <p>
          <strong>Address</strong>
          <br />
          {shop.address}
          {shop.mapUrl && (
            <>
              {' '}
              <a href={shop.mapUrl} target="_blank" rel="noopener noreferrer">
                Open map
              </a>
            </>
          )}
        </p>
      )}
      {shop.orderHours && (
        <p>
          <strong>Order hours</strong>
          <br />
          {shop.orderHours}
        </p>
      )}
      {shop.contact && (
        <p>
          <strong>Contact</strong>
          <br />
          <a href={`tel:${shop.contact.replace(/[^0-9+]/g, '')}`}>{shop.contact}</a>
        </p>
      )}
      <p>
        <strong>How it works</strong>
        <br />
        {shop.pickup && 'Pick up at the shop. '}
        {shop.delivery &&
          `Delivery${BigInt(shop.deliveryFeePaise) > 0n ? ` ${rupees(shop.deliveryFeePaise)}` : ' free'}${
            shop.freeDeliveryAbovePaise ? `, free above ${rupees(shop.freeDeliveryAbovePaise)}` : ''
          }. `}
        Pay at {shop.delivery ? 'delivery or ' : ''}the shop{shop.upiId ? ', or by UPI' : ''}.
      </p>
      {shop.licence && <p class="muted">{shop.licence}</p>}
      <a href="#/">Back to shop</a>
    </main>
  );
}

if ('serviceWorker' in navigator && import.meta.env.PROD)
  addEventListener(
    'load',
    () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined),
  );

render(<App />, document.getElementById('app')!);
