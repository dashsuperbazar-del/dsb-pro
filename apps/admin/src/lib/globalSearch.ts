import { billCodeMatch } from './billCode';

export const GLOBAL_SEARCH_LIMIT = 10;
type Named = { id: string; name: string };
export type SearchItem = Named & {
  sku?: string | null;
  unit1?: string | null;
  unit2?: string | null;
  unit3?: string | null;
  min_stock?: number | null;
};
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
export function searchEverything(
  query: string,
  data: SearchData,
  limits: { items?: number; customers?: number; suppliers?: number } = {},
): SearchResult {
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
    items: items.slice(0, limits.items ?? GLOBAL_SEARCH_LIMIT),
    customers: customers.slice(0, limits.customers ?? GLOBAL_SEARCH_LIMIT),
    suppliers: suppliers.slice(0, limits.suppliers ?? GLOBAL_SEARCH_LIMIT),
    itemsTotal: items.length,
    customersTotal: customers.length,
    suppliersTotal: suppliers.length,
  };
}

// Bills and invoices: matched on number, party name and amount. "1250", "1250.5" or "₹1,250.50" match
// a total of ₹1,250.50 (whole rupees, then the typed paise digits), so a typed amount finds the bill.
export type SearchBill = {
  id: string;
  number: string | null;
  /** Bill code (0069); absent on older rows. */
  code?: string | null;
  partyName: string;
  date: string;
  totalPaise: string | number;
  /** Document status as stored (POSTED / VOID / FINALIZED / DRAFT); shown as a chip. */
  status?: string | null;
};
function amountMatches(totalPaise: string | number, q: string): boolean {
  const m = /^₹?\s*(\d[\d,]*)(?:\.(\d{1,2}))?$/.exec(q);
  if (!m) return false;
  const want = m[1]!.replace(/,/g, '').replace(/^0+(?=\d)/, '');
  const s = String(totalPaise).replace(/^-/, '').padStart(3, '0');
  const whole = s.slice(0, -2).replace(/^0+(?=\d)/, '');
  return whole === want && (m[2] === undefined || s.slice(-2).startsWith(m[2]));
}
export function searchBills(
  query: string,
  bills: SearchBill[],
  limit = GLOBAL_SEARCH_LIMIT,
): { rows: SearchBill[]; total: number } {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return { rows: [], total: 0 };
  const scored: Array<[number, SearchBill]> = [];
  for (const b of bills) {
    const no = (b.number ?? '').toLowerCase();
    const party = b.partyName.toLowerCase();
    const byCode = billCodeMatch(b.code, q);
    let score = -1;
    if ((no && no === q) || byCode === 'exact') score = 0;
    else if (amountMatches(b.totalPaise, q)) score = 1;
    else if ((no && no.includes(q)) || byCode === 'partial') score = 2;
    else if (party.startsWith(q)) score = 3;
    else if (party.includes(q)) score = 4;
    if (score >= 0) scored.push([score, b]);
  }
  const rows = scored
    .sort((a, b) => a[0] - b[0] || b[1].date.localeCompare(a[1].date))
    .map(([, r]) => r);
  return { rows: rows.slice(0, limit), total: rows.length };
}
