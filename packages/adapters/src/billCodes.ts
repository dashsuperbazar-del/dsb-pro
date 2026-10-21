import { getSupabaseClient } from './client';

// Bill codes (0069): a short server-made code on every purchase bill and sale invoice ("K7M2-QX9P").
// The column does not exist before the migration, so every read here is best-effort: a database without
// it, an old cached row or a failed read simply shows no code. Nothing here ever blocks a bill from opening.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 100;

type Failure = { code?: string | null; message?: string | null } | null;

/** True when the server says the bill_code column does not exist (database not yet upgraded to 0069). */
export function isMissingBillCodeColumn(error: Failure | undefined): boolean {
  if (!error) return false;
  return error.code === '42703' || /bill_code/i.test(error.message ?? '');
}

let supported: boolean | null = null;

/**
 * Runs a read first with the bill_code column and, when the database has no such column yet, again
 * without it (and remembers that for the rest of the session). Any other error is returned unchanged.
 */
export async function withBillCode<R extends { error: Failure }>(
  run: (withCode: boolean) => PromiseLike<R>,
): Promise<R> {
  if (supported !== false) {
    const r = await run(true);
    if (!r.error) {
      supported = true;
      return r;
    }
    if (!isMissingBillCodeColumn(r.error)) return r;
    supported = false;
  }
  return run(false);
}

/** Test hook: forgets what was learned about whether the database has the column. */
export function resetBillCodeSupport(): void {
  supported = null;
}

/** Codes of the given purchase bills and sale invoices, by document id. Best effort: failures leave gaps. */
export async function readBillCodes(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (!unique.length || supported === false) return out;
  const client = getSupabaseClient();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    for (const table of ['purchase_bills', 'sale_invoices'] as const) {
      try {
        const { data, error } = await client.from(table).select('id,bill_code').in('id', chunk);
        if (error) {
          if (isMissingBillCodeColumn(error)) {
            supported = false;
            return out;
          }
          continue;
        }
        for (const row of (data ?? []) as Array<{ id: string; bill_code: string | null }>)
          if (row.bill_code) out.set(row.id, row.bill_code);
      } catch {
        /* a label only */
      }
    }
  }
  return out;
}

/**
 * Where a ledger or report row names a document by its raw uuid (a bill with no supplier bill no.), swap
 * in the bill code. Display only: the row's id, amounts and order are untouched; unreadable = unchanged.
 */
export async function relabelRawIds<T>(
  rows: T[],
  idOf: (row: T) => string | null,
  labelOf: (row: T) => string,
  withLabel: (row: T, code: string) => T,
): Promise<T[]> {
  const wanted = rows.flatMap((row) => {
    const id = idOf(row);
    return id && UUID.test(id) && labelOf(row) === id ? [id] : [];
  });
  if (!wanted.length) return rows;
  const codes = await readBillCodes(wanted);
  if (!codes.size) return rows;
  return rows.map((row) => {
    const id = idOf(row);
    const code = id ? codes.get(id) : undefined;
    return code && labelOf(row) === id ? withLabel(row, code) : row;
  });
}

export type BillCodeHit = {
  kind: 'purchase' | 'sale';
  id: string;
  bill_code: string;
  /** The supplier's bill no. (purchase) or the invoice number (sale). */
  doc_no: string | null;
  /** Supplier (purchase) or customer (sale). */
  party_id: string | null;
  business_date: string;
  total_paise: number;
  status: string;
};

/**
 * Bills and invoices of a shop whose bill code contains the query (case and dashes ignored, 4+ characters),
 * over the whole history. Returns [] for a short query, and also when the database has no such search yet
 * (not upgraded to 0069) so the caller falls back to the bills it already holds. Other failures throw.
 */
export async function findBillsByCode(shopId: string, query: string): Promise<BillCodeHit[]> {
  if (query.replace(/[^A-Za-z0-9]/g, '').length < 4 || supported === false) return [];
  const { data, error } = await getSupabaseClient().rpc('find_bills_by_code', {
    p_shop_id: shopId,
    p_query: query,
  });
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as BillCodeHit[]).map((r) => ({ ...r, total_paise: Number(r.total_paise) }));
}
