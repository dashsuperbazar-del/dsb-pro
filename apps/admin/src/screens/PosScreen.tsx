import { HomeRow } from '../components/HomeRow';
import { useUserId } from '../lib/useUserId';
import { formatQuantity } from '@dsb-pro/core';
import { CameraScanner } from '../components/CameraScanner';
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
  createCustomer,
  findItemByBarcode,
  getShopBusinessDate,
  listCurrentPrices,
  listCustomerBalances,
  listCustomers,
  listItems,
  listRecentSales,
  recordCustomerPayment,
  type Customer,
  type Item,
  type SaleInvoice,
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
import { loadShopProfile, type ProfileLoad } from '../lib/shopProfile';
import { addSalePricePlans, flushSalePricePlans, type SalePricePlan } from '../lib/salePricePlans';

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
const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const paise = (rupees: string) => parseRupeesToPaise(rupees || '0');
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
/** Server codes stay in the log; the counter sees the sentence. */
const plainError = (e: unknown) =>
  String(e)
    .replace(/^Error: /, '')
    .replace(/DSB_[A-Z_]+: /, '');

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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [barcode, setBarcode] = useState('');
  const [itemQuery, setItemQuery] = useState('');
  const [manualItemId, setManualItemId] = useState('');
  const [manualUnitLevel, setManualUnitLevel] = useState<1 | 2 | 3>(1);
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
  // The item whose manual add is in flight: Enter pressed again for the SAME item while its price lookup
  // runs must not add it twice (another item may still be added meanwhile).
  const addingManual = useRef<string | null>(null);
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
      setError(`The sale is saved, but a sale price was not: ${plainError(e)}`);
      return '';
    }
  }
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
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
  const manualItem = items.find((i) => i.id === manualItemId);
  const visibleItems = useMemo(() => searchCatalogItems(items, itemQuery, 50), [items, itemQuery]);
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
    return prices;
  }
  async function addLine(
    item: Item,
    unitLevel: 1 | 2 | 3,
    rawQty: string | number,
    priceKind: 'retail' | 'wholesale',
    discountPaise = 0,
  ): Promise<boolean> {
    const qty = canonicalQuantity(rawQty);
    const prices = await currentPrices(item.id);
    const matching = prices.filter((p) => p.kind === priceKind && p.unit_level === unitLevel);
    const chosen =
      matching.find((p) => p.shop_id === shopId) ?? matching.find((p) => p.shop_id === null);
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
    setCart((v) => [
      ...v,
      {
        item,
        unitLevel,
        qty,
        priceKind,
        unitPricePaise: chosen.price_paise,
        discountPaise,
        listPricePaise: chosen.price_paise,
      },
    ]);
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
      setError(String(e));
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
      setError(String(e));
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
        `Held-copy cleanup still failed; the active cart and held copy are both preserved: ${String(e)}`,
      );
    }
  }
  async function discardCart(id: string) {
    setError('');
    try {
      await discardHeldCartById(id);
      setHeldCarts(await listHeldCartsForShop());
    } catch (e) {
      setError(String(e));
    }
  }

  async function addManual(ev: Event) {
    ev.preventDefault();
    setError('');
    const addForm = ev.currentTarget as HTMLFormElement;
    const f = new FormData(addForm);
    const item = items.find((i) => i.id === String(f.get('itemId')));
    if (!item || addingManual.current === item.id) return;
    addingManual.current = item.id;
    try {
      const added = await addLine(
        item,
        manualUnitLevel,
        String(f.get('qty')),
        String(f.get('priceKind')) as 'retail' | 'wholesale',
        paise(String(f.get('lineDiscount') || '0')),
      );
      // Ready for the next product: back to the search box with its text selected (typing replaces it).
      // Only when focus is still in this form: the price lookup is async and the cashier may have moved on.
      const at = document.activeElement;
      // The choice is cleared so a second Enter (or a held key) picks again instead of adding the item twice.
      if (added) setManualItemId('');
      if (added && (!at || at === document.body || addForm.contains(at))) {
        findRef.current?.focus();
        findRef.current?.select();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (addingManual.current === item.id) addingManual.current = null;
    }
  }

  scanBlocked.current = busy || checkout || !!heldCleanup;

  async function scan(ev: Event) {
    ev.preventDefault();
    await scanCode(barcode);
  }

  async function scanCode(code: string) {
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
      if (!hit) throw new Error('Barcode not found.');
      const item = items.find((i) => i.id === hit.item_id);
      if (!item) throw new Error('Barcode item is unavailable.');
      if (scanBlocked.current) return;
      await addLine(item, hit.unit_level, 1, 'retail');
      setBarcode('');
    } catch (e) {
      setError(String(e));
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
    try {
      // Kept before sending: written only once this sale is confirmed (never for a rejected sale).
      addSalePricePlans(shopId, plans);
      const result = await finalizeSaleResilient({
        shopId,
        customerId: customerId || undefined,
        businessDate: await resolveBusinessDate(),
        discountPaise: paise(globalDiscount),
        extraChargesPaise: paise(extra),
        clientId: saleClientId,
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
      setMessage(
        result.kind === 'synced'
          ? `Sale finalized: ${result.docNo}.${savedNote}`
          : `Saved locally as ${result.provisionalDocNo}. It will sync automatically when the backend is reachable.${plans.length ? ' The typed price is saved to the item after the sale syncs.' : ''}`,
      );
      setSaleClientId(crypto.randomUUID());
      setCart([]);
      setCheckout(false);
      setGlobalDiscount('0');
      setExtra('0');
      setTenders([{ mode: 'cash', amount: '' }]);
      setCreditOverride(false);
      setCreditRefused(false);
      setInvoiceType('gst_included');
      await refresh();
    } catch (e) {
      const text = String(e);
      if (/DSB_CREDIT_LIMIT_EXCEEDED/.test(text)) setCreditRefused(true);
      // A sale the server refused is final: the next attempt is a new sale (new request id).
      if (isDefinitiveFinancialRejectionMessage(text)) setSaleClientId(crypto.randomUUID());
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
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
      setError(String(e));
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
      setCheckout(!checkout);
      window.scrollTo(0, 0);
    } else if (action === 'customer') {
      setCheckout(true);
      window.setTimeout(() => customerRef.current?.focus(), 0);
    } else if (action === 'find') {
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
  // Up/Down in the product search move the choice in the Item list; Enter picks the first match, and
  // Enter again (with a choice) adds it. Adding is the form's own submit, never a sale post.
  function findKeyDown(ev: KeyboardEvent) {
    if (ev.isComposing || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!visibleItems.length) return;
      ev.preventDefault();
      const at = stepIndex(
        visibleItems.findIndex((i) => i.id === manualItemId),
        visibleItems.length,
        ev.key,
      );
      const item = visibleItems[at]!;
      setManualItemId(item.id);
      setManualUnitLevel(item.unit3 ? 3 : item.unit2 ? 2 : 1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      // A held Enter auto-repeats: ignore the repeats (no pick, no add); each add needs its own key press.
      if (ev.repeat) return;
      if (manualItemId && visibleItems.some((i) => i.id === manualItemId)) {
        (ev.currentTarget as HTMLInputElement).form?.requestSubmit();
      } else if (visibleItems.length) {
        const item = visibleItems[0]!;
        setManualItemId(item.id);
        setManualUnitLevel(item.unit3 ? 3 : item.unit2 ? 2 : 1);
      }
    }
  }
  function printLocalReceipt(sale: OfflineSaleRecord) {
    // Uses the profile loaded (or read from cache) when POS opened; never waits on the network.
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
      setError(String(e));
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
      {error && (
        <p role="alert" class="alert">
          {error}
        </p>
      )}
      {message && (
        <p role="status" class="success">
          {message}
        </p>
      )}

      <section class="card pos-items" id="pos-items" hidden={checkout}>
        <h2>Find products</h2>
        <form onSubmit={scan} class="row">
          <label>
            Barcode{' '}
            <input
              autofocus
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
        <form onSubmit={addManual} class="grid-form">
          <label>
            Find product{' '}
            <input
              ref={findRef}
              value={itemQuery}
              onKeyDown={findKeyDown}
              placeholder="Name or SKU"
              onInput={(e) => {
                setItemQuery((e.currentTarget as HTMLInputElement).value);
                setManualItemId('');
              }}
            />
          </label>
          <label>
            Item{' '}
            <select
              name="itemId"
              aria-label="Item"
              required
              value={manualItemId}
              onChange={(e) => {
                const id = (e.currentTarget as HTMLSelectElement).value;
                setManualItemId(id);
                const item = items.find((i) => i.id === id);
                setManualUnitLevel(item?.unit3 ? 3 : item?.unit2 ? 2 : 1);
              }}
            >
              <option value="">Choose…</option>
              {visibleItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.sku ? ` · ${i.sku}` : ''}
                </option>
              ))}
            </select>
            <small>
              Showing up to 50 matches from {items.length} items. In the search box: ↑ ↓ choose,
              Enter to pick, Enter again to add.
            </small>
          </label>
          <label>
            Unit{' '}
            <select
              name="unitLevel"
              value={manualUnitLevel}
              disabled={!manualItem}
              onChange={(e) =>
                setManualUnitLevel(
                  Number((e.currentTarget as HTMLSelectElement).value) as 1 | 2 | 3,
                )
              }
            >
              <option value="1">{manualItem?.unit1 || 'Unit 1'}</option>
              {manualItem?.unit2 && <option value="2">{manualItem.unit2}</option>}
              {manualItem?.unit3 && <option value="3">{manualItem.unit3}</option>}
            </select>
          </label>
          <label>
            Quantity{' '}
            <input
              key="pos-add-quantity"
              data-testid="pos-add-quantity"
              name="qty"
              type="number"
              inputMode="decimal"
              min="0.000001"
              step="0.000001"
              value="1"
              required
            />
          </label>
          <label>
            Price{' '}
            <select name="priceKind">
              <option value="retail">Retail</option>
              <option value="wholesale">Wholesale</option>
            </select>
          </label>
          <label>
            Discount ₹{' '}
            <input
              name="lineDiscount"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value="0"
            />
          </label>
          <button>Add item</button>
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
              GST {money(bill!.taxPaise)} (CGST {money(gst.cgstPaise)} + SGST {money(gst.sgstPaise)}
              ) ·{' '}
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
      </section>
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

      <section class="card pos-payment" id="pos-payment" hidden={!checkout}>
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
                  setTenders((v) =>
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
                value={t.amount}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                onInput={(e) =>
                  setTenders((v) =>
                    v.map((x, i) =>
                      i === n ? { ...x, amount: (e.currentTarget as HTMLInputElement).value } : x,
                    ),
                  )
                }
              />
            </label>
            {n > 0 && (
              <button type="button" onClick={() => setTenders((v) => v.filter((_, i) => i !== n))}>
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
        <div class="row checkout-actions">
          <button
            type="button"
            onClick={() => setTenders((v) => [...v, { mode: 'upi', amount: '' }])}
          >
            + Split tender
          </button>
          <span>Entered {money(tenderTotal)}</span>
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

      <section class="card" hidden={checkout}>
        <h2>Customer payment / advance</h2>
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
      </section>

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
          forceOpen={offlineSales.some(
            (s) => s.reconciliationWarning && !s.reconciliationReviewedAt,
          )}
        >
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provisional</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Official</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {offlineSales.map((s) => (
                  <tr>
                    <td>
                      {s.provisionalDocNo}
                      {s.reconciliationWarning && !s.reconciliationReviewedAt ? (
                        <small role="alert">
                          Totals changed after sync:{' '}
                          {s.provisionalTotals ? money(s.provisionalTotals.totalPaise) + ' → ' : ''}
                          {money(s.totalPaise)}{' '}
                          <button type="button" onClick={() => void reviewMismatch(s.clientId)}>
                            Mark reviewed
                          </button>
                        </small>
                      ) : null}
                    </td>
                    <td>{s.status}</td>
                    <td>{money(s.totalPaise)}</td>
                    <td>{s.officialDocNo ?? '—'}</td>
                    <td>
                      <button type="button" onClick={() => printLocalReceipt(s)}>
                        Print provisional
                      </button>
                    </td>
                  </tr>
                ))}
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
                  <td data-label="Price">{money(l.unitPricePaise)}</td>
                  <td>{money(l.lineTotalPaise - (l.taxPaise ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl class="receipt-totals">
            <div>
              <dt>
                {localReceipt.invoiceType === 'gst_extra' ? 'Subtotal (before GST)' : 'Subtotal'}
              </dt>
              <dd>{money(localReceipt.subtotalPaise - (localReceipt.taxPaise ?? 0))}</dd>
            </div>
            {localReceipt.discountPaise > 0 && (
              <div>
                <dt>Discount</dt>
                <dd>−{money(localReceipt.discountPaise)}</dd>
              </div>
            )}
            {localReceipt.invoiceType === 'gst_extra' && (
              <>
                <div>
                  <dt>CGST</dt>
                  <dd>{money(splitGst(localReceipt.taxPaise ?? 0).cgstPaise)}</dd>
                </div>
                <div>
                  <dt>SGST</dt>
                  <dd>{money(splitGst(localReceipt.taxPaise ?? 0).sgstPaise)}</dd>
                </div>
              </>
            )}
            {localReceipt.extraChargesPaise > 0 && (
              <div>
                <dt>Extra charges</dt>
                <dd>{money(localReceipt.extraChargesPaise)}</dd>
              </div>
            )}
            {(localReceipt.roundOffPaise ?? 0) !== 0 && (
              <div>
                <dt>Round off</dt>
                <dd>
                  {(localReceipt.roundOffPaise ?? 0) > 0 ? '+' : '−'}
                  {money(Math.abs(localReceipt.roundOffPaise ?? 0))}
                </dd>
              </div>
            )}
            <div>
              <dt>Total</dt>
              <dd>
                <strong>{money(localReceipt.totalPaise)}</strong>
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
                  {p.mode.toUpperCase()} {money(p.amountPaise)}
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
      <section class="card print-area" hidden={checkout}>
        <div class="row no-print">
          <h2>Recent invoices</h2>
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
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr>
                <td>{s.doc_no}</td>
                <td>{s.business_date}</td>
                <td>{s.status}</td>
                <td>{money(s.total_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
