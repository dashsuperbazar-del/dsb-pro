import { formatQuantity } from '@dsb-pro/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { hiddenNote, hideVoided, loadShowVoided, saveShowVoided } from '../lib/voidedVisibility';
import {
  listParties,
  listPurchaseHistory,
  getPurchaseDetail,
  getPurchaseExtras,
  getPurchaseEditLinks,
  voidPaidPurchaseOutcome,
  listPurchaseSettlements,
  listOpenRemarks,
  type Party,
  type PurchaseEditLinks,
  type PurchaseSettlement,
  type PurchaseExtras,
  type PurchaseRecord,
} from '@dsb-pro/adapters';
import { BillDocumentPreview } from '../components/BillDocumentPreview';
import { InventoryScreen } from './InventoryScreen';
import { shopContext } from '../lib/shopContext';
import { getOfflineRuntimeIdentity, waitForOfflineRuntime } from '../lib/offlineSync';
import { appRoute } from '../lib/paths';
import { roundOffLabel, rupees } from '../lib/money';
import { PAYMENT_LABEL, percentText } from '../lib/billExtras';
import { settlementLabel, voidPaidAccess } from '../lib/purchaseSettlement';
import { filterBills, listBadge, type BillStatusFilter } from '../lib/purchaseListFilter';
import { billCodeMatch } from '../lib/billCode';
import { BillCodeChip } from '../components/BillCodeChip';
import {
  CreditVoidPanel,
  VoidReasonNote,
  clearPendingVoid,
  voidBlocker,
} from '../components/CreditVoidPanel';
import {
  dropSnapshot,
  peekSnapshot,
  putSnapshot,
  snapshotRefreshFailed,
  snapshotUserId,
} from '../lib/routeSnapshot';
import { SnapshotNote } from '../components/SnapshotNote';
import { RemarkBox } from '../components/RemarkBox';
import { pendingDocIds } from '../lib/remarkQueue';
import { createDetailCache } from '../lib/detailCache';
import { ShareImageButton } from '../components/ShareImageButton';
import { purchaseBillDoc } from '../lib/shareImage';
import { loadShopProfile } from '../lib/shopProfile';

type PurchaseListSnapshot = { rows: PurchaseRecord[]; parties: Party[] };
type Detail = Awaited<ReturnType<typeof getPurchaseDetail>>;
type ExtrasResult = { ok: true; v: PurchaseExtras } | { ok: false; e: unknown };
type OpenBill = { detail: Detail; extras: ExtrasResult };
const billKey = (shopId: string, id: string) => `${shopId}:${id}`;
// Display-only cache of recently opened bills: reopen and hover-prefetch are instant, every open still
// revalidates from the server, and any void/post/list refresh invalidates it.
const billCache = createDetailCache<OpenBill>(async (key) => {
  const [shopId, id] = key.split(':') as [string, string];
  const [detail, extras] = await Promise.all([
    getPurchaseDetail(shopId, id),
    Promise.resolve()
      .then(() => getPurchaseExtras(shopId, id))
      .then(
        (v): ExtrasResult => ({ ok: true, v }),
        (e: unknown): ExtrasResult => ({ ok: false, e }),
      ),
  ]);
  return { detail, extras };
}, 20);

export function PurchasesScreen({ url }: { url?: string }) {
  const query = new URL(url ?? window.location.href, window.location.origin).searchParams;
  const entering = query.get('new') === '1';
  const [shop, setShop] = useState('');
  const [parties, setParties] = useState<Party[]>([]);
  const [rows, setRows] = useState<PurchaseRecord[]>([]);
  const [queryText, setQueryText] = useState('');
  const [supplier, setSupplier] = useState('');
  const [sort, setSort] = useState('date');
  const [showVoided, setShowVoided] = useState(false);
  const [statusFilter, setStatusFilter] = useState<BillStatusFilter | 'pending'>('all');
  // 0067: bills with an open remark ("Pending" badge and filter); null = not known (no badge, filter empty).
  const [pending, setPending] = useState<Set<string> | null>(null);
  const pendingGen = useRef(0);
  function loadPending(shopId: string) {
    const token = ++pendingGen.current;
    void Promise.resolve()
      .then(() => listOpenRemarks(shopId))
      .then(
        (r) => token === pendingGen.current && setPending(pendingDocIds(r, 'purchase')),
        () => token === pendingGen.current && setPending(null),
      );
  }
  // Ledger settlement per listed bill (Paid/Partial/Unpaid/Void badge); missing = not known, no badge.
  const [settlements, setSettlements] = useState<Map<string, PurchaseSettlement>>(new Map());
  function loadSettlements(shopId: string, bills: PurchaseRecord[], reset: boolean) {
    void Promise.resolve()
      .then(() => listPurchaseSettlements(shopId, bills))
      .then(
        (m) =>
          setSettlements((old) => {
            const next = reset ? new Map<string, PurchaseSettlement>() : new Map(old);
            for (const [k, v] of m) next.set(k, v);
            return next;
          }),
        () => {},
      );
  }
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  // The bill opened from the list: its header shows at once while lines load.
  const [openRow, setOpenRow] = useState<PurchaseRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  // The purchase entry form is mounted only once it is first used (it keeps its draft afterwards).
  const [entryMounted, setEntryMounted] = useState(entering);
  useEffect(() => {
    if (entering) setEntryMounted(true);
  }, [entering]);
  // billextras: payment type, notes, charges, photos and the ledger-derived settlement of the open bill.
  // null while loading or when it could not be read (then no paid/unpaid badge is shown).
  const [extras, setExtras] = useState<PurchaseExtras | null>(null);
  const [extrasError, setExtrasError] = useState('');
  // 0066 edit links of the open bill; null = unknown (or a database without 0066): no "Edit bill" then.
  const [links, setLinks] = useState<PurchaseEditLinks | null>(null);
  const openBillId = detail?.bill.id ?? '';
  const openBillStatus = detail?.bill.status ?? '';
  useEffect(() => {
    let active = true;
    setLinks(null);
    if (!shop || !openBillId) return;
    void Promise.resolve()
      .then(() => getPurchaseEditLinks(shop, openBillId))
      .then(
        (l) => {
          if (active) setLinks(l);
        },
        () => {},
      );
    return () => {
      active = false;
    };
  }, [shop, openBillId, openBillStatus]);
  const [role, setRole] = useState('');
  // Void of a cash/UPI bill: one request id per bill, kept after an unconfirmed answer so a retry can
  // never void twice or act on a different reason.
  const [voidReason, setVoidReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidNote, setVoidNote] = useState('');
  const [creditVoidNote, setCreditVoidNote] = useState('');
  const voidRequest = useRef<{ billId: string; clientId: string; reason: string } | null>(null);
  const [voidUnconfirmed, setVoidUnconfirmed] = useState(false);
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
    billCache.clear();
    dropSnapshot('purchases', userRef.current);
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
      billCache.clear();
      setRows(bills);
      setParties(suppliers);
      loadSettlements(shopId, bills, true);
      loadPending(shopId);
      setMore(bills.length === 50);
      setSnapshotAt(null);
      putSnapshot<PurchaseListSnapshot>('purchases', userRef.current, shopId, {
        rows: bills,
        parties: suppliers,
      });
    } catch (e) {
      if (token === listGeneration.current) {
        setError(String(e));
        snapshotRefreshFailed('purchases', e, userRef.current);
        setSnapshotFailed(true);
      }
    } finally {
      if (token === listGeneration.current) setLoading(false);
    }
  }
  useEffect(() => {
    let active = true;
    // A cached bill never outlives the screen: sign-out, another user or shop starts empty.
    billCache.clear();
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
        // Offline (docs/OFFLINE_PURCHASES_PLAN.md): the device's signed-in identity opens bill entry, which
        // saves bills on this device; the bill list shows the saved copy.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          await waitForOfflineRuntime(10000);
          const identity = getOfflineRuntimeIdentity();
          if (!identity) throw new Error('This device has no saved shop data yet. Connect once.');
          if (!active) return;
          setAllowed(['owner', 'manager', 'accountant'].includes(identity.role));
          setCanPost(['owner', 'manager'].includes(identity.role));
          setRole(identity.role);
          setShop(identity.shopId);
          setLoading(false);
          return;
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
        setShowVoided(loadShowVoided('purchases', fresh.user.id));
        if (!['owner', 'manager', 'accountant'].includes(m.role)) {
          forgetSaved(active);
          throw new Error('Purchase history is restricted by your role.');
        }
        if (!active) return;
        setAllowed(true);
        setCanPost(['owner', 'manager'].includes(m.role));
        setRole(m.role);
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
  function applyOpen(o: OpenBill) {
    setDetail(o.detail);
    if (o.extras.ok) {
      setExtras(o.extras.v);
      setExtrasError('');
    } else {
      setExtras(null);
      setExtrasError(`Payment details could not be loaded: ${String(o.extras.e)}`);
    }
  }
  // Touch: prefetch only after a ~250 ms hold/pause on a row, never on every scroll touch.
  const holdTimer = useRef<number | undefined>(undefined);
  function cancelHold() {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
  }
  function holdPrefetch(id: string) {
    cancelHold();
    holdTimer.current = window.setTimeout(() => prefetch(id), 250);
  }
  useEffect(() => cancelHold, []);
  function prefetch(id: string) {
    if (!shop || billCache.peek(billKey(shop, id))) return;
    billCache.fetch(billKey(shop, id)).catch(() => undefined);
  }
  // Global search opens a bill directly: /purchases?bill=<id>.
  const billParam = query.get('bill') ?? '';
  useEffect(() => {
    if (shop && billParam) void open(billParam);
  }, [shop, billParam]);
  async function open(id: string, fresh = false) {
    if (!shop) {
      setError('Still loading this shop. Try again in a moment.');
      return;
    }
    const token = ++generation.current;
    setCreditVoidNote('');
    const key = billKey(shop, id);
    const cached = fresh ? undefined : billCache.peek(key);
    setOpenRow(rows.find((r) => r.id === id) ?? null);
    setDetailError('');
    if (cached) applyOpen(cached);
    else {
      setDetail(null);
      setExtras(null);
      setExtrasError('');
    }
    if (voidRequest.current?.billId !== id) {
      voidRequest.current = null;
      setVoidUnconfirmed(false);
      setVoidReason('');
      setVoidNote('');
    }
    setDetailLoading(true);
    try {
      // Always revalidate: a cached bill is shown only until the server answers.
      // A hover prefetch already in flight is reused; an explicit refresh never is.
      if (cached || fresh) billCache.invalidate(key);
      const o = await billCache.fetch(key);
      if (token !== generation.current) return;
      applyOpen(o);
    } catch (e) {
      if (token === generation.current) setDetailError(String(e));
    } finally {
      if (token === generation.current) setDetailLoading(false);
    }
  }
  async function voidPaid(billId: string) {
    if (voidBusy) return;
    const reason = voidReason.trim();
    if (!reason) return;
    if (!voidRequest.current || voidRequest.current.billId !== billId) {
      if (
        !confirm(
          'Void this bill and its payment? Stock comes off and the supplier payment is cancelled. This cannot be undone.',
        )
      )
        return;
      voidRequest.current = { billId, clientId: crypto.randomUUID(), reason };
    }
    const req = voidRequest.current;
    setVoidBusy(true);
    setVoidNote('');
    try {
      const outcome = await voidPaidPurchaseOutcome({
        purchaseId: req.billId,
        reason: req.reason,
        clientId: req.clientId,
      });
      if (outcome.kind === 'unknown') {
        setVoidUnconfirmed(true);
        setVoidNote(
          `Not confirmed: ${outcome.message}. Retry sends the same void request; it never voids twice.`,
        );
        return;
      }
      voidRequest.current = null;
      setVoidUnconfirmed(false);
      if (outcome.kind === 'rejected') {
        setVoidNote(`Not voided: ${outcome.message}`);
        return;
      }
      setVoidReason('');
      setVoidNote(
        outcome.value.paymentVoided
          ? 'Bill and its payment voided.'
          : 'Bill voided (its payment had already been voided).',
      );
      billCache.invalidate(billKey(shop, billId));
      await refresh();
      const note = outcome.value.paymentVoided
        ? 'Bill and its payment voided.'
        : 'Bill voided (its payment had already been voided).';
      await open(billId, true);
      setVoidNote(note);
    } finally {
      setVoidBusy(false);
    }
  }
  const name = (id: string | null) =>
    parties.find((p) => p.id === id)?.name ?? (id ? 'Supplier unavailable' : 'No supplier');
  const matching = filterBills(
    rows,
    { status: statusFilter === 'pending' ? 'all' : statusFilter, from: fromDate, to: toDate },
    settlements,
  )
    .filter(
      (b) =>
        (statusFilter !== 'pending' || !!pending?.has(b.id)) &&
        (!supplier || b.party_id === supplier) &&
        (`${b.bill_no ?? ''} ${name(b.party_id)} ${b.business_date} ${rupees(b.total_paise)}`
          .toLowerCase()
          .includes(queryText.toLowerCase()) ||
          billCodeMatch(b.bill_code, queryText) !== null),
    )
    .sort(
      (a, b) =>
        (sort === 'entered'
          ? b.created_at.localeCompare(a.created_at)
          : b.business_date.localeCompare(a.business_date)) ||
        b.created_at.localeCompare(a.created_at) ||
        a.id.localeCompare(b.id),
    );
  // Display only. Choosing the Voided status filter is an explicit request to see them.
  const voidedShown = showVoided || statusFilter === 'void';
  const { shown: visible, hidden: hiddenVoided } = hideVoided(
    matching,
    (b) => b.status === 'VOID',
    voidedShown,
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
      {loading && !rows.length && <p role="status">Loading purchases…</p>}
      {loading && !!rows.length && (
        <p class="muted" role="status">
          Updating the bill list…
        </p>
      )}
      {!entering && <SnapshotNote at={snapshotAt} failed={snapshotFailed} />}
      {allowed && canPost && (entering || entryMounted) && (
        <div hidden={!entering}>
          <InventoryScreen
            purchaseOnly
            purchaseContextActive={entering}
            purchaseSupplierId={query.get('supplier') ?? ''}
            purchaseRepeatId={query.get('repeat') ?? ''}
            purchaseEditId={query.get('edit') ?? ''}
            onPurchasePosted={() => {
              billCache.clear();
              void refresh();
            }}
          />
        </div>
      )}
      <div hidden={entering}>
        <section class="card">
          <label class="search-field">
            Search loaded bills
            <input
              value={queryText}
              placeholder="Bill, bill code, supplier, date or amount"
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
            <label>
              Status
              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.currentTarget.value as BillStatusFilter | 'pending')
                }
              >
                <option value="all">All bills</option>
                <option value="posted">Posted</option>
                <option value="void">Voided</option>
                <option value="paid">Paid</option>
                <option value="partial">Partial</option>
                <option value="unpaid">Unpaid</option>
                <option value="pending">Pending items</option>
              </select>
            </label>
            <label class="inline-check">
              <input
                type="checkbox"
                checked={voidedShown}
                disabled={statusFilter === 'void'}
                onChange={(e) => {
                  setShowVoided(e.currentTarget.checked);
                  saveShowVoided('purchases', userRef.current, e.currentTarget.checked);
                }}
              />{' '}
              Show voided
            </label>
            <label>
              From
              <input
                type="date"
                value={fromDate}
                onInput={(e) => setFromDate(e.currentTarget.value)}
              />
            </label>
            <label>
              To
              <input type="date" value={toDate} onInput={(e) => setToDate(e.currentTarget.value)} />
            </label>
          </div>
          <p class="muted">
            Showing {visible.length} of {rows.length} loaded bills.{hiddenNote(hiddenVoided)}{' '}
            Filters apply to loaded bills; load older bills to search more history.
          </p>
          <div class="record-list">
            {visible.map((b) => (
              <button
                type="button"
                key={b.id}
                aria-current={openRow?.id === b.id ? 'true' : undefined}
                onClick={() => void open(b.id)}
                onPointerEnter={() => prefetch(b.id)}
                onTouchStart={() => holdPrefetch(b.id)}
                onTouchMove={cancelHold}
                onTouchEnd={cancelHold}
                onTouchCancel={cancelHold}
                onFocus={() => prefetch(b.id)}
              >
                <span>
                  <strong>{name(b.party_id)}</strong>
                  <small>
                    {b.bill_no || b.bill_code || b.id.slice(0, 8)}
                    {b.bill_no && b.bill_code ? ` · ${b.bill_code}` : ''} · {b.business_date} ·{' '}
                    {b.status === 'VOID' ? 'Voided' : 'Posted'}
                  </small>
                  {listBadge(settlements.get(b.id)) && (
                    <span
                      class={`badge settle-${settlements.get(b.id)!.status}`}
                      data-testid="list-settlement"
                    >
                      {listBadge(settlements.get(b.id))}
                    </span>
                  )}
                  {pending?.has(b.id) && (
                    <span class="badge remark-open" data-testid="list-pending">
                      Pending
                    </span>
                  )}
                </span>
                <span class="record-value">{rupees(b.total_paise)}</span>
              </button>
            ))}
          </div>
          {!loading && !visible.length && (
            <p>
              No purchases match.
              {hiddenVoided > 0 && ' Voided bills are hidden; tick Show voided to see them.'}
            </p>
          )}
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
                    loadSettlements(shop, next, false);
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
        {!detail && openRow && (
          <section class="card" aria-label="Purchase detail">
            <div class="row">
              <h2>{openRow.bill_no || 'Purchase bill'}</h2>
              <button
                type="button"
                onClick={() => {
                  generation.current++;
                  setOpenRow(null);
                  setDetailLoading(false);
                }}
              >
                Close detail
              </button>
            </div>
            <p>
              {name(openRow.party_id)} · {openRow.business_date}
            </p>
            <p>
              <strong>{rupees(openRow.total_paise)}</strong>
            </p>
            {detailError ? (
              <p role="alert">
                {detailError}{' '}
                <button type="button" onClick={() => void open(openRow.id, true)}>
                  Retry
                </button>
              </p>
            ) : (
              detailLoading && <p role="status">Loading bill items…</p>
            )}
          </section>
        )}
        {detail && (
          <section class="card" aria-label="Purchase detail" aria-busy={detailLoading}>
            {detailLoading && (
              <p class="muted" role="status">
                Refreshing…
              </p>
            )}
            {detailError && (
              <p role="alert" data-testid="detail-stale">
                This bill may be out of date — it could not be refreshed: {detailError}{' '}
                <button type="button" onClick={() => void open(detail.bill.id, true)}>
                  Retry
                </button>
              </p>
            )}
            <div class="row">
              <h2>{detail.bill.bill_no || 'Purchase bill'}</h2>
              <ShareImageButton
                build={async () => {
                  const party = parties.find((p) => p.id === detail.bill.party_id) ?? null;
                  const prof = await loadShopProfile(shop);
                  return purchaseBillDoc(
                    detail,
                    prof.profile,
                    party ? { name: party.name, phone: party.phone } : null,
                    extras?.lines ?? [],
                  );
                }}
              />
              <button
                type="button"
                onClick={() => {
                  generation.current++;
                  setDetail(null);
                  setOpenRow(null);
                  setDetailLoading(false);
                }}
              >
                Close detail
              </button>
            </div>
            <p>
              {name(detail.bill.party_id)} · {detail.bill.business_date}
            </p>
            <BillCodeChip code={detail.bill.bill_code} />
            <p>
              <strong>{rupees(detail.bill.total_paise)}</strong>
              {extras && (
                <>
                  {' '}
                  · {PAYMENT_LABEL[extras.paymentType]} bill ·{' '}
                  <span
                    class={`badge settle-${extras.settlement.status}`}
                    data-testid="settlement-badge"
                  >
                    {settlementLabel(extras.settlement)}
                  </span>
                </>
              )}
            </p>
            {extrasError && (
              <p class="muted">
                <span class="badge" data-testid="settlement-badge">
                  Payment status unavailable
                </span>{' '}
                {extrasError}
              </p>
            )}
            {creditVoidNote && <p role="status">{creditVoidNote}</p>}
            {links?.replacedById && (
              <p data-testid="bill-replaced">
                This bill was corrected and replaced.{' '}
                <button
                  type="button"
                  class="link"
                  onClick={() => void open(links.replacedById as string, true)}
                >
                  Open the corrected bill
                </button>
              </p>
            )}
            {links?.editedFromId && (
              <p data-testid="bill-edited-from">
                Corrected bill.{' '}
                <button
                  type="button"
                  class="link"
                  onClick={() => void open(links.editedFromId as string, true)}
                >
                  Open the original
                </button>
              </p>
            )}
            {detail.bill.status === 'VOID' &&
              clearPendingVoid(`${userRef.current}:${shop}`, detail.bill.id)}
            {detail.bill.status === 'VOID' && (
              <VoidReasonNote shopId={shop} billId={detail.bill.id} />
            )}
            {extras?.notes && <p data-testid="bill-notes">Notes: {extras.notes}</p>}
            {shop && userRef.current && (
              <RemarkBox
                shopId={shop}
                docKind="purchase"
                docId={detail.bill.id}
                userId={userRef.current}
                role={role}
                onLoaded={(list) => {
                  const id = detail.bill.id;
                  const has = list.some((r) => r.status === 'OPEN');
                  // A void bill is never ADDED to the badges from its own remark list: a bill replaced by an
                  // edit shows its open remarks under the corrected bill (server list), so marking the void
                  // original "Pending" would show them twice. Removing a badge is always safe.
                  if (has && detail.bill.status !== 'POSTED') return;
                  setPending((old) => {
                    if (!old || old.has(id) === has) return old;
                    const next = new Set(old);
                    if (has) next.add(id);
                    else next.delete(id);
                    return next;
                  });
                }}
              />
            )}
            {detail.balance && (
              <p>
                Paid {rupees(detail.balance.allocated_paise)} · Returned{' '}
                {rupees(detail.balance.returned_paise)} · Due{' '}
                {rupees(detail.balance.outstanding_paise)}
              </p>
            )}
            {(
              extras?.images ?? (detail.bill.bill_image_path ? [detail.bill.bill_image_path] : [])
            ).map((path, i) => (
              <BillDocumentPreview
                key={`${detail.bill.id}:${path}`}
                path={path}
                name={`${detail.bill.bill_no || 'Purchase bill'}${i ? `-${i + 1}` : ''}.${path.endsWith('.pdf') ? 'pdf' : 'webp'}`}
              />
            ))}
            <div class="record-list">
              {detail.lines.map((l) => {
                const x = extras?.lines.find((e) => e.lineNo === l.line_no);
                return (
                  <div class="purchase-line" key={l.id}>
                    <span>
                      <strong>{l.item_name_snapshot}</strong>
                      <small>
                        {formatQuantity(l.qty)} {l.unit_name_snapshot} ×{' '}
                        {rupees(l.unit_price_paise)}
                        {x?.discountBp ? ` − ${percentText(x.discountBp)}% discount` : ''}
                        {x && x.gstBp !== null ? ` + ${percentText(x.gstBp)}% GST` : ''}
                      </small>
                    </span>
                    <strong>{rupees(l.line_total_paise)}</strong>
                  </div>
                );
              })}
            </div>
            {!!extras?.charges.length && (
              <p data-testid="bill-charges">
                Extra charges:{' '}
                {extras.charges.map((c) => `${c.label} ${rupees(c.amountPaise)}`).join(' · ')}
              </p>
            )}
            <p>
              Items {rupees(detail.bill.subtotal_paise)} · Discount{' '}
              {rupees(detail.bill.discount_paise)} · Extra {rupees(detail.bill.extra_charges_paise)}
              {roundOffLabel(detail.bill.round_off_paise) &&
                ` · ${roundOffLabel(detail.bill.round_off_paise)}`}
            </p>
            {extras && detail.bill.status === 'POSTED' && extras.paymentType !== 'credit' && (
              <section class="void-paid" aria-label="Void bill">
                {voidPaidAccess(role) ? (
                  <>
                    <label>
                      Reason for voiding
                      <input
                        value={voidReason}
                        readOnly={voidUnconfirmed}
                        disabled={voidBusy || detailLoading || !!detailError}
                        placeholder="e.g. entered twice"
                        onInput={(e) => setVoidReason(e.currentTarget.value)}
                      />
                    </label>
                    <button
                      type="button"
                      class="danger"
                      disabled={voidBusy || detailLoading || !!detailError || !voidReason.trim()}
                      onClick={() => void voidPaid(detail.bill.id)}
                    >
                      {voidBusy
                        ? 'Voiding…'
                        : voidUnconfirmed
                          ? 'Retry void (same request)'
                          : 'Void bill and its payment'}
                    </button>
                    <small class="muted">
                      Voids this {PAYMENT_LABEL[extras.paymentType]} bill, its stock and the{' '}
                      {PAYMENT_LABEL[extras.paymentType]} payment of{' '}
                      {rupees(detail.bill.total_paise)} together.
                    </small>
                  </>
                ) : (
                  <p class="muted" data-testid="void-not-allowed">
                    Only the owner can void a {PAYMENT_LABEL[extras.paymentType]} bill, because it
                    also voids the supplier payment. Ask the owner.
                  </p>
                )}
                {voidNote && <p role="status">{voidNote}</p>}
              </section>
            )}
            {extras && detail.bill.status === 'POSTED' && extras.paymentType === 'credit' && (
              <>
                {canPost ? (
                  <CreditVoidPanel
                    shopId={shop}
                    offlineCapable={canPost}
                    billId={detail.bill.id}
                    label={detail.bill.bill_no || 'this bill'}
                    scope={`${userRef.current}:${shop}`}
                    disabled={detailLoading || !!detailError}
                    blocked={voidBlocker(detail.balance)}
                    onVoided={(note) => {
                      void refresh();
                      void open(detail.bill.id, true).then(() => setCreditVoidNote(note));
                    }}
                  />
                ) : (
                  <p class="muted" data-testid="void-not-allowed">
                    Only the owner or a manager can void a bill. Ask them.
                  </p>
                )}
              </>
            )}
            <nav class="context-actions" aria-label="Bill actions">
              {canPost && detail.bill.status === 'POSTED' && links && !links.replacedById && (
                <a
                  class="button-link"
                  data-testid="edit-bill"
                  href={appRoute.purchases + '?new=1&edit=' + encodeURIComponent(detail.bill.id)}
                >
                  Edit bill
                </a>
              )}
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
