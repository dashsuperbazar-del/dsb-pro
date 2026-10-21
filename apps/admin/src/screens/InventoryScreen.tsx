import { formatQuantity } from '@dsb-pro/core';
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
import { UsualItems, type UsualLoad } from '../components/UsualItems';
import {
  cardsFromUsual,
  itemsOnBill,
  lastSupplierStorageKey,
  sameUnitAsLast,
  usualItems,
  type UsualItem,
} from '../lib/usualItems';
import {
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
  listSupplierPurchaseLines,
  type PurchaseRecord,
  getShopBusinessDate,
  importLegacyDsbMaster,
  listCurrentPrices,
  listItems,
  listParties,
  listStock,
  postPurchaseOutcome,
  postPurchaseV2Outcome,
  editPurchaseBillOutcome,
  plainEditRefusal,
  getPurchaseExtras,
  replaceItemImage,
  setItemPrice,
  setItemMinStock,
  setItemTaxRate,
  type Item,
  type ItemPrice,
  type Party,
  type StockRow,
  type BillDocument,
  listSupplierBills,
} from '@dsb-pro/adapters';
import {
  buildLegacyDsbImportPlan,
  parseRupeesToPaise,
  type LegacyDsbImportPlan,
  type PurchasePaymentType,
} from '@dsb-pro/core';
import {
  NOTES_MAX,
  PAYMENT_LABEL,
  billTotals,
  chargeRowsFromExtra,
  chargeRowsFromPaise,
  emptyCharge,
  evaluateCharges,
  isV2Pending,
  parsePercentBp,
  pendingImages,
  percentText,
  postButtonText,
  roundOffText,
  type ChargeRow,
  type PendingPurchase,
  type PendingPurchaseV2,
} from '../lib/billExtras';
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
import {
  duplicateMessage,
  findDuplicateBill,
  mergeKnownBills,
  type DuplicateMatch,
  type KnownBill,
} from '../lib/duplicateBill';
import { useDirtyGuard } from '../lib/dirtyGuard';
import {
  ageText,
  currentPricePaise,
  isPermanentPriceError,
  priceChangedQuestion,
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
import {
  clearPendingIntent,
  loadPendingIntent,
  savePendingIntent,
  type IntentLoad,
} from '../lib/pendingIntent';

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
  draftDocuments,
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
const OFFLINE_POST =
  "You're offline. Purchases post only online; nothing was sent. Your bill is kept as a draft on this device.";
const RETRYABLE = new Set<PriceRetry['state']>(['failed', 'check', 'late']);
const entryId = (key: string, clientId: string) => `${key}|${clientId}`;
const sameEntry = (a: PriceRetry, b: PriceRetry) =>
  a.key === b.key && a.write.clientId === b.write.clientId;

export function InventoryScreen({
  purchaseOnly = false,
  purchaseContextActive = true,
  purchaseSupplierId = '',
  purchaseRepeatId = '',
  purchaseEditId = '',
  onPurchasePosted,
}: {
  purchaseOnly?: boolean;
  purchaseContextActive?: boolean;
  purchaseSupplierId?: string;
  purchaseRepeatId?: string;
  /** 0066: open this posted bill in the entry card; saving corrects it (edit_purchase_bill). */
  purchaseEditId?: string;
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
  // Bill photos/PDFs in order (≤10); the first is also the bill's document.
  const [billDocuments, setBillDocuments] = useState<BillDocument[]>([]);
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
  // Alerts discarded on this page (plan key | write id): never stored again by a write still running.
  const discarded = useRef(new Set<string>());
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
  // Named extra charges (old DSB "Extra Charges (Bill Level)", + Add Charge).
  const [purchaseCharges, setPurchaseCharges] = useState<ChargeRow[]>([]);
  const [purchasePaymentType, setPurchasePaymentType] = useState<PurchasePaymentType>('credit');
  const [purchaseNotes, setPurchaseNotes] = useState('');
  // Purchases are online-only (no outbox): Post waits for a connection; the draft keeps everything.
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  const [recentBills, setRecentBills] = useState<PurchaseRecord[]>([]);
  const [recentDetail, setRecentDetail] = useState<Awaited<
    ReturnType<typeof getPurchaseDetail>
  > | null>(null);
  // Latest rendered values, read after an await (repeat/tap-to-add) to drop a stale answer.
  const copyContextRef = useRef({ shopId, purchaseSupplier, recentDetail, purchaseCards });
  copyContextRef.current = { shopId, purchaseSupplier, recentDetail, purchaseCards };
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
  const purchaseLockedRef = useRef(purchaseLocked);
  purchaseLockedRef.current = purchaseLocked;
  useEffect(() => {
    if (purchaseLocked) setView('purchase');
  }, [purchaseLocked]);
  const lockedPurchase = useRef<PendingPurchase | null>(null);
  // Survives a reload: stored BEFORE the first send (V002 VF-005), so an unconfirmed purchase is
  // retried as the same request, never re-entered. Unreadable storage blocks new purchases.
  // v1 entries (stored by the previous version) and v2 entries live under different names, so an older
  // app version never finds a v2 request and resends it through post_purchase without its charges, GST
  // and payment. This version reads both, v1 first.
  // Bill edits (0066) live under a third name that older versions never read (they would post it as new).
  const pendingKey = (shop: string, v2: boolean, edit = false) =>
    edit
      ? `dsb-pending-purchase-edit:${shop}`
      : v2
        ? `dsb-pending-purchase-v2:${shop}`
        : `dsb-pending-purchase:${shop}`;
  const isEditPending = (request: PendingPurchase) =>
    isV2Pending(request) && Boolean(request.editOf);
  const pendingKeyFor = (request: PendingPurchase) =>
    pendingKey(request.shopId, isV2Pending(request), isEditPending(request));
  const allPendingKeys = (shop: string) => [
    pendingKey(shop, false),
    pendingKey(shop, true),
    pendingKey(shop, true, true),
  ];
  const loadPending = (shop: string): IntentLoad<PendingPurchase> => {
    let last: IntentLoad<PendingPurchase> = { ok: true, value: null };
    for (const key of allPendingKeys(shop)) {
      last = loadPendingIntent<PendingPurchase>(key);
      if (!last.ok || last.value) return last;
    }
    return last;
  };
  // The posted bill this form corrects ('' = a new bill). Never autosaved as a draft: a restored draft would
  // post as a new bill next to the original.
  const [purchaseEditOf, setPurchaseEditOf] = useState('');
  const [purchaseEditLabel, setPurchaseEditLabel] = useState('');
  // A stored edit request (e.g. after a reload) is an edit even when this form did not open it.
  const lockedEditOf =
    purchaseLocked && lockedPurchase.current && isV2Pending(lockedPurchase.current)
      ? (lockedPurchase.current.editOf ?? '')
      : '';
  const [purchaseStorageBlocked, setPurchaseStorageBlocked] = useState('');
  useEffect(() => {
    if (!shopId) return;
    const saved = loadPending(shopId);
    if (!saved.ok) {
      setPurchaseStorageBlocked(saved.message);
    } else if (saved.value) {
      lockedPurchase.current = saved.value;
      setPurchaseLocked(true);
    }
  }, [shopId]);
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const purchaseBusyRef = useRef(purchaseBusy);
  purchaseBusyRef.current = purchaseBusy;
  // Old-draft discard never offers the draft of this window's purchase or of a purchase awaiting
  // confirmation (its pending request id), so an unconfirmed bill's editable copy is never removed.
  function discardableDrafts() {
    const ids = shopId
      ? allPendingKeys(shopId).map((key) => {
          const p = loadPendingIntent<PendingPurchase>(key);
          return p.ok ? p.value?.clientId : undefined;
        })
      : [];
    return staleDrafts(
      savedDrafts.filter(
        (s) =>
          s.draft.clientId !== purchaseClientId &&
          !ids.includes(s.draft.clientId) &&
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
  // Usual items from the chosen supplier (distinct items of its posted bills, most bought first). The
  // list is keyed by shop and supplier: an answer for another supplier is dropped, and adding checks the
  // key against the current supplier again, so a supplier switch mid-read adds nothing.
  const purchaseCardsRef = useRef(purchaseCards);
  purchaseCardsRef.current = purchaseCards;
  const usualKey = shopId && purchaseSupplier ? `${shopId}:${purchaseSupplier}` : '';
  const [usual, setUsual] = useState<{ key: string; load: UsualLoad } | null>(null);
  const [usualOpen, setUsualOpen] = useState(false);
  const [usualReload, setUsualReload] = useState(0);
  useEffect(() => {
    if (!purchaseOnly || !usualKey || !canSeePurchasePrices) {
      setUsual(null);
      return;
    }
    const key = usualKey;
    const [shop, party] = [shopId, purchaseSupplier];
    let active = true;
    setUsual((u) =>
      u?.key === key && u.load.state === 'ok' ? u : { key, load: { state: 'loading' } },
    );
    // Through a promise, so an unavailable read becomes a "could not be read" note, never a crash.
    void Promise.resolve()
      .then(() => listSupplierPurchaseLines(shop, party))
      .then((lines) => {
        if (active) setUsual({ key, load: { state: 'ok', rows: usualItems(lines) } });
      })
      .catch((e) => {
        if (active)
          setUsual({
            key,
            load: { state: 'failed', message: e instanceof Error ? e.message : String(e) },
          });
      });
    return () => {
      active = false;
    };
  }, [usualKey, purchaseOnly, recentBills, usualReload, canSeePurchasePrices]);
  // A new supplier on an empty bill opens its usual items: picking from them is the fast way in.
  useEffect(() => {
    setUsualOpen(!!usualKey && purchaseCardsRef.current.every((c) => isBlankCard(c)));
  }, [usualKey]);
  // Once the bill has an item the list folds away (its toggle reopens it), leaving room for the rows.
  const billStarted = purchaseCards.some((c) => !isBlankCard(c));
  useEffect(() => {
    if (billStarted) setUsualOpen(false);
  }, [billStarted]);
  const usualRows = usual?.key === usualKey && usual.load.state === 'ok' ? usual.load.rows : null;
  // The unit last bought from this supplier, only while that unit is unchanged on the item.
  const lastUnit = (item: Item) => {
    const row = usualRows?.find((r) => r.itemId === item.id);
    return row && sameUnitAsLast(item, row) ? row.unitLevel : undefined;
  };
  const [focusCard, setFocusCard] = useState('');
  function addUsualItems(key: string, rows: UsualItem[]) {
    const now = copyContextRef.current;
    if (!now.shopId || `${now.shopId}:${now.purchaseSupplier}` !== key) {
      setMessage('Supplier changed — nothing added.');
      return;
    }
    // Built from the cards as last rendered (a click handler always sees the latest render), and
    // set as a whole, so the message and focus describe exactly the rows that were added.
    const current = purchaseCardsRef.current;
    const { cards, skipped } = cardsFromUsual(
      rows,
      itemsRef.current,
      itemsOnBill(current),
      canSeePurchasePrices,
    );
    if (cards.length) {
      const base =
        current.length && isBlankCard(current[current.length - 1]!)
          ? current.slice(0, -1)
          : current;
      setPurchaseCards([...base, ...cards]);
      setDraftTouched(true);
      setFocusCard(`${cards[0]!.key}|qty`);
      setUsualOpen(false);
    }
    const withRate = cards.some((c) => c.suggested);
    setMessage(
      (cards.length
        ? `Added ${cards.length} item${cards.length === 1 ? '' : 's'}. Type each quantity${withRate ? '; a rate filled in is the last one paid — check it' : ''}.`
        : 'Nothing added.') +
        (skipped.length ? ` Not in the item list any more: ${skipped.join(', ')}.` : ''),
    );
  }
  // "+ Add item" in the bill bar: a new empty row at the end, its item name focused.
  function addItemRow() {
    const card = emptyCard();
    setPurchaseCards((c) => [...c, card]);
    setDraftTouched(true);
    setFocusCard(`${card.key}|name`);
  }
  // The supplier of the last bill this user posted in this shop on this device starts a new, untouched
  // bill (shown at the top, changeable). Applied once per bill, never over anything entered (items,
  // bill no., discount, charges, notes, photos, paper total, any typing) or a resumed draft; clearing
  // it by hand is respected.
  const lastSupplierKey = shopId && saleUser ? lastSupplierStorageKey(saleUser, shopId) : '';
  const rememberedFor = useRef('');
  useEffect(() => {
    if (
      !purchaseOnly ||
      !lastSupplierKey ||
      !purchaseContextReady ||
      contextBusy ||
      purchaseLocked ||
      purchaseSupplierId ||
      purchaseRepeatId ||
      purchaseEditId ||
      purchaseEditOf ||
      rememberedFor.current === purchaseClientId
    )
      return;
    if (
      purchaseSupplier ||
      draftTouched ||
      !purchaseCards.every((c) => isBlankCard(c)) ||
      purchaseBillNo ||
      purchaseDiscount ||
      purchaseCharges.length ||
      purchaseNotes.trim() ||
      billDocuments.length ||
      purchaseExpectedTotal ||
      purchasePaymentType !== 'credit' ||
      savedDrafts.some((d) => d.draft.clientId === purchaseClientId)
    ) {
      rememberedFor.current = purchaseClientId;
      return;
    }
    let last = '';
    try {
      last = localStorage.getItem(lastSupplierKey) ?? '';
    } catch {
      last = '';
    }
    if (!last || !parties.length) return;
    rememberedFor.current = purchaseClientId;
    if (parties.some((p) => p.id === last)) setPurchaseSupplier(last);
  }, [
    purchaseOnly,
    lastSupplierKey,
    purchaseContextReady,
    contextBusy,
    purchaseLocked,
    purchaseClientId,
    parties,
  ]);
  useEffect(() => {
    const intent = purchaseSupplierId + ':' + purchaseRepeatId + ':' + purchaseEditId;
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
      (billDocuments.length ||
        draftTouched ||
        purchaseCards.some((c) => !isBlankCard(c)) ||
        purchaseBillNo ||
        purchaseDiscount ||
        purchaseNotes.trim() ||
        purchaseCharges.length) &&
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
        // Edit (0066) opens the posted bill exactly as entered (supplier, bill no., date, payment type, notes
        // too); Repeat copies only the items into a new bill dated today.
        const sourceId = purchaseEditId || purchaseRepeatId;
        let edit: {
          id: string;
          label: string;
          billNo: string;
          date: string;
          type: PurchasePaymentType;
          notes: string;
        } | null = null;
        if (sourceId) {
          const d = await getPurchaseDetail(shopId, sourceId);
          const cart = repeatPurchase(d.bill, d.lines, itemsRef.current);
          if (!active) return;
          if (d.bill.party_id && !partiesRef.current.some((p) => p.id === d.bill.party_id))
            throw new Error('The original supplier is unavailable. Start a new purchase manually.');
          // Named charges and per-item discount/GST of a v2 bill are copied; an older bill's single
          // extra amount becomes one row. If the extras cannot be read, the repeat stops: copying the
          // items without their discount/GST would silently change what the bill costs.
          let charges = chargeRowsFromExtra(
            Number(d.bill.extra_charges_paise) ? paiseToDecimal(d.bill.extra_charges_paise) : '',
          );
          const extras = await getPurchaseExtras(shopId, sourceId);
          if (!active) return;
          if (extras.charges.length) charges = chargeRowsFromPaise(extras.charges);
          const cards = cart.map((line, i) => {
            const x = extras.lines.find((e) => e.lineNo === d.lines[i]?.line_no);
            return cardFromLine(x ? { ...line, discountBp: x.discountBp, gstBp: x.gstBp } : line);
          });
          setPurchaseSupplier(d.bill.party_id || '');
          setPurchaseCards(cards);
          setPurchaseDiscount(paiseToDecimal(d.bill.discount_paise));
          setPurchaseCharges(charges);
          const label = d.bill.bill_no || d.bill.id.slice(0, 8);
          if (purchaseEditId) {
            edit = {
              id: d.bill.id,
              label,
              billNo: d.bill.bill_no ?? '',
              date: d.bill.business_date,
              // An edit keeps the payment type, except a paid bill whose payment is no longer assigned
              // to it (released/voided): the server corrects that only as Credit.
              type:
                extras.paymentType !== 'credit' &&
                extras.settlement.allocatedPaise !== null &&
                BigInt(extras.settlement.allocatedPaise) === 0n
                  ? 'credit'
                  : extras.paymentType,
              notes: extras.notes ?? '',
            };
            setMessage(
              `Editing bill ${label} (${d.bill.business_date}). Change the items and save: the corrected bill replaces the original in one step.`,
            );
          } else {
            setMessage(
              `Draft repeated from ${label} (${d.bill.business_date}). Historical costs and adjustments copied — review them. This is a new purchase, not posted yet.`,
            );
          }
        } else {
          if (purchaseSupplierId && !partiesRef.current.some((p) => p.id === purchaseSupplierId))
            throw new Error('Supplier is unavailable.');
          setPurchaseSupplier(purchaseSupplierId);
          setPurchaseCards([emptyCard()]);
          setPurchaseDiscount('');
          setPurchaseCharges([]);
        }
        setPurchasePaymentType(edit?.type ?? 'credit');
        setPurchaseNotes(edit?.notes ?? '');
        setBusinessDate(edit?.date ?? newDate);
        setPurchaseExpectedTotal(undefined);
        setPurchaseBillNo(edit?.billNo ?? '');
        setBillDocuments([]);
        setDocumentBusy(false);
        setDocumentSaveError('');
        setPurchaseEditOf(edit?.id ?? '');
        setPurchaseEditLabel(edit?.label ?? '');
        const nextClientId = crypto.randomUUID();
        // A deliberate repeat legitimately has the same total: only its bill number is checked.
        repeatedClientId.current = purchaseRepeatId ? nextClientId : null;
        setPurchaseClientId(nextClientId);
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
    purchaseEditId,
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
      const heads = [pendingKey(shopId, false), pendingKey(shopId, true)];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !heads.some((head) => key === head || key.startsWith(`${head}:`))) continue;
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
          .filter((w) => !r.some((x) => x.key === p.key && x.write.clientId === w.clientId))
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
  // Writes (with a known old price) whose item price now differs from the one the bill saw; an
  // unreadable price counts as changed (it cannot be shown to be unchanged).
  async function changedSinceBill(shop: string, writes: PlannedPriceWrite[]) {
    const out: PlannedPriceWrite[] = [];
    const byItem = new Map<string, Promise<ItemPrice[] | null>>();
    for (const w of writes) {
      if (w.oldPaise === undefined) continue;
      if (!byItem.has(w.itemId))
        byItem.set(
          w.itemId,
          listCurrentPrices(w.itemId).catch(() => null),
        );
      const prices = await byItem.get(w.itemId)!;
      const nowPaise = prices ? currentPricePaise(prices, shop, w.kind, w.unitLevel) : undefined;
      if (nowPaise === undefined || priceChangedQuestion(w, nowPaise)) out.push(w);
    }
    return out;
  }
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
      // A plan saved by an earlier page (after a reload): a price someone changed since the bill was
      // entered is never written by itself; it becomes a "check" alert whose Retry asks first.
      let writes = plan.writes;
      if (own === undefined) {
        const changed = await changedSinceBill(shop, writes);
        entries.push(
          ...changed.map((write) => ({ ...base, write, state: 'check' as const, message: '' })),
        );
        writes = writes.filter((w) => !changed.includes(w));
      }
      const failed = await writePriceList(writes, (w) =>
        setItemPrice({
          itemId: w.itemId,
          shopId: shop,
          kind: w.kind,
          unitLevel: w.unitLevel,
          pricePaise: w.pricePaise,
          clientId: w.clientId,
        }),
      );
      done += writes.length - failed.length;
      // Re-read before storing: a write discarded while these ran is never stored again.
      const kept = loadPricePlan(plan.key)?.writes ?? [];
      const live = failed.filter(
        (f) =>
          !discarded.current.has(entryId(plan.key, f.write.clientId)) &&
          kept.some((w) => w.clientId === f.write.clientId),
      );
      const checks = entries.filter((e) => e.key === plan.key && e.state === 'check');
      updatePricePlan(plan.key, [
        ...checks.map((e) => e.write),
        ...live.filter((f) => !isPermanentPriceError(f.message)).map((f) => f.write),
      ]);
      entries.push(
        ...live.map((f) => ({
          ...base,
          write: f.write,
          state: isPermanentPriceError(f.message) ? ('refused' as const) : ('failed' as const),
          message: f.message,
        })),
      );
    }
    setPriceRetries((r) => [...r.filter((x) => !entries.some((e) => sameEntry(e, x))), ...entries]);
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
  // Discard is per plan and write: a duplicate plan of the same bill keeps its own alert.
  function discardPrice(entry: PriceRetry) {
    discarded.current.add(entryId(entry.key, entry.write.clientId));
    dropFromPlan(entry);
    setPriceRetries((r) => r.filter((x) => !sameEntry(x, entry)));
  }
  async function retryPrice(entry: PriceRetry) {
    if (priceRetryBusy) return;
    setPriceRetryBusy(entry.write.clientId);
    try {
      const w = entry.write;
      // Someone may have changed the price since the bill was entered: read it now and ask before
      // replacing a price the bill never saw (every Retry, failed/check/late alike).
      const nowPaise = currentPricePaise(
        await listCurrentPrices(w.itemId),
        entry.shop,
        w.kind,
        w.unitLevel,
      );
      const question = priceChangedQuestion(w, nowPaise);
      if (question && !confirm(question)) return;
      await setItemPrice({
        itemId: w.itemId,
        shopId: entry.shop,
        kind: w.kind,
        unitLevel: w.unitLevel,
        pricePaise: w.pricePaise,
        clientId: w.clientId,
      });
      // Written: the same id in any other plan is written too.
      setPriceRetries((r) => {
        for (const x of r) if (x.write.clientId === w.clientId) dropFromPlan(x);
        return r.filter((x) => x.write.clientId !== w.clientId);
      });
      reloadSalePrices();
      setMessage(`Sale price updated for ${w.itemName}.`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const permanent = isPermanentPriceError(message);
      if (permanent) dropFromPlan(entry);
      setPriceRetries((r) =>
        r.map((x) =>
          sameEntry(x, entry) ? { ...x, message, state: permanent ? 'refused' : x.state } : x,
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
    version: 2,
    clientId: purchaseClientId,
    savedAt: Date.now(),
    supplier: purchaseSupplier,
    billNo: purchaseBillNo,
    businessDate,
    discount: purchaseDiscount,
    // Older readers only know one extra amount; this version keeps the named rows in `charges`.
    extra: '',
    charges: purchaseCharges.map((c) => ({ label: c.label, amount: c.amount })),
    paymentType: purchasePaymentType,
    notes: purchaseNotes,
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
    document: billDocuments[0] ?? null,
    documents: billDocuments,
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
    if (
      accountChanged ||
      !draftPrefix ||
      !catalogLoaded ||
      contextBusy ||
      purchaseLocked ||
      purchaseEditOf
    )
      return;
    if (!(
      billDocuments.length ||
      draftTouched ||
      purchaseCards.some((c) => !isBlankCard(c)) ||
      purchaseBillNo ||
      purchaseDiscount ||
      purchaseCharges.length ||
      purchaseNotes ||
      purchasePaymentType !== 'credit'
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
    purchaseEditOf,
    purchaseLocked,
    draftTouched,
    purchaseClientId,
    purchaseSupplier,
    purchaseBillNo,
    businessDate,
    purchaseDiscount,
    purchaseCharges,
    purchasePaymentType,
    purchaseNotes,
    purchaseCards,
    billDocuments,
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
      contextApplied.current = purchaseSupplierId + ':' + purchaseRepeatId + ':' + purchaseEditId;
      // A restored draft is always a new bill.
      setPurchaseEditOf('');
      setPurchaseEditLabel('');
      contextNeedsReset.current = false;
      setPurchaseClientId(d.clientId);
      setBillDocuments(draftDocuments(d));
      setDocumentBusy(false);
      setDocumentSaveError(d.documentIssue ?? '');
      setPurchaseSupplier(d.supplier);
      setPurchaseBillNo(d.billNo);
      setBusinessDate(d.businessDate);
      setPurchaseDiscount(d.discount);
      setPurchaseCharges(
        d.charges
          ? d.charges.map((c) => ({ ...emptyCharge(), label: c.label, amount: c.amount }))
          : chargeRowsFromExtra(d.extra),
      );
      setPurchasePaymentType(d.paymentType ?? 'credit');
      setPurchaseNotes(d.notes ?? '');
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
  const chargesResult = useMemo(() => evaluateCharges(purchaseCharges), [purchaseCharges]);
  // Exactly the server's totals (core purchaseBillTotals): items after discount and GST, bill discount,
  // named charges, then the round-off to the nearest rupee (half up), as old DSB rounded every bill.
  const totals = useMemo(
    () =>
      billTotals(
        purchaseBill.lines.map((l) => ({
          qty: l.qty,
          unitPricePaise: l.unitPricePaise,
          discountBp: l.discountBp,
          gstBp: l.gstBp,
        })),
        purchaseDiscount,
        chargesResult.charges,
      ),
    [purchaseBill, purchaseDiscount, chargesResult],
  );
  const payablePaise = totals.ok ? totals.totalPaise : null;
  const paperCheck = paperTotalCheck(purchaseExpectedTotal, payablePaise);
  const payablePreview = totals.ok ? rupees(totals.totalPaise) : 'Check amounts';
  const lockedV2 =
    purchaseLocked && lockedPurchase.current && isV2Pending(lockedPurchase.current)
      ? lockedPurchase.current
      : null;
  // What Post will do with money: shown before Post, and on the button itself.
  const shownType: PurchasePaymentType = purchaseLocked
    ? (lockedV2?.paymentType ?? 'credit')
    : purchasePaymentType;
  const notesTooLong = purchaseNotes.trim().length > NOTES_MAX;
  const [dupChecking, setDupChecking] = useState(false);
  // The duplicate check freezes the form so the bill that posts is exactly the one that was checked.
  const editLocked =
    purchaseLocked || contextBusy || documentBusy || !purchaseContextReady || dupChecking;
  // Bill details (discount, charges, notes, photos) start closed; the summary names every value in it,
  // and a problem there opens it.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsForced = !!chargesResult.problems.length || notesTooLong || !totals.ok;
  const detailsShown = detailsOpen || detailsForced;
  // A new problem in there opens it (and leaves it open once fixed, so it never folds mid-typing).
  useEffect(() => {
    if (detailsForced) setDetailsOpen(true);
  }, [detailsForced]);
  const detailsBadges = [
    purchaseDiscount.trim() ? `discount ₹${purchaseDiscount.trim()}` : '',
    purchaseCharges.length
      ? `${purchaseCharges.length} charge${purchaseCharges.length === 1 ? '' : 's'}${chargesResult.totalPaise ? ` ${rupees(chargesResult.totalPaise)}` : ''}`
      : '',
    purchaseNotes.trim() ? 'notes' : '',
    billDocuments.length
      ? `${billDocuments.length} photo${billDocuments.length === 1 ? '' : 's'}`
      : '',
  ].filter(Boolean);

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
    let taxRateBp: number;
    try {
      taxRateBp = parsePercentBp(text('gstPercent')) ?? 0;
    } catch {
      setError('Enter the GST % from 0 to 100 (at most 2 decimals), or leave it blank for 0%.');
      return;
    }
    try {
      const item = await createItem({
        tenantId,
        ...newItemInput(fields),
        taxRateBp,
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
  // Items of a posted bill as cards, WITH their discount/GST (getPurchaseExtras). If the extras cannot be
  // read nothing is copied: a card without its discount/GST would silently change what the bill costs.
  // The extras read is awaited, so the answer is dropped (null) if meanwhile the shop, supplier, source
  // bill or bill being entered changed, or the bill was sent/locked: never copy into another bill.
  // A dropped answer resolves to `{ stale: message }`, shown instead of copying.
  async function cardsFromBill(
    detail: NonNullable<typeof recentDetail>,
    lines: NonNullable<typeof recentDetail>['lines'],
  ): Promise<BillCard[] | { stale: string }> {
    const cart = repeatPurchase(detail.bill, lines, items);
    const startShop = shopId;
    const startSupplier = purchaseSupplier;
    const startClient = purchaseClientRef.current;
    const staleReason = () => {
      const now = copyContextRef.current;
      if (now.shopId !== startShop || now.purchaseSupplier !== startSupplier)
        return 'Shop or supplier changed — not copied.';
      if (
        now.recentDetail?.bill.id !== detail.bill.id ||
        purchaseClientRef.current !== startClient ||
        purchaseLockedRef.current ||
        purchaseBusyRef.current
      )
        return 'The bill changed while the last bill was being read — not copied.';
      return '';
    };
    let extras;
    try {
      extras = await getPurchaseExtras(startShop, detail.bill.id);
    } catch {
      const stale = staleReason();
      if (stale) return { stale };
      throw new Error(
        "This bill's discount and GST could not be read, so its items were not copied. Try again when connected.",
      );
    }
    const stale = staleReason();
    if (stale) return { stale };
    return cart.map((line, i) => {
      const x = extras.lines.find((e) => e.lineNo === lines[i]?.line_no);
      return cardFromLine(x ? { ...line, discountBp: x.discountBp, gstBp: x.gstBp } : line);
    });
  }
  async function repeatLastBill() {
    if (!recentDetail) return;
    let cards: BillCard[];
    try {
      const got = await cardsFromBill(recentDetail, recentDetail.lines);
      if (!Array.isArray(got)) {
        setMessage(got.stale);
        return;
      }
      cards = got;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    // Decide from the cards as they are NOW (after the await): anything typed meanwhile is asked about.
    if (
      copyContextRef.current.purchaseCards.some((c) => !isBlankCard(c)) &&
      !confirm(
        `Replace the items on this bill with the ${cards.length} item${cards.length === 1 ? '' : 's'} of the last bill from this supplier?`,
      )
    )
      return;
    setPurchaseCards(cards);
    setDraftTouched(true);
    repeatedClientId.current = purchaseClientId;
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
  const duplicateCheckBusy = useRef(false);
  const repeatedClientId = useRef<string | null>(null);
  async function addPurchase(ev: Event) {
    ev.preventDefault();
    // Only the Post button posts (never Enter in a field, never a script-driven submit without it).
    if (!postButton.current || (ev as SubmitEvent).submitter !== postButton.current) return;
    if (purchaseBusy || contextBusy || (!purchaseLocked && !purchaseContextReady) || accountChanged)
      return;
    setError('');
    // Purchases are online-only: nothing is queued, so nothing is sent without a connection.
    if (!online) {
      setError(OFFLINE_POST);
      return;
    }
    if (
      !purchaseLocked &&
      (documentBusy || documentSaveError || billDocuments.some((d) => !d.uploaded))
    ) {
      setError('Confirm the document upload, or explicitly remove the attachment, before posting.');
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const focusField = (selector: string) => {
      const input = form.querySelector<HTMLInputElement>(selector);
      input?.scrollIntoView?.({ block: 'center' });
      input?.focus();
    };
    const refuse = (problem: string, selector?: string) => {
      setError(problem);
      setBarProblem(problem);
      if (selector) focusField(selector);
    };
    if (!purchaseLocked && purchaseBill.problems.length) {
      const first = purchaseBill.problems[0]!;
      const problem = `Item ${first.index + 1}: ${first.message}${purchaseBill.problems.length > 1 ? ` (${purchaseBill.problems.length} items need a look.)` : ''}`;
      setError(problem);
      setBarProblem(problem);
      // Take the user to the first card that needs a look, at the field to fix.
      const bad = purchaseCards[first.index];
      const field = !bad?.item
        ? 'name'
        : /discount/i.test(first.message)
          ? 'discount'
          : /GST/.test(first.message)
            ? 'gst'
            : /quantity/i.test(first.message)
              ? 'qty'
              : 'price';
      const badCard = form.querySelectorAll('.bill-card')[first.index];
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
    if (!purchaseLocked) {
      if (chargesResult.problems.length) {
        const first = chargesResult.problems[0]!;
        return refuse(
          `Extra charge ${first.index + 1}: ${first.message}`,
          `[data-charge="${first.index}"] input`,
        );
      }
      if (!totals.ok) return refuse(totals.message, 'input[name="discount"]');
      if (notesTooLong)
        return refuse(`Notes are limited to ${NOTES_MAX} characters.`, 'textarea[name="notes"]');
      if (purchasePaymentType !== 'credit' && !purchaseSupplier)
        return refuse(
          `A ${PAYMENT_LABEL[purchasePaymentType]} bill is paid to a supplier. Choose the supplier, or make it a Credit bill.`,
          'select[name="partyId"]',
        );
      if (purchasePaymentType !== 'credit' && shopToday && businessDate > shopToday)
        return refuse(
          `A ${PAYMENT_LABEL[purchasePaymentType]} bill cannot be dated after today: it is paid now.`,
          'input[name="date"]',
        );
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
        const cardEls = form.querySelectorAll('.bill-card');
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
    const f = new FormData(form);
    const lineCount =
      purchaseLocked && lockedPurchase.current
        ? lockedPurchase.current.lines.length
        : purchaseBill.lines.length;
    // A retry after an unknown outcome resends the frozen request byte for byte (v1 entries stored before
    // this version are retried as v1). A new bill is always sent to post_purchase_v2.
    const fresh: PendingPurchaseV2 = {
      api: 'v2',
      shopId,
      clientId: purchaseClientId,
      partyId: String(f.get('partyId') || '') || null,
      billNo: String(f.get('billNo') || '').trim() || null,
      businessDate: String(f.get('date')),
      discountPaise: totals.ok ? totals.discountPaise : 0,
      paymentType: purchasePaymentType,
      notes: purchaseNotes.trim() || null,
      lines: purchaseBill.lines.map((l) => ({
        itemId: l.item.id,
        unitLevel: l.unitLevel,
        qty: l.qty,
        unitPricePaise: l.unitPricePaise,
        discountBp: l.discountBp,
        // Blank GST is null (price already includes GST), never 0 ("0% added").
        gstBp: l.gstBp,
      })),
      charges: chargesResult.charges,
      images: purchaseEditOf ? [] : billDocuments.map((d) => d.path),
      ...(purchaseEditOf ? { editOf: purchaseEditOf } : {}),
    };
    const request: PendingPurchase = (purchaseLocked && lockedPurchase.current) || fresh;
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
    // Possible duplicate (same supplier + bill number, or same supplier + total within 3 days): a confirm,
    // never a block. Reads this supplier's bills (short timeout) plus the bills already loaded here.
    if (!purchaseLocked && fresh.partyId) {
      if (duplicateCheckBusy.current) return;
      duplicateCheckBusy.current = true;
      setDupChecking(true);
      let match: DuplicateMatch | null;
      try {
        // An edit replaces its own original (same supplier, bill no., often total): never a duplicate of it.
        const known = (await knownSupplierBills(shopId, fresh.partyId, recentBills)).filter(
          (b) => !fresh.editOf || b.id !== fresh.editOf,
        );
        match = findDuplicateBill(
          {
            partyId: fresh.partyId,
            billNo: fresh.billNo ?? null,
            businessDate: fresh.businessDate ?? '',
            totalPaise: payablePaise,
          },
          known,
          { sameTotal: repeatedClientId.current !== fresh.clientId },
        );
      } finally {
        duplicateCheckBusy.current = false;
        setDupChecking(false);
      }
      if (match && !confirm(duplicateMessage(match))) return;
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
      // A new bill waits for an unconfirmed one stored under the other name too.
      if (!isRetry) {
        for (const key of allPendingKeys(request.shopId)) {
          if (key === pendingKeyFor(request)) continue;
          const other = loadPendingIntent<PendingPurchase>(key);
          if (!other.ok || other.value)
            throw new Error(
              'Another unconfirmed purchase is stored on this device. Nothing was sent; reload this page to finish it first.',
            );
        }
      }
      savePendingIntent(pendingKeyFor(request), request, { retry: isRetry });
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
      // v2 replays a same-id request with its stored answer (same bill, same payment); a refused retry is
      // decided by the stored answer (lookupPurchaseRequest), and a payload mismatch is a final refusal.
      // An edit request (it carries editOf, even after a reload) always goes to edit_purchase_bill.
      const editOf = isV2Pending(request) ? (request.editOf ?? '') : '';
      const outcome =
        isV2Pending(request) && editOf
          ? await editPurchaseBillOutcome({ ...request, originalId: editOf }, isRetry)
          : isV2Pending(request)
            ? await postPurchaseV2Outcome(request, isRetry)
            : await postPurchaseOutcome(request, isRetry);
      if (outcome.kind === 'unknown') {
        // May have committed: the form stays frozen and a retry resends this exact request.
        setError(
          `Not confirmed: ${outcome.message}. The bill is locked — retry sends the same bill and never posts it (or its payment) twice.`,
        );
        return;
      }
      lockedPurchase.current = null;
      setPurchaseLocked(false);
      clearPendingIntent(pendingKeyFor(request), request.clientId);
      // Another window's unconfirmed purchase may still be stored: lock onto it next, same id (VF-009).
      const next = loadPending(request.shopId);
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
        // Nothing posted, so no sale price of this bill may ever be written: every stored plan for it
        // (this window's, or an earlier page's after a reload or takeover) is removed. The next attempt
        // plans them again from the cards.
        if (saleUser)
          for (const plan of listPricePlans(saleUser, request.shopId))
            if (plan.bill === request.clientId) removePricePlan(plan.key);
        ownPlans.current.delete(request.clientId);
        setError(
          editOf
            ? `Not saved: ${plainEditRefusal(outcome.message)} The original bill is unchanged.${anotherNote}`
            : outcome.code === 'DSB_PAYLOAD_MISMATCH'
              ? `Not posted, and it cannot be posted from this form: ${outcome.message}${anotherNote}`
              : `Not posted: ${outcome.message}.${anotherNote}`,
        );
        return;
      }
      const paidNote =
        isV2Pending(request) &&
        request.paymentType &&
        request.paymentType !== 'credit' &&
        outcome.kind === 'committed' &&
        (outcome.value as { paymentId?: string | null }).paymentId
          ? ` Paid in full ${rupees((outcome.value as { totalPaise: number }).totalPaise)} by ${PAYMENT_LABEL[request.paymentType]}.`
          : '';
      // Only a purchase built from this cart (it carries the cart's id) clears the cart when it posts;
      // a restored entry from another window leaves the user's cart intact (Codex P2).
      // The next new bill on this device starts with this supplier (shown, changeable).
      if (request.partyId && saleUser)
        try {
          localStorage.setItem(lastSupplierStorageKey(saleUser, request.shopId), request.partyId);
        } catch {
          // A convenience only: a new bill then starts without a supplier.
        }
      if (request.clientId === purchaseClientId) {
        setPurchaseClientId(crypto.randomUUID());
        for (const d of billDocuments) void removeLocalDocument(draftPrefix, d.id).catch(() => {});
        setBillDocuments([]);
        setDocumentBusy(false);
        setDocumentSaveError('');
        setPurchaseCards([emptyCard()]);
        setPurchaseExpectedTotal(undefined);
        setPurchaseBillNo('');
        setPurchaseDiscount('');
        setPurchaseCharges([]);
        setPurchasePaymentType('credit');
        setPurchaseNotes('');
        setPurchaseEditOf('');
        setPurchaseEditLabel('');
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
      const carried =
        editOf && outcome.kind === 'committed'
          ? ((outcome.value as { carriedPaise?: number }).carriedPaise ?? 0)
          : 0;
      setMessage(
        editOf
          ? `Bill corrected (${lineCount} item${lineCount === 1 ? '' : 's'}). The original bill is void and replaced; stock and supplier balance updated.${carried ? ` Its payment of ${rupees(carried)} now counts against the corrected bill.` : ''}${priceNote}${refreshNote}`
          : `Purchase posted (${lineCount} item${lineCount === 1 ? '' : 's'}) and stock updated.${paidNote}${priceNote}${refreshNote}`,
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
  async function changeTaxRate(ev: Event) {
    ev.preventDefault();
    if (!selectedItem) return;
    const f = new FormData(ev.currentTarget as HTMLFormElement);
    try {
      const bp = parsePercentBp(String(f.get('gstPercent') || '')) ?? 0;
      const rate = await setItemTaxRate(selectedItem.id, bp);
      setItems((v) => v.map((i) => (i.id === selectedItem.id ? { ...i, tax_rate_bp: rate } : i)));
      setMessage(`GST rate saved: ${percentText(rate)}%.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
                  {formatQuantity(stock.find((row) => row.item_id === item.id)?.qty_base) || '—'}
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
          <div class="alert price-retry" role="alert" key={entryId(r.key, w.clientId)}>
            <span>
              {text}{' '}
              <small class="muted">
                Entered {ageText(r.savedAt, Date.now())} · Now{' '}
                {load?.state === 'ok' ? (now === null ? 'no price' : rupees(now)) : '…'}
                {RETRYABLE.has(r.state) && r.message ? ` · ${r.message}` : ''}
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
            <label>
              GST %{' '}
              <input name="gstPercent" inputMode="decimal" placeholder="0" aria-label="GST %" />
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
            Reorder at: {formatQuantity(selectedItem.min_stock)}{' '}
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
          <form key={`gst:${selectedItem.id}`} onSubmit={changeTaxRate}>
            <label>
              Item GST %{' '}
              <input
                name="gstPercent"
                inputMode="decimal"
                defaultValue={percentText(selectedItem.tax_rate_bp ?? 0)}
              />
            </label>{' '}
            <button disabled={!tenantId}>Save GST rate</button>
          </form>
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
        <h2>{purchaseEditOf || lockedEditOf ? 'Edit bill' : 'Post purchase'}</h2>
        {lockedEditOf && (
          <p class="card" data-testid="editing-bill-locked" role="status">
            An unconfirmed bill edit is locked in this form. Retry sends the same edit: it replaces
            the original bill once, never twice.
          </p>
        )}
        {purchaseEditOf && !purchaseLocked && (
          <p class="card" data-testid="editing-bill" role="status">
            Editing bill {purchaseEditLabel}. Saving posts the corrected bill and voids the original
            together; a payment on it moves to the corrected bill.{' '}
            <a href={appRoute.purchases}>Cancel</a>
          </p>
        )}
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
              {lockedV2 && lockedV2.paymentType && lockedV2.paymentType !== 'credit' && (
                <p>
                  This bill was sent as a {PAYMENT_LABEL[lockedV2.paymentType]} bill. A retry
                  records its payment only once.
                </p>
              )}
              {lockedPurchase.current &&
                pendingImages(lockedPurchase.current).map((path) => (
                  <BillDocumentPreview key={path} path={path} />
                ))}
            </div>
          )}
          <fieldset disabled={editLocked} class="plain bill-head">
            <label class="bill-supplier">
              <small>Supplier</small>
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
            </label>
            {purchaseOnly && !purchaseSupplier && (
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
            <div class="bill-head-row">
              <label>
                <small>Bill no.</small>
                <input
                  name="billNo"
                  placeholder="Bill no."
                  enterKeyHint="next"
                  value={purchaseBillNo}
                  onInput={(e) => setPurchaseBillNo(e.currentTarget.value)}
                />
              </label>
              <label>
                <small>Business date</small>
                <input
                  name="date"
                  type="date"
                  value={businessDate}
                  onInput={(e) => setBusinessDate((e.currentTarget as HTMLInputElement).value)}
                  required
                />
              </label>
            </div>
          </fieldset>
          {purchaseOnly && purchaseSupplier && usual && usual.key === usualKey && (
            <UsualItems
              key={usual.key}
              supplierName={parties.find((p) => p.id === purchaseSupplier)?.name ?? 'this supplier'}
              load={usual.load}
              onBill={itemsOnBill(purchaseCards)}
              open={usualOpen}
              onToggle={() => setUsualOpen((o) => !o)}
              onAdd={(rows) => addUsualItems(usual.key, rows)}
              onRetry={() => setUsualReload((n) => n + 1)}
              onRepeat={recentDetail ? repeatLastBill : undefined}
              disabled={editLocked}
              showRates={canSeePurchasePrices}
            />
          )}
          <fieldset disabled={editLocked} class="plain">
            <PurchaseBillCards
              cards={purchaseCards}
              items={items}
              onChange={(next) => {
                setPurchaseCards(next);
                setDraftTouched(true);
              }}
              disabled={editLocked}
              shopId={shopId}
              parties={parties}
              canSeePrices={canSeePurchasePrices}
              saleLoads={saleEnabled ? saleLoads : undefined}
              onMessage={setMessage}
              findBarcode={findBarcodeForCard}
              onCreateItem={tenantId ? createItemFromCard : undefined}
              showAdd={false}
              focusCard={focusCard}
              lastUnit={lastUnit}
            />
            <div class="bill-total" aria-label="Bill total" data-testid="bill-total">
              <p>
                <span>Items ({purchaseBill.lines.length})</span>
                <span>{rupees(purchaseBill.itemsTotalPaise)}</span>
              </p>
              {totals.ok ? (
                <>
                  {totals.discountPaise > 0 && (
                    <p class="muted">
                      <span>Bill discount</span>
                      <span>−{rupees(totals.discountPaise)}</span>
                    </p>
                  )}
                  {totals.extraChargesPaise > 0 && (
                    <p class="muted">
                      <span>Extra charges</span>
                      <span>+{rupees(totals.extraChargesPaise)}</span>
                    </p>
                  )}
                  {totals.roundOffPaise !== 0 && (
                    <>
                      <p class="muted">
                        <span>Total before round off</span>
                        <span>{rupees(totals.totalBeforeRoundOffPaise)}</span>
                      </p>
                      <p class="muted" data-testid="round-off">
                        <span>Round off</span>
                        <span>{roundOffText(totals.roundOffPaise).slice('Round off '.length)}</span>
                      </p>
                    </>
                  )}
                </>
              ) : (
                <p class="alert">{totals.message}</p>
              )}
              <p class="bill-total-main">
                <span>Bill total</span>
                <strong>{payablePreview}</strong>
              </p>
            </div>
          </fieldset>
          <div class="bill-details">
            <button
              type="button"
              class="bill-details-toggle"
              aria-expanded={detailsShown}
              aria-controls="bill-details-body"
              onClick={() => setDetailsOpen(!detailsShown)}
            >
              Bill details{' '}
              <span class="bill-details-badge" data-testid="bill-details-badge">
                {detailsBadges.length
                  ? detailsBadges.join(' · ')
                  : 'discount, charges, notes, photos'}
              </span>
            </button>
            <div id="bill-details-body" class="bill-details-body" hidden={!detailsShown}>
              <fieldset disabled={editLocked} class="plain">
                <label class="bill-discount">
                  <small>Bill discount ₹</small>
                  <input
                    name="discount"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={purchaseDiscount}
                    onInput={(e) => setPurchaseDiscount(e.currentTarget.value)}
                  />
                </label>
                <div class="bill-charges" role="group" aria-label="Extra charges">
                  <small>Extra charges</small>
                  {purchaseCharges.map((c, i) => (
                    <div class="bill-charge-row" key={c.key} data-charge={i}>
                      <input
                        aria-label={`Extra charge ${i + 1} name`}
                        autocomplete="off"
                        maxLength={60}
                        placeholder="Transport, packing…"
                        value={c.label}
                        onInput={(e) => {
                          const label = e.currentTarget.value;
                          setPurchaseCharges((rows) =>
                            rows.map((r) => (r.key === c.key ? { ...r, label } : r)),
                          );
                          setDraftTouched(true);
                        }}
                      />
                      <input
                        aria-label={`Extra charge ${i + 1} amount ₹`}
                        type="text"
                        inputMode="decimal"
                        autocomplete="off"
                        placeholder="₹"
                        value={c.amount}
                        onInput={(e) => {
                          const amount = e.currentTarget.value;
                          setPurchaseCharges((rows) =>
                            rows.map((r) => (r.key === c.key ? { ...r, amount } : r)),
                          );
                          setDraftTouched(true);
                        }}
                      />
                      <button
                        type="button"
                        aria-label={`Remove extra charge ${i + 1}`}
                        onClick={() => {
                          setPurchaseCharges((rows) => rows.filter((r) => r.key !== c.key));
                          setDraftTouched(true);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {chargesResult.problems.map((p) => (
                    <small class="alert" key={p.index}>
                      Extra charge {p.index + 1}: {p.message}
                    </small>
                  ))}
                  <div class="row">
                    <button
                      type="button"
                      onClick={() => {
                        setPurchaseCharges((rows) => [...rows, emptyCharge()]);
                        setDraftTouched(true);
                      }}
                    >
                      + Add charge
                    </button>
                    {chargesResult.totalPaise > 0 && (
                      <span data-testid="charges-sum">
                        Extra charges {rupees(chargesResult.totalPaise)}
                      </span>
                    )}
                  </div>
                </div>
                <label class="bill-notes">
                  <small>Notes</small>
                  <textarea
                    name="notes"
                    rows={2}
                    maxLength={NOTES_MAX}
                    placeholder="Optional notes…"
                    value={purchaseNotes}
                    onInput={(e) => {
                      setPurchaseNotes(e.currentTarget.value);
                      setDraftTouched(true);
                    }}
                  />
                  <small class={notesTooLong ? 'alert' : 'muted'} data-testid="notes-count">
                    {purchaseNotes.trim().length}/{NOTES_MAX}
                  </small>
                </label>
              </fieldset>
              {purchaseEditOf && (
                <p class="muted" data-testid="edit-photos-note">
                  Bill photos stay on the original bill.
                </p>
              )}
              {draftPrefix && !purchaseEditOf && (
                <BillAttachmentEditor
                  key={purchaseClientId}
                  scope={draftPrefix}
                  tenantId={tenantId}
                  shopId={shopId}
                  clientId={purchaseClientId}
                  documents={billDocuments}
                  disabled={
                    purchaseLocked || contextBusy || !purchaseContextReady || accountChanged
                  }
                  onProblem={(message) => {
                    if (purchaseClientRef.current === purchaseClientId)
                      setDocumentSaveError(message);
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
                  onChange={(docs) => {
                    if (purchaseClientRef.current !== purchaseClientId || lockedPurchase.current)
                      return;
                    try {
                      savePurchaseDraft(draftPrefix, draftWriter.current, {
                        ...draftSnapshot,
                        document: docs[0] ?? null,
                        documents: docs,
                        documentIssue: '',
                        savedAt: Date.now(),
                      });
                      setBillDocuments(docs);
                      setDraftTouched(true);
                      setDocumentSaveError('');
                    } catch (e) {
                      setDocumentSaveError(String(e));
                      throw e;
                    }
                  }}
                />
              )}
            </div>
          </div>
          {documentSaveError && (
            <div role="alert">
              <p>{documentSaveError}</p>
              <button
                type="button"
                disabled={purchaseLocked || documentBusy}
                onClick={() => setDocumentSaveError('')}
              >
                {billDocuments.length ? 'Keep current attachment' : 'Continue without attachment'}
              </button>
            </div>
          )}
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
          {!purchaseLocked &&
            purchasePaymentType !== 'credit' &&
            totals.ok &&
            totals.totalPaise > 0 && (
              <p class="bill-paid-note" role="status" data-testid="paid-now">
                Paid in full {rupees(totals.totalPaise)} now by {PAYMENT_LABEL[purchasePaymentType]}
                . Posting records this bill and a {PAYMENT_LABEL[purchasePaymentType]} payment of
                the same amount to the supplier.
              </p>
            )}
          {!online && (
            <p class="alert" role="status" data-testid="offline-post">
              {OFFLINE_POST}
            </p>
          )}
          <div class="bill-bar">
            <fieldset disabled={editLocked} class="plain bill-bar-edit">
              <small class="muted">Payment</small>
              <div class="bill-pay" role="group" aria-label="Payment type">
                {(['credit', 'cash', 'upi'] as const).map((t) => (
                  <button
                    type="button"
                    key={t}
                    aria-pressed={purchasePaymentType === t}
                    onClick={() => {
                      setPurchasePaymentType(t);
                      setDraftTouched(true);
                    }}
                  >
                    {PAYMENT_LABEL[t]}
                  </button>
                ))}
              </div>
            </fieldset>
            <button type="button" class="bill-bar-add" disabled={editLocked} onClick={addItemRow}>
              + Add item
            </button>
            {!purchaseLocked && barProblem && (
              <span class="bill-bar-problem" role="alert">
                {barProblem}
              </span>
            )}
            {!purchaseLocked && (
              <span class="bill-bar-total" aria-live="polite">
                Total {payablePreview}
                {totals.ok && totals.roundOffPaise !== 0 && (
                  <small class="muted">
                    {' '}
                    incl. round off {roundOffText(totals.roundOffPaise).slice('Round off '.length)}
                  </small>
                )}
              </span>
            )}
            <button
              ref={postButton}
              class="primary"
              disabled={
                purchaseBusy ||
                dupChecking ||
                contextBusy ||
                (!purchaseLocked &&
                  (!purchaseContextReady ||
                    documentBusy ||
                    !!documentSaveError ||
                    billDocuments.some((d) => !d.uploaded))) ||
                !online ||
                !shopId ||
                !businessDate ||
                (!purchaseBill.lines.length && !purchaseLocked)
              }
            >
              {purchaseBusy
                ? 'Posting…'
                : purchaseLocked
                  ? lockedEditOf
                    ? 'Retry same edit'
                    : 'Retry same purchase'
                  : purchaseEditOf
                    ? 'Save corrected bill'
                    : postButtonText(shownType, totals.ok ? totals.totalPaise : null)}
            </button>
          </div>
        </form>
      </section>
    </Container>
  );
}

const DUPLICATE_READ_TIMEOUT_MS = 4000;
const fromRecord = (b: PurchaseRecord): KnownBill => ({
  id: b.id,
  partyId: b.party_id,
  billNo: b.bill_no,
  businessDate: b.business_date,
  totalPaise: b.total_paise,
  status: b.status,
});
// This supplier's posted bills from the server (bounded wait), merged with any bill list this device has
// already loaded (this screen's recent bills, the Purchases list snapshot). A failed read is no match.
async function knownSupplierBills(
  shopId: string,
  partyId: string,
  loaded: PurchaseRecord[],
): Promise<KnownBill[]> {
  let server: KnownBill[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      listSupplierBills(shopId, partyId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), DUPLICATE_READ_TIMEOUT_MS);
      }),
    ]);
    server = rows.map((b) => ({
      id: b.purchase_bill_id,
      partyId,
      billNo: b.bill_no,
      businessDate: b.business_date,
      totalPaise: b.total_paise,
    }));
  } catch {
    /* offline or refused: fall back to what is loaded */
  } finally {
    clearTimeout(timer);
  }
  let cached: KnownBill[] = [];
  try {
    const snap = peekSnapshot<{ rows: PurchaseRecord[] }>(
      'purchases',
      await snapshotUserId(),
      shopId,
    );
    cached = (snap?.value.rows ?? []).map(fromRecord);
  } catch {
    /* no snapshot */
  }
  return mergeKnownBills(server, loaded.map(fromRecord), cached);
}
