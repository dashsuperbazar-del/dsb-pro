import { useEffect, useRef, useState } from 'preact/hooks';
import {
  findBillsByCode,
  listCustomers,
  listItems,
  listParties,
  listPurchaseHistory,
  listRecentSales,
  type BillCodeHit,
  type PurchaseRecord,
  type SaleInvoice,
} from '@dsb-pro/adapters';
import { rupees } from '../lib/money';
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
  const [debounced, setDebounced] = useState('');
  const [shopId, setShopId] = useState('');
  const [bills, setBills] = useState<BillLists | null>(null);
  const [billsBusy, setBillsBusy] = useState(false);
  const billsStarted = useRef(false);
  // Bills whose bill code contains the query, read from the server over the whole history (0069).
  const [codeHits, setCodeHits] = useState<{ query: string; hits: BillCodeHit[] } | null>(null);
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
      .catch(() => live && setCodeHits(null));
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
        setShopId(shop);
      } catch (e) {
        if (alive.current) setError(String(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  const r = searchEverything(debounced, data);
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
  }));
  const loadedSales = (bills?.sales ?? []).map((x): SearchBill => ({
    id: x.id,
    number: x.doc_no,
    code: x.bill_code,
    partyName: (x.customer_id && customerNames.get(x.customer_id)) || 'Walk-in',
    date: x.business_date,
    totalPaise: x.total_paise,
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
      }));
  const purchaseHits = searchBills(debounced, [
    ...loadedPurchases,
    ...extra('purchase', loadedPurchases),
  ]);
  const saleHits = searchBills(debounced, [...loadedSales, ...extra('sale', loadedSales)]);
  const total =
    r.items.length +
    r.customers.length +
    r.suppliers.length +
    purchaseHits.rows.length +
    saleHits.rows.length;
  return (
    <main class="page wide">
      <p>
        <a href={appRoute.home}>← Home</a>
      </p>
      <h1>Search</h1>
      <label>
        Search items, customers{role === 'cashier' ? '' : ', suppliers'}, bills and invoices
        <input
          type="search"
          autoFocus
          placeholder="Name, SKU, phone, bill no. or amount"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
      </label>
      <p class="muted">
        A bill code (like K7M2-QX9P, 4 characters or more) finds a bill or invoice.
      </p>
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
      {!searched && !loading && <p class="muted">Type at least two characters.</p>}
      {searched && !loading && !billsBusy && total === 0 && <p>No matches.</p>}
      {r.items.length > 0 && (
        <Group
          title="Items"
          href={appRoute.inventory}
          shown={r.items.length}
          total={r.itemsTotal}
          rows={r.items.map((i) => ({ id: i.id, name: i.name, detail: i.sku ?? '' }))}
        />
      )}
      {r.customers.length > 0 && (
        <Group
          title="Customers"
          href={appRoute.customers}
          shown={r.customers.length}
          total={r.customersTotal}
          rows={r.customers.map((c) => ({ id: c.id, name: c.name, detail: c.phone ?? '' }))}
        />
      )}
      {r.suppliers.length > 0 && (
        <Group
          title="Suppliers"
          href={appRoute.suppliers}
          shown={r.suppliers.length}
          total={r.suppliersTotal}
          rows={r.suppliers.map((s) => ({ id: s.id, name: s.name, detail: s.phone ?? '' }))}
        />
      )}
      {searched && billsBusy && <p class="muted">Searching bills and invoices…</p>}
      {bills && bills.failed.length > 0 && (
        <p role="alert" class="alert">
          Could not load {bills.failed.join(', ')}. Results below leave those out.
        </p>
      )}
      {purchaseHits.rows.length > 0 && (
        <BillGroup
          title="Purchase bills"
          total={purchaseHits.total}
          rows={purchaseHits.rows}
          href={(id) => `${appRoute.purchases}?bill=${encodeURIComponent(id)}`}
        />
      )}
      {saleHits.rows.length > 0 && (
        <BillGroup
          title="Sale invoices"
          total={saleHits.total}
          rows={saleHits.rows}
          href={(id) => `${appRoute.salesHistory}?sale=${encodeURIComponent(id)}`}
        />
      )}
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

function BillGroup({
  title,
  total,
  rows,
  href,
}: {
  title: string;
  total: number;
  rows: SearchBill[];
  href: (id: string) => string;
}) {
  return (
    <section class="card" aria-label={title}>
      <h2>
        {title} ({total})
      </h2>
      <ul>
        {rows.map((b) => (
          <li key={b.id}>
            <a href={href(b.id)}>{b.number || b.code || 'No number'}</a>
            <span class="muted">
              {' '}
              {b.number && b.code ? `· ${b.code} ` : ''}· {b.partyName || 'Unknown'} · {b.date} ·{' '}
              {rupees(b.totalPaise)}
            </span>
          </li>
        ))}
      </ul>
      {total > rows.length && (
        <p class="muted">
          Showing the first {GLOBAL_SEARCH_LIMIT} of {total}. Type more to narrow the list.
        </p>
      )}
    </section>
  );
}

function Group({
  title,
  href,
  shown,
  total,
  rows,
}: {
  title: string;
  href: string;
  shown: number;
  total: number;
  rows: Array<{ id: string; name: string; detail: string }>;
}) {
  return (
    <section class="card" aria-label={title}>
      <h2>
        {title} ({total})
      </h2>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <a href={href}>{row.name}</a>
            {row.detail && <span class="muted"> · {row.detail}</span>}
          </li>
        ))}
      </ul>
      {total > shown && (
        <p class="muted">
          Showing the first {GLOBAL_SEARCH_LIMIT} of {total}. Type more to narrow the list.
        </p>
      )}
    </section>
  );
}
