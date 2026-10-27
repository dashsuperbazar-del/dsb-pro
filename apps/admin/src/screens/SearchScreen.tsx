import { errorText } from '../lib/friendlyError';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  findBillsByCode,
  getSupplierOutstanding,
  listCustomerBalances,
  listCustomers,
  listItems,
  listParties,
  listPurchaseHistory,
  listRecentSales,
  listRetailPrices,
  listStock,
  type BillCodeHit,
  type ItemPrice,
  type PurchaseRecord,
  type SaleInvoice,
} from '@dsb-pro/adapters';
import { formatQuantity } from '@dsb-pro/core';
import { rupees } from '../lib/money';
import { currentPricePaise } from '../lib/billSalePrices';
import { ResultGroup, type ResultRowData } from '../components/ResultGroup';
import { appRoute } from '../lib/paths';
import { readCatalogForScreen, catalogDirtySince } from '../lib/catalogRead';
import { shopContext } from '../lib/shopContext';
import { getOfflineCustomers, getSyncedOfflineCatalog } from '../lib/offlineSync';
import {
  GLOBAL_SEARCH_LIMIT,
  searchBills,
  searchEverything,
  type SearchBill,
  type SearchData,
  type SearchItem,
  type SearchParty,
} from '../lib/globalSearch';

// One box over what this device can already show: items (device catalog, same trust rules as Inventory),
// customers, and suppliers (owner/manager), plus purchase bills (owner/manager/accountant) and sale
// invoices, read page by page from the existing list adapters once the user searches. Results open the
// screen that owns the record (a bill or invoice opens its detail). Nothing here writes; a list that could
// not be loaded is named, never silently treated as "no match".
const PURCHASE_PAGE = 50;
const SALES_PAGE = 100;
const DEBOUNCE_MS = 250;
const PAGE_MORE = 20;
const RECENT_MAX = 5;
const recentKey = (userId: string) => `dsb-pro:recent-searches:${userId || 'anon'}`;
function readRecent(userId: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(recentKey(userId)) ?? '[]');
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}
function writeRecent(userId: string, list: string[]) {
  try {
    localStorage.setItem(recentKey(userId), JSON.stringify(list));
  } catch {
    /* recent searches are a convenience only */
  }
}
// Status as stored → chip (never invented: an unknown status is shown as it is).
function statusChip(status: string | null | undefined): ResultRowData['chip'] {
  switch ((status ?? '').toUpperCase()) {
    case '':
      return undefined;
    case 'POSTED':
    case 'FINALIZED':
      return { label: 'Posted', tone: 'success' };
    case 'VOID':
      return { label: 'Void', tone: 'danger' };
    case 'DRAFT':
      return { label: 'Draft', tone: 'warning' };
    case 'QUEUED':
      return { label: 'Queued', tone: 'warning' };
    default:
      return { label: status as string, tone: '' };
  }
}
// Figures shown beside matches, read once the user searches (never on load). A read that fails leaves
// that figure out; it never shows a guess.
type Figures = {
  stockLoaded: boolean;
  customersLoaded: boolean;
  suppliersLoaded: boolean;
  stock: Map<string, number>;
  prices: Map<string, ItemPrice[]>;
  customerBalance: Map<string, string>;
  supplierOwed: Map<string, string>;
  failed: Set<string>;
};
type BillLists = {
  purchases: PurchaseRecord[];
  purchasesMore: boolean;
  sales: SaleInvoice[];
  salesMore: boolean;
  supplierNames: Map<string, string>;
  failed: string[];
};
export function SearchScreen() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<SearchData>({ items: [], customers: [], suppliers: [] });
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [role, setRole] = useState('');
  const alive = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const [debounced, setDebounced] = useState('');
  const [shopId, setShopId] = useState('');
  const [userId, setUserId] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [shown, setShown] = useState<Record<string, number>>({});
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({});
  const [figures, setFigures] = useState<Figures>({
    stockLoaded: false,
    customersLoaded: false,
    suppliersLoaded: false,
    stock: new Map(),
    prices: new Map(),
    customerBalance: new Map(),
    supplierOwed: new Map(),
    failed: new Set(),
  });
  const figureKinds = useRef(new Set<string>());
  const pricesAsked = useRef(new Set<string>());
  const [bills, setBills] = useState<BillLists | null>(null);
  const [billsBusy, setBillsBusy] = useState(false);
  const billsStarted = useRef(false);
  // Bills whose bill code contains the query, read from the server over the whole history (0069).
  const [codeHits, setCodeHits] = useState<{
    query: string;
    hits: BillCodeHit[];
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);
  const canSeePurchases = ['owner', 'manager', 'accountant'].includes(role);
  async function loadBills(more: boolean) {
    if (!shopId) return;
    setBillsBusy(true);
    const prev = more ? bills : null;
    try {
      const [p, sl, names] = await Promise.allSettled([
        canSeePurchases && (!prev || prev.purchasesMore)
          ? listPurchaseHistory(shopId, prev?.purchases.length ?? 0)
          : Promise.resolve([] as PurchaseRecord[]),
        !prev || prev.salesMore
          ? listRecentSales(shopId, (prev?.sales.length ?? 0) + SALES_PAGE)
          : Promise.resolve(prev.sales),
        prev
          ? Promise.resolve(prev.supplierNames)
          : canSeePurchases
            ? (data.suppliers.length ? Promise.resolve(data.suppliers) : listParties()).then(
                (list) => new Map(list.map((x) => [x.id, x.name])),
              )
            : Promise.resolve(new Map<string, string>()),
      ]);
      if (!alive.current) return;
      const failed: string[] = [];
      const purchasePage = p.status === 'fulfilled' ? p.value : [];
      if (p.status === 'rejected') failed.push('purchase bills');
      if (sl.status === 'rejected') failed.push('sale invoices');
      const sales = sl.status === 'fulfilled' ? sl.value : (prev?.sales ?? []);
      setBills({
        // Offset pages can shift when a bill is posted meanwhile: keep each bill once.
        purchases: [
          ...(prev?.purchases ?? []),
          ...purchasePage.filter((b) => !prev?.purchases.some((x) => x.id === b.id)),
        ],
        purchasesMore:
          canSeePurchases &&
          (p.status === 'rejected'
            ? Boolean(prev?.purchasesMore)
            : purchasePage.length === PURCHASE_PAGE),
        sales,
        salesMore:
          sl.status === 'fulfilled'
            ? sl.value.length === (prev?.sales.length ?? 0) + SALES_PAGE
            : Boolean(prev?.salesMore),
        supplierNames: names.status === 'fulfilled' ? names.value : new Map(),
        failed,
      });
    } finally {
      if (alive.current) setBillsBusy(false);
    }
  }
  // A bill code (4+ characters) is looked up on the server so an old bill is found too. A failure only
  // leaves the bills already loaded above; it never hides them.
  useEffect(() => {
    const query = debounced.trim();
    if (!shopId || query.replace(/[^A-Za-z0-9]/g, '').length < 4) {
      setCodeHits(null);
      return;
    }
    let live = true;
    findBillsByCode(shopId, query)
      .then((hits) => live && setCodeHits({ query, hits }))
      .catch(() => live && setCodeHits({ query, hits: [], failed: true }));
    return () => {
      live = false;
    };
  }, [debounced, shopId]);
  // Bills are read only once someone searches (debounced), never on every keystroke.
  useEffect(() => {
    if (debounced.trim().length >= 2 && shopId && !billsStarted.current) {
      billsStarted.current = true;
      void loadBills(false);
    }
  }, [debounced, shopId]);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const { membership, session, shopId: shop } = await shopContext.get();
        const canSeeSuppliers = membership.role === 'owner' || membership.role === 'manager';
        const [items, customers, suppliers] = await Promise.allSettled([
          readCatalogForScreen<SearchItem>({
            device: async () => {
              const device = await getSyncedOfflineCatalog({ notBefore: catalogDirtySince() });
              if (!device) return null;
              if (device.tenantId !== membership.tenantId || device.userId !== session.user.id)
                return null;
              return device.items as unknown as SearchItem[];
            },
            server: async () => (await listItems()) as SearchItem[],
          }).then((r) => r.items),
          listCustomers().catch(async () => (await getOfflineCustomers()) as SearchParty[]),
          canSeeSuppliers ? listParties() : Promise.resolve([] as SearchParty[]),
        ]);
        if (!alive.current) return;
        const missing: string[] = [];
        if (items.status === 'rejected') missing.push('items');
        if (customers.status === 'rejected') missing.push('customers');
        if (suppliers.status === 'rejected') missing.push('suppliers');
        setData({
          items: items.status === 'fulfilled' ? items.value : [],
          customers: customers.status === 'fulfilled' ? customers.value : [],
          suppliers: suppliers.status === 'fulfilled' ? suppliers.value : [],
        });
        setNotes(missing);
        setRole(membership.role);
        setUserId(session.user.id);
        setRecent(readRecent(session.user.id));
        setShopId(shop);
      } catch (e) {
        if (alive.current) setError(errorText(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  const limitFor = (k: string) => shown[k] ?? GLOBAL_SEARCH_LIMIT;
  const r = searchEverything(debounced, data, {
    items: limitFor('items'),
    customers: limitFor('customers'),
    suppliers: limitFor('suppliers'),
  });
  const searched = debounced.trim().length >= 2;
  const customerNames = new Map(data.customers.map((c) => [c.id, c.name]));
  const supplierNames = new Map(data.suppliers.map((x) => [x.id, x.name] as [string, string]));
  const fromCode = codeHits && codeHits.query === debounced.trim() ? codeHits.hits : [];
  const loadedPurchases = (bills?.purchases ?? []).map((b): SearchBill => ({
    id: b.id,
    number: b.bill_no,
    code: b.bill_code,
    partyName: (b.party_id && bills?.supplierNames.get(b.party_id)) || '',
    date: b.business_date,
    totalPaise: b.total_paise,
    status: b.status,
  }));
  const loadedSales = (bills?.sales ?? []).map((x): SearchBill => ({
    id: x.id,
    number: x.doc_no,
    code: x.bill_code,
    partyName: (x.customer_id && customerNames.get(x.customer_id)) || 'Walk-in',
    date: x.business_date,
    totalPaise: x.total_paise,
    status: x.status,
  }));
  // Older bills found only by the server's code search are added once each.
  const extra = (kind: 'purchase' | 'sale', loaded: SearchBill[]): SearchBill[] =>
    fromCode
      .filter((h) => h.kind === kind && !loaded.some((b) => b.id === h.id))
      .map((h) => ({
        id: h.id,
        number: h.doc_no,
        code: h.bill_code,
        partyName:
          (h.party_id &&
            (kind === 'purchase'
              ? (bills?.supplierNames.get(h.party_id) ?? supplierNames.get(h.party_id))
              : customerNames.get(h.party_id))) ||
          (kind === 'sale' ? 'Walk-in' : ''),
        date: h.business_date,
        totalPaise: h.total_paise,
        status: h.status,
      }));
  const purchaseHits = searchBills(
    debounced,
    [...loadedPurchases, ...extra('purchase', loadedPurchases)],
    limitFor('purchases'),
  );
  const saleHits = searchBills(
    debounced,
    [...loadedSales, ...extra('sale', loadedSales)],
    limitFor('sales'),
  );
  const total =
    r.items.length +
    r.customers.length +
    r.suppliers.length +
    purchaseHits.rows.length +
    saleHits.rows.length;

  // A new query starts from the first page and the default open group.
  useEffect(() => {
    setShown({});
    setOpenOverride({});
  }, [debounced]);

  // Figures beside matches: read lazily, only for what is matched, once each. A failed read leaves
  // that figure out (and says so); nothing is guessed.
  const itemIdsKey = r.items.map((i) => i.id).join(',');
  const hasCustomers = r.customers.length > 0;
  const hasSuppliers = r.suppliers.length > 0;
  useEffect(() => {
    if (!shopId || !searched) return;
    const fail = (what: string) =>
      alive.current && setFigures((f) => ({ ...f, failed: new Set(f.failed).add(what) }));
    if (itemIdsKey && !figureKinds.current.has('stock')) {
      figureKinds.current.add('stock');
      listStock(shopId)
        .then(
          (rows) =>
            alive.current &&
            setFigures((f) => ({
              ...f,
              stock: new Map(rows.map((x) => [x.item_id, Number(x.qty_base)])),
              stockLoaded: true,
            })),
        )
        .catch(() => fail('stock'));
    }
    const missing = itemIdsKey.split(',').filter((id) => id && !pricesAsked.current.has(id));
    if (missing.length) {
      missing.forEach((id) => pricesAsked.current.add(id));
      listRetailPrices(missing)
        .then(
          (rows) =>
            alive.current &&
            setFigures((f) => {
              const prices = new Map(f.prices);
              for (const id of missing)
                prices.set(
                  id,
                  rows.filter((p) => p.item_id === id),
                );
              return { ...f, prices };
            }),
        )
        .catch(() => fail('prices'));
    }
    if (hasCustomers && !figureKinds.current.has('customers')) {
      figureKinds.current.add('customers');
      listCustomerBalances()
        .then(
          (rows) =>
            alive.current &&
            setFigures((f) => ({
              ...f,
              customerBalance: new Map(rows.map((x) => [x.customer_id, String(x.balance_paise)])),
              customersLoaded: true,
            })),
        )
        .catch(() => fail('balances'));
    }
    if (hasSuppliers && role !== 'cashier' && !figureKinds.current.has('suppliers')) {
      figureKinds.current.add('suppliers');
      getSupplierOutstanding(shopId)
        .then(
          (rows) =>
            alive.current &&
            setFigures((f) => ({
              ...f,
              supplierOwed: new Map(rows.map((x) => [x.partyId, x.netLedgerBalance])),
              suppliersLoaded: true,
            })),
        )
        .catch(() => fail('balances'));
    }
  }, [shopId, searched, itemIdsKey, hasCustomers, hasSuppliers, role]);

  function remember(text: string) {
    const t = text.trim();
    if (t.length < 2) return;
    const next = [t, ...recent.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(
      0,
      RECENT_MAX,
    );
    setRecent(next);
    writeRecent(userId, next);
  }
  const showMore = (k: string) => setShown((m) => ({ ...m, [k]: limitFor(k) + PAGE_MORE }));

  const itemRows: ResultRowData[] = r.items.map((i) => {
    const level: 1 | 2 | 3 = i.unit3 ? 3 : i.unit2 ? 2 : 1;
    const unit = i.unit3 || i.unit2 || i.unit1 || '';
    const priceRows = figures.prices.get(i.id);
    const price = priceRows ? currentPricePaise(priceRows, shopId, 'retail', level) : null;
    const priceText = priceRows
      ? price === null
        ? 'No price set'
        : `${rupees(price)}${unit ? ` / ${unit}` : ''}`
      : '';
    // stock_current has no row for an item that was never stocked: that is zero, as in Inventory's list.
    const qty = figures.stockLoaded ? (figures.stock.get(i.id) ?? 0) : null;
    const low = qty !== null && (i.min_stock ?? 0) > 0 && qty <= (i.min_stock ?? 0);
    return {
      id: i.id,
      href: appRoute.inventory,
      title: i.name,
      secondary: [i.sku || 'No SKU', priceText].filter(Boolean),
      value: qty === null ? '' : `${formatQuantity(qty) || '0'}${unit ? ` ${unit}` : ''}`,
      valueSub: qty === null ? '' : 'in stock',
      chip: low ? { label: 'Low stock', tone: 'warning' } : undefined,
    };
  });
  const balanceRow = (
    id: string,
    name: string,
    phone: string | null | undefined,
    href: string,
    loaded: boolean,
    raw: string | undefined,
    words: [string, string],
  ): ResultRowData => {
    // No ledger row yet = nothing owed either way.
    const n = loaded ? BigInt(raw ?? '0') : null;
    return {
      id,
      href,
      title: name,
      secondary: phone ? [phone] : [],
      value: n === null ? '' : rupees((n < 0n ? -n : n).toString()),
      valueSub: n === null ? '' : n === 0n ? 'settled' : n > 0n ? words[0] : words[1],
    };
  };
  const customerRows = r.customers.map((c) =>
    balanceRow(
      c.id,
      c.name,
      c.phone,
      appRoute.customers,
      figures.customersLoaded,
      figures.customerBalance.get(c.id),
      ['owes you', 'advance'],
    ),
  );
  const supplierRows = r.suppliers.map((x) =>
    balanceRow(
      x.id,
      x.name,
      x.phone,
      appRoute.suppliers,
      figures.suppliersLoaded,
      figures.supplierOwed.get(x.id),
      ['you owe', 'advance paid'],
    ),
  );
  const billRows = (rows: SearchBill[], href: (id: string) => string): ResultRowData[] =>
    rows.map((b) => ({
      id: b.id,
      href: href(b.id),
      title: b.number || b.code || 'No number',
      secondary: [b.number && b.code ? b.code : '', b.partyName || 'Unknown', b.date].filter(
        Boolean,
      ),
      value: rupees(b.totalPaise),
      chip: statusChip(b.status),
    }));
  const groups = [
    { key: 'items', title: 'Items', total: r.itemsTotal, rows: itemRows },
    { key: 'customers', title: 'Customers', total: r.customersTotal, rows: customerRows },
    { key: 'suppliers', title: 'Suppliers', total: r.suppliersTotal, rows: supplierRows },
    {
      key: 'purchases',
      title: 'Purchase bills',
      total: purchaseHits.total,
      rows: billRows(
        purchaseHits.rows,
        (id) => `${appRoute.purchases}?bill=${encodeURIComponent(id)}`,
      ),
    },
    {
      key: 'sales',
      title: 'Sale invoices',
      total: saleHits.total,
      rows: billRows(
        saleHits.rows,
        (id) => `${appRoute.salesHistory}?sale=${encodeURIComponent(id)}`,
      ),
    },
  ].filter((g) => g.rows.length > 0);
  const firstKey = groups[0]?.key;
  return (
    <main class="page wide search-page">
      <p>
        <a href={appRoute.home}>← Home</a>
      </p>
      <h1>Search</h1>
      <form
        class="search-box"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          remember(q);
        }}
      >
        <label>
          <span class="sr-only">
            Search items, customers{role === 'cashier' ? '' : ', suppliers'}, bills and invoices
          </span>
          <input
            ref={inputRef}
            type="search"
            autoFocus
            autoComplete="off"
            placeholder="Name, SKU, phone, bill no. or amount"
            value={q}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
        </label>
        {q && (
          <button
            type="button"
            class="search-clear"
            aria-label="Clear search"
            onClick={() => {
              setQ('');
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </form>
      <p class="muted search-hint">Bill codes work too, e.g. K7M2-QX9P.</p>
      {!q && recent.length > 0 && (
        <div class="shortcut-chips" role="group" aria-label="Recent searches">
          {recent.map((x) => (
            <button type="button" key={x} onClick={() => setQ(x)}>
              {x}
            </button>
          ))}
          <button
            type="button"
            class="ghost"
            onClick={() => {
              setRecent([]);
              writeRecent(userId, []);
            }}
          >
            Clear recent
          </button>
        </div>
      )}
      {loading && <p class="muted">Loading…</p>}
      {error && (
        <p role="alert" class="alert">
          Search could not load: {error}
        </p>
      )}
      {notes.length > 0 && (
        <p role="alert" class="alert">
          Could not load {notes.join(', ')}. Results below leave those out.
        </p>
      )}
      {codeHits?.failed && codeHits.query === debounced.trim() && (
        <p role="alert" class="alert">
          Could not search older bills by code. Results below leave them out.
        </p>
      )}
      {!searched && !loading && <p class="muted">Type at least two characters.</p>}
      {searched && !loading && !billsBusy && total === 0 && <p class="empty-state">No matches.</p>}
      {searched && billsBusy && <p class="muted">Searching bills and invoices…</p>}
      {bills && bills.failed.length > 0 && (
        <p role="alert" class="alert">
          Could not load {bills.failed.join(', ')}. Results below leave those out.
        </p>
      )}
      {figures.failed.size > 0 && (
        <p class="muted" data-testid="search-figures-note">
          Some figures (stock, price or balance) could not be loaded and are left out.
        </p>
      )}
      {groups.map((g) => (
        <ResultGroup
          key={g.key}
          title={g.title}
          total={g.total}
          rows={g.rows}
          open={openOverride[g.key] ?? g.key === firstKey}
          onToggle={() =>
            setOpenOverride((m) => ({ ...m, [g.key]: !(m[g.key] ?? g.key === firstKey) }))
          }
          onOpen={() => remember(q)}
          onMore={g.total > g.rows.length ? () => showMore(g.key) : undefined}
          moreCount={g.total - g.rows.length}
        />
      ))}
      {searched && bills && (
        <p class="muted" data-testid="bill-search-scope">
          Searched the latest{' '}
          {canSeePurchases ? `${bills.purchases.length} purchase bills and ` : ''}
          {bills.sales.length} sale invoices.{' '}
          {(bills.purchasesMore || bills.salesMore) && (
            <button type="button" disabled={billsBusy} onClick={() => void loadBills(true)}>
              Search older bills
            </button>
          )}
        </p>
      )}
    </main>
  );
}
