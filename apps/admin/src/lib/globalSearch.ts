export const GLOBAL_SEARCH_LIMIT = 10;
type Named = { id: string; name: string };
export type SearchItem = Named & { sku?: string | null };
export type SearchParty = Named & { phone?: string | null };
export type SearchData = {
  items: SearchItem[];
  customers: SearchParty[];
  suppliers: SearchParty[];
};
export type SearchResult = {
  items: SearchItem[];
  customers: SearchParty[];
  suppliers: SearchParty[];
  itemsTotal: number;
  customersTotal: number;
  suppliersTotal: number;
};
const digits = (s: string) => s.replace(/\D/g, '');
// Bounded, in-memory search over the lists the screens already hold. Names that start with the
// query rank first. Phone numbers match on digits only, so "98765 43210" is found by "98765".
function rank<T extends Named & { sku?: string | null; phone?: string | null }>(
  list: T[],
  q: string,
): T[] {
  const qd = digits(q);
  const scored: Array<[number, T]> = [];
  for (const row of list) {
    const name = row.name.toLowerCase();
    const sku = (row.sku ?? '').toLowerCase();
    let score = -1;
    if (name.startsWith(q) || (sku && sku.startsWith(q))) score = 0;
    else if (name.includes(q) || (sku && sku.includes(q))) score = 1;
    else if (qd.length >= 3 && row.phone && digits(row.phone).includes(qd)) score = 2;
    if (score >= 0) scored.push([score, row]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, r]) => r);
}
export function searchEverything(query: string, data: SearchData): SearchResult {
  const q = query.trim().toLowerCase();
  if (q.length < 2)
    return {
      items: [],
      customers: [],
      suppliers: [],
      itemsTotal: 0,
      customersTotal: 0,
      suppliersTotal: 0,
    };
  const items = rank(data.items, q);
  const customers = rank(data.customers, q);
  const suppliers = rank(data.suppliers, q);
  return {
    items: items.slice(0, GLOBAL_SEARCH_LIMIT),
    customers: customers.slice(0, GLOBAL_SEARCH_LIMIT),
    suppliers: suppliers.slice(0, GLOBAL_SEARCH_LIMIT),
    itemsTotal: items.length,
    customersTotal: customers.length,
    suppliersTotal: suppliers.length,
  };
}
