import { useEffect, useState } from 'preact/hooks';
import {
  createStockCount,
  getDefaultShopId,
  getShopBusinessDate,
  listItems,
  listStock,
  postStockCount,
  type Item,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';

const REASONS = ['physical count', 'damaged', 'expired', 'theft / loss', 'found extra'];

export function StockAdjustScreen() {
  const [shop, setShop] = useState('');
  const [date, setDate] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [item, setItem] = useState('');
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  // Kept until the adjustment is confirmed, so a retry never creates a second count document.
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [countId, setCountId] = useState('');
  // Set after any unconfirmed attempt: the request (item, qty, reason, id) is frozen until the
  // server confirms it or definitively says nothing was posted.
  const [frozen, setFrozen] = useState<{ item: string; counted: string; reason: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

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
      await load(s);
    })().catch((e) => setMsg(String(e)));
  }, []);

  function startOver() {
    setFrozen(null);
    setCountId('');
    setClientId(crypto.randomUUID());
  }
  async function submit(e: Event) {
    e.preventDefault();
    const req = frozen ?? { item, counted, reason };
    if (!shop || !date || !req.item || req.counted === '' || busy) return;
    setBusy(true);
    setMsg('');
    setFrozen(req);
    let id = countId;
    try {
      if (!id) {
        id = await createStockCount(
          shop,
          date,
          [{ item_id: req.item, counted_qty: Number(req.counted), reason: req.reason }],
          `Stock adjustment: ${req.reason}`,
          clientId,
        );
        setCountId(id);
      }
      await postStockCount(id);
      setMsg('Stock adjusted through the adjustment ledger.');
      startOver();
      setCounted('');
      await load();
    } catch (err) {
      const text = String(err);
      if (/recount required/i.test(text)) {
        // Definitive: nothing was applied. A fresh count (new id) is safe.
        startOver();
        setMsg('Stock changed since this count was taken. Nothing was posted — count again.');
      } else if (id && /unavailable/i.test(text)) {
        // The count is no longer a draft: an earlier attempt most likely posted it. Verify.
        await load();
        setMsg(
          'This count was already posted by an earlier attempt. Check the expected stock above before entering anything again.',
        );
        startOver();
      } else {
        setMsg(`Not confirmed: ${text}. Press Retry — it resends this same count safely.`);
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
          <button class="primary" disabled={busy || !shop}>
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
