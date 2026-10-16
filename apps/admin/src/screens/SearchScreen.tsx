import { useEffect, useRef, useState } from 'preact/hooks';
import { listCustomers, listItems, listParties } from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { readCatalogForScreen, catalogDirtySince } from '../lib/catalogRead';
import { shopContext } from '../lib/shopContext';
import { getOfflineCustomers, getSyncedOfflineCatalog } from '../lib/offlineSync';
import {
  GLOBAL_SEARCH_LIMIT,
  searchEverything,
  type SearchData,
  type SearchItem,
  type SearchParty,
} from '../lib/globalSearch';

// One box over what this device can already show: items (device catalog, same trust rules as Inventory),
// customers, and suppliers (owner/manager). Results open the screen that owns the record. Nothing here
// writes; a list that could not be loaded is named, never silently treated as "no match".
export function SearchScreen() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<SearchData>({ items: [], customers: [], suppliers: [] });
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [role, setRole] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const { membership, session } = await shopContext.get();
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

  const r = searchEverything(q, data);
  const searched = q.trim().length >= 2;
  const total = r.items.length + r.customers.length + r.suppliers.length;
  return (
    <main class="page wide">
      <p>
        <a href={appRoute.home}>← Home</a>
      </p>
      <h1>Search</h1>
      <label>
        Search items, customers{role === 'cashier' ? '' : ' and suppliers'}
        <input
          type="search"
          autoFocus
          placeholder="Name, SKU or phone"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
      </label>
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
      {searched && !loading && total === 0 && <p>No matches.</p>}
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
    </main>
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
