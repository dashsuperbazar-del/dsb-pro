import { errorText } from '../lib/friendlyError';
import { HomeRow } from '../components/HomeRow';
import { useUserId } from '../lib/useUserId';
import { formatQuantity } from '@dsb-pro/core';
import { CameraScanner } from '../components/CameraScanner';
import { createBurstDetector, isScanTarget } from '../lib/scanBurst';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  billRoundOff,
  canonicalQuantity,
  parseRupeesToPaise,
  quantityTimesPaise,
  saleBillTotals,
  searchCatalogItems,
  splitGst,
  type SaleInvoiceType,
} from '@dsb-pro/core';
import { route } from 'preact-router';
import { isTypingField, posShortcut, stepIndex } from '../lib/shortcuts';
import {
  addQuantity,
  defaultSellLevel,
  pickPrice,
  pushRecent,
  readRecent,
  stockState,
  writeRecent,
} from '../lib/posPicker';
import {
  createCustomer,
  findItemByBarcode,
  getShopBusinessDate,
  listCurrentPrices,
  listCustomerBalances,
  listCustomers,
  listItems,
  listRecentSales,
  listStock,
  recordCustomerPayment,
  getSaleReceipt,
  type Customer,
  type Item,
  type SaleInvoice,
  type SaleReceipt,
} from '@dsb-pro/adapters';
import {
  isDefinitiveFinancialRejectionMessage,
  resolveHeldCart,
  type HeldCartRecord,
  type OfflineSaleRecord,
} from '@dsb-pro/sync';
import { appRoute } from '../lib/paths';
import {
  finalizeSaleResilient,
  findOfflineBarcode,
  getOfflineBusinessDate,
  getOfflineCustomers,
  getOfflineItems,
  getOfflineItemCount,
  getOfflinePrices,
  getOfflineStock,
  getOfflineRuntimeIdentity,
  getOfflineSaleStatus,
  listOfflineSales,
  waitForOfflineRuntime,
  reviewOfflineSaleMismatch,
  holdCurrentCart,
  listHeldCartsForShop,
  claimHeldCartForResume,
  releaseHeldCartForResume,
  completeHeldCartForResume,
  discardHeldCartById,
} from '../lib/offlineSync';
import { mergeCatalog, watchOfflineCatalog } from '../lib/catalogWatch';
import { ReceiptHeader } from '../components/ReceiptHeader';
import { SaleReceiptPrint } from '../components/SaleReceiptPrint';
import { SaleDoneCard, type SaleDoneInfo } from '../components/SaleDoneCard';
import { ShareImageButton } from '../components/ShareImageButton';
import { saleInvoiceDoc } from '../lib/shareImage';
import { rupees } from '../lib/money';
import { friendlyError, type FriendlyError } from '../lib/friendlyError';
import {
  figuresFromReceipt,
  figuresFromRecord,
  friendlySaleName,
  saleStateLabel,
} from '../lib/saleDone';
import { loadShopProfile, type ProfileLoad } from '../lib/shopProfile';
import { addSalePricePlans, flushSalePricePlans, type SalePricePlan } from '../lib/salePricePlans';

/** The price fields the list rows need (a server row and a device row both have them). */
type PriceLite = { kind: string; unit_level: number; shop_id: string | null; price_paise: number };
const PICK_PAGE = 8;
const PICK_MORE = 20;

type CartLine = {
  item: Item;
  unitLevel: 1 | 2 | 3;
  qty: string;
  priceKind: 'retail' | 'wholesale';
  unitPricePaise: number;
  discountPaise: number;
  /** salepricing: 'manual' = typed by an owner/manager at the counter (stored with the sale). */
  priceSource?: 'manual';
  /** The active list price when the item was added (null = the item had none). */
  listPricePaise?: number | null;
  /** "Save as this item's sale price" (default off): written only after the sale is confirmed. */
  savePrice?: boolean;
  /**
   * backlog (0070): a free-text line (not in the item list). `item` is then a stand-in carrying the typed name
   * and GST % (id ''); the line has no stock and always a typed price.
   */
  freeText?: boolean;
};
/** Common GST rates for a free-text item (basis points). */
const FREE_TEXT_GST_BP = [0, 500, 1200, 1800, 2800, 300, 25, 4000];
function freeTextItem(name: string, taxRateBp: number): Item {
  return {
    id: '',
    name,
    sku: null,
    unit1: 'unit',
    unit2: null,
    unit3: null,
    conv1: null,
    conv2: null,
    tax_rate_bp: taxRateBp,
    min_stock: 0,
    image_path: null,
  };
}
type PendingPrice = {
  item: Item;
  unitLevel: 1 | 2 | 3;
  qty: string;
  priceKind: 'retail' | 'wholesale';
  discountPaise: number;
};
type Tender = { mode: 'cash' | 'upi' | 'card' | 'bank' | 'other'; amount: string };
// One money format on the counter (₹2,647.00, same as Home); never "₹NaN" and never a minus sign on zero.
const money = (paise: number) => (Number.isSafeInteger(paise) ? rupees(paise) : '—');
// Printed receipts keep their own plain format (the same document Sales history reprints).
const receiptMoney = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const paise = (text: string) => parseRupeesToPaise(text || '0');
/** A money box the cashier may have left half typed: 0 instead of throwing while the screen draws. */
const safePaise = (text: string) => {
  try {
    return paise(text);
  } catch {
    return 0;
  }
};
/** A phone-sized screen: the secondary blocks start closed there. */
const isPhoneScreen = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 640px)').matches;
/** A mouse + keyboard counter (not a touch phone): the barcode box may take focus without a keyboard popping up. */
const hasFinePointer = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
const lineGross = (qty: string, pricePaise: number) => {
  try {
    return quantityTimesPaise(qty, pricePaise);
  } catch {
    return 0;
  }
};
const tenderTotalOf = (tenders: Tender[]) => tenders.reduce((sum, t) => sum + paise(t.amount), 0);
const HOLD_LABEL_DRAFT_KEY = 'dsb-pro:pos:hold-label-draft';
/** A typed price in rupees: more than zero, at most two decimals; null when invalid. */
function typedPricePaise(value: string): number | null {
  const typed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) return null;
  const amount = parseRupeesToPaise(typed);
  return amount > 0 ? amount : null;
}

function readHoldLabelDraft() {
  if (typeof sessionStorage === 'undefined') return '';
  try {
    return sessionStorage.getItem(HOLD_LABEL_DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}
function writeHoldLabelDraft(value: string) {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (value) sessionStorage.setItem(HOLD_LABEL_DRAFT_KEY, value);
    else sessionStorage.removeItem(HOLD_LABEL_DRAFT_KEY);
  } catch {
    /* storage may be unavailable */
  }
}

function unitName(item: Item, level: 1 | 2 | 3) {
  return level === 1
    ? item.unit1
    : level === 2
      ? (item.unit2 ?? item.unit1)
      : (item.unit3 ?? item.unit2 ?? item.unit1);
}

function HoldLabelField() {
  const [value, setValue] = useState(readHoldLabelDraft);
  return (
    <input
      data-testid="pos-hold-label"
      type="text"
      placeholder="e.g. Table 3"
      value={value}
      onInput={(event) => {
        const next = (event.currentTarget as HTMLInputElement).value;
        writeHoldLabelDraft(next);
        setValue(next);
      }}
    />
  );
}

export function PosScreen() {
  const userId = useUserId();
  const [checkout, setCheckout] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<SaleInvoice[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [offlineSales, setOfflineSales] = useState<OfflineSaleRecord[]>([]);
  const [localReceipt, setLocalReceipt] = useState<OfflineSaleRecord | null>(null);
  const [profile, setProfile] = useState<ProfileLoad | null>(null);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [shopId, setShopId] = useState('');
  // Warm the shop-profile cache while online so a later offline receipt can still name the shop.
  useEffect(() => {
    if (shopId) void loadShopProfile(shopId).then(setProfile);
  }, [shopId]);
  const [tenantId, setTenantId] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [globalDiscount, setGlobalDiscount] = useState('0');
  const [extra, setExtra] = useState('0');
  const [tenders, setTenders] = useState<Tender[]>([{ mode: 'cash', amount: '' }]);
  const [message, setMessage] = useState('');
  // Errors are shown in plain words with the server code kept apart (central map: lib/friendlyError).
  const [error, setErrorState] = useState<FriendlyError | null>(null);
  const setError = (e: unknown) => setErrorState(e ? friendlyError(e) : null);
  const [busy, setBusy] = useState(false);
  // D4: the card after a finalized sale, and the printed receipt of a synced sale (one receipt at a time).
  const [saleDone, setSaleDone] = useState<SaleDoneInfo | null>(null);
  const [saleDoneSale, setSaleDoneSale] = useState<{
    saleId: string;
    customerId: string;
    receipt: SaleReceipt | null;
    record: OfflineSaleRecord | null;
  } | null>(null);
  const [printReceipt, setPrintReceipt] = useState<SaleReceipt | null>(null);
  // Secondary blocks start closed on a phone only; a desktop counter keeps them open as before.
  const [phone] = useState(isPhoneScreen);
  const [barcode, setBarcode] = useState('');
  const [itemQuery, setItemQuery] = useState('');
  // D4b: the tap-to-add list (which row the arrow keys are on, how many rows are shown, per-row unit,
  // retail/wholesale, prices and stock read for the rows, recently added items on this device).
  const [activeId, setActiveId] = useState('');
  const [shownRows, setShownRows] = useState(PICK_PAGE);
  const [rowLevel, setRowLevel] = useState<Record<string, 1 | 2 | 3>>({});
  const [pickKind, setPickKind] = useState<'retail' | 'wholesale'>('retail');
  const [rowPrices, setRowPrices] = useState<Map<string, PriceLite[]>>(new Map());
  const [stockMap, setStockMap] = useState<Map<string, number> | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [lastAdded, setLastAdded] = useState<{ id: string; name: string } | null>(null);
  const pricesAsked = useRef(new Set<string>());
  const [listTick, setListTick] = useState(0);
  const [saleClientId, setSaleClientId] = useState(() => crypto.randomUUID());
  const [paymentClientId, setPaymentClientId] = useState(() => crypto.randomUUID());
  const [paymentCustomer, setPaymentCustomer] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMode, setPaymentMode] = useState<Tender['mode']>('cash');
  const [heldCarts, setHeldCarts] = useState<HeldCartRecord[]>([]);
  const [holdLabelResetVersion, setHoldLabelResetVersion] = useState(0);
  const [resumeBusyId, setResumeBusyId] = useState('');
  const [heldCleanup, setHeldCleanup] = useState<{ id: string; token: string } | null>(null);
  const [role, setRole] = useState('');
  const [invoiceType, setInvoiceType] = useState<SaleInvoiceType>('gst_included');
  const [creditOverride, setCreditOverride] = useState(false);
  const [creditRefused, setCreditRefused] = useState(false);
  const [pendingPrice, setPendingPrice] = useState<PendingPrice | null>(null);
  const [pendingPriceInput, setPendingPriceInput] = useState('');
  const [pendingSave, setPendingSave] = useState(false);
  const [editingPrice, setEditingPrice] = useState<number | null>(null);
  const [ftName, setFtName] = useState('');
  const [ftQty, setFtQty] = useState('1');
  const [ftPrice, setFtPrice] = useState('');
  const [ftGst, setFtGst] = useState(0);
  const canTypePrice = role === 'owner' || role === 'manager';
  const scanBlocked = useRef(false);
  const findRef = useRef<HTMLInputElement>(null);
  const barcodeRef = useRef<HTMLInputElement>(null);
  const saleDoneRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const paymentRef = useRef<HTMLElement>(null);
  const customerRef = useRef<HTMLSelectElement>(null);
  const resumeLock = useRef(false);

  // The business date loads asynchronously; a sale or payment submitted before it arrives
  // (e.g. straight after an offline app restart) must not be queued with an empty date,
  // which the server rejects on sync. Resolve it the same way refresh() does.
  async function resolveBusinessDate(): Promise<string> {
    if (businessDate) return businessDate;
    const offlineFallback = async () =>
      (await getOfflineBusinessDate()) ?? new Date().toISOString().slice(0, 10);
    let d: string;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      d = await offlineFallback();
    } else {
      try {
        d = await getShopBusinessDate(shopId);
      } catch {
        d = await offlineFallback();
      }
    }
    setBusinessDate(d);
    return d;
  }

  async function loadStock(forShop: string, useOffline: boolean) {
    const toMap = (rows: { item_id: string; qty_base: number | string }[]) =>
      new Map(rows.map((r) => [r.item_id, Number(r.qty_base)]));
    try {
      setStockMap(toMap(useOffline ? await getOfflineStock(forShop) : await listStock(forShop)));
    } catch {
      try {
        setStockMap(toMap(await getOfflineStock(forShop)));
      } catch {
        // Keep what was last known; with nothing known the rows show no stock figure and no stock chip.
      }
    }
  }
  async function refresh() {
    await waitForOfflineRuntime();
    const identity = getOfflineRuntimeIdentity();
    if (!identity) throw new Error('Offline shop cache is not ready.');
    setTenantId(identity.tenantId);
    setShopId(identity.shopId);
    setRole(identity.role);
    const useOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    if (useOffline) {
      const [i, c, d] = await Promise.all([
        getOfflineItems(),
        getOfflineCustomers(),
        getOfflineBusinessDate(),
      ]);
      setItems(i);
      setCatalogReady(true);
      setCustomers(c);
      setBusinessDate(d ?? new Date().toISOString().slice(0, 10));
      setSales([]);
      setBalances({});
    } else {
      try {
        // Paint the complete synced catalog immediately, then merge a fresh
        // paginated server read. This keeps 10k-item search fast while making
        // a just-created/imported item visible before realtime sync catches up.
        const cachedItems = await getOfflineItems();
        setItems(cachedItems);
        if (cachedItems.length) setCatalogReady(true);
        // Large catalogs are already complete in the sync cache. Avoid a
        // redundant multi-page server read on every entry to POS; realtime
        // sync supplies later changes. Small/new catalogs still refresh here
        // so an item created moments ago appears immediately.
        const freshItems =
          cachedItems.length >= 1000 ? Promise.resolve(cachedItems as Item[]) : listItems();
        const [serverItems, c, d, s, b] = await Promise.all([
          freshItems,
          listCustomers(),
          getShopBusinessDate(identity.shopId),
          listRecentSales(identity.shopId, 20),
          listCustomerBalances(),
        ]);
        const merged = new Map(cachedItems.map((item) => [item.id, item as Item]));
        for (const item of serverItems) merged.set(item.id, item);
        setItems([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)));
        setCatalogReady(true);
        setCustomers(c);
        setBusinessDate(d);
        setSales(s);
        setBalances(Object.fromEntries(b.map((x) => [x.customer_id, x.balance_paise])));
      } catch {
        const [i, c, d] = await Promise.all([
          getOfflineItems(),
          getOfflineCustomers(),
          getOfflineBusinessDate(),
        ]);
        setItems(i);
        setCatalogReady(true);
        setCustomers(c);
        setBusinessDate(d ?? new Date().toISOString().slice(0, 10));
        setSales([]);
        setBalances({});
      }
    }
    // Row figures are read again after every refresh (a sale changes stock; prices may have changed).
    pricesAsked.current.clear();
    setListTick((t) => t + 1);
    void loadStock(identity.shopId, useOffline);
    setOfflineSales(await listOfflineSales());
    setHeldCarts(await listHeldCartsForShop());
    if (!useOffline) void savePlannedPrices(identity.shopId);
  }
  /** Saves typed prices the owner asked to keep, once their sale is confirmed. */
  async function savePlannedPrices(shop: string): Promise<string> {
    try {
      const { saved, failed } = await flushSalePricePlans(shop, getOfflineSaleStatus);
      if (failed.length)
        setError(`The sale is saved, but a sale price was not: ${failed.join('; ')}`);
      return saved.length ? ` Saved as sale price: ${saved.join(', ')}.` : '';
    } catch (e) {
      setError(`The sale is saved, but a sale price was not: ${friendlyError(e).text}`);
      return '';
    }
  }
  useEffect(() => {
    void refresh().catch((e) => setError(errorText(e)));
  }, []);
  // A catalog still syncing when POS opened is re-read from the device as it grows (display only).
  useEffect(
    () =>
      watchOfflineCatalog<Item>({
        count: getOfflineItemCount,
        load: async () => (await getOfflineItems()) as Item[],
        onChange: (rows) => setItems((shown) => mergeCatalog(shown, rows)),
      }),
    [],
  );
  useEffect(() => {
    if (!heldCleanup) return;
    let active = true;
    void completeHeldCartForResume(heldCleanup.id, heldCleanup.token)
      .then(() => {
        if (!active) return;
        setHeldCleanup(null);
        setHeldCarts((current) => current.filter((cart) => cart.id !== heldCleanup.id));
        setMessage('Cart resumed.');
        void listHeldCartsForShop()
          .then((remaining) => {
            if (active) setHeldCarts(remaining);
          })
          .catch(() => undefined);
      })
      .catch((reason) => {
        if (active)
          setError(
            `Cart was restored, but its held copy could not be removed. Retry cleanup before finalizing: ${String(reason)}`,
          );
      });
    return () => {
      active = false;
    };
  }, [heldCleanup?.id, heldCleanup?.token]);
  // The barcode box takes focus only where that cannot raise a phone keyboard over the form.
  useEffect(() => {
    if (catalogReady && hasFinePointer()) barcodeRef.current?.focus({ preventScroll: true });
  }, [catalogReady]);
  // A message must be seen: in checkout it sits just above the Finalize bar and is brought into view.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);
  // The payment fields must never sit under the fixed Finalize bar: scroll just enough to clear it.
  function keepAmountVisible() {
    const bar = barRef.current;
    const fields = paymentRef.current?.querySelectorAll<HTMLElement>('[data-tender-amount]');
    const field = fields?.length ? fields[fields.length - 1] : null;
    if (!bar || !field) return;
    const over = field.getBoundingClientRect().bottom + 12 - bar.getBoundingClientRect().top;
    if (over > 0) window.scrollBy(0, over);
  }
  useEffect(() => {
    if (!checkout) return;
    const frame = window.requestAnimationFrame(keepAmountVisible);
    return () => window.cancelAnimationFrame(frame);
  }, [checkout, tenders.length, error]);
  // Starting the next bill closes the old sale's card.
  useEffect(() => {
    if (cart.length > 0) {
      setSaleDone(null);
      setSaleDoneSale(null);
    }
  }, [cart.length]);
  // A finished sale is announced and brought into view.
  useEffect(() => {
    if (!saleDone) return;
    saleDoneRef.current?.scrollIntoView?.({ block: 'start' });
    saleDoneRef.current?.focus?.({ preventScroll: true });
  }, [saleDone?.clientId]);
  // The result rows: matches while typing; recent items (else the first items) while the box is empty.
  const pickRows = useMemo(() => {
    if (itemQuery.trim()) return searchCatalogItems(items, itemQuery, 300);
    const byId = new Map(items.map((i) => [i.id, i]));
    const recent = recentIds.map((id) => byId.get(id)).filter((i): i is Item => !!i);
    return recent.length ? recent : items.slice(0, PICK_PAGE);
  }, [items, itemQuery, recentIds]);
  const pickShown = pickRows.slice(0, shownRows);
  const inBill = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of cart) if (!l.freeText) m.set(l.item.id, (m.get(l.item.id) ?? 0) + 1);
    return m;
  }, [cart]);
  // The spoken note changes with every add (a repeat tap says the new quantity), so it is announced again.
  const pickNote = lastAdded
    ? `Added ${lastAdded.name} (qty ${cart.find((l) => !l.freeText && l.item.id === lastAdded.id)?.qty ?? '?'})`
    : '';
  const pickIds = pickShown.map((i) => i.id).join(',');
  // Prices for the rows on screen only (cached; a price is never worked out here, see pickPrice).
  useEffect(() => {
    if (!shopId || !catalogReady) return;
    const t = window.setTimeout(() => {
      for (const id of pickIds.split(',')) {
        if (!id || pricesAsked.current.has(id)) continue;
        pricesAsked.current.add(id);
        void currentPrices(id).catch(() => pricesAsked.current.delete(id));
      }
    }, 120);
    return () => window.clearTimeout(t);
  }, [pickIds, shopId, catalogReady, listTick]);
  useEffect(() => {
    if (userId && shopId) setRecentIds(readRecent(userId, shopId));
  }, [userId, shopId]);
  const preview = useMemo(
    () =>
      cart.reduce((sum, l) => sum + lineGross(l.qty, l.unitPricePaise) - l.discountPaise, 0) -
      paise(globalDiscount) +
      paise(extra),
    [cart, globalDiscount, extra],
  );
  // salepricing: the same arithmetic as the server (GST added on top per item when chosen).
  const bill = useMemo(() => {
    try {
      return saleBillTotals(
        cart.map((l) => ({
          qty: l.qty,
          unitPricePaise: l.unitPricePaise,
          discountPaise: l.discountPaise,
          taxRateBp: l.item.tax_rate_bp ?? 0,
        })),
        {
          invoiceType,
          billDiscountPaise: invoiceType === 'gst_extra' ? 0 : paise(globalDiscount),
          extraChargesPaise: paise(extra),
        },
      );
    } catch {
      return null;
    }
  }, [cart, globalDiscount, extra, invoiceType]);
  // R0: the bill total is rounded to the nearest rupee (half up); item values stay exact.
  const previewRoundOff =
    invoiceType === 'gst_extra' && bill
      ? bill.roundOffPaise
      : preview > 0
        ? billRoundOff(preview)
        : 0;
  const previewTotal =
    invoiceType === 'gst_extra' && bill ? bill.totalPaise : Math.max(0, preview) + previewRoundOff;
  const gst = invoiceType === 'gst_extra' && bill ? splitGst(bill.taxPaise) : null;
  const selectedCustomer = customers.find((c) => c.id === customerId);
  const creditLimit = selectedCustomer?.sale_credit_limit_paise;
  const unpaidPaise = Math.max(0, previewTotal - tenderTotalOf(tenders));
  const outstandingPaise = customerId ? (balances[customerId] ?? 0) : 0;
  const overLimit =
    !!customerId &&
    typeof creditLimit === 'number' &&
    unpaidPaise > 0 &&
    outstandingPaise + unpaidPaise > creditLimit;
  const tenderTotal = useMemo(() => tenderTotalOf(tenders), [tenders]);
  // Changing the payment makes the last refusal out of date: take it off the screen.
  const editTenders = (change: (v: Tender[]) => Tender[]) => {
    setError('');
    setTenders(change);
  };
  // Bill options (invoice type, discount, extra charges, hold): closed on a phone unless something is set.
  const billDiscountPaise = safePaise(globalDiscount);
  const extraChargesPaise = safePaise(extra);
  const optionsNeedAction =
    invoiceType === 'gst_extra' ||
    billDiscountPaise > 0 ||
    extraChargesPaise > 0 ||
    Boolean(heldCleanup);
  const optionsSummary = [
    invoiceType === 'gst_extra' ? 'GST on top' : 'GST included',
    billDiscountPaise > 0 ? `discount ${money(billDiscountPaise)}` : '',
    extraChargesPaise > 0 ? `charges ${money(extraChargesPaise)}` : '',
    heldCleanup ? 'held cart needs cleanup' : 'hold a cart',
  ]
    .filter(Boolean)
    .join(' · ');

  async function currentPrices(itemId: string) {
    let prices;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      prices = await getOfflinePrices(itemId);
    } else {
      try {
        prices = await listCurrentPrices(itemId);
      } catch {
        prices = await getOfflinePrices(itemId);
      }
    }
    // The rows show the same figures the cart used (a fresh read replaces what a row showed).
    setRowPrices((m) => new Map(m).set(itemId, prices as PriceLite[]));
    return prices;
  }
  async function addLine(
    item: Item,
    unitLevel: 1 | 2 | 3,
    rawQty: string | number,
    priceKind: 'retail' | 'wholesale',
    discountPaise = 0,
    /** A tap on a list row: the same item/unit/price with no discount just gets one more. */
    merge = false,
  ): Promise<boolean> {
    const qty = canonicalQuantity(rawQty);
    const prices = await currentPrices(item.id);
    const chosen = pickPrice(prices, shopId, priceKind, unitLevel);
    if (!chosen) {
      // Owner decision 2026-10-20: an owner/manager types the price; a cashier cannot sell an unpriced item.
      if (canTypePrice) {
        setPendingPrice({ item, unitLevel, qty, priceKind, discountPaise });
        setPendingPriceInput('');
        setPendingSave(false);
        return false;
      }
      throw new Error(
        `No ${priceKind} price for ${item.name} / ${unitName(item, unitLevel)}. Ask the owner or a manager to enter a price.`,
      );
    }
    const line: CartLine = {
      item,
      unitLevel,
      qty,
      priceKind,
      unitPricePaise: chosen.price_paise,
      discountPaise,
      listPricePaise: chosen.price_paise,
    };
    setCart((v) => {
      if (merge) {
        // Decided inside the update so two quick taps both count (never two lines for one tap pair).
        const at = v.findIndex(
          (l) =>
            !l.freeText &&
            l.item.id === item.id &&
            l.unitLevel === unitLevel &&
            l.priceKind === priceKind &&
            l.priceSource === undefined &&
            l.discountPaise === 0 &&
            l.unitPricePaise === chosen.price_paise,
        );
        const sum = at >= 0 ? addQuantity(v[at]!.qty, qty) : null;
        if (at >= 0 && sum) return v.map((l, i) => (i === at ? { ...l, qty: sum } : l));
      }
      return [...v, line];
    });
    return true;
  }
  function confirmPendingPrice(ev: Event) {
    ev.preventDefault();
    if (!pendingPrice) return;
    const price = typedPricePaise(pendingPriceInput);
    if (price === null) {
      setError('Enter a price above zero in rupees, for example 120 or 120.50.');
      return;
    }
    setError('');
    const line: CartLine = {
      ...pendingPrice,
      unitPricePaise: price,
      priceSource: 'manual',
      listPricePaise: null,
      savePrice: pendingSave,
    };
    setCart((v) => [...v, line]);
    setPendingPrice(null);
  }
  // backlog (0070): an item that is not in the list. Owner/manager only (a typed price); no stock.
  function addFreeTextLine(ev: Event) {
    ev.preventDefault();
    const name = ftName.trim();
    if (!name || name.length > 120) {
      setError('Enter a name for the item (1 to 120 characters).');
      return;
    }
    let qty: string;
    try {
      qty = canonicalQuantity(ftQty);
      if (!(Number(qty) > 0)) throw new Error('qty');
    } catch {
      setError('Enter a quantity above zero.');
      return;
    }
    const price = typedPricePaise(ftPrice);
    if (price === null) {
      setError('Enter a price above zero in rupees, for example 120 or 120.50.');
      return;
    }
    setError('');
    setCart((v) => [
      ...v,
      {
        item: freeTextItem(name, ftGst),
        unitLevel: 1,
        qty,
        priceKind: 'retail',
        unitPricePaise: price,
        discountPaise: 0,
        priceSource: 'manual',
        listPricePaise: null,
        freeText: true,
      },
    ]);
    setFtName('');
    setFtQty('1');
    setFtPrice('');
  }
  function typeLinePrice(n: number, value: string) {
    const price = typedPricePaise(value);
    if (price === null) {
      setError('Enter a price above zero in rupees, for example 120 or 120.50.');
      return;
    }
    setError('');
    setCart((v) =>
      v.map((x, i) =>
        i !== n
          ? x
          : price === x.listPricePaise
            ? { ...x, unitPricePaise: price, priceSource: undefined, savePrice: false }
            : { ...x, unitPricePaise: price, priceSource: 'manual' },
      ),
    );
  }

  async function holdCartNow() {
    setError('');
    if (heldCleanup) {
      setError('Remove the previous held-cart copy before holding another cart.');
      return;
    }
    if (!cart.length) {
      setError('Add at least one item before holding.');
      return;
    }
    // A held cart keeps item, quantity and discount only; it would come back at list prices.
    if (cart.some((l) => l.priceSource === 'manual') || invoiceType === 'gst_extra') {
      setError(
        'A cart with typed prices or GST added on top cannot be held. Finalize it, or remove the typed prices and choose GST included.',
      );
      return;
    }
    try {
      // The field writes synchronously to tab-scoped storage so even a full
      // POS reconstruction during an async price lookup cannot lose it.
      await holdCurrentCart({
        label: readHoldLabelDraft(),
        customerId,
        globalDiscount,
        extra,
        lines: cart.map((l) => ({
          itemId: l.item.id,
          unitLevel: l.unitLevel,
          qty: l.qty,
          priceKind: l.priceKind,
          discountPaise: l.discountPaise,
        })),
      });
      setCart([]);
      setCheckout(false);
      setCustomerId('');
      setGlobalDiscount('0');
      setExtra('0');
      writeHoldLabelDraft('');
      setHoldLabelResetVersion((version) => version + 1);
      setSaleClientId(crypto.randomUUID());
      setHeldCarts(await listHeldCartsForShop());
      setMessage('Cart held. Start a new sale, or resume it later.');
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function resumeCart(id: string) {
    setError('');
    if (cart.length) {
      setError('Hold or clear the current cart before resuming another.');
      return;
    }
    if (resumeLock.current) return;
    resumeLock.current = true;
    const token = crypto.randomUUID();
    let claimed = false;
    setResumeBusyId(id);
    try {
      const record = await claimHeldCartForResume(id, token);
      if (!record) {
        setError('This held cart no longer exists.');
        return;
      }
      claimed = true;
      const candidate = await resolveHeldCart(record, {
        shopId,
        items,
        customerIds: new Set(customers.map((customer) => customer.id)),
        loadPrices: currentPrices,
      });
      setCustomerId(candidate.customerId);
      setGlobalDiscount(candidate.globalDiscount);
      setExtra(candidate.extra);
      setCart(candidate.lines.map((l) => ({ ...l, listPricePaise: l.unitPricePaise })));
      setHeldCleanup({ id, token });
      setMessage('Cart restored. Removing the held copy…');
    } catch (e) {
      if (claimed) await releaseHeldCartForResume(id, token).catch(() => false);
      setHeldCarts(await listHeldCartsForShop().catch(() => heldCarts));
      setError(errorText(e));
    } finally {
      resumeLock.current = false;
      setResumeBusyId('');
    }
  }
  async function retryHeldCleanup() {
    if (!heldCleanup) return;
    setError('');
    try {
      await completeHeldCartForResume(heldCleanup.id, heldCleanup.token);
      setHeldCleanup(null);
      setHeldCarts((current) => current.filter((cart) => cart.id !== heldCleanup.id));
      setMessage('Cart resumed and held copy removed.');
      void listHeldCartsForShop()
        .then(setHeldCarts)
        .catch(() => undefined);
    } catch (e) {
      setError(
        `Held-copy cleanup still failed; the active cart and held copy are both preserved: ${errorText(e)}`,
      );
    }
  }
  async function discardCart(id: string) {
    setError('');
    try {
      await discardHeldCartById(id);
      setHeldCarts(await listHeldCartsForShop());
    } catch (e) {
      setError(errorText(e));
    }
  }

  // One tap on a result row: quantity 1 in the row's unit (default: as the old Add), same price rules.
  async function tapAdd(item: Item) {
    setError('');
    try {
      const level = rowLevel[item.id] ?? defaultSellLevel(item);
      const added = await addLine(item, level, 1, pickKind, 0, true);
      if (added) {
        setLastAdded({ id: item.id, name: item.name });
        // Ready for the next search: on a desktop the text is selected so typing replaces it; on a phone
        // the keyboard is not raised.
        // Only while focus is still in the item area: the add finishes asynchronously and the cashier may
        // already be typing elsewhere (e.g. the hold label), which must never lose its keystrokes.
        const at = document.activeElement;
        const inItems =
          !at || at === document.body || !!document.getElementById('pos-items')?.contains(at);
        if (hasFinePointer() && inItems) {
          findRef.current?.focus({ preventScroll: true });
          findRef.current?.select();
        }
        setRecentIds((list) => {
          const next = pushRecent(list, item.id);
          if (userId && shopId) writeRecent(userId, shopId, next);
          return next;
        });
      }
    } catch (e) {
      setError(errorText(e));
    }
  }

  scanBlocked.current = busy || checkout || !!heldCleanup;

  async function scan(ev: Event) {
    ev.preventDefault();
    await scanCode(barcode);
  }

  async function scanCode(code: string, opts: { burst?: boolean } = {}) {
    // A scan may finish after the cashier moved on (finalizing, checkout, held-cart cleanup); never let it
    // change a cart that is being settled. Read the live state, not this render's closure.
    if (scanBlocked.current) return;
    setError('');
    try {
      let hit;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        hit = await findOfflineBarcode(code);
      } else {
        try {
          hit = await findItemByBarcode(code);
        } catch {
          hit = await findOfflineBarcode(code);
        }
      }
      if (!hit) {
        // A scanner burst may carry an exact SKU; nothing else is guessed. No match adds nothing.
        const wanted = code.trim().toLowerCase();
        const bySku =
          opts.burst && wanted ? items.filter((i) => i.sku?.trim().toLowerCase() === wanted) : [];
        if (bySku.length === 1) {
          if (scanBlocked.current) return;
          await addLine(bySku[0]!, defaultSellLevel(bySku[0]!), 1, 'retail');
          setBarcode('');
          return;
        }
        throw new Error(opts.burst ? `No item with code ${code}` : 'Barcode not found.');
      }
      const item = items.find((i) => i.id === hit.item_id);
      if (!item) throw new Error('Barcode item is unavailable.');
      if (scanBlocked.current) return;
      await addLine(item, hit.unit_level, 1, 'retail');
      setBarcode('');
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function finalizeSale() {
    if (busy) return;
    if (heldCleanup) {
      setError('Retry held-cart cleanup before finalizing this sale.');
      return;
    }
    if (!cart.length) {
      setError('Add at least one item.');
      return;
    }
    if (overLimit && !creditOverride) {
      setError(
        canTypePrice
          ? "This credit sale is over the customer's credit limit. Tick the override to allow it, or take more payment."
          : "This credit sale is over the customer's credit limit. Take more payment, or ask the owner or a manager.",
      );
      return;
    }
    if (invoiceType === 'gst_extra' && paise(globalDiscount) !== 0) {
      setError('A bill discount is not allowed when GST is added on top. Use item discounts.');
      return;
    }
    // Typed prices, GST added on top and any customer (credit limit) go through the new sale format.
    const needsV2 =
      invoiceType === 'gst_extra' || !!customerId || cart.some((l) => l.priceSource === 'manual');
    const plans: SalePricePlan[] = cart
      .filter((l) => l.priceSource === 'manual' && l.savePrice && !l.freeText)
      .map((l) => ({
        saleClientId,
        itemId: l.item.id,
        itemName: l.item.name,
        kind: l.priceKind,
        unitLevel: l.unitLevel,
        pricePaise: l.unitPricePaise,
      }));
    setBusy(true);
    setError('');
    const soldClientId = saleClientId;
    const soldCustomerId = customerId;
    const soldCustomerName = selectedCustomer?.name ?? null;
    // The numbers this sale was sent with; shown only if the saved copy cannot be read back.
    const sentTotalPaise = previewTotal;
    const sentPaidPaise = Math.min(tenderTotalOf(tenders), previewTotal);
    try {
      // Kept before sending: written only once this sale is confirmed (never for a rejected sale).
      addSalePricePlans(shopId, plans);
      const result = await finalizeSaleResilient({
        shopId,
        customerId: customerId || undefined,
        businessDate: await resolveBusinessDate(),
        discountPaise: paise(globalDiscount),
        extraChargesPaise: paise(extra),
        clientId: soldClientId,
        lines: cart.map((l) => ({
          itemId: l.item.id,
          unitLevel: l.unitLevel,
          qty: canonicalQuantity(l.qty),
          priceKind: l.priceKind,
          discountPaise: l.discountPaise,
          ...(l.priceSource === 'manual' ? { manualUnitPricePaise: l.unitPricePaise } : {}),
          ...(l.freeText ? { freeText: { name: l.item.name, taxRateBp: l.item.tax_rate_bp } } : {}),
        })),
        payments: tenders
          .filter((t) => paise(t.amount) > 0)
          .map((t) => ({ amountPaise: paise(t.amount), mode: t.mode })),
        ...(needsV2
          ? {
              saleV2: {
                invoiceType,
                creditOverride: creditOverride && canTypePrice,
                expectedTotalPaise: previewTotal,
              },
            }
          : {}),
      });
      const savedNote =
        result.kind === 'synced' && plans.length ? await savePlannedPrices(shopId) : '';
      // The device's own record of this sale (total + payments exactly as they were stored).
      const saved =
        (await listOfflineSales().catch(() => [] as OfflineSaleRecord[])).find(
          (r) => r.clientId === soldClientId,
        ) ?? null;
      const fallback = {
        totalPaise: sentTotalPaise,
        paidPaise: sentPaidPaise,
        balancePaise: Math.max(0, sentTotalPaise - sentPaidPaise),
      };
      const figures = saved ? figuresFromRecord(saved) : fallback;
      setMessage('');
      if (result.kind === 'synced') {
        setSaleDone({
          kind: 'synced',
          clientId: soldClientId,
          docNo: result.docNo,
          billCode: null,
          figures: { ...figures, confirmed: false },
          customerName: soldCustomerName,
          note: savedNote.trim(),
        });
        setSaleDoneSale({
          saleId: result.saleId,
          customerId: soldCustomerId,
          receipt: null,
          record: saved,
        });
        // The server's own invoice replaces the device copy (bill code, posted payments) when it arrives.
        void getSaleReceipt(result.saleId)
          .then((receipt) => {
            setSaleDone((cur) =>
              cur && cur.clientId === soldClientId
                ? {
                    ...cur,
                    billCode: receipt.invoice.bill_code ?? null,
                    figures: figuresFromReceipt(receipt),
                  }
                : cur,
            );
            setSaleDoneSale((cur) =>
              cur && cur.saleId === result.saleId ? { ...cur, receipt } : cur,
            );
          })
          .catch(() => undefined);
      } else {
        setSaleDone({
          kind: 'queued',
          clientId: soldClientId,
          docNo: result.provisionalDocNo,
          billCode: null,
          figures,
          customerName: soldCustomerName,
          note: plans.length ? 'The typed price is saved to the item after the sale syncs.' : '',
        });
        setSaleDoneSale({ saleId: '', customerId: soldCustomerId, receipt: null, record: saved });
      }
      setItemQuery('');
      setActiveId('');
      setBarcode('');
      setSaleClientId(crypto.randomUUID());
      setCart([]);
      setCheckout(false);
      setGlobalDiscount('0');
      setExtra('0');
      setTenders([{ mode: 'cash', amount: '' }]);
      setCreditOverride(false);
      setCreditRefused(false);
      setInvoiceType('gst_included');
      // The sale is done; a failed screen refresh must never look like a failed sale.
      await refresh().catch(() => undefined);
    } catch (e) {
      const text = errorText(e);
      if (/DSB_CREDIT_LIMIT_EXCEEDED/.test(text)) setCreditRefused(true);
      // A sale the server refused is final: the next attempt is a new sale (new request id).
      if (isDefinitiveFinancialRejectionMessage(text)) setSaleClientId(crypto.randomUUID());
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  /** "New sale": the old card, the old search text and any half-typed barcode go; the next sale starts clean. */
  function startNewSale() {
    setSaleDone(null);
    setSaleDoneSale(null);
    setItemQuery('');
    setActiveId('');
    setBarcode('');
    setMessage('');
    setError('');
    if (hasFinePointer()) window.setTimeout(() => findRef.current?.focus(), 0);
    else document.getElementById('pos-items')?.scrollIntoView?.({ block: 'start' });
  }
  async function printSaleDone() {
    if (!saleDone || !saleDoneSale) return;
    if (saleDone.kind === 'queued') {
      if (saleDoneSale.record) printLocalReceipt(saleDoneSale.record);
      return;
    }
    try {
      const receipt = saleDoneSale.receipt ?? (await getSaleReceipt(saleDoneSale.saleId));
      const prof = profile ?? (await loadShopProfile(shopId));
      setProfile(prof);
      setLocalReceipt(null);
      setPrintReceipt(receipt);
      window.setTimeout(() => window.print(), 50);
    } catch (e) {
      setError(e);
    }
  }
  async function saleDoneImage() {
    if (!saleDoneSale) throw new Error('Nothing to share.');
    const receipt = saleDoneSale.receipt ?? (await getSaleReceipt(saleDoneSale.saleId));
    const prof = await loadShopProfile(shopId);
    const customer = customers.find((c) => c.id === saleDoneSale.customerId);
    return saleInvoiceDoc(
      receipt,
      prof.profile,
      customer ? { name: customer.name, phone: customer.phone } : null,
    );
  }

  async function addCustomer(ev: Event) {
    ev.preventDefault();
    setError('');
    if (!tenantId) {
      setError('Shop data is still loading.');
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    try {
      const c = await createCustomer({
        tenantId,
        name: String(f.get('name')),
        phone: String(f.get('phone') || '') || undefined,
        clientId: crypto.randomUUID(),
      });
      setCustomers((v) => [...v, c].sort((a, b) => a.name.localeCompare(b.name)));
      setCustomerId(c.id);
      form.reset();
      setMessage(`Customer ${c.name} created.`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  // Shortcuts only move between views/fields. The one that acts, Ctrl+Enter, runs the Finalize button's own
  // handler (same checks, same busy guard) and only from the payment view, where the payment is on screen.
  function handlePosKeyDown(ev: KeyboardEvent) {
    const action = posShortcut(ev);
    if (!action) return;
    if (action === 'finalize') {
      // Not while a price is being asked for: Ctrl+Enter there must not post the sale behind the prompt.
      if (!checkout || pendingPrice || busy) return;
      ev.preventDefault();
      if (!ev.repeat) void finalizeSale();
      return;
    }
    if (action === 'cancel') {
      const target = ev.target as HTMLElement;
      if (isTypingField(target) || target.tagName === 'SELECT') {
        // First Esc only leaves the field (never cancels what was typed).
        target.blur();
        ev.preventDefault();
      } else if (pendingPrice) {
        ev.preventDefault();
        setPendingPrice(null);
      } else if (checkout) {
        ev.preventDefault();
        setCheckout(false);
      }
      return;
    }
    ev.preventDefault();
    if (action === 'payment') {
      setError('');
      setCheckout(!checkout);
      window.scrollTo(0, 0);
    } else if (action === 'customer') {
      setError('');
      setCheckout(true);
      window.setTimeout(() => customerRef.current?.focus(), 0);
    } else if (action === 'find') {
      setError('');
      setCheckout(false);
      window.setTimeout(() => findRef.current?.focus(), 0);
    }
  }
  // Listen on the document: when a view switch hides the focused field, focus falls to the page body and a
  // handler on <main> would no longer hear the keys. The ref keeps the handler current without re-binding.
  const keyHandler = useRef(handlePosKeyDown);
  keyHandler.current = handlePosKeyDown;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => keyHandler.current(ev);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // A hardware scanner types its code in a burst and ends with Enter, into whatever field has focus. Caught before
  // the field's own Enter handling (capture phase): the typed characters are taken back out of the field and the
  // code goes through the same scan path as the barcode box. Numeric quantity/price fields are never touched, and
  // nothing is intercepted while a sale is being settled. Slow human typing is left alone (Enter highlights, a
  // second Enter adds).
  const burst = useRef(createBurstDetector());
  const scanRef = useRef(scanCode);
  scanRef.current = scanCode;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const field = ev.target;
      // Only the Find-product field and the Barcode box: other text fields (hold label, customer, modals) are
      // never read as scans.
      if (!isScanTarget(field) || (field !== findRef.current && field !== barcodeRef.current)) {
        burst.current.reset();
        return;
      }
      const code = burst.current.onKey(ev, field);
      if (!code || scanBlocked.current) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      // Take the burst back out of the field (anything typed before it stays), as if it was never typed.
      const before = field.value.endsWith(code) ? field.value.slice(0, -code.length) : field.value;
      field.value = before;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      void scanRef.current(code, { burst: true });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  // Up/Down in the search move along the result rows; Enter adds the highlighted row (else the top match)
  // as one tap would. Adding never posts a sale.
  function findKeyDown(ev: KeyboardEvent) {
    if (ev.isComposing || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!pickShown.length) return;
      ev.preventDefault();
      const at = stepIndex(
        pickShown.findIndex((i) => i.id === activeId),
        pickShown.length,
        ev.key,
      );
      const id = pickShown[at]!.id;
      setActiveId(id);
      document.getElementById(`pick-${id}`)?.scrollIntoView?.({ block: 'nearest' });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      // A held Enter auto-repeats: each add needs its own key press.
      if (ev.repeat) return;
      // Two steps, so nothing unseen is ever added (a scanner burst typed into this box ends in Enter):
      // Enter adds ONLY a highlighted row; with none, it just highlights the top match (visible).
      const row = pickShown.find((i) => i.id === activeId);
      if (row) void tapAdd(row);
      else if (itemQuery.trim() && pickShown[0]) {
        setActiveId(pickShown[0].id);
        document.getElementById(`pick-${pickShown[0].id}`)?.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }
  function printLocalReceipt(sale: OfflineSaleRecord) {
    // Uses the profile loaded (or read from cache) when POS opened; never waits on the network.
    setPrintReceipt(null);
    setLocalReceipt(sale);
    window.setTimeout(() => window.print(), 0);
  }
  async function reviewMismatch(clientId: string) {
    await reviewOfflineSaleMismatch(clientId);
    setOfflineSales(await listOfflineSales());
  }

  if (!catalogReady)
    return (
      <main class="page wide">
        <p role="status">Loading billing catalog…</p>
      </main>
    );

  async function receivePayment(ev: Event) {
    ev.preventDefault();
    if (busy || !paymentCustomer) return;
    setBusy(true);
    setError('');
    try {
      await recordCustomerPayment({
        shopId,
        customerId: paymentCustomer,
        businessDate: await resolveBusinessDate(),
        amountPaise: paise(paymentAmount),
        mode: paymentMode,
        clientId: paymentClientId,
      });
      setPaymentClientId(crypto.randomUUID());
      setMessage('Customer payment recorded.');
      setPaymentAmount('');
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="page wide pos-page">
      <p>
        <a href={appRoute.home}>← Home</a> ·{' '}
        <a
          href={appRoute.sync}
          onClick={(e) => {
            e.preventDefault();
            route(appRoute.sync);
          }}
        >
          Sync & offline
        </a>
      </p>
      <h1>Sales POS</h1>
      <p class="muted">Add items, review your bill, then enter the payment.</p>
      <div class="pos-overview no-print" aria-label="Bill summary">
        <div>
          <small>
            {cart.length} item{cart.length === 1 ? '' : 's'} in bill
          </small>
          <strong>{money(previewTotal)}</strong>
        </div>
        <button
          class="primary checkout-link"
          type="button"
          title="Shortcut: F4"
          aria-keyshortcuts="F4"
          onClick={() => {
            setError('');
            setCheckout(!checkout);
            window.scrollTo(0, 0);
          }}
        >
          {checkout ? '← Back to items' : 'Review payment →'}
        </button>
      </div>
      <p class="muted shortcut-hint no-print">
        <kbd>F2</kbd> customer · <kbd>F3</kbd> find · <kbd>F4</kbd> items/payment · <kbd>Esc</kbd>{' '}
        back · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> finalize
      </p>
      <details class="keyboard-help">
        <summary>
          <strong>Keyboard map</strong>
        </summary>
        <p>
          <kbd>Enter</kbd> submits the focused scan/item form · <kbd>Tab</kbd> moves through billing
          fields · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> finalizes the current sale (payment view only).
        </p>
        <p>
          <kbd>F2</kbd> customer · <kbd>F3</kbd> find product · <kbd>F4</kbd> items / payment ·{' '}
          <kbd>Esc</kbd> leave the field, then go back. In the search box <kbd>↑</kbd>
          <kbd>↓</kbd> choose an item, <kbd>Enter</kbd> pick, <kbd>Enter</kbd> add.
        </p>
      </details>
      {error && !checkout && (
        <p role="alert" aria-live="assertive" class="alert banner danger" ref={errorRef}>
          {error.text}
          {error.code && <small class="error-code">Code: {error.code}</small>}
        </p>
      )}
      {message && (
        <p role="status" class="success">
          {message}
        </p>
      )}
      {saleDone && !checkout && (
        <SaleDoneCard
          info={saleDone}
          cardRef={saleDoneRef}
          onNewSale={startNewSale}
          onClose={() => {
            setSaleDone(null);
            setSaleDoneSale(null);
          }}
          onPrint={
            saleDone.kind === 'synced' || saleDoneSale?.record
              ? () => void printSaleDone()
              : undefined
          }
          share={
            saleDone.kind === 'synced' && saleDoneSale?.saleId ? (
              <ShareImageButton build={saleDoneImage} />
            ) : undefined
          }
        />
      )}

      <section
        class="card pos-items"
        id="pos-items"
        data-catalog-count={items.length}
        hidden={checkout}
      >
        <h2>Find products</h2>
        <div class="pick-search">
          <input
            ref={findRef}
            class="pick-input"
            type="text"
            enterKeyHint="search"
            autoComplete="off"
            aria-label="Find product"
            aria-controls="pos-pick-list"
            aria-activedescendant={activeId ? `pick-${activeId}` : undefined}
            value={itemQuery}
            onKeyDown={findKeyDown}
            placeholder="Search by name or SKU"
            onInput={(e) => {
              setItemQuery((e.currentTarget as HTMLInputElement).value);
              setActiveId('');
              setShownRows(PICK_PAGE);
            }}
          />
          {itemQuery && (
            <button
              type="button"
              class="pick-clear"
              aria-label="Clear search"
              onClick={() => {
                setItemQuery('');
                setActiveId('');
                setShownRows(PICK_PAGE);
                findRef.current?.focus();
              }}
            >
              ×
            </button>
          )}
        </div>
        <div class="pick-tools">
          <div class="pick-kind" role="group" aria-label="Price type">
            {(['retail', 'wholesale'] as const).map((k) => (
              <button
                type="button"
                key={k}
                aria-pressed={pickKind === k}
                onClick={() => setPickKind(k)}
              >
                {k === 'retail' ? 'Retail' : 'Wholesale'}
              </button>
            ))}
          </div>
          <small class="pick-hint">↑ ↓ move, Enter adds</small>
        </div>
        <p class="pick-head muted" id="pos-pick-head">
          {itemQuery.trim()
            ? pickRows.length
              ? `${pickRows.length >= 300 ? '300+' : pickRows.length} matching ${pickRows.length === 1 ? 'item' : 'items'}`
              : ''
            : recentIds.length && pickRows.length
              ? 'Recent items'
              : 'Items'}
        </p>
        <p class="sr-only" role="status" aria-live="polite">
          {pickNote}
        </p>
        {!catalogReady ? (
          <p class="muted">Loading items…</p>
        ) : pickRows.length === 0 ? (
          <p class="pick-empty" role="status">
            {itemQuery.trim()
              ? `No item matches “${itemQuery.trim()}”. Check the spelling, try the SKU or scan the barcode.`
              : 'No items yet. Add items in Stock first.'}
          </p>
        ) : (
          <ul class="pick-list" id="pos-pick-list" aria-labelledby="pos-pick-head">
            {pickShown.map((i) => {
              const level = rowLevel[i.id] ?? defaultSellLevel(i);
              const unit = unitName(i, level);
              const prices = rowPrices.get(i.id);
              const price = prices ? pickPrice(prices, shopId, pickKind, level) : undefined;
              const stock = stockMap ? (stockMap.get(i.id) ?? 0) : null;
              const state = stockState(stock, i.min_stock ?? 0);
              const levels = [1, i.unit2 ? 2 : 0, i.unit3 ? 3 : 0].filter(Boolean) as (1 | 2 | 3)[];
              const count = inBill.get(i.id) ?? 0;
              return (
                <li
                  key={i.id}
                  id={`pick-${i.id}`}
                  class={`pick-row${activeId === i.id ? ' active' : ''}`}
                >
                  <button
                    type="button"
                    class="pick-main"
                    aria-label={`Add ${i.name}`}
                    aria-describedby={`pick-info-${i.id}`}
                    onClick={() => {
                      setActiveId(i.id);
                      void tapAdd(i);
                    }}
                  >
                    <span class="pick-text">
                      <span class="pick-name">{i.name}</span>
                      <span class="pick-sub" id={`pick-info-${i.id}`}>
                        {[
                          i.sku,
                          `per ${unit}`,
                          stock === null
                            ? ''
                            : `${formatQuantity(stock) || '0'} ${i.unit1} in stock`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {(state || count > 0) && (
                        <span class="pick-chips">
                          {state === 'out' && <span class="chip danger">Out of stock</span>}
                          {state === 'low' && <span class="chip warning">Low stock</span>}
                          {count > 0 && <span class="chip success">In bill</span>}
                        </span>
                      )}
                    </span>
                    <span class="pick-price">
                      {price ? money(price.price_paise) : prices ? 'No price' : '…'}
                    </span>
                  </button>
                  {levels.length > 1 && (
                    <div class="pick-units" role="group" aria-label={`Unit for ${i.name}`}>
                      {levels.map((lv) => (
                        <button
                          type="button"
                          key={lv}
                          aria-pressed={level === lv}
                          onClick={() => setRowLevel((m) => ({ ...m, [i.id]: lv }))}
                        >
                          {unitName(i, lv)}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {pickRows.length > pickShown.length && (
          <button
            type="button"
            class="pick-more"
            onClick={() => setShownRows((n) => n + PICK_MORE)}
          >
            Show more ({pickRows.length - pickShown.length} more)
          </button>
        )}
        <form onSubmit={scan} class="row pick-barcode">
          <label>
            Barcode{' '}
            <input
              ref={barcodeRef}
              value={barcode}
              onInput={(e) => setBarcode((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <button>Scan / Add</button>
          <CameraScanner
            disabled={busy || checkout || !!heldCleanup}
            onCode={(code) => void scanCode(code)}
          />
        </form>
        {canTypePrice && (
          <details class="optional-control">
            <summary>Add an item that is not in the list</summary>
            <form class="inline-form" aria-label="Other thing" onSubmit={addFreeTextLine}>
              <label>
                What is it{' '}
                <input
                  aria-label="Other thing name"
                  maxLength={120}
                  value={ftName}
                  onInput={(e) => setFtName((e.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <label>
                How many{' '}
                <input
                  aria-label="Other thing count"
                  type="number"
                  inputMode="decimal"
                  min="0.000001"
                  step="0.000001"
                  value={ftQty}
                  onInput={(e) => setFtQty((e.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <label>
                Rate per unit ₹{' '}
                <input
                  aria-label="Other thing rate ₹"
                  inputMode="decimal"
                  value={ftPrice}
                  onInput={(e) => setFtPrice((e.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <label>
                Tax rate{' '}
                <select
                  aria-label="Other thing tax rate"
                  value={String(ftGst)}
                  onChange={(e) => setFtGst(Number((e.currentTarget as HTMLSelectElement).value))}
                >
                  {FREE_TEXT_GST_BP.map((bp) => (
                    <option key={bp} value={String(bp)}>
                      {bp / 100}%
                    </option>
                  ))}
                </select>
              </label>
              <button>Add to bill</button>
              <small>No stock is kept for it. It cannot be returned later.</small>
            </form>
          </details>
        )}
        {pendingPrice && (
          <form class="price-prompt" aria-label="Enter a price" onSubmit={confirmPendingPrice}>
            <p>
              <strong>{pendingPrice.item.name}</strong> has no {pendingPrice.priceKind} price for{' '}
              {unitName(pendingPrice.item, pendingPrice.unitLevel)}. Enter the price for this sale.
            </p>
            <label>
              Price ₹ per {unitName(pendingPrice.item, pendingPrice.unitLevel)}{' '}
              <input
                autofocus
                aria-label="Price for this sale ₹"
                inputMode="decimal"
                value={pendingPriceInput}
                onInput={(e) => setPendingPriceInput((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={pendingSave}
                onChange={(e) => setPendingSave((e.currentTarget as HTMLInputElement).checked)}
              />{' '}
              Save as this item's sale price
            </label>
            <button class="primary">Use this price</button>{' '}
            <button type="button" onClick={() => setPendingPrice(null)}>
              Cancel
            </button>
          </form>
        )}
      </section>

      <section class="card pos-cart" id="pos-cart" hidden={checkout}>
        <h2>Current bill</h2>
        {!cart.length ? (
          <p key="cart-lines" class="muted">
            Cart is empty.
          </p>
        ) : (
          <div key="cart-lines" class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Discount</th>
                  <th>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cart.map((l, n) => (
                  <tr>
                    <td data-label="Item" class="cart-item-name">
                      {l.item.name}
                      <small>
                        {unitName(l.item, l.unitLevel)} · {l.priceKind}
                      </small>
                    </td>
                    <td data-label="Quantity">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0.000001"
                        step="0.000001"
                        value={l.qty}
                        aria-label={`Cart qty for ${l.item.name}`}
                        onInput={(e) => {
                          const qty = (e.currentTarget as HTMLInputElement).value;
                          setCart((v) => v.map((x, i) => (i === n ? { ...x, qty } : x)));
                        }}
                      />
                    </td>
                    <td data-label="Price">
                      {canTypePrice && editingPrice === n ? (
                        <input
                          autofocus
                          type="number"
                          inputMode="decimal"
                          min="0.01"
                          step="0.01"
                          defaultValue={(l.unitPricePaise / 100).toFixed(2)}
                          aria-label={`Price for ${l.item.name}`}
                          onChange={(e) => {
                            typeLinePrice(n, (e.currentTarget as HTMLInputElement).value);
                            setEditingPrice(null);
                          }}
                          onBlur={() => setEditingPrice(null)}
                        />
                      ) : (
                        <>
                          {money(l.unitPricePaise)}
                          {canTypePrice && (
                            <button
                              type="button"
                              class="link-button"
                              aria-label="Change price"
                              onClick={() => setEditingPrice(n)}
                            >
                              Change
                            </button>
                          )}
                        </>
                      )}
                      {l.freeText ? (
                        <small class="typed-price">
                          Not in the item list · GST {l.item.tax_rate_bp / 100}% · no stock
                        </small>
                      ) : (
                        l.priceSource === 'manual' && (
                          <small class="typed-price">
                            Typed price
                            {l.listPricePaise != null
                              ? ` · list ${money(l.listPricePaise)}`
                              : ' · no list price'}
                            <label>
                              <input
                                type="checkbox"
                                checked={!!l.savePrice}
                                aria-label="Save as sale price"
                                onChange={(e) => {
                                  const savePrice = (e.currentTarget as HTMLInputElement).checked;
                                  setCart((v) =>
                                    v.map((x, i) => (i === n ? { ...x, savePrice } : x)),
                                  );
                                }}
                              />{' '}
                              Save as this item's sale price
                            </label>
                          </small>
                        )
                      )}
                    </td>
                    <td data-label="Discount ₹">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={(l.discountPaise / 100).toFixed(2)}
                        aria-label={`Discount for ${l.item.name}`}
                        onInput={(e) => {
                          const discountPaise = paise((e.currentTarget as HTMLInputElement).value);
                          if (Number.isFinite(discountPaise) && discountPaise >= 0)
                            setCart((v) =>
                              v.map((x, i) => (i === n ? { ...x, discountPaise } : x)),
                            );
                        }}
                      />
                    </td>
                    <td data-label="Total" class="cart-line-total">
                      {invoiceType === 'gst_extra' && bill
                        ? money(bill.lines[n].lineTotalPaise)
                        : money(lineGross(l.qty, l.unitPricePaise) - l.discountPaise)}
                      {invoiceType === 'gst_extra' && bill ? (
                        <small>
                          incl. GST {money(bill.lines[n].taxPaise)} @{' '}
                          {(l.item.tax_rate_bp ?? 0) / 100}%
                        </small>
                      ) : null}
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => setCart((v) => v.filter((_, i) => i !== n))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div hidden={checkout}>
        <HomeRow
          name="pos-bill-options"
          title="Bill options"
          label="Bill options"
          userId={userId}
          class="no-print"
          count={null}
          tone="neutral"
          summary={optionsSummary}
          defaultOpen={!phone}
          forceOpen={optionsNeedAction}
        >
          <div key="cart-totals" class="row">
            <label>
              Invoice type{' '}
              <select
                aria-label="Invoice type"
                value={invoiceType}
                onChange={(e) => {
                  const next = (e.currentTarget as HTMLSelectElement).value as SaleInvoiceType;
                  setInvoiceType(next);
                  if (next === 'gst_extra') setGlobalDiscount('0');
                }}
              >
                <option value="gst_included">GST included in prices</option>
                <option value="gst_extra">GST added on top</option>
              </select>
            </label>
            <label>
              Invoice discount ₹{' '}
              <input
                disabled={invoiceType === 'gst_extra'}
                title={
                  invoiceType === 'gst_extra'
                    ? 'Use item discounts when GST is added on top.'
                    : undefined
                }
                value={globalDiscount}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                onInput={(e) => setGlobalDiscount((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label>
              Extra charges ₹{' '}
              <input
                value={extra}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                onInput={(e) => setExtra((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            {gst && (
              <span data-testid="gst-extra-summary">
                GST {money(bill!.taxPaise)} (CGST {money(gst.cgstPaise)} + SGST{' '}
                {money(gst.sgstPaise)}) ·{' '}
              </span>
            )}
            {invoiceType === 'gst_extra' &&
              cart.some((l) => !l.freeText && !(l.item.tax_rate_bp ?? 0)) && (
                <p role="alert" class="alert" data-testid="gst-zero-warning">
                  GST 0%:{' '}
                  {[
                    ...new Set(
                      cart
                        .filter((l) => !l.freeText && !(l.item.tax_rate_bp ?? 0))
                        .map((l) => l.item.name),
                    ),
                  ].join(', ')}{' '}
                  {cart.filter((l) => !l.freeText && !(l.item.tax_rate_bp ?? 0)).length === 1
                    ? 'has'
                    : 'have'}{' '}
                  no GST rate, so no GST is added. Set the item GST % in Stock → Items if this is
                  wrong.
                </p>
              )}
            {previewRoundOff !== 0 && (
              <span>
                Round off {previewRoundOff > 0 ? '+' : '−'}
                {money(Math.abs(previewRoundOff))} ·{' '}
              </span>
            )}
            <strong>Preview {money(previewTotal)}</strong>
          </div>
          <div key="hold-actions" class="row">
            <label>
              Hold label <HoldLabelField key={holdLabelResetVersion} />
            </label>
            <button
              type="button"
              disabled={!cart.length || Boolean(heldCleanup)}
              onClick={() => void holdCartNow()}
            >
              Hold cart
            </button>
            {heldCleanup && (
              <button type="button" onClick={() => void retryHeldCleanup()}>
                Retry held-cart cleanup
              </button>
            )}
          </div>
        </HomeRow>
      </div>
      {heldCarts.length > 0 && (
        <section class="card" aria-label="Held carts" hidden={checkout}>
          <h2>Held carts</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Items</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {heldCarts.map((h) => (
                  <tr key={h.id}>
                    <td>{h.label}</td>
                    <td>{h.lines.length}</td>
                    <td>
                      <button
                        type="button"
                        disabled={Boolean(resumeBusyId)}
                        aria-label={`Resume ${h.label}`}
                        onClick={() => void resumeCart(h.id)}
                      >
                        {resumeBusyId === h.id ? 'Resuming…' : 'Resume'}
                      </button>{' '}
                      <button
                        type="button"
                        disabled={Boolean(resumeBusyId) || heldCleanup?.id === h.id}
                        onClick={() => void discardCart(h.id)}
                      >
                        Discard
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section class="card pos-payment" id="pos-payment" hidden={!checkout} ref={paymentRef}>
        <h2>Customer & payment</h2>
        <p class="payment-total">
          Bill total <strong>{money(previewTotal)}</strong>
          {gst ? ` · includes GST ${money(bill!.taxPaise)} added on top` : ''}
        </p>
        <label>
          Customer{' '}
          <select
            ref={customerRef}
            value={customerId}
            onChange={(e) => {
              setCustomerId((e.currentTarget as HTMLSelectElement).value);
              setError('');
              setCreditOverride(false);
              setCreditRefused(false);
            }}
          >
            <option value="">Walk-in</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {balances[c.id] ? ` · balance ${money(balances[c.id])}` : ''}
              </option>
            ))}
          </select>
        </label>
        <details class="optional-control">
          <summary>Add a new customer</summary>
          <form onSubmit={addCustomer} class="row">
            <label>
              Quick customer <input name="name" placeholder="Name" required />
            </label>
            <label>
              Phone <input name="phone" placeholder="Phone" />
            </label>
            <button>Create & select</button>
          </form>
        </details>
        {tenders.map((t, n) => (
          <div class="row">
            <label>
              Mode{' '}
              <select
                value={t.mode}
                onChange={(e) =>
                  editTenders((v) =>
                    v.map((x, i) =>
                      i === n
                        ? {
                            ...x,
                            mode: (e.currentTarget as HTMLSelectElement).value as Tender['mode'],
                          }
                        : x,
                    ),
                  )
                }
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank">Bank</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Amount ₹{' '}
              <input
                data-tender-amount
                value={t.amount}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                onInput={(e) =>
                  editTenders((v) =>
                    v.map((x, i) =>
                      i === n ? { ...x, amount: (e.currentTarget as HTMLInputElement).value } : x,
                    ),
                  )
                }
              />
            </label>
            {n > 0 && (
              <button type="button" onClick={() => editTenders((v) => v.filter((_, i) => i !== n))}>
                Remove tender
              </button>
            )}
          </div>
        ))}
        {(overLimit || (creditRefused && !!customerId)) && (
          <div role="alert" class="alert credit-warning" data-testid="credit-limit-warning">
            <p>
              Over credit limit
              {typeof creditLimit === 'number' ? (
                <>
                  : {selectedCustomer?.name} owes {money(outstandingPaise)}, this bill adds{' '}
                  {money(unpaidPaise)} on credit, limit {money(creditLimit)}.
                </>
              ) : (
                ' (the server refused this credit sale).'
              )}
            </p>
            {canTypePrice ? (
              <label>
                <input
                  type="checkbox"
                  checked={creditOverride}
                  onChange={(e) => setCreditOverride((e.currentTarget as HTMLInputElement).checked)}
                />{' '}
                Allow this credit sale anyway (owner/manager override, recorded with the sale)
              </label>
            ) : (
              <p>Take more payment, or ask the owner or a manager.</p>
            )}
          </div>
        )}
        <div class="row">
          <button
            type="button"
            onClick={() => editTenders((v) => [...v, { mode: 'upi', amount: '' }])}
          >
            + Split tender
          </button>
        </div>
        <div class="checkout-actions" ref={barRef}>
          {error && (
            <p role="alert" aria-live="assertive" class="bar-error" ref={errorRef}>
              {error.text}
              {error.code && <small class="error-code">Code: {error.code}</small>}
            </p>
          )}
          <div class="checkout-entered">
            <small>Entered</small>
            <strong>{money(tenderTotal)}</strong>
          </div>
          <button
            class="primary"
            type="button"
            disabled={busy || !cart.length || Boolean(heldCleanup)}
            onClick={() => void finalizeSale()}
          >
            {busy ? 'Saving…' : 'Finalize sale'}
          </button>
        </div>
      </section>

      <div hidden={checkout}>
        <HomeRow
          name="pos-customer-payment"
          title="Customer payment / advance"
          userId={userId}
          class="no-print"
          count={null}
          tone="neutral"
          summary="Record money a customer paid"
          defaultOpen={!phone}
          forceOpen={Boolean(paymentCustomer || paymentAmount)}
        >
          <form onSubmit={receivePayment} class="grid-form">
            <label>
              Customer{' '}
              <select
                value={paymentCustomer}
                onChange={(e) => setPaymentCustomer((e.currentTarget as HTMLSelectElement).value)}
                required
              >
                <option value="">Choose…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount ₹{' '}
              <input
                value={paymentAmount}
                onInput={(e) => setPaymentAmount((e.currentTarget as HTMLInputElement).value)}
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                required
              />
            </label>
            <label>
              Mode{' '}
              <select
                value={paymentMode}
                onChange={(e) =>
                  setPaymentMode((e.currentTarget as HTMLSelectElement).value as Tender['mode'])
                }
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank">Bank</option>
                <option value="other">Other</option>
              </select>
            </label>
            <button disabled={busy}>Record payment</button>
          </form>
        </HomeRow>
      </div>

      {offlineSales.length > 0 && (
        <HomeRow
          name="pos-offline-sales"
          title="Saved on this device"
          label="Local offline sales"
          userId={userId}
          class="no-print"
          count={offlineSales.length}
          tone={offlineSales.some((s) => s.status !== 'SYNCED') ? 'warning' : 'neutral'}
          summary={`${offlineSales.filter((s) => s.status !== 'SYNCED').length} not synced`}
          forceOpen={offlineSales.some((s) => saleStateLabel(s) === 'needs review')}
        >
          <div class="table-wrap mobile-records">
            <table>
              <thead>
                <tr>
                  <th>Sale</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Invoice</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {offlineSales.map((s) => {
                  const state = saleStateLabel(s);
                  return (
                    <tr key={s.clientId}>
                      <td class="record-title">
                        {friendlySaleName(s)}
                        <small class="muted" title={s.provisionalDocNo}>
                          {' '}
                          ref {s.provisionalDocNo.slice(0, 10)}
                        </small>
                        {s.reconciliationWarning && !s.reconciliationReviewedAt ? (
                          <small role="alert">
                            Totals changed after sync:{' '}
                            {s.provisionalTotals
                              ? money(s.provisionalTotals.totalPaise) + ' → '
                              : ''}
                            {money(s.totalPaise)}{' '}
                            <button type="button" onClick={() => void reviewMismatch(s.clientId)}>
                              Mark reviewed
                            </button>
                          </small>
                        ) : null}
                      </td>
                      <td data-label="Status">
                        <span
                          class={`badge ${state === 'synced' ? 'success' : state === 'waiting' ? 'warning' : 'danger'}`}
                        >
                          {state}
                        </span>
                      </td>
                      <td data-label="Total" class="num">
                        {money(s.totalPaise)}
                      </td>
                      <td data-label="Invoice">{s.officialDocNo ?? 'Numbered after sync'}</td>
                      <td>
                        <button type="button" onClick={() => printLocalReceipt(s)}>
                          Print provisional
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </HomeRow>
      )}
      {localReceipt && (
        <article
          class={`receipt-print receipt-thermal${profile?.profile?.printerWidth === '58mm' ? ' receipt-w58' : ''}`}
          aria-label="provisional offline receipt"
        >
          <ReceiptHeader load={profile}>
            <p>
              <strong>
                {localReceipt.status === 'QUEUED'
                  ? 'PROVISIONAL — PENDING SYNC'
                  : 'PROVISIONAL RECORD — SYNCED'}
              </strong>
              <br />
              Number {localReceipt.provisionalDocNo}
              {localReceipt.officialDocNo ? (
                <>
                  <br />
                  Official {localReceipt.officialDocNo}
                </>
              ) : null}
              <br />
              Date {localReceipt.businessDate}
            </p>
          </ReceiptHeader>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Rate</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {localReceipt.lines.map((l) => (
                <tr>
                  <td>
                    {l.itemName}
                    <small>{l.unitName}</small>
                  </td>
                  <td>{formatQuantity(l.qty)}</td>
                  <td data-label="Price">{receiptMoney(l.unitPricePaise)}</td>
                  <td>{receiptMoney(l.lineTotalPaise - (l.taxPaise ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl class="receipt-totals">
            <div>
              <dt>
                {localReceipt.invoiceType === 'gst_extra' ? 'Subtotal (before GST)' : 'Subtotal'}
              </dt>
              <dd>{receiptMoney(localReceipt.subtotalPaise - (localReceipt.taxPaise ?? 0))}</dd>
            </div>
            {localReceipt.discountPaise > 0 && (
              <div>
                <dt>Discount</dt>
                <dd>−{receiptMoney(localReceipt.discountPaise)}</dd>
              </div>
            )}
            {localReceipt.invoiceType === 'gst_extra' && (
              <>
                <div>
                  <dt>CGST</dt>
                  <dd>{receiptMoney(splitGst(localReceipt.taxPaise ?? 0).cgstPaise)}</dd>
                </div>
                <div>
                  <dt>SGST</dt>
                  <dd>{receiptMoney(splitGst(localReceipt.taxPaise ?? 0).sgstPaise)}</dd>
                </div>
              </>
            )}
            {localReceipt.extraChargesPaise > 0 && (
              <div>
                <dt>Extra charges</dt>
                <dd>{receiptMoney(localReceipt.extraChargesPaise)}</dd>
              </div>
            )}
            {(localReceipt.roundOffPaise ?? 0) !== 0 && (
              <div>
                <dt>Round off</dt>
                <dd>
                  {(localReceipt.roundOffPaise ?? 0) > 0 ? '+' : '−'}
                  {receiptMoney(Math.abs(localReceipt.roundOffPaise ?? 0))}
                </dd>
              </div>
            )}
            <div>
              <dt>Total</dt>
              <dd>
                <strong>{receiptMoney(localReceipt.totalPaise)}</strong>
              </dd>
            </div>
          </dl>
          {localReceipt.reconciliationWarning && (
            <p role="alert">
              <strong>Reconciled:</strong> {localReceipt.reconciliationWarning}
            </p>
          )}
          <h2>Payments</h2>
          {localReceipt.payments.length ? (
            <ul>
              {localReceipt.payments.map((p) => (
                <li>
                  {p.mode.toUpperCase()} {receiptMoney(p.amountPaise)}
                  {p.reference ? ' · ' + p.reference : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p>Credit / unpaid</p>
          )}
          {localReceipt.status === 'QUEUED' && (
            <footer>
              <p>
                <strong>
                  Provisional receipt — not an official invoice until this sale syncs successfully.
                </strong>
              </p>
            </footer>
          )}
        </article>
      )}
      {printReceipt && (
        <SaleReceiptPrint receipt={printReceipt} profile={profile} printMode="thermal" />
      )}
      <div hidden={checkout}>
        <HomeRow
          name="pos-recent-invoices"
          title="Recent invoices"
          userId={userId}
          class="no-print"
          count={sales.length}
          tone="neutral"
          summary={sales[0] ? `${sales[0].doc_no} · ${money(sales[0].total_paise)}` : 'None yet'}
          defaultOpen={!phone}
        >
          <div class="print-area">
            <div class="row no-print">
              <button type="button" onClick={() => window.print()}>
                Print list
              </button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th class="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr>
                    <td>{s.doc_no}</td>
                    <td>{s.business_date}</td>
                    <td>{s.status}</td>
                    <td class="num">{money(s.total_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </HomeRow>
      </div>
    </main>
  );
}
