import { useEffect, useState } from 'preact/hooks';
import {
  getDefaultShopId,
  getShopBusinessDate,
  listItems,
  listStock,
  postStockCountOutcome,
  type Item,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { clearPendingIntent, loadPendingIntent, savePendingIntent } from '../lib/pendingIntent';

const REASONS = ['physical count', 'damaged', 'expired', 'theft / loss', 'found extra'];

type Frozen = { item: string; counted: string; reason: string; date: string };

export function StockAdjustScreen() {
  const [shop, setShop] = useState('');
  const [date, setDate] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [item, setItem] = useState('');
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  // Kept until the adjustment is confirmed, so a retry never creates a second count document.
  const [clientId, setClientId] = useState<string>(() => crypto.randomUUID());
  // Set from the first send until the server confirms or definitively refuses: the request
  // (item, qty, reason, date, id) is frozen and stored on the device, surviving reloads (V002 VF-005).
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const pendingKey = (s: string) => `dsb-pending-stock-count:${s}`;

  async function load(shopId = shop) {
    if (!shopId) return;
    const [i, s] = await Promise.all([listItems(), listStock(shopId)]);
    setItems(i);
    setQty(Object.fromEntries(s.map((r) => [r.item_id, Number(r.qty_base)])));
  }
  useEffect(() => {
    void (async () => {
      const s = await getDefaultShopId();
      setShop(s);
      setDate(await getShopBusinessDate(s));
      const saved = loadPendingIntent<{ req: Frozen; clientId: string }>(pendingKey(s));
      if (!saved.ok) {
        setStorageBlocked(true);
        setMsg(saved.message);
      } else if (saved.value) {
        setFrozen(saved.value.req);
        setClientId(saved.value.clientId);
        setItem(saved.value.req.item);
        setCounted(saved.value.req.counted);
        setReason(saved.value.req.reason);
        setMsg(
          'An earlier stock count was not confirmed. Press Retry to finish it — it is sent once.',
        );
      }
      await load(s);
    })().catch((e) => setMsg(String(e)));
  }, []);

  function startOver() {
    setFrozen(null);
    clearPendingIntent(pendingKey(shop));
    setClientId(crypto.randomUUID());
  }
  async function submit(e: Event) {
    e.preventDefault();
    const req: Frozen = frozen ?? { item, counted: counted.trim(), reason, date };
    if (!shop || !req.date || !req.item || req.counted === '' || busy || storageBlocked) return;
    if (!/^\d+(\.\d{1,6})?$/.test(req.counted)) {
      setMsg('Enter a counted quantity of 0 or more, with at most 6 decimals.');
      return;
    }
    // Durable before dispatch, or not sent at all.
    try {
      savePendingIntent(pendingKey(shop), { req, clientId });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    setMsg('');
    setFrozen(req);
    try {
      const outcome = await postStockCountOutcome({
        shopId: shop,
        businessDate: req.date,
        lines: [{ item_id: req.item, counted_qty: Number(req.counted), reason: req.reason }],
        notes: `Stock adjustment: ${req.reason}`,
        clientId,
      });
      if (outcome.kind === 'committed') {
        startOver();
        setCounted('');
        setMsg(
          outcome.value.alreadyPosted
            ? 'This count was already posted by an earlier attempt; nothing was applied twice.'
            : 'Stock adjusted through the adjustment ledger.',
        );
        await load().catch(() => undefined);
      } else if (outcome.kind === 'rejected') {
        // The database refused and rolled back (e.g. stock changed since the count): nothing applied.
        startOver();
        setMsg(
          /recount required/i.test(outcome.message)
            ? 'Stock changed since this count was taken. Nothing was posted — count again.'
            : `Not posted: ${outcome.message}`,
        );
        await load().catch(() => undefined);
      } else {
        setMsg(
          `Not confirmed: ${outcome.message}. Press Retry — it resends this same count safely.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }
  const selected = items.find((i) => i.id === item);

  return (
    <main>
      <div class="row">
        <h1>Stock adjust</h1>
        <a href={appRoute.home}>Home</a>
      </div>
      {msg && <p role="status">{msg}</p>}
      <section class="card">
        <h2>Physical stock count</h2>
        <form class="grid-form" onSubmit={(e) => void submit(e)}>
          <label>
            Item
            <select
              value={item}
              disabled={Boolean(frozen)}
              onInput={(e) => setItem((e.target as HTMLSelectElement).value)}
              required
            >
              <option value="">Choose…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <p aria-label="expected stock">Expected {qty[selected.id] ?? 0} (smallest unit)</p>
          )}
          <label>
            Counted quantity (smallest unit)
            <input
              inputMode="decimal"
              value={counted}
              disabled={Boolean(frozen)}
              onInput={(e) => setCounted((e.target as HTMLInputElement).value)}
              required
            />
          </label>
          <label>
            Reason
            <select
              value={reason}
              disabled={Boolean(frozen)}
              onInput={(e) => setReason((e.target as HTMLSelectElement).value)}
            >
              {REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <button class="primary" disabled={busy || !shop || storageBlocked}>
            {busy ? 'Posting…' : frozen ? 'Retry posting this count' : 'Post stock count'}
          </button>
        </form>
        <p class="muted">
          Posting is refused if stock changed after the count snapshot, preventing a stale count
          from overwriting live movements.
        </p>
      </section>
    </main>
  );
}
