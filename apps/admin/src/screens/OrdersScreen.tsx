import { useEffect, useState } from 'preact/hooks';
import {
  expireDueOnlineOrders,
  fulfilOnlineOrder,
  getDefaultShopId,
  getStorefrontSettings,
  listOnlineOrderLines,
  listOnlineOrders,
  setOnlineOrderStatus,
  type OnlineOrder,
  type OnlineOrderLine,
  type OrderStatus,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { errorText } from '../lib/friendlyError';
import { rupees } from '../lib/money';
import { orderMessage, whatsAppLink, type ShopInfo } from '../lib/orderMessages';

// SF4: online orders for the shop (old DSB admin orders, G07/G08). Open orders oldest first; finished ones below.
// Steps: New -> Confirmed -> Preparing -> Ready -> Hand over (one normal sale, paid in full) or Cancel with a reason.
// Refreshes every 30 s and on demand; expired orders are cancelled by the server, freeing their stock.
const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  NEW: { to: 'CONFIRMED', label: 'Confirm' },
  CONFIRMED: { to: 'PREPARING', label: 'Start packing' },
  PREPARING: { to: 'READY', label: 'Mark ready' },
};
const LABEL: Record<OrderStatus, string> = {
  NEW: 'New',
  CONFIRMED: 'Confirmed',
  PREPARING: 'Packing',
  READY: 'Ready',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Handed over',
  CANCELLED: 'Cancelled',
};
const minutesLeft = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 60000);
export function OrdersScreen() {
  const [shopId, setShopId] = useState('');
  const [open, setOpen] = useState<OnlineOrder[]>([]);
  const [done, setDone] = useState<OnlineOrder[]>([]);
  const [lines, setLines] = useState<Record<string, OnlineOrderLine[]>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [payMode, setPayMode] = useState<Record<string, string>>({});
  const [shopInfo, setShopInfo] = useState<ShopInfo>({ name: 'our shop', upiId: null });
  // After a step: the ready-to-send WhatsApp update for that customer (one tap sends it from this phone).
  const [notify, setNotify] = useState<{ order: OnlineOrder; text: string } | null>(null);

  async function load(shop = shopId) {
    if (!shop) return;
    try {
      await expireDueOnlineOrders(shop).catch(() => 0);
      const [o, d] = await Promise.all([
        listOnlineOrders(shop, true),
        listOnlineOrders(shop, false),
      ]);
      setOpen(o);
      setDone(d);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    void getDefaultShopId()
      .then((s) => {
        setShopId(s);
        void getStorefrontSettings(s)
          .then((c) => c && setShopInfo({ name: c.displayName, upiId: c.upiId ?? null }))
          .catch(() => undefined);
        return load(s);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!shopId) return;
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [shopId]);

  async function showLines(o: OnlineOrder) {
    if (lines[o.id]) return;
    try {
      const l = await listOnlineOrderLines(o.id);
      setLines((m) => ({ ...m, [o.id]: l }));
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function act(
    o: OnlineOrder,
    run: () => Promise<{ expired?: boolean; status?: OrderStatus }>,
    ok: string,
    reason?: string,
  ) {
    setBusy(o.id);
    setError('');
    setMsg('');
    setNotify(null);
    try {
      const r = await run();
      setMsg(
        r.expired ? `Order ${o.publicRef} had expired and was cancelled; its stock is free.` : ok,
      );
      const to = r.status ?? (r.expired ? 'CANCELLED' : undefined);
      if (to) setNotify({ order: o, text: orderMessage(o, to, shopInfo, reason) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
      await load();
    }
  }
  function cancel(o: OnlineOrder) {
    const reason = prompt(`Cancel order ${o.publicRef}? Give a reason:`)?.trim();
    if (!reason) return;
    void act(
      o,
      () => setOnlineOrderStatus(o.id, 'CANCELLED', o.revision, reason),
      `Order ${o.publicRef} cancelled.`,
      reason,
    );
  }
  function handOver(o: OnlineOrder) {
    const mode = payMode[o.id] ?? 'cash';
    if (
      !confirm(
        `Hand over ${o.publicRef} and record ${rupees(o.totalPaise)} paid by ${mode}?${mode === 'upi' ? ' Check the money arrived in your UPI app first.' : ''}`,
      )
    )
      return;
    void act(
      o,
      () => fulfilOnlineOrder(o.id, o.revision, [{ mode, amount_paise: o.totalPaise }]),
      `Order ${o.publicRef} handed over and recorded as a sale.`,
    );
  }

  const card = (o: OnlineOrder) => (
    <details class="card" key={o.id} data-testid="online-order" onToggle={() => void showLines(o)}>
      <summary>
        <strong>{o.publicRef}</strong> · {LABEL[o.status]} · {o.contactName} ·{' '}
        {rupees(o.totalPaise)} ·{' '}
        {o.fulfilment === 'delivery'
          ? `Delivery${o.deliverySlot ? ` ${o.deliverySlot}` : ''}`
          : 'Pickup'}
        {['NEW', 'CONFIRMED', 'PREPARING', 'READY'].includes(o.status) && (
          <small class="muted"> · {Math.max(0, minutesLeft(o.expiresAt))} min left</small>
        )}
      </summary>
      <p>
        <a href={`tel:${o.contactPhone}`}>{o.contactPhone}</a> ·{' '}
        <a
          href={whatsAppLink(o.contactPhone, orderMessage(o, o.status, shopInfo))}
          target="_blank"
          rel="noopener noreferrer"
        >
          WhatsApp status
        </a>
      </p>
      {o.contactAddress && <p>Address: {o.contactAddress}</p>}
      {o.customerNote && <p>Note: {o.customerNote}</p>}
      {o.cancelReason && <p class="muted">Cancelled: {o.cancelReason}</p>}
      <ul class="record-list">
        {(lines[o.id] ?? []).map((l) => (
          <li key={l.lineNo}>
            {l.qty} {l.unitName} {l.itemName} × {rupees(l.unitPricePaise)} ={' '}
            {rupees(l.lineTotalPaise)}
          </li>
        ))}
      </ul>
      {o.deliveryFeePaise > 0 && <p>Delivery fee {rupees(o.deliveryFeePaise)}</p>}
      <div class="context-actions">
        {NEXT[o.status] && (
          <button
            type="button"
            class="primary"
            disabled={busy === o.id}
            onClick={() =>
              void act(
                o,
                () => setOnlineOrderStatus(o.id, NEXT[o.status]!.to, o.revision),
                `Order ${o.publicRef}: ${LABEL[NEXT[o.status]!.to]}.`,
              )
            }
          >
            {NEXT[o.status]!.label}
          </button>
        )}
        {o.status === 'READY' && o.fulfilment === 'delivery' && (
          <button
            type="button"
            disabled={busy === o.id}
            onClick={() =>
              void act(
                o,
                () => setOnlineOrderStatus(o.id, 'OUT_FOR_DELIVERY', o.revision),
                `Order ${o.publicRef}: out for delivery.`,
              )
            }
          >
            Out for delivery
          </button>
        )}
        {(o.status === 'READY' || o.status === 'OUT_FOR_DELIVERY') && (
          <>
            <select
              aria-label={`Payment for ${o.publicRef}`}
              value={payMode[o.id] ?? 'cash'}
              onChange={(e) =>
                setPayMode((m) => ({ ...m, [o.id]: (e.currentTarget as HTMLSelectElement).value }))
              }
            >
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="card">Card</option>
            </select>
            <button
              type="button"
              class="primary"
              disabled={busy === o.id}
              onClick={() => handOver(o)}
            >
              Hand over and record sale
            </button>
          </>
        )}
        {['NEW', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'].includes(o.status) && (
          <button type="button" disabled={busy === o.id} onClick={() => cancel(o)}>
            Cancel order
          </button>
        )}
      </div>
    </details>
  );

  return (
    <main class="page wide" data-testid="orders-screen">
      <p>
        <a class="back-home" href={appRoute.more}>
          ← Shop tools
        </a>
      </p>
      <h1>Online orders</h1>
      <button type="button" onClick={() => void load()}>
        Refresh
      </button>
      {error && (
        <p role="alert" class="alert">
          {error}
        </p>
      )}
      {msg && <p role="status">{msg}</p>}
      {notify && (
        <p class="card" data-testid="wa-notify">
          <a
            class="button primary"
            href={whatsAppLink(notify.order.contactPhone, notify.text)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setNotify(null)}
          >
            Send WhatsApp update to {notify.order.contactName}
          </a>{' '}
          <button type="button" onClick={() => setNotify(null)}>
            Skip
          </button>
          <br />
          <small class="muted">{notify.text}</small>
        </p>
      )}
      <h2>Open ({open.length})</h2>
      {open.length === 0 && <p class="muted">No open orders.</p>}
      {open.map(card)}
      <h2>Finished</h2>
      {done.length === 0 && <p class="muted">Nothing yet.</p>}
      {done.map(card)}
    </main>
  );
}
