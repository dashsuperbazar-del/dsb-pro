import { useEffect, useRef, useState } from 'preact/hooks';
import {
  listParties,
  listPurchaseHistory,
  getPurchaseDetail,
  type Party,
  type PurchaseRecord,
} from '@dsb-pro/adapters';
import { BillDocumentPreview } from '../components/BillDocumentPreview';
import { InventoryScreen } from './InventoryScreen';
import { shopContext } from '../lib/shopContext';
import { appRoute } from '../lib/paths';
import { rupees } from '../lib/money';
import { purchaseStatus } from '../lib/purchaseWorkflow';
import { dropSnapshot, peekSnapshot, putSnapshot, snapshotUserId } from '../lib/routeSnapshot';
import { SnapshotNote } from '../components/SnapshotNote';

type PurchaseListSnapshot = { rows: PurchaseRecord[]; parties: Party[] };

export function PurchasesScreen({ url }: { url?: string }) {
  const query = new URL(url ?? window.location.href, window.location.origin).searchParams;
  const entering = query.get('new') === '1';
  const [shop, setShop] = useState('');
  const [parties, setParties] = useState<Party[]>([]);
  const [rows, setRows] = useState<PurchaseRecord[]>([]);
  const [queryText, setQueryText] = useState('');
  const [supplier, setSupplier] = useState('');
  const [sort, setSort] = useState('date');
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getPurchaseDetail>> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [canPost, setCanPost] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [more, setMore] = useState(false);
  const generation = useRef(0);
  const listGeneration = useRef(0);
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const userRef = useRef('');
  function forgetSaved(active: boolean) {
    dropSnapshot('purchases');
    if (!active) return;
    setRows([]);
    setParties([]);
    setSnapshotAt(null);
  }
  async function refresh(shopId = shop) {
    const token = ++listGeneration.current;
    setLoading(true);
    setError('');
    try {
      const [bills, suppliers] = await Promise.all([listPurchaseHistory(shopId), listParties()]);
      if (token !== listGeneration.current) return;
      setRows(bills);
      setParties(suppliers);
      setMore(bills.length === 50);
      setSnapshotAt(null);
      putSnapshot<PurchaseListSnapshot>('purchases', userRef.current, shopId, {
        rows: bills,
        parties: suppliers,
      });
    } catch (e) {
      if (token === listGeneration.current) {
        setError(String(e));
        setSnapshotFailed(true);
      }
    } finally {
      if (token === listGeneration.current) setLoading(false);
    }
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // Show the last list at once (display only), then refresh it below.
        userRef.current = await snapshotUserId();
        const snap = peekSnapshot<PurchaseListSnapshot>('purchases', userRef.current);
        if (snap && active) {
          setRows(snap.value.rows);
          setParties(snap.value.parties);
          setSnapshotAt(snap.at);
          setLoading(false);
        }
        let context;
        try {
          context = await shopContext.get();
        } catch (e) {
          // No session or membership: whatever was saved is no longer this user's to see.
          forgetSaved(active);
          throw e;
        }
        const { session: fresh, membership: m, shopId: s } = context;
        userRef.current = fresh.user.id;
        if (!['owner', 'manager', 'accountant'].includes(m.role)) {
          forgetSaved(active);
          throw new Error('Purchase history is restricted by your role.');
        }
        if (!active) return;
        setAllowed(true);
        setCanPost(['owner', 'manager'].includes(m.role));
        setShop(s);
        // refresh() reads suppliers together with the bill list; no second supplier read here.
        await refresh(s);
      } catch (e) {
        if (active) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
      generation.current++;
      listGeneration.current++;
    };
  }, []);
  async function open(id: string) {
    if (!shop) {
      setError('Still loading this shop. Try again in a moment.');
      return;
    }
    const token = ++generation.current;
    setDetail(null);
    setError('');
    setLoading(true);
    try {
      const d = await getPurchaseDetail(shop, id);
      if (token === generation.current) setDetail(d);
    } catch (e) {
      if (token === generation.current) setError(String(e));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }
  const name = (id: string | null) =>
    parties.find((p) => p.id === id)?.name ?? (id ? 'Supplier unavailable' : 'No supplier');
  const visible = rows
    .filter(
      (b) =>
        (!supplier || b.party_id === supplier) &&
        `${b.bill_no ?? ''} ${name(b.party_id)} ${b.business_date} ${rupees(b.total_paise)}`
          .toLowerCase()
          .includes(queryText.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (sort === 'entered'
          ? b.created_at.localeCompare(a.created_at)
          : b.business_date.localeCompare(a.business_date)) ||
        b.created_at.localeCompare(a.created_at) ||
        a.id.localeCompare(b.id),
    );
  return (
    <main class="purchase-workspace">
      <div class="row">
        <h1>{entering ? 'New purchase' : 'Purchases'}</h1>
        <a href={appRoute.inventory}>Stock</a>
      </div>
      <nav class="context-actions" aria-label="Purchase actions">
        {canPost && (
          <a class="button-link primary" href={appRoute.purchases + '?new=1'}>
            New purchase
          </a>
        )}
        <a href={appRoute.purchases}>Bill list</a>
        <a href={appRoute.suppliers}>Suppliers & payments</a>
      </nav>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading purchases…</p>}
      {!entering && <SnapshotNote at={snapshotAt} failed={snapshotFailed} />}
      {allowed && canPost && (
        <div hidden={!entering}>
          <InventoryScreen
            purchaseOnly
            purchaseContextActive={entering}
            purchaseSupplierId={query.get('supplier') ?? ''}
            purchaseRepeatId={query.get('repeat') ?? ''}
            onPurchasePosted={() => void refresh()}
          />
        </div>
      )}
      <div hidden={entering}>
        <section class="card">
          <label class="search-field">
            Search loaded bills
            <input
              value={queryText}
              placeholder="Bill, supplier, date or amount"
              onInput={(e) => setQueryText(e.currentTarget.value)}
            />
          </label>
          <div class="grid-form">
            <label>
              Supplier
              <select value={supplier} onChange={(e) => setSupplier(e.currentTarget.value)}>
                <option value="">All suppliers</option>
                {parties.map((p) => (
                  <option value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label>
              Sort
              <select value={sort} onChange={(e) => setSort(e.currentTarget.value)}>
                <option value="date">Bill date</option>
                <option value="entered">Recently entered</option>
              </select>
            </label>
          </div>
          <p class="muted">{rows.length} bills loaded. Load older bills to search more history.</p>
          <div class="record-list">
            {visible.map((b) => (
              <button type="button" key={b.id} onClick={() => void open(b.id)}>
                <span>
                  <strong>{name(b.party_id)}</strong>
                  <small>
                    {b.bill_no || b.id.slice(0, 8)} · {b.business_date} ·{' '}
                    {b.status === 'VOID' ? 'Voided' : 'Posted'}
                  </small>
                </span>
                <span class="record-value">{rupees(b.total_paise)}</span>
              </button>
            ))}
          </div>
          {!loading && !visible.length && <p>No purchases match.</p>}
          {more && (
            <button
              disabled={loading}
              onClick={() => {
                const token = listGeneration.current;
                setLoading(true);
                void listPurchaseHistory(shop, rows.length)
                  .then((next) => {
                    if (token !== listGeneration.current) return;
                    setRows((old) => [...old, ...next]);
                    setMore(next.length === 50);
                  })
                  .catch((e) => {
                    if (token === listGeneration.current) setError(String(e));
                  })
                  .finally(() => {
                    if (token === listGeneration.current) setLoading(false);
                  });
              }}
            >
              Load older bills
            </button>
          )}
        </section>
        {detail && (
          <section class="card" aria-label="Purchase detail">
            <div class="row">
              <h2>{detail.bill.bill_no || 'Purchase bill'}</h2>
              <button
                type="button"
                onClick={() => {
                  generation.current++;
                  setDetail(null);
                }}
              >
                Close detail
              </button>
            </div>
            <p>
              {name(detail.bill.party_id)} · {detail.bill.business_date}
            </p>
            <p>
              <strong>{rupees(detail.bill.total_paise)}</strong> ·{' '}
              {purchaseStatus(detail.bill, detail.balance)}
            </p>
            {detail.balance && (
              <p>
                Paid {rupees(detail.balance.allocated_paise)} · Returned{' '}
                {rupees(detail.balance.returned_paise)} · Due{' '}
                {rupees(detail.balance.outstanding_paise)}
              </p>
            )}
            {detail.bill.bill_image_path && (
              <BillDocumentPreview
                key={detail.bill.id}
                path={detail.bill.bill_image_path}
                name={`${detail.bill.bill_no || 'Purchase bill'}.${detail.bill.bill_image_path.endsWith('.pdf') ? 'pdf' : 'webp'}`}
              />
            )}
            <div class="record-list">
              {detail.lines.map((l) => (
                <div class="purchase-line" key={l.id}>
                  <span>
                    <strong>{l.item_name_snapshot}</strong>
                    <small>
                      {l.qty} {l.unit_name_snapshot} × {rupees(l.unit_price_paise)}
                    </small>
                  </span>
                  <strong>{rupees(l.line_total_paise)}</strong>
                </div>
              ))}
            </div>
            <p>
              Lines {rupees(detail.bill.subtotal_paise)} · Discount{' '}
              {rupees(detail.bill.discount_paise)} · Extra {rupees(detail.bill.extra_charges_paise)}
            </p>
            <nav class="context-actions" aria-label="Bill actions">
              {canPost && detail.bill.status === 'POSTED' && (
                <a
                  class="button-link primary"
                  href={appRoute.purchases + '?new=1&repeat=' + encodeURIComponent(detail.bill.id)}
                >
                  Repeat into new draft
                </a>
              )}
              {detail.bill.party_id && canPost && (
                <>
                  <a
                    href={
                      appRoute.purchases +
                      '?new=1&supplier=' +
                      encodeURIComponent(detail.bill.party_id)
                    }
                  >
                    New purchase · same supplier
                  </a>
                  <a
                    href={
                      appRoute.suppliers +
                      '?supplier=' +
                      encodeURIComponent(detail.bill.party_id) +
                      '&view=payment&bill=' +
                      encodeURIComponent(detail.bill.id)
                    }
                  >
                    Record payment
                  </a>
                  <a
                    href={
                      appRoute.suppliers +
                      '?supplier=' +
                      encodeURIComponent(detail.bill.party_id) +
                      '&view=ledger'
                    }
                  >
                    Supplier ledger
                  </a>
                </>
              )}
            </nav>
          </section>
        )}
      </div>
    </main>
  );
}
