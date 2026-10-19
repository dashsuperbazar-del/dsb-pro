import { CameraScanner } from '../components/CameraScanner';
import { PriceHistory } from '../components/PriceHistory';
import { DemandChart } from '../components/DemandChart';
import { learnedUnits } from '../lib/unitLearning';
import {
  ITEM_FIELD_LABELS,
  ITEM_UNITS_HINT,
  describeItemUnits,
  isItemClientIdConflict,
  newItemInput,
  newItemProblem,
  sameUnits,
  type NewItemFields,
} from '../lib/newItem';
import { PurchaseBillCards } from '../components/PurchaseBillCards';
import {
  addLineAsCard,
  billFromCards,
  cardDrafts,
  cardFromLine,
  cardsFromDraft,
  emptyCard,
  isBlankCard,
  type BillCard,
} from '../lib/billCards';
import { SnapshotNote } from '../components/SnapshotNote';
import {
  peekSnapshot,
  putSnapshot,
  snapshotRefreshFailed,
  snapshotUserId,
} from '../lib/routeSnapshot';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  addItemBarcode,
  createItem,
  findItemByClientId,
  createParty,
  findItemByBarcode,
  onAuthStateChange,
  getPurchaseDetail,
  listPurchaseHistory,
  type PurchaseRecord,
  getShopBusinessDate,
  importLegacyDsbMaster,
  listCurrentPrices,
  listItems,
  listParties,
  listStock,
  postPurchaseOutcome,
  replaceItemImage,
  setItemPrice,
  setItemMinStock,
  type Item,
  type ItemPrice,
  type Party,
  type StockRow,
  type PurchaseRequest,
  type BillDocument,
} from '@dsb-pro/adapters';
import {
  buildLegacyDsbImportPlan,
  parseRupeesToPaise,
  type LegacyDsbImportPlan,
} from '@dsb-pro/core';
import { repeatPurchase, rankedPurchaseParties } from '../lib/purchaseWorkflow';
import { readCatalogForScreen, markCatalogDirty, catalogDirtySince } from '../lib/catalogRead';
import { boundedItemOptions } from '../lib/itemOptions';
import { BatchPurchaseEntry } from '../components/BatchPurchaseEntry';
import { QuickBillEntry } from '../components/QuickBillEntry';
import { paperTotalCheck } from '../lib/quickBill';
import { shopContext } from '../lib/shopContext';
import { findOfflineBarcode, getSyncedOfflineCatalog, runSyncNow } from '../lib/offlineSync';
import { paiseToDecimal, rupees } from '../lib/money';
import { compressItemImage } from '../lib/compressImage';
import { BillDocumentPreview } from '../components/BillDocumentPreview';
import { BillAttachmentEditor } from '../components/BillAttachmentEditor';
import { removeLocalDocument } from '../lib/billDocumentStore';
import { TaskTabs } from '../components/TaskTabs';
import { appRoute } from '../lib/paths';
import { useDirtyGuard } from '../lib/dirtyGuard';
import {
  ageText,
  currentPricePaise,
  isPermanentPriceError,
  listPricePlans,
  loadPricePlan,
  planKey,
  PLAN_MAX_AGE_MS,
  removePricePlan,
  salePricePlan,
  savePricePlan,
  updatePricePlan,
  writePriceList,
  type PlannedPriceWrite,
  type PriceLoad,
  type StoredPlan,
} from '../lib/billSalePrices';
import { clearPendingIntent, loadPendingIntent, savePendingIntent } from '../lib/pendingIntent';

import {
  purchaseDraftPrefix,
  scanPurchaseDrafts,
  savePurchaseDraft,
  removePurchaseDraft,
  removePurchaseDrafts,
  staleDrafts,
  clearPurchaseDrafts,
  restorePurchaseDraft,
  hasTypedPurchaseInput,
  type PurchaseDraft,
  type SavedPurchaseDraft,
} from '../lib/purchaseDraft';

const paise = (rupees: string) => parseRupeesToPaise(rupees || '0');

type InventorySnapshot = { items: Item[]; parties: Party[]; stock: StockRow[] };

// A sale price of a bill that was not written. failed: bill saved, write failed (Retry). check: found on
// this device after a reload, bill state unknown (check, then Retry). late: the bill confirmed more than a
// day after the price was entered (not written by itself; Retry). expired / refused: Discard only.
type PriceRetry = {
  key: string;
  shop: string;
  savedAt: number;
  write: PlannedPriceWrite;
  state: 'failed' | 'check' | 'late' | 'expired' | 'refused';
  message: string;
};
const RETRYABLE = new Set<PriceRetry['state']>(['failed', 'check', 'late']);

export function InventoryScreen({
  purchaseOnly = false,
  purchaseContextActive = true,
  purchaseSupplierId = '',
  purchaseRepeatId = '',
  onPurchasePosted,
}: {
  purchaseOnly?: boolean;
  purchaseContextActive?: boolean;
  purchaseSupplierId?: string;
  purchaseRepeatId?: string;
  onPurchasePosted?: () => void;
} = {}) {
  type View = 'items' | 'purchase' | 'suppliers' | 'advanced';
  const initial = new URLSearchParams(window.location.search).get('view');
  const [view, setView] = useState<View>(
    purchaseOnly
      ? 'purchase'
      : initial === 'purchase' || initial === 'suppliers' || initial === 'advanced'
        ? initial
        : 'items',
  );
  const [itemSearch, setItemSearch] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [shopId, setShopId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [draftPrefix, setDraftPrefix] = useState('');
  const draftUser = useRef('');
  const [accountChanged, setAccountChanged] = useState(false);
  useEffect(
    () =>
      onAuthStateChange((session) => {
        if (draftUser.current && session?.user.id !== draftUser.current) {
          refreshGeneration.current++;
          setDraftPrefix('');
          setSavedDrafts([]);
          setAccountChanged(true);
        }
      }),
    [],
  );
  const draftWriter = useRef(crypto.randomUUID());
  const barcodeInput = useRef<HTMLInputElement>(null);
  const [savedDrafts, setSavedDrafts] = useState<SavedPurchaseDraft[]>([]);
  const [draftError, setDraftError] = useState('');
  const [unreadableDrafts, setUnreadableDrafts] = useState<string[]>([]);
  const [draftStatus, setDraftStatus] = useState('');
  const [draftTouched, setDraftTouched] = useState(false);
  const [billDocument, setBillDocument] = useState<BillDocument | null>(null);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentSaveError, setDocumentSaveError] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  // The shop's own date, never changed by the purchase form or a resumed draft (limits batch entry dates).
  const [shopToday, setShopToday] = useState('');
  const [canSeePurchasePrices, setCanSeePurchasePrices] = useState(false);
  const [canReadSaleReturns, setCanReadSaleReturns] = useState(false);
  // Bill card "Sale prices" box: only roles that set_item_price accepts (MANAGE_MASTER_DATA).
  const [canSetSalePrices, setCanSetSalePrices] = useState(false);
  const [saleUser, setSaleUser] = useState('');
  const saleEnabled = canSetSalePrices && !!saleUser;
  const [saleLoads, setSaleLoads] = useState<Record<string, PriceLoad>>({});
  const saleLoadsAsked = useRef(new Set<string>());
  const [salePriceGen, setSalePriceGen] = useState(0);
  const saleGenSeen = useRef(0);
  // This page's own key for its stored plans (a second window never touches them).
  const saleWindowId = useRef(crypto.randomUUID());
  // Sale prices of a posted bill that were not written; each can be retried with its own client id.
  const [priceRetries, setPriceRetries] = useState<PriceRetry[]>([]);
  const [priceRetryBusy, setPriceRetryBusy] = useState('');
  // Bills this page has sent: bill client id → its stored plan key (null = no prices to write).
  const ownPlans = useRef(new Map<string, string | null>());
  // P06: the paper bill's total (paise) when this purchase started as a quick bill; checked before posting.
  const [purchaseExpectedTotal, setPurchaseExpectedTotal] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricesFailed, setPricesFailed] = useState(false);
  const [prices, setPrices] = useState<ItemPrice[]>([]);
  // Bill entry cards (old DSB layout): every item of the bill is editable at once. The posted lines are
  // derived from the cards by lib/billCards with the old add-line rules; a total is never silently rounded.
  const [purchaseCards, setPurchaseCards] = useState<BillCard[]>(() => [emptyCard()]);
  const [purchaseSupplier, setPurchaseSupplier] = useState('');
  const [purchaseBillNo, setPurchaseBillNo] = useState('');
  const [purchaseDiscount, setPurchaseDiscount] = useState('');
  const [purchaseExtra, setPurchaseExtra] = useState('');
  const [recentBills, setRecentBills] = useState<PurchaseRecord[]>([]);
  const [recentDetail, setRecentDetail] = useState<Awaited<
    ReturnType<typeof getPurchaseDetail>
  > | null>(null);
  const contextApplied = useRef('');
  const contextNeedsReset = useRef(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const partiesRef = useRef(parties);
  partiesRef.current = parties;
  const [contextBusy, setContextBusy] = useState(false);
  const [purchaseContextReady, setPurchaseContextReady] = useState(!purchaseOnly);
  const [purchaseClientId, setPurchaseClientId] = useState<string>(() => crypto.randomUUID());
  const purchaseClientRef = useRef(purchaseClientId);
  purchaseClientRef.current = purchaseClientId;
  // After a failure whose outcome is unknown (offline/server), the bill may already be posted. The
  // form stays frozen so a retry resends the SAME request id and payload; the server returns the
  // stored bill if it was committed (and refuses a changed payload).
  const [purchaseLocked, setPurchaseLocked] = useState(false);
  useEffect(() => {
    if (purchaseLocked) setView('purchase');
  }, [purchaseLocked]);
  const lockedPurchase = useRef<PurchaseRequest | null>(null);
  // Survives a reload: stored BEFORE the first send (V002 VF-005), so an unconfirmed purchase is
  // retried as the same request, never re-entered. Unreadable storage blocks new purchases.
  const pendingKey = (shop: string) => `dsb-pending-purchase:${shop}`;
  const [purchaseStorageBlocked, setPurchaseStorageBlocked] = useState('');
  useEffect(() => {
    if (!shopId) return;
    const saved = loadPendingIntent<PurchaseRequest>(pendingKey(shopId));
    if (!saved.ok) {
      setPurchaseStorageBlocked(saved.message);
    } else if (saved.value) {
      lockedPurchase.current = saved.value;
      setPurchaseLocked(true);
    }
  }, [shopId]);
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  // Old-draft discard never offers the draft of this window's purchase or of a purchase awaiting
  // confirmation (its pending request id), so an unconfirmed bill's editable copy is never removed.
  function discardableDrafts() {
    const pending = shopId ? loadPendingIntent<PurchaseRequest>(pendingKey(shopId)) : null;
    const pendingId = pending?.ok ? pending.value?.clientId : undefined;
    return staleDrafts(
      savedDrafts.filter(
        (s) =>
          s.draft.clientId !== purchaseClientId &&
          s.draft.clientId !== pendingId &&
          // A quick bill is the only record of a paper bill not yet entered; never swept with old drafts.
          !s.draft.expectedTotalPaise,
      ),
      Date.now(),
      30,
    );
  }
  const [legacyPlan, setLegacyPlan] = useState<LegacyDsbImportPlan | null>(null);
  const [legacyFileName, setLegacyFileName] = useState('');
  const [legacyClientId, setLegacyClientId] = useState(() => crypto.randomUUID());
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const refreshGeneration = useRef(0);
  // After any server read (first load fallback, or a read that follows our own write) the screen's list is
  // authoritative; a later device-cache pass must not replace it with possibly older rows.
  const serverAuthoritative = useRef(false);
  async function refresh(fresh = false) {
    const generation = ++refreshGeneration.current;
    // SP2b: the stock screen (not purchase entry) shows this tab's last lists at once, display only, then
    // refreshes. Never after one of our own writes that the saved copy may lack, and it never marks the
    // catalogue as loaded, so purchase drafts and repeats still wait for the fresh read.
    const userId = await snapshotUserId();
    if (!fresh && !purchaseOnly && generation === 1) {
      const snap = peekSnapshot<InventorySnapshot>('inventory', userId);
      if (snap && snap.at >= catalogDirtySince() && generation === refreshGeneration.current) {
        setItems(snap.value.items);
        setParties(snap.value.parties);
        setStock(snap.value.stock);
        setSnapshotAt(snap.at);
      }
    }
    if (fresh) {
      // Called right after one of our own writes: the device copy lacks it until a later cycle.
      serverAuthoritative.current = true;
      markCatalogDirty();
      shopContext.invalidate();
    }
    const { membership, session, shopId: shop } = await shopContext.get();
    if (generation !== refreshGeneration.current) return;
    setTenantId(membership.tenantId);
    setShopId(shop);
    setCanSeePurchasePrices(['owner', 'manager', 'accountant'].includes(membership.role));
    // Roles granted POST_SALES or VIEW_REPORTS (sale_returns RLS).
    setCanReadSaleReturns(['owner', 'manager', 'accountant', 'cashier'].includes(membership.role));
    setCanSetSalePrices(['owner', 'manager'].includes(membership.role));
    setSaleUser(session.user.id);
    if (['owner', 'manager'].includes(membership.role)) {
      draftUser.current = session.user.id;
      setDraftPrefix(purchaseDraftPrefix(session.user.id, shop));
    }
    const [catalog, p, s, d] = await Promise.all([
      fresh
        ? listItems().then((rows) => ({ source: 'server' as const, items: rows }))
        : readCatalogForScreen<Item>({
            device: async () => {
              const device = await getSyncedOfflineCatalog({ notBefore: catalogDirtySince() });
              if (!device) return null;
              // Rows must belong to the user and tenant this screen is acting for.
              if (device.tenantId !== membership.tenantId || device.userId !== session.user.id)
                return null;
              catalogKey.current = device.key;
              return device.items as unknown as Item[];
            },
            server: listItems,
          }),
      listParties(),
      listStock(shop),
      shopContext.businessDate(shop),
    ]);
    if (generation !== refreshGeneration.current) return;
    if (catalog.source === 'server') serverAuthoritative.current = true;
    setItems(catalog.items);
    setParties(p);
    setStock(s);
    setSnapshotAt(null);
    if (!purchaseOnly && session.user.id === userId)
      putSnapshot<InventorySnapshot>('inventory', userId, shop, {
        items: catalog.items,
        parties: p,
        stock: s,
      });
    setCatalogLoaded(true);
    setBusinessDate((value) => value || d);
    setShopToday(d);
  }
  const catalogKey = useRef('');
  useEffect(() => {
    let stopped = false;
    void refresh()
      .then(async () => {
        // Opened from the device copy: pick up changes from other devices with one incremental sync cycle
        // (a few small requests) instead of re-downloading the catalog. Display only.
        if (stopped || serverAuthoritative.current || !catalogKey.current) return;
        await runSyncNow().catch(() => undefined);
        if (stopped || serverAuthoritative.current) return;
        const device = await getSyncedOfflineCatalog({ notBefore: catalogDirtySince() });
        if (stopped || serverAuthoritative.current || !device || device.key !== catalogKey.current)
          return;
        setItems(device.items as unknown as Item[]);
      })
      .catch((e) => {
        snapshotRefreshFailed('inventory', e);
        setSnapshotFailed(true);
        setError(String(e));
      });
    return () => {
      stopped = true;
      refreshGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (!selected) {
      setPricesLoading(false);
      setPrices([]);
      return;
    }
    let cancelled = false;
    setPricesLoading(true);
    setPricesFailed(false);
    setPrices([]);
    void listCurrentPrices(selected)
      .then((value) => {
        if (!cancelled) {
          setPrices(value);
          setPricesLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setPricesFailed(true);
          setPricesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);
  useEffect(() => {
    if (!shopId || !purchaseOnly) return;
    let active = true;
    void listPurchaseHistory(shopId)
      .then((b) => {
        if (active) setRecentBills(b);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [shopId, purchaseOnly]);
  useEffect(() => {
    setRecentDetail(null);
    if (!shopId || !purchaseSupplier || !purchaseOnly) return;
    const latest = recentBills.find(
      (b) => b.party_id === purchaseSupplier && b.status === 'POSTED',
    );
    if (!latest) return;
    let active = true;
    void getPurchaseDetail(shopId, latest.id)
      .then((d) => {
        if (active) setRecentDetail(d);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [shopId, purchaseSupplier, recentBills, purchaseOnly]);
  useEffect(() => {
    const intent = purchaseSupplierId + ':' + purchaseRepeatId;
    if (
      (!purchaseContextActive || intent !== contextApplied.current) &&
      contextNeedsReset.current
    ) {
      contextApplied.current = '';
      contextNeedsReset.current = false;
    }
    if (
      !purchaseOnly ||
      !purchaseContextActive ||
      !shopId ||
      !catalogLoaded ||
      contextNeedsReset.current
    )
      return;
    if (contextApplied.current === intent) return;
    if (lockedPurchase.current || purchaseStorageBlocked) {
      setError('Resolve the pending purchase before starting or repeating another bill.');
      return;
    }
    contextApplied.current = intent;
    if (
      (billDocument ||
        draftTouched ||
        purchaseCards.some((c) => !isBlankCard(c)) ||
        purchaseBillNo ||
        purchaseDiscount ||
        purchaseExtra) &&
      !confirm('Replace this unfinished purchase with the selected new draft?')
    ) {
      contextNeedsReset.current = true;
      setPurchaseContextReady(true);
      return;
    }
    let active = true;
    let completed = false;
    setPurchaseContextReady(false);
    setContextBusy(true);
    void (async () => {
      try {
        const newDate = await getShopBusinessDate(shopId);
        if (!active) return;
        if (purchaseRepeatId) {
          const d = await getPurchaseDetail(shopId, purchaseRepeatId);
          const cart = repeatPurchase(d.bill, d.lines, itemsRef.current);
          if (!active) return;
          if (d.bill.party_id && !partiesRef.current.some((p) => p.id === d.bill.party_id))
            throw new Error('The original supplier is unavailable. Start a new purchase manually.');
          setPurchaseSupplier(d.bill.party_id || '');
          setPurchaseCards(cart.map(cardFromLine));
          setPurchaseDiscount(paiseToDecimal(d.bill.discount_paise));
          setPurchaseExtra(paiseToDecimal(d.bill.extra_charges_paise));
          setMessage(
            `Draft repeated from ${d.bill.bill_no || d.bill.id.slice(0, 8)} (${d.bill.business_date}). Historical costs and adjustments copied — review them. This is a new purchase, not posted yet.`,
          );
        } else {
          if (purchaseSupplierId && !partiesRef.current.some((p) => p.id === purchaseSupplierId))
            throw new Error('Supplier is unavailable.');
          setPurchaseSupplier(purchaseSupplierId);
          setPurchaseCards([emptyCard()]);
          setPurchaseDiscount('');
          setPurchaseExtra('');
        }
        setBusinessDate(newDate);
        setPurchaseExpectedTotal(undefined);
        setPurchaseBillNo('');
        setBillDocument(null);
        setDocumentBusy(false);
        setDocumentSaveError('');
        setPurchaseClientId(crypto.randomUUID());
        completed = true;
      } catch (e) {
        if (active) {
          setError(String(e));
          contextNeedsReset.current = true;
        }
      } finally {
        if (active) {
          setContextBusy(false);
          setPurchaseContextReady(true);
        }
      }
    })();
    return () => {
      active = false;
      if (!completed) contextApplied.current = '';
      setContextBusy(false);
    };
  }, [
    shopId,
    catalogLoaded,
    purchaseSupplierId,
    purchaseRepeatId,
    purchaseOnly,
    purchaseContextActive,
    purchaseLocked,
    purchaseStorageBlocked,
  ]);
  function refreshDrafts() {
    if (!draftPrefix) return;
    try {
      const scan = scanPurchaseDrafts(draftPrefix);
      setSavedDrafts(scan.drafts);
      setUnreadableDrafts(scan.unreadable);
      setDraftError('');
    } catch (e) {
      setDraftError(`Draft recovery unavailable: ${String(e)}. Existing drafts have been kept.`);
    }
  }
  useEffect(() => {
    if (!draftPrefix) return;
    refreshDrafts();
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(draftPrefix)) refreshDrafts();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [draftPrefix]);
  const purchaseBill = useMemo(() => billFromCards(purchaseCards), [purchaseCards]);
  // Current sale prices of the items on the cards (and of retry alerts), read once per item and read
  // again after any price write, so "unchanged" is judged against fresh prices.
  const saleItemIds = saleEnabled
    ? [
        ...new Set([
          ...purchaseCards.flatMap((c) => (c.item ? [c.item.id] : [])),
          ...priceRetries.map((r) => r.write.itemId),
        ]),
      ]
        .sort()
        .join(',')
    : '';
  useEffect(() => {
    if (!saleItemIds) return;
    if (saleGenSeen.current !== salePriceGen) {
      saleGenSeen.current = salePriceGen;
      saleLoadsAsked.current.clear();
    }
    const gen = salePriceGen;
    for (const id of saleItemIds.split(',')) {
      if (saleLoadsAsked.current.has(id)) continue;
      saleLoadsAsked.current.add(id);
      setSaleLoads((l) => ({ ...l, [id]: { state: 'loading' } }));
      const settle = (load: PriceLoad) => {
        if (saleGenSeen.current === gen) setSaleLoads((l) => ({ ...l, [id]: load }));
      };
      void Promise.resolve()
        .then(() => listCurrentPrices(id))
        .then(
          (prices) => settle({ state: 'ok', prices: prices ?? [] }),
          () => settle({ state: 'failed' }),
        );
    }
  }, [saleItemIds, salePriceGen]);
  const reloadSalePrices = () => setSalePriceGen((g) => g + 1);
  // Plans of this user on this device with no unconfirmed bill behind them: the page closed before their
  // prices were written, or a write failed. Whether the bill posted is not known here, so each is offered
  // as "check the bill, then Retry or Discard"; plans older than a day only as Discard.
  useEffect(() => {
    if (!shopId || !saleEnabled) return;
    const pending = new Set<string>();
    try {
      const head = pendingKey(shopId);
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || (key !== head && !key.startsWith(`${head}:`))) continue;
        const v = JSON.parse(localStorage.getItem(key) ?? 'null') as { clientId?: unknown } | null;
        if (typeof v?.clientId === 'string') pending.add(v.clientId);
      }
    } catch {
      return; // Cannot tell an unconfirmed bill from a finished one: offer nothing.
    }
    const now = Date.now();
    const left = listPricePlans(saleUser, shopId).filter(
      (p) =>
        !pending.has(p.bill) &&
        p.bill !== lockedPurchase.current?.clientId &&
        !ownPlans.current.has(p.bill),
    );
    if (!left.length) return;
    setPriceRetries((r) => [
      ...r,
      ...left.flatMap((p) =>
        p.writes
          .filter((w) => !r.some((x) => x.write.clientId === w.clientId))
          .map((write): PriceRetry => ({
            key: p.key,
            shop: shopId,
            savedAt: p.savedAt,
            write,
            state: now - p.savedAt > PLAN_MAX_AGE_MS ? 'expired' : 'check',
            message: '',
          })),
      ),
    ]);
  }, [shopId, saleEnabled, saleUser]);
  async function writeSalePrices(shop: string, bill: string): Promise<string> {
    const own = ownPlans.current.get(bill);
    ownPlans.current.delete(bill);
    // This window's plan; after a reload (plan saved by the earlier page) every plan kept for this bill.
    const plans =
      own === undefined
        ? saleUser
          ? listPricePlans(saleUser, shop).filter((p) => p.bill === bill)
          : []
        : own
          ? [loadPricePlan(own)].filter((p): p is StoredPlan => !!p)
          : [];
    if (!plans.length) return '';
    const entries: PriceRetry[] = [];
    let done = 0;
    for (const plan of plans) {
      const base = { key: plan.key, shop, savedAt: plan.savedAt };
      if (Date.now() - plan.savedAt > PLAN_MAX_AGE_MS) {
        // Confirmed more than a day after the prices were entered: never written by itself.
        entries.push(
          ...plan.writes.map((write) => ({ ...base, write, state: 'late' as const, message: '' })),
        );
        continue;
      }
      const failed = await writePriceList(plan.writes, (w) =>
        setItemPrice({
          itemId: w.itemId,
          shopId: shop,
          kind: w.kind,
          unitLevel: w.unitLevel,
          pricePaise: w.pricePaise,
          clientId: w.clientId,
        }),
      );
      done += plan.writes.length - failed.length;
      const retryable = failed.filter((f) => !isPermanentPriceError(f.message));
      updatePricePlan(
        plan.key,
        retryable.map((f) => f.write),
      );
      entries.push(
        ...failed.map((f) => ({
          ...base,
          write: f.write,
          state: isPermanentPriceError(f.message) ? ('refused' as const) : ('failed' as const),
          message: f.message,
        })),
      );
    }
    setPriceRetries((r) => [
      ...r.filter((x) => !entries.some((e) => e.write.clientId === x.write.clientId)),
      ...entries,
    ]);
    reloadSalePrices();
    return done ? ` Sale price${done === 1 ? '' : 's'} updated: ${done}.` : '';
  }
  function dropFromPlan(entry: PriceRetry) {
    const plan = loadPricePlan(entry.key);
    if (plan)
      updatePricePlan(
        entry.key,
        plan.writes.filter((w) => w.clientId !== entry.write.clientId),
      );
  }
  function discardPrice(entry: PriceRetry) {
    dropFromPlan(entry);
    setPriceRetries((r) => r.filter((x) => x.write.clientId !== entry.write.clientId));
  }
  async function retryPrice(entry: PriceRetry) {
    if (priceRetryBusy) return;
    setPriceRetryBusy(entry.write.clientId);
    try {
      const w = entry.write;
      await setItemPrice({
        itemId: w.itemId,
        shopId: entry.shop,
        kind: w.kind,
        unitLevel: w.unitLevel,
        pricePaise: w.pricePaise,
        clientId: w.clientId,
      });
      discardPrice(entry);
      reloadSalePrices();
      setMessage(`Sale price updated for ${w.itemName}.`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const permanent = isPermanentPriceError(message);
      if (permanent) dropFromPlan(entry);
      setPriceRetries((r) =>
        r.map((x) =>
          x.write.clientId === entry.write.clientId
            ? { ...x, message, state: permanent ? 'refused' : x.state }
            : x,
        ),
      );
    } finally {
      setPriceRetryBusy('');
    }
  }
  const postButton = useRef<HTMLButtonElement>(null);
  // A refused post's reason, shown next to the Post button until the items change.
  const [barProblem, setBarProblem] = useState('');
  useEffect(() => setBarProblem(''), [purchaseCards]);
  const draftSnapshot: PurchaseDraft = {
    version: 1,
    clientId: purchaseClientId,
    savedAt: Date.now(),
    supplier: purchaseSupplier,
    billNo: purchaseBillNo,
    businessDate,
    discount: purchaseDiscount,
    extra: purchaseExtra,
    // `cart` keeps the complete cards (what would post) for older readers and the draft list;
    // `cards` keeps every card as typed, including unfinished ones.
    cart: purchaseBill.lines,
    search: '',
    lineItem: null,
    unitLevel: 1,
    qty: '',
    price: '',
    costMode: 'unit',
    ...(purchaseExpectedTotal ? { expectedTotalPaise: purchaseExpectedTotal } : {}),
    editingLine: null,
    cards: cardDrafts(purchaseCards),
    document: billDocument,
    documentIssue: documentSaveError,
  };
  // N08: ask before leaving the purchase editor with typed input; its autosaved draft is kept either way.
  useDirtyGuard(
    purchaseOnly &&
      purchaseContextActive &&
      !accountChanged &&
      hasTypedPurchaseInput(draftSnapshot),
  );
  // Layout effect runs after each committed edit, without a debounce that could lose picker/reload work.
  useLayoutEffect(() => {
    if (accountChanged || !draftPrefix || !catalogLoaded || contextBusy || purchaseLocked) return;
    if (!(
      billDocument ||
      draftTouched ||
      purchaseCards.some((c) => !isBlankCard(c)) ||
      purchaseBillNo ||
      purchaseDiscount ||
      purchaseExtra
    ))
      return;
    try {
      // VF-016/017: the save result stands on its own, and only this snapshot is updated in the
      // list (no full rescan and re-parse of every snapshot on each edit).
      const key = savePurchaseDraft(draftPrefix, draftWriter.current, draftSnapshot);
      const saved = { key, draft: draftSnapshot };
      setSavedDrafts((prev) => [saved, ...prev.filter((d) => d.key !== key)]);
      setDraftStatus('Draft saved on this device · not posted');
      setDraftError('');
    } catch (e) {
      setDraftStatus('');
      setDraftError(`Draft not saved: ${String(e)}. Keep this page open until storage works.`);
    }
  }, [
    accountChanged,
    draftPrefix,
    catalogLoaded,
    contextBusy,
    purchaseLocked,
    draftTouched,
    purchaseClientId,
    purchaseSupplier,
    purchaseBillNo,
    businessDate,
    purchaseDiscount,
    purchaseExtra,
    purchaseCards,
    billDocument,
    documentSaveError,
  ]);
  function resumeDraft(saved: SavedPurchaseDraft) {
    if (
      lockedPurchase.current ||
      purchaseBusy ||
      contextBusy ||
      !purchaseContextReady ||
      accountChanged ||
      documentBusy ||
      purchaseStorageBlocked
    )
      return;
    if (
      (draftTouched || purchaseCards.some((c) => !isBlankCard(c)) || purchaseBillNo) &&
      !confirm('Switch to this saved draft? Your current draft stays saved on this device.')
    )
      return;
    try {
      const d = restorePurchaseDraft(saved.draft, items, parties);
      contextApplied.current = purchaseSupplierId + ':' + purchaseRepeatId;
      contextNeedsReset.current = false;
      setPurchaseClientId(d.clientId);
      setBillDocument(d.document ?? null);
      setDocumentBusy(false);
      setDocumentSaveError(d.documentIssue ?? '');
      setPurchaseSupplier(d.supplier);
      setPurchaseBillNo(d.billNo);
      setBusinessDate(d.businessDate);
      setPurchaseDiscount(d.discount);
      setPurchaseExtra(d.extra);
      setPurchaseCards(cardsFromDraft(d));
      setPurchaseExpectedTotal(d.expectedTotalPaise);
      setDraftTouched(true);
      setView('purchase');
      setError('');
      setMessage('Saved purchase draft restored. Review it before posting.');
    } catch (e) {
      setError(String(e));
    }
  }
  const unitSuggestions = useMemo(() => learnedUnits(items), [items]);
  const selectedItem = items.find((i) => i.id === selected);
  const detailPicker = boundedItemOptions(items, itemSearch, selected);
  const selectedStock = useMemo(
    () => stock.find((s) => s.item_id === selected)?.qty_base ?? 0,
    [stock, selected],
  );
  const purchaseTotalPaise = purchaseBill.itemsTotalPaise;
  const payablePaise = (() => {
    try {
      return purchaseTotalPaise - paise(purchaseDiscount) + paise(purchaseExtra);
    } catch {
      return null;
    }
  })();
  const paperCheck = paperTotalCheck(purchaseExpectedTotal, payablePaise);
  const payablePreview = (() => {
    try {
      return rupees(purchaseTotalPaise - paise(purchaseDiscount) + paise(purchaseExtra));
    } catch {
      return 'Check amounts';
    }
  })();

  async function chooseLegacyBackup(ev: Event) {
    setError('');
    setMessage('');
    setLegacyPlan(null);
    setLegacyFileName('');
    const file = (ev.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('DSB backup is too large to import from this screen.');
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const plan = buildLegacyDsbImportPlan(parsed);
      setLegacyPlan(plan);
      setLegacyFileName(file.name);
      setMessage(`Backup checked: ${plan.items.length} valid items are ready to import.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function runLegacyImport() {
    if (legacyBusy || !legacyPlan || !shopId) return;
    const ok = window.confirm(
      `Import ${legacyPlan.items.length} items and their current stock into this empty DSB Pro shop? Old bills and invoices will NOT be imported.`,
    );
    if (!ok) return;
    setLegacyBusy(true);
    setError('');
    setMessage('');
    try {
      const summary = await importLegacyDsbMaster({
        shopId,
        plan: legacyPlan,
        clientId: legacyClientId,
      });
      setLegacyClientId(crypto.randomUUID());
      await refresh(true);
      setLegacyPlan(null);
      setLegacyFileName('');
      setMessage(
        `Import complete: ${summary.items} items, ${summary.parties} suppliers, ${summary.customers} customers and ${summary.stockRows} stock balances loaded.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLegacyBusy(false);
    }
  }
  async function addItem(ev: Event) {
    ev.preventDefault();
    setError('');
    if (!tenantId) {
      setError('Shop data is still loading.');
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    const text = (key: string) => String(f.get(key) || '');
    const fields: NewItemFields = {
      name: text('name'),
      sku: text('sku'),
      unit1: text('unit1'),
      unit2: text('unit2'),
      unit3: text('unit3'),
      conv1: text('conv1'),
      conv2: text('conv2'),
    };
    // The same plain unit rules as "+ Create" in a bill card, before anything is sent.
    const problem = newItemProblem(fields);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      const item = await createItem({
        tenantId,
        ...newItemInput(fields),
        clientId: crypto.randomUUID(),
      });
      form.reset();
      await refresh(true);
      setMessage(`Created ${item.name}.`);
    } catch (e) {
      setError(String(e));
    }
  }
  // "+ Create" inside a bill card: the same adapter and field mapping as the Add item form above. The new
  // item joins the list at once (every card can find it) and the list is then re-read from the server; a
  // failed re-read never turns the successful create into an error (that would invite a second create).
  async function createItemFromCard(fields: NewItemFields, clientId: string): Promise<Item> {
    if (!tenantId) throw new Error('Shop data is still loading.');
    let item: Item;
    try {
      item = await createItem({ tenantId, ...newItemInput(fields), clientId });
    } catch (e) {
      // The answer may be lost after the server saved it: re-read, so a retry finds the name instead.
      void refresh(true).catch(() => {});
      if (!isItemClientIdConflict(e)) throw e;
      // A retry refused because this create was already saved: it succeeded, so find that item.
      const found = await findItemByClientId(tenantId, clientId).catch((lookupError: unknown) => {
        console.warn('New item lookup by client id failed', lookupError);
        return null;
      });
      if (!found)
        throw new Error('Could not confirm the new item. Check Stock, then search for it here.', {
          cause: e,
        });
      // Only the item that was asked for counts as created; anything else is reported, never selected.
      if (!sameUnits(found, fields))
        throw new Error(
          `Saved earlier as: ${found.name} — ${describeItemUnits(found)}. Check it in Stock before using it.`,
          { cause: e },
        );
      item = found;
    }
    setItems((now) =>
      now.some((i) => i.id === item.id)
        ? now
        : [...now, item].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
    void refresh(true).catch(() => {});
    return item;
  }
  async function addBarcode(ev: Event) {
    ev.preventDefault();
    if (!tenantId) {
      setError('Shop data is still loading.');
      return;
    }
    if (!selectedItem) return;
    const form = ev.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    try {
      await addItemBarcode({
        tenantId,
        itemId: selectedItem.id,
        barcode: String(f.get('barcode')),
        unitLevel: Number(f.get('unitLevel')) as 1 | 2 | 3,
        clientId: crypto.randomUUID(),
      });
      form.reset();
      setMessage('Barcode linked to item.');
    } catch (e) {
      setError(String(e));
    }
  }
  async function addParty(ev: Event) {
    ev.preventDefault();
    setError('');
    if (!tenantId) {
      setError('Shop data is still loading.');
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    try {
      const party = await createParty({
        tenantId,
        name: String(f.get('name')),
        phone: String(f.get('phone') || '') || undefined,
        gstin: String(f.get('gstin') || '') || undefined,
        clientId: crypto.randomUUID(),
      });
      form.reset();
      await refresh(true);
      if (purchaseOnly) {
        setPurchaseSupplier(party.id);
        setDraftTouched(true);
        const disclosure = form.closest('details');
        if (disclosure) disclosure.open = false;
      }
      setMessage(`Created supplier ${party.name}.`);
    } catch (e) {
      setError(String(e));
    }
  }
  // Card camera scan: the device copy first when offline, as on the POS screen. Fills that card only.
  async function findBarcodeForCard(code: string) {
    let hit;
    if (typeof navigator !== 'undefined' && !navigator.onLine) hit = await findOfflineBarcode(code);
    else {
      try {
        hit = await findItemByBarcode(code);
      } catch {
        hit = await findOfflineBarcode(code);
      }
    }
    if (!hit) return null;
    const item = itemsRef.current.find((i) => i.id === hit.item_id);
    if (!item) throw new Error('Barcode item is unavailable.');
    return { item, unitLevel: hit.unit_level };
  }
  // Old DSB "↺ Repeat": the items of this supplier's last bill replace the cards (discount/extra untouched).
  function repeatLastBill() {
    if (!recentDetail) return;
    let cards: BillCard[];
    try {
      cards = repeatPurchase(recentDetail.bill, recentDetail.lines, items).map(cardFromLine);
    } catch (e) {
      setError(String(e));
      return;
    }
    if (
      purchaseCards.some((c) => !isBlankCard(c)) &&
      !confirm(
        `Replace the items on this bill with the ${cards.length} item${cards.length === 1 ? '' : 's'} of the last bill from this supplier?`,
      )
    )
      return;
    setPurchaseCards(cards);
    setDraftTouched(true);
    setMessage('Items copied from the last bill. Check each quantity and rate.');
  }
  // Enter in a field moves to the next control instead of submitting: implicit form submission would post
  // a half-entered bill. Posting happens only from the Post button.
  function purchaseFormKeyDown(ev: KeyboardEvent) {
    const target = ev.target as HTMLElement;
    if (
      ev.key !== 'Enter' ||
      !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)
    )
      return;
    ev.preventDefault();
    const form = target.form;
    if (!form) return;
    const controls = [...form.elements].filter(
      (el): el is HTMLElement =>
        (el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLButtonElement) &&
        !el.disabled &&
        !(el instanceof HTMLInputElement && el.type === 'hidden') &&
        !el.closest('[hidden], details:not([open])'),
    );
    const at = controls.indexOf(target);
    const next = controls[at + 1];
    if (next && next !== postButton.current) next.focus();
  }
  async function addPurchase(ev: Event) {
    ev.preventDefault();
    // Only the Post button posts (never Enter in a field, never a script-driven submit without it).
    if (!postButton.current || (ev as SubmitEvent).submitter !== postButton.current) return;
    if (purchaseBusy || contextBusy || (!purchaseLocked && !purchaseContextReady) || accountChanged)
      return;
    setError('');
    if (
      !purchaseLocked &&
      (documentBusy || documentSaveError || (billDocument && !billDocument.uploaded))
    ) {
      setError('Confirm the document upload, or explicitly remove the attachment, before posting.');
      return;
    }
    if (!purchaseLocked && purchaseBill.problems.length) {
      const first = purchaseBill.problems[0]!;
      const problem = `Item ${first.index + 1}: ${first.message}${purchaseBill.problems.length > 1 ? ` (${purchaseBill.problems.length} items need a look.)` : ''}`;
      setError(problem);
      setBarProblem(problem);
      // Take the user to the first card that needs a look, at the field to fix.
      const bad = purchaseCards[first.index];
      const field = !bad?.item ? 'name' : /quantity/i.test(first.message) ? 'qty' : 'price';
      const badCard = (ev.currentTarget as HTMLFormElement).querySelectorAll('.bill-card')[
        first.index
      ];
      const input = badCard?.querySelector<HTMLInputElement>(`[data-field="${field}"]`);
      input?.scrollIntoView?.({ block: 'center' });
      input?.focus();
      return;
    }
    if (!shopId || !businessDate) {
      setError('Shop data is still loading.');
      return;
    }
    if (!purchaseBill.lines.length && !(purchaseLocked && lockedPurchase.current)) {
      setError('Add at least one item.');
      return;
    }
    // Sale prices typed on the cards: checked before anything is sent, written only after the bill posts.
    let salePlan: PlannedPriceWrite[] = [];
    if (!purchaseLocked && saleEnabled) {
      const plan = salePricePlan(purchaseCards, saleLoads, shopId, purchaseClientId);
      if (plan.problems.length) {
        const first = plan.problems[0]!;
        const problem = `Item ${first.index + 1}: ${first.message}`;
        setError(problem);
        setBarProblem(problem);
        const field = /wholesale/i.test(first.message) ? 'sale-wsprice' : 'sale-retail';
        const cardEls = (ev.currentTarget as HTMLFormElement).querySelectorAll('.bill-card');
        const input = cardEls[first.index]?.querySelector<HTMLInputElement>(
          `[data-field="${field}"]`,
        );
        input?.scrollIntoView?.({ block: 'center' });
        input?.focus();
        return;
      }
      salePlan = plan.writes;
    }
    if (!purchaseLocked) {
      try {
        restorePurchaseDraft(draftSnapshot, items, parties);
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    const f = new FormData(ev.currentTarget as HTMLFormElement);
    const lineCount =
      purchaseLocked && lockedPurchase.current
        ? lockedPurchase.current.lines.length
        : purchaseBill.lines.length;
    // A retry after an unknown outcome resends the frozen request byte for byte.
    const request = (purchaseLocked && lockedPurchase.current) || {
      shopId,
      partyId: String(f.get('partyId') || '') || undefined,
      billNo: String(f.get('billNo') || '') || undefined,
      businessDate: String(f.get('date')),
      discountPaise: paise(String(f.get('discount'))),
      extraChargesPaise: paise(String(f.get('extra'))),
      clientId: purchaseClientId,
      billImagePath: billDocument?.path,
      lines: purchaseBill.lines.map((l) => ({
        itemId: l.item.id,
        unitLevel: l.unitLevel,
        qty: l.qty,
        unitPricePaise: l.unitPricePaise,
      })),
    };
    if (purchaseStorageBlocked) {
      setError(purchaseStorageBlocked);
      return;
    }
    // P06: a quick bill's items must add up to its paper total, or the user says so explicitly.
    if (!purchaseLocked) {
      const check = paperTotalCheck(purchaseExpectedTotal, payablePaise);
      if (
        check &&
        !check.matches &&
        !confirm(
          check.diffPaise === null
            ? 'The payable amount cannot be worked out, so it cannot be checked against the paper bill total. Post anyway?'
            : `The items come to ${rupees(payablePaise!)} but the paper bill total is ${rupees(purchaseExpectedTotal!)} (${rupees(Math.abs(check.diffPaise))} ${check.diffPaise < 0 ? 'less' : 'more'}). Post anyway?`,
        )
      )
        return;
    }
    const isRetry = Boolean(purchaseLocked && lockedPurchase.current);
    // The sale price plan is stored before the bill (and never inside its request, which stays as it was),
    // so prices are written or offered for retry once the bill posts, even after a reload.
    const ownKey = saleUser
      ? planKey(saleUser, request.shopId, request.clientId, saleWindowId.current)
      : '';
    if (!isRetry) {
      try {
        if (salePlan.length)
          savePricePlan(ownKey, { bill: request.clientId, savedAt: Date.now(), writes: salePlan });
        else if (ownKey) removePricePlan(ownKey);
      } catch (e) {
        setError(
          `Sale prices could not be kept on this device, so the bill was not sent: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      ownPlans.current.set(request.clientId, salePlan.length ? ownKey : null);
    }
    // Durable before dispatch, or not sent at all.
    try {
      savePendingIntent(pendingKey(request.shopId), request, { retry: isRetry });
    } catch (e) {
      // Only this window's own plan is removed; another window's plan for the same bill is kept.
      if (!isRetry) {
        if (ownKey) removePricePlan(ownKey);
        ownPlans.current.delete(request.clientId);
      }
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    lockedPurchase.current = request;
    setPurchaseLocked(true);
    setPurchaseBusy(true);
    setMessage('');
    try {
      const outcome = await postPurchaseOutcome(request, isRetry);
      if (outcome.kind === 'unknown') {
        // May have committed: the form stays frozen and a retry resends this exact request.
        setError(
          `Not confirmed: ${outcome.message}. The bill is locked — retry sends the same bill and never posts it twice.`,
        );
        return;
      }
      lockedPurchase.current = null;
      setPurchaseLocked(false);
      clearPendingIntent(pendingKey(request.shopId), request.clientId);
      // Another window's unconfirmed purchase may still be stored: lock onto it next, same id (VF-009).
      const next = loadPendingIntent<PurchaseRequest>(pendingKey(request.shopId));
      const another = Boolean(next.ok && next.value);
      if (next.ok && next.value) {
        lockedPurchase.current = next.value;
        setPurchaseLocked(true);
      }
      const anotherNote = another
        ? ' Another unconfirmed purchase from this device is locked in the form now — retry it first; your items are kept.'
        : '';
      if (outcome.kind === 'rejected') {
        // The database refused and rolled back: nothing posted; the cart stays for correction.
        // Keep this identity after rejection too: another editor may already have posted
        // a different payload under it. Rotating would turn a mismatch into a duplicate bill.
        // Nothing posted, so no sale price is written; the next attempt plans them again from the cards.
        if (ownKey) removePricePlan(ownKey);
        ownPlans.current.delete(request.clientId);
        setError(`Not posted: ${outcome.message}.${anotherNote}`);
        return;
      }
      // Only a purchase built from this cart (it carries the cart's id) clears the cart when it posts;
      // a restored entry from another window leaves the user's cart intact (Codex P2).
      if (request.clientId === purchaseClientId) {
        setPurchaseClientId(crypto.randomUUID());
        if (billDocument) void removeLocalDocument(draftPrefix, billDocument.id).catch(() => {});
        setBillDocument(null);
        setDocumentBusy(false);
        setDocumentSaveError('');
        setPurchaseCards([emptyCard()]);
        setPurchaseExpectedTotal(undefined);
        setPurchaseBillNo('');
        setPurchaseDiscount('');
        setPurchaseExtra('');
        contextNeedsReset.current = true;
      }
      if (draftPrefix) {
        try {
          clearPurchaseDrafts(draftPrefix, request.clientId);
          refreshDrafts();
        } catch (e) {
          setDraftError(
            `Purchase confirmed, but its old draft could not be removed: ${String(e)}.`,
          );
        }
      }
      if (request.clientId === purchaseClientId) {
        setDraftTouched(false);
        setDraftStatus('');
      }
      // Sale prices only now, after the bill is confirmed. A failed price write never undoes the bill.
      const priceNote = await writeSalePrices(request.shopId, request.clientId);
      onPurchasePosted?.();
      // Refresh before announcing, as before: the screen is settled when the message appears.
      let refreshNote = '';
      await refresh(true).catch((e) => (refreshNote = ` (Refresh failed: ${String(e)})`));
      setMessage(
        `Purchase posted (${lineCount} item${lineCount === 1 ? '' : 's'}) and stock updated.${priceNote}${refreshNote}`,
      );
    } finally {
      setPurchaseBusy(false);
    }
  }
  async function changePrice(ev: Event) {
    ev.preventDefault();
    if (!shopId) {
      setError('Shop data is still loading.');
      return;
    }
    if (!selected) return;
    const f = new FormData(ev.currentTarget as HTMLFormElement);
    try {
      await setItemPrice({
        itemId: selected,
        shopId,
        kind: String(f.get('kind')) as ItemPrice['kind'],
        unitLevel: Number(f.get('unitLevel')) as 1 | 2 | 3,
        pricePaise: paise(String(f.get('price'))),
        clientId: crypto.randomUUID(),
      });
      const updatedPrices = await listCurrentPrices(selected);
      if (selectedRef.current === selected) setPrices(updatedPrices);
      reloadSalePrices();
      setMessage('Price history updated atomically.');
    } catch (e) {
      setError(String(e));
    }
  }
  async function changeImage(ev: Event) {
    const file = (ev.currentTarget as HTMLInputElement).files?.[0];
    if (!file || !selectedItem) return;
    try {
      const blob = await compressItemImage(file);
      const path = await replaceItemImage({
        tenantId,
        itemId: selectedItem.id,
        blob,
        oldPath: selectedItem.image_path,
      });
      setMessage(`Image stored (${Math.round(blob.size / 1024)} KB).`);
      setItems((v) => v.map((i) => (i.id === selectedItem.id ? { ...i, image_path: path } : i)));
    } catch (e) {
      setError(String(e));
    }
  }
  async function changeMinStock(ev: Event) {
    ev.preventDefault();
    if (!selectedItem) return;
    const f = new FormData(ev.currentTarget as HTMLFormElement);
    try {
      const updated = await setItemMinStock(selectedItem.id, Number(f.get('minStock')));
      setItems((v) => v.map((i) => (i.id === updated.id ? updated : i)));
      setMessage('Reorder threshold saved.');
    } catch (e) {
      setError(String(e));
    }
  }

  if (accountChanged)
    return (
      <p role="alert">
        Your signed-in account changed. Reload to open purchases for the current account.
      </p>
    );
  const Container = purchaseOnly ? 'section' : 'main';
  return (
    <Container>
      <p hidden={purchaseOnly}>
        <a href={appRoute.home}>← Home</a>
      </p>
      {!purchaseOnly && <h1>Inventory & purchases</h1>}
      {!purchaseOnly && (
        <TaskTabs
          label="Stock tasks"
          value={view}
          onChange={setView}
          options={[
            { value: 'items', label: 'Items' },
            { value: 'purchase', label: 'Purchases' },
            { value: 'suppliers', label: 'Suppliers' },
            { value: 'advanced', label: 'Advanced' },
          ]}
        />
      )}
      {(purchaseLocked || purchaseStorageBlocked) && (
        <p role="alert">
          A purchase needs attention.{' '}
          <button type="button" onClick={() => setView('purchase')}>
            Review pending purchase
          </button>
        </p>
      )}
      <section class="card" hidden={purchaseOnly || view !== 'items'} aria-label="Stock items">
        <label class="search-field">
          Find stock item
          <input
            value={itemSearch}
            placeholder="Name or SKU"
            onInput={(e) => setItemSearch(e.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            const form = document.getElementById('stock-add-item') as HTMLDetailsElement | null;
            if (form) form.open = true;
            document.getElementById('stock-item-details')?.scrollIntoView({ block: 'start' });
          }}
        >
          New item
        </button>
        <div class="record-list">
          {items
            .filter((item) =>
              (item.name + ' ' + (item.sku ?? '')).toLowerCase().includes(itemSearch.toLowerCase()),
            )
            .slice(0, 50)
            .map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  setSelected(item.id);
                  requestAnimationFrame(() =>
                    document
                      .getElementById('stock-item-details')
                      ?.scrollIntoView({ block: 'start' }),
                  );
                }}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.sku || 'No SKU'}</small>
                </span>
                <span class="record-value">
                  {stock.find((row) => row.item_id === item.id)?.qty_base ?? '—'}
                  <small>{item.unit3 || item.unit2 || item.unit1}</small>
                </span>
              </button>
            ))}
        </div>
        <p class="muted">Showing up to 50 matches · {items.length} items</p>
      </section>
      {error && <p role="alert">{error}</p>}
      {!purchaseOnly && <SnapshotNote at={snapshotAt} failed={snapshotFailed} />}
      {message && <p role="status">{message}</p>}
      {priceRetries.map((r) => {
        const w = r.write;
        const what = `${w.itemName} (${w.kind} ${rupees(w.pricePaise)} per ${w.unitName})`;
        const load = saleLoads[w.itemId];
        const now =
          load?.state === 'ok' ? currentPricePaise(load.prices, r.shop, w.kind, w.unitLevel) : null;
        const text = {
          failed: `Bill saved. Sale price not updated for ${what}.`,
          check: `Sale price for ${what} was entered with a bill and not written. Check that the bill was posted, then Retry or Discard.`,
          late: `Bill saved. Sale price for ${what} was not written: it was entered more than a day before the bill was confirmed. Retry to write it now, or Discard.`,
          expired: `Sale price for ${what} was not written and has expired.`,
          refused: `Sale price for ${what} cannot be written: ${r.message}.`,
        }[r.state];
        return (
          <div class="alert price-retry" role="alert" key={w.clientId}>
            <span>
              {text}{' '}
              <small class="muted">
                Entered {ageText(r.savedAt, Date.now())} · Now{' '}
                {load?.state === 'ok' ? (now === null ? 'no price' : rupees(now)) : '…'}
                {r.state === 'failed' && r.message ? ` · ${r.message}` : ''}
              </small>
            </span>
            <span class="price-retry-actions">
              {RETRYABLE.has(r.state) && (
                <button
                  type="button"
                  aria-label={`Retry sale price for ${w.itemName}`}
                  disabled={!!priceRetryBusy}
                  onClick={() => void retryPrice(r)}
                >
                  {priceRetryBusy === w.clientId ? 'Retrying…' : 'Retry'}
                </button>
              )}
              <button
                type="button"
                aria-label={`Discard sale price for ${w.itemName}`}
                disabled={priceRetryBusy === w.clientId}
                onClick={() => discardPrice(r)}
              >
                Discard
              </button>
            </span>
          </div>
        );
      })}
      <section hidden={purchaseOnly || view !== 'advanced'} aria-label="Import old DSB backup">
        <h2>Import old DSB backup</h2>
        <p class="muted">
          Shop-test setup only. This imports the current item master, sale prices, current stock,
          suppliers and real customers. It does not copy historical purchase bills, sales invoices
          or payments.
        </p>
        <input
          aria-label="Choose DSB backup JSON"
          type="file"
          accept=".json,application/json"
          onChange={chooseLegacyBackup}
        />
        {legacyPlan && (
          <div class="card">
            <strong>{legacyFileName}</strong>
            <br />
            Ready: {legacyPlan.items.length} items · {legacyPlan.parties.length} suppliers ·{' '}
            {legacyPlan.customers.length} customers ·{' '}
            {legacyPlan.items.reduce((n, i) => n + i.prices.length, 0)} price rows ·{' '}
            {legacyPlan.items.filter((i) => i.openingStockSmallest > 0).length} positive stock
            balances.
            {legacyPlan.warnings.length > 0 && (
              <>
                <p>
                  <strong>{legacyPlan.warnings.length} warnings</strong> (nothing is silently
                  guessed):
                </p>
                <ul>
                  {legacyPlan.warnings.slice(0, 6).map((w, n) => (
                    <li key={n}>{w}</li>
                  ))}
                </ul>
                {legacyPlan.warnings.length > 6 && (
                  <p>
                    …and {legacyPlan.warnings.length - 6} more. Items without a usable sale price
                    remain unsellable until a price is added.
                  </p>
                )}
              </>
            )}
            <p>
              <button
                type="button"
                class="primary"
                disabled={legacyBusy || !shopId}
                onClick={() => void runLegacyImport()}
              >
                {legacyBusy ? 'Importing…' : 'Import checked backup'}
              </button>
            </p>
          </div>
        )}
      </section>
      <section id="stock-item-details" hidden={purchaseOnly || view !== 'items'}>
        <h2>Item setup</h2>
        <p>{ITEM_UNITS_HINT}</p>
        <details id="stock-add-item">
          <summary>Add item</summary>
          <form onSubmit={addItem}>
            <label>
              {ITEM_FIELD_LABELS.name}{' '}
              <input name="name" placeholder={ITEM_FIELD_LABELS.name} required />
            </label>{' '}
            <label>
              SKU <input name="sku" placeholder="SKU" />
            </label>{' '}
            <label>
              {ITEM_FIELD_LABELS.unit1}{' '}
              <input
                name="unit1"
                placeholder={ITEM_FIELD_LABELS.unit1}
                required
                list="learned-units"
              />
            </label>{' '}
            <label>
              {ITEM_FIELD_LABELS.unit2}{' '}
              <input name="unit2" placeholder={ITEM_FIELD_LABELS.unit2} list="learned-units" />
            </label>{' '}
            <label>
              {ITEM_FIELD_LABELS.conv1}{' '}
              <input
                name="conv1"
                type="number"
                min="0"
                step="any"
                placeholder={ITEM_FIELD_LABELS.conv1}
              />
            </label>{' '}
            <label>
              {ITEM_FIELD_LABELS.unit3}{' '}
              <input name="unit3" placeholder={ITEM_FIELD_LABELS.unit3} list="learned-units" />
              <datalist id="learned-units">
                {unitSuggestions.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </label>{' '}
            <label>
              {ITEM_FIELD_LABELS.conv2}{' '}
              <input
                name="conv2"
                type="number"
                min="0"
                step="any"
                placeholder={ITEM_FIELD_LABELS.conv2}
              />
            </label>{' '}
            <button disabled={!tenantId}>Create item</button>
          </form>
        </details>
        <label>
          Item details{' '}
          <select
            value={selected}
            onChange={(e) => setSelected((e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">Choose…</option>
            {detailPicker.options.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        {detailPicker.truncated && (
          <p class="muted">
            Showing up to 50 of {detailPicker.matches} matching items. Type in “Find stock item”
            above to narrow the list.
          </p>
        )}
        {selectedItem && (
          <div aria-label="item peek">
            <strong>{selectedItem.name}</strong> · Stock {selectedStock}{' '}
            {selectedItem.unit3 || selectedItem.unit2 || selectedItem.unit1}
            <br />
            Current prices:{' '}
            {pricesLoading
              ? 'Loading…'
              : pricesFailed
                ? 'Unavailable'
                : prices.length
                  ? prices.map((p) => `${p.kind} ₹${(p.price_paise / 100).toFixed(2)}`).join(' · ')
                  : 'none'}
            <br />
            Reorder at: {selectedItem.min_stock}{' '}
            {selectedItem.unit3 || selectedItem.unit2 || selectedItem.unit1}
            <br />
            <input type="file" accept="image/*" onChange={changeImage} />
            {canSeePurchasePrices && (
              <PriceHistory
                key={selectedItem.id}
                shopId={shopId}
                itemId={selectedItem.id}
                baseUnit={selectedItem.unit3 || selectedItem.unit2 || selectedItem.unit1}
                parties={parties}
              />
            )}
            {shopToday && (
              <DemandChart
                key={`demand:${selectedItem.id}`}
                shopId={shopId}
                itemId={selectedItem.id}
                baseUnit={selectedItem.unit3 || selectedItem.unit2 || selectedItem.unit1}
                today={shopToday}
                canReadReturns={canReadSaleReturns}
              />
            )}
          </div>
        )}
        {selectedItem && (
          <form onSubmit={changeMinStock}>
            <label>
              Reorder threshold ({selectedItem.unit3 || selectedItem.unit2 || selectedItem.unit1}){' '}
              <input
                name="minStock"
                type="number"
                min="0"
                step="any"
                defaultValue={selectedItem.min_stock}
                key={selectedItem.id}
              />
            </label>{' '}
            <button disabled={!shopId}>Save reorder threshold</button>
          </form>
        )}
        {selectedItem && (
          <form key={`barcode:${selectedItem.id}`} onSubmit={addBarcode}>
            <label>
              Barcode <input name="barcode" placeholder="Barcode" required ref={barcodeInput} />
            </label>{' '}
            <CameraScanner
              onCode={(code) => {
                if (barcodeInput.current) barcodeInput.current.value = code;
                setMessage(`Scanned ${code}. Check the unit, then link the barcode.`);
              }}
            />{' '}
            <select aria-label="Unit" name="unitLevel">
              <option value="1">{selectedItem.unit1}</option>
              {selectedItem.unit2 && <option value="2">{selectedItem.unit2}</option>}
              {selectedItem.unit3 && <option value="3">{selectedItem.unit3}</option>}
            </select>{' '}
            <button disabled={!tenantId}>Link barcode</button>
          </form>
        )}
        {selectedItem && (
          <form key={`price:${selectedItem.id}`} onSubmit={changePrice}>
            <select name="kind">
              <option value="retail">Retail</option>
              <option value="wholesale">Wholesale</option>
              <option value="mrp">MRP</option>
              <option value="cost_last">Last cost</option>
            </select>{' '}
            <select aria-label="Unit" name="unitLevel">
              <option value="1">{selectedItem.unit1}</option>
              {selectedItem.unit2 && <option value="2">{selectedItem.unit2}</option>}
              {selectedItem.unit3 && <option value="3">{selectedItem.unit3}</option>}
            </select>{' '}
            <label>
              ₹ price{' '}
              <input
                name="price"
                type="number"
                min="0"
                step="0.01"
                placeholder="₹ price"
                required
              />
            </label>{' '}
            <button disabled={!shopId}>Set price</button>
          </form>
        )}
      </section>
      <section hidden={purchaseOnly || view !== 'suppliers'}>
        <h2>Suppliers</h2>
        <form onSubmit={addParty}>
          <label>
            Supplier name <input name="name" placeholder="Supplier name" required />
          </label>{' '}
          <label>
            Phone <input name="phone" placeholder="Phone" />
          </label>{' '}
          <label>
            GSTIN <input name="gstin" placeholder="GSTIN" />
          </label>{' '}
          <button disabled={!tenantId}>Create supplier</button>
        </form>
      </section>
      {purchaseOnly && (
        <details class="card">
          <summary>Add a supplier</summary>
          <form onSubmit={addParty}>
            <label>
              Supplier name
              <input name="name" placeholder="New supplier name" required />
            </label>
            <label>
              Phone
              <input name="phone" type="tel" />
            </label>
            <label>
              GSTIN
              <input name="gstin" />
            </label>
            <button
              disabled={
                purchaseLocked ||
                contextBusy ||
                !purchaseContextReady ||
                !catalogLoaded ||
                !tenantId
              }
            >
              Create & select supplier
            </button>
          </form>
        </details>
      )}
      <section
        hidden={view !== 'purchase'}
        onInput={() => setDraftTouched(true)}
        onChange={() => setDraftTouched(true)}
      >
        <h2>Post purchase</h2>
        {draftError && <p role="alert">{draftError}</p>}
        {!purchaseLocked && draftStatus && (
          <p class="muted" aria-live="polite">
            {draftStatus}
          </p>
        )}
        {unreadableDrafts.length > 0 && (
          <div class="card" role="alert" aria-label="Unreadable purchase drafts">
            <p>
              {unreadableDrafts.length} saved draft
              {unreadableDrafts.length === 1 ? ' is' : 's are'} unreadable on this device. It cannot
              be resumed; your other drafts are listed normally.
            </p>
            {unreadableDrafts.map((key) => (
              <button
                type="button"
                key={key}
                disabled={purchaseLocked || contextBusy}
                onClick={() => {
                  if (!confirm('Discard this unreadable draft? It cannot be recovered.')) return;
                  try {
                    removePurchaseDraft(key);
                    refreshDrafts();
                  } catch (e) {
                    setDraftError(`Draft could not be discarded: ${String(e)}.`);
                  }
                }}
              >
                Discard unreadable draft
              </button>
            ))}
          </div>
        )}
        {purchaseOnly && purchaseContextActive && shopToday && (
          <QuickBillEntry
            parties={parties}
            today={shopToday}
            draftPrefix={draftPrefix}
            disabled={
              purchaseLocked ||
              contextBusy ||
              !purchaseContextReady ||
              accountChanged ||
              !catalogLoaded
            }
            onSaved={refreshDrafts}
          />
        )}
        {purchaseOnly && purchaseContextActive && shopToday && (
          <BatchPurchaseEntry
            items={items}
            parties={parties}
            today={shopToday}
            draftPrefix={draftPrefix}
            disabled={
              purchaseLocked ||
              contextBusy ||
              !purchaseContextReady ||
              accountChanged ||
              !catalogLoaded
            }
            onSaved={refreshDrafts}
          />
        )}
        {savedDrafts.some((s) => s.draft.clientId !== purchaseClientId) && (
          <details class="card" aria-label="Saved purchase drafts">
            <summary>Saved purchase drafts</summary>
            <p class="muted">
              Unposted work on this device, for your account and this shop. Resume to review;
              nothing posts automatically.
            </p>
            {discardableDrafts().length > 0 && (
              <button
                type="button"
                disabled={purchaseLocked || contextBusy}
                onClick={() => {
                  const old = discardableDrafts();
                  if (
                    !confirm(
                      `Discard ${old.length} unposted draft${old.length === 1 ? '' : 's'} saved more than 30 days ago? This cannot be undone.`,
                    )
                  )
                    return;
                  try {
                    removePurchaseDrafts(old.map((s) => s.key));
                    refreshDrafts();
                  } catch (e) {
                    setDraftError(`Old drafts could not be discarded: ${String(e)}.`);
                  }
                }}
              >
                Discard drafts older than 30 days
              </button>
            )}
            {savedDrafts
              .filter((s) => s.draft.clientId !== purchaseClientId)
              .map((s) => (
                <div class="context-actions" key={s.key}>
                  <span>
                    {s.draft.expectedTotalPaise ? 'Quick bill ' : ''}
                    {s.draft.billNo || 'Untitled purchase'} ·{' '}
                    {parties.find((p) => p.id === s.draft.supplier)?.name ?? 'no supplier'} ·{' '}
                    {s.draft.businessDate} ·{' '}
                    {s.draft.expectedTotalPaise
                      ? `paper total ${rupees(s.draft.expectedTotalPaise)} · `
                      : ''}
                    {s.draft.cart.length} item{s.draft.cart.length === 1 ? '' : 's'} · saved{' '}
                    {new Date(s.draft.savedAt).toISOString().slice(0, 10)}
                  </span>
                  <button
                    type="button"
                    disabled={
                      purchaseLocked ||
                      purchaseBusy ||
                      contextBusy ||
                      !purchaseContextReady ||
                      accountChanged ||
                      documentBusy ||
                      !catalogLoaded ||
                      !!purchaseStorageBlocked
                    }
                    onClick={() => resumeDraft(s)}
                  >
                    Resume draft
                  </button>
                  <button
                    type="button"
                    disabled={purchaseLocked || contextBusy}
                    onClick={() => {
                      if (!confirm('Discard this unposted draft snapshot?')) return;
                      try {
                        removePurchaseDraft(s.key);
                        refreshDrafts();
                      } catch (e) {
                        setDraftError(`Draft could not be discarded: ${String(e)}.`);
                      }
                    }}
                  >
                    Discard draft
                  </button>
                </div>
              ))}
          </details>
        )}
        <form onSubmit={addPurchase} onKeyDown={purchaseFormKeyDown}>
          {purchaseLocked && (
            <div class="alert" role="alert">
              <p>
                The last purchase may already be saved. Editing is locked: press “Retry same
                purchase” — it never posts the bill twice.
              </p>
              {lockedPurchase.current?.billImagePath && (
                <BillDocumentPreview
                  key={lockedPurchase.current.clientId}
                  path={lockedPurchase.current.billImagePath}
                />
              )}
            </div>
          )}
          <fieldset
            disabled={purchaseLocked || contextBusy || documentBusy || !purchaseContextReady}
            class="plain"
          >
            <label>
              Supplier
              <select
                name="partyId"
                value={purchaseSupplier}
                onChange={(e) => setPurchaseSupplier(e.currentTarget.value)}
              >
                <option value="">No supplier</option>
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>{' '}
            {purchaseOnly && (
              <div class="shortcut-chips" aria-label="Recent suppliers">
                {rankedPurchaseParties(parties, recentBills, businessDate)
                  .slice(0, 6)
                  .map((p) => (
                    <button
                      type="button"
                      aria-pressed={purchaseSupplier === p.id}
                      onClick={() => {
                        setPurchaseSupplier(p.id);
                        setDraftTouched(true);
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
              </div>
            )}
            <label>
              Bill no.{' '}
              <input
                name="billNo"
                placeholder="Bill no."
                value={purchaseBillNo}
                onInput={(e) => setPurchaseBillNo(e.currentTarget.value)}
              />
            </label>{' '}
            <label>
              Business date
              <input
                name="date"
                type="date"
                value={businessDate}
                onInput={(e) => setBusinessDate((e.currentTarget as HTMLInputElement).value)}
                required
              />
            </label>{' '}
          </fieldset>
          {draftPrefix && (
            <BillAttachmentEditor
              key={purchaseClientId}
              scope={draftPrefix}
              tenantId={tenantId}
              shopId={shopId}
              clientId={purchaseClientId}
              document={billDocument}
              disabled={purchaseLocked || contextBusy || !purchaseContextReady || accountChanged}
              onProblem={(message) => {
                if (purchaseClientRef.current === purchaseClientId) setDocumentSaveError(message);
              }}
              onBusy={(busy) => {
                if (purchaseClientRef.current === purchaseClientId) setDocumentBusy(busy);
              }}
              beforePicker={() => {
                if (
                  lockedPurchase.current ||
                  contextBusy ||
                  documentBusy ||
                  !purchaseContextReady ||
                  accountChanged
                )
                  return false;
                try {
                  const notice =
                    'Document selection needs review. Select the file again, or explicitly continue with the current attachment.';
                  savePurchaseDraft(draftPrefix, draftWriter.current, {
                    ...draftSnapshot,
                    documentIssue: notice,
                    savedAt: Date.now(),
                  });
                  setDocumentSaveError(notice);
                  return true;
                } catch (e) {
                  setDocumentSaveError(
                    `Draft could not be kept before opening the picker: ${String(e)}`,
                  );
                  return false;
                }
              }}
              onChange={(doc) => {
                if (purchaseClientRef.current !== purchaseClientId || lockedPurchase.current)
                  return;
                try {
                  savePurchaseDraft(draftPrefix, draftWriter.current, {
                    ...draftSnapshot,
                    document: doc,
                    documentIssue: '',
                    savedAt: Date.now(),
                  });
                  setBillDocument(doc);
                  setDraftTouched(true);
                  setDocumentSaveError('');
                } catch (e) {
                  setDocumentSaveError(String(e));
                  throw e;
                }
              }}
            />
          )}
          {documentSaveError && (
            <div role="alert">
              <p>{documentSaveError}</p>
              <button
                type="button"
                disabled={purchaseLocked || documentBusy}
                onClick={() => setDocumentSaveError('')}
              >
                {billDocument ? 'Keep current attachment' : 'Continue without attachment'}
              </button>
            </div>
          )}
          <fieldset
            disabled={purchaseLocked || contextBusy || documentBusy || !purchaseContextReady}
            class="plain"
          >
            <PurchaseBillCards
              cards={purchaseCards}
              items={items}
              onChange={(next) => {
                setPurchaseCards(next);
                setDraftTouched(true);
              }}
              disabled={purchaseLocked || contextBusy || documentBusy || !purchaseContextReady}
              shopId={shopId}
              parties={parties}
              canSeePrices={canSeePurchasePrices}
              saleLoads={saleEnabled ? saleLoads : undefined}
              onMessage={setMessage}
              findBarcode={findBarcodeForCard}
              onCreateItem={tenantId ? createItemFromCard : undefined}
              onRepeat={purchaseOnly && recentDetail ? repeatLastBill : undefined}
              recent={
                purchaseOnly && recentDetail
                  ? recentDetail.lines.slice(0, 8).map((l, n) => ({
                      key: `${l.item_id}:${l.unit_level}:${n}`,
                      label: `${l.item_name_snapshot} · ${rupees(l.unit_price_paise)}/${l.unit_name_snapshot}`,
                      onAdd: () => {
                        try {
                          const line = repeatPurchase(recentDetail.bill, [l], items)[0]!;
                          setPurchaseCards((c) => addLineAsCard(c, line));
                          setDraftTouched(true);
                          setMessage(
                            'Added from the last supplier bill. Check the quantity and rate.',
                          );
                        } catch (e) {
                          setError(String(e));
                        }
                      },
                    }))
                  : undefined
              }
            />
            <div class="bill-adjustments">
              <label>
                Extra charges ₹
                <input
                  name="extra"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="Transport, packing…"
                  value={purchaseExtra}
                  onInput={(e) => setPurchaseExtra(e.currentTarget.value)}
                />
              </label>
              <label>
                Bill discount ₹
                <input
                  name="discount"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="Discount on the whole bill"
                  value={purchaseDiscount}
                  onInput={(e) => setPurchaseDiscount(e.currentTarget.value)}
                />
              </label>
            </div>
            <div class="bill-total card" aria-label="Bill total" data-testid="bill-total">
              <p>
                <span>Items ({purchaseBill.lines.length})</span>
                <span>{rupees(purchaseTotalPaise)}</span>
              </p>
              <p class="muted">
                <span>Round off</span>
                <span>₹0.00 (purchases are not rounded)</span>
              </p>
              <p class="bill-total-main">
                <span>Bill total</span>
                <strong>{payablePreview}</strong>
              </p>
            </div>
          </fieldset>
          {paperCheck && purchaseExpectedTotal && (
            <p
              class={paperCheck.matches ? 'muted' : 'alert'}
              role="status"
              data-testid="paper-total"
            >
              Paper bill total: {rupees(purchaseExpectedTotal)}.{' '}
              {paperCheck.matches
                ? 'The items match it.'
                : paperCheck.diffPaise === null
                  ? 'Check the amounts.'
                  : `Items are ${rupees(Math.abs(paperCheck.diffPaise))} ${paperCheck.diffPaise < 0 ? 'short of' : 'over'} it.`}{' '}
              <button
                type="button"
                disabled={purchaseLocked || purchaseBusy}
                onClick={() => {
                  if (
                    !confirm(
                      'Remove the paper bill total from this purchase? Posting will no longer check against it.',
                    )
                  )
                    return;
                  setPurchaseExpectedTotal(undefined);
                  setDraftTouched(true);
                }}
              >
                Remove paper total
              </button>
            </p>
          )}
          <div class="bill-bar">
            {!purchaseLocked && barProblem && (
              <span class="bill-bar-problem" role="alert">
                {barProblem}
              </span>
            )}
            {!purchaseLocked && (
              <span class="bill-bar-total" aria-live="polite">
                Total {payablePreview} ·
              </span>
            )}
            <button
              ref={postButton}
              class="primary"
              disabled={
                purchaseBusy ||
                contextBusy ||
                (!purchaseLocked &&
                  (!purchaseContextReady ||
                    documentBusy ||
                    !!documentSaveError ||
                    (!!billDocument && !billDocument.uploaded))) ||
                !shopId ||
                !businessDate ||
                (!purchaseBill.lines.length && !purchaseLocked)
              }
            >
              {purchaseBusy ? 'Posting…' : purchaseLocked ? 'Retry same purchase' : 'Post purchase'}
            </button>
          </div>
        </form>
      </section>
    </Container>
  );
}
