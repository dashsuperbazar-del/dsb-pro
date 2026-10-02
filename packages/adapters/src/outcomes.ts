import { getSupabaseClient } from './client';

// Transaction outcome of a write, separate from how an error is displayed (V002 VF-006).
// Only a definitive database answer proves a rollback; everything else may have committed.
export type WriteOutcome<T> =
  | { kind: 'committed'; value: T }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'unknown'; message: string };

// SQLSTATE classes that prove the transaction rolled back with a definitive answer: raised business
// errors (P0001), constraint and privilege errors. Anything else -- network loss, aborts, timeouts,
// gateway errors, deadlock/serialization aborts -- is an unknown outcome and is reconciled by ID.
export function definitiveCode(error: { code?: string; message?: string }): string | null {
  const code = error.code ?? '';
  const dsb = /^(DSB_[A-Z_]+)/.exec(error.message ?? '')?.[1];
  // PAYLOAD_MISMATCH means a request with this id already exists server-side (possibly committed):
  // never a rejection, or the user could re-enter the same money under a new id.
  if (dsb === 'DSB_PAYLOAD_MISMATCH') return null;
  if (code === 'P0001' || code === '42501' || /^(22|23)/.test(code))
    return dsb ?? (code || 'REJECTED');
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

type RpcError = { code?: string; message?: string };

// Calls an RPC and maps the result to a three-way outcome. `ack` validates the success payload;
// an unverifiable answer is unknown, never committed.
export async function rpcOutcome<T>(
  fn: string,
  args: Record<string, unknown>,
  ack: (data: unknown) => T | null,
): Promise<WriteOutcome<T>> {
  let response: { data: unknown; error: RpcError | null };
  try {
    response = (await getSupabaseClient().rpc(fn as never, args as never)) as typeof response;
  } catch (error) {
    return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
  if (response.error) {
    const code = definitiveCode(response.error);
    if (code) return { kind: 'rejected', code, message: response.error.message ?? code };
    return { kind: 'unknown', message: response.error.message ?? 'No answer from the server.' };
  }
  const value = ack(response.data);
  if (value === null)
    return { kind: 'unknown', message: 'The server answer could not be verified.' };
  return { kind: 'committed', value };
}

export const uuidAck = (data: unknown): string | null => (isUuid(data) ? data : null);

// A rejection of a RETRY is not proof that nothing was written: the first send may have committed
// and the retry been refused by a check that runs before the server's idempotency lookup (e.g. a
// revoked permission). Unlock only when a lookup by client id finds no row and the refusal is not an
// access error (row-level security hides rows from a user without access, so absence is unprovable).
const ACCESS = /not permitted|permission|access|tenant|shop (is )?(not|un)/i;
export async function verifyRetryRejection(
  table: 'expenses' | 'purchase_bills' | 'stock_counts' | 'account_openings',
  clientId: string,
  rejected: { kind: 'rejected'; code: string; message: string },
): Promise<WriteOutcome<string>> {
  let found: string | null;
  try {
    const { data, error } = await getSupabaseClient()
      .from(table as never)
      .select('id')
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) return { kind: 'unknown', message: `${rejected.message} (could not verify)` };
    found = ((data as { id?: string } | null)?.id as string | undefined) ?? null;
  } catch {
    return { kind: 'unknown', message: `${rejected.message} (could not verify)` };
  }
  if (found) return { kind: 'committed', value: found };
  if (rejected.code === '42501' || ACCESS.test(rejected.message))
    return {
      kind: 'unknown',
      message: `${rejected.message} (the earlier attempt cannot be verified)`,
    };
  return rejected;
}

export async function postExpenseOutcome(input: {
  isRetry?: boolean;
  shopId: string;
  businessDate: string;
  category: string;
  description: string;
  amountPaise: number;
  mode: string;
  reference: string | null;
  clientId: string;
}): Promise<WriteOutcome<string>> {
  const outcome = await rpcOutcome(
    'post_expense',
    {
      p_shop_id: input.shopId,
      p_business_date: input.businessDate,
      p_category: input.category,
      p_description: input.description,
      p_amount_paise: input.amountPaise,
      p_mode: input.mode,
      p_reference: input.reference,
      p_client_id: input.clientId,
    },
    uuidAck,
  );
  return outcome.kind === 'rejected' && input.isRetry
    ? verifyRetryRejection('expenses', input.clientId, outcome)
    : outcome;
}

export type PurchaseRequest = {
  shopId: string;
  partyId?: string;
  billNo?: string;
  businessDate: string;
  discountPaise?: number;
  extraChargesPaise?: number;
  clientId: string;
  lines: { itemId: string; unitLevel: 1 | 2 | 3; qty: string; unitPricePaise: number }[];
  billImagePath?: string;
};
// post_purchase verifies a same-id retry against the stored bill (C3b), so resending is safe.
export async function postPurchaseOutcome(
  input: PurchaseRequest,
  isRetry = false,
): Promise<WriteOutcome<string>> {
  const outcome = await rpcOutcome(
    'post_purchase',
    {
      p_shop_id: input.shopId,
      p_party_id: input.partyId ?? null,
      p_bill_no: input.billNo ?? null,
      p_business_date: input.businessDate,
      p_discount_paise: input.discountPaise ?? 0,
      p_extra_charges_paise: input.extraChargesPaise ?? 0,
      p_client_id: input.clientId,
      p_lines: input.lines.map((l) => ({
        item_id: l.itemId,
        unit_level: l.unitLevel,
        qty: l.qty,
        unit_price_paise: l.unitPricePaise,
      })),
      p_bill_image_path: input.billImagePath ?? null,
    },
    uuidAck,
  );
  return outcome.kind === 'rejected' && isRetry
    ? verifyRetryRejection('purchase_bills', input.clientId, outcome)
    : outcome;
}

export type StockCountRequest = {
  shopId: string;
  businessDate: string;
  lines: { item_id: string; counted_qty: number; reason?: string }[];
  notes: string;
  clientId: string;
};
// Two-step stock count, resumable by client id: create_stock_count returns the existing count for a
// known id, and the count's own status (read, not inferred from error text) decides whether to post.
export async function postStockCountOutcome(
  input: StockCountRequest,
  isRetry = false,
): Promise<WriteOutcome<{ countId: string; alreadyPosted: boolean }>> {
  const created = await rpcOutcome(
    'create_stock_count',
    {
      p_shop_id: input.shopId,
      p_business_date: input.businessDate,
      p_lines: input.lines,
      p_notes: input.notes,
      p_client_id: input.clientId,
    },
    uuidAck,
  );
  if (created.kind === 'unknown') return created;
  let countId: string;
  if (created.kind === 'rejected') {
    if (!isRetry) return created;
    // A count with this id may already exist: if so, resume it by its status below.
    const checked = await verifyRetryRejection('stock_counts', input.clientId, created);
    if (checked.kind !== 'committed') return checked;
    countId = checked.value;
  } else countId = created.value;
  const first = await readStockCountStatus(countId);
  if (first.kind !== 'committed') return first;
  if (first.value === 'POSTED')
    return { kind: 'committed', value: { countId, alreadyPosted: true } };
  if (first.value !== 'DRAFT')
    return { kind: 'unknown', message: `Stock count is in state ${first.value ?? 'missing'}.` };
  const posted = await rpcOutcome('post_stock_count', { p_stock_count_id: countId }, () => true);
  if (posted.kind === 'committed')
    return { kind: 'committed', value: { countId, alreadyPosted: false } };
  if (posted.kind === 'unknown') return posted;
  // A rejection may come from a concurrent earlier attempt that posted this same count first:
  // the count's status, not the error text, is the answer.
  const after = await readStockCountStatus(countId);
  if (after.kind === 'committed' && after.value === 'POSTED')
    return { kind: 'committed', value: { countId, alreadyPosted: true } };
  if (after.kind === 'committed' && after.value === 'DRAFT') return posted;
  return { kind: 'unknown', message: posted.message };
}

async function readStockCountStatus(countId: string): Promise<WriteOutcome<string | null>> {
  try {
    const { data, error } = await getSupabaseClient()
      .from('stock_counts')
      .select('status')
      .eq('id', countId)
      .maybeSingle();
    if (error) return { kind: 'unknown', message: error.message };
    return { kind: 'committed', value: (data as { status?: string } | null)?.status ?? null };
  } catch (error) {
    return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
}

// O1 opening balances. Positive = the customer owes the shop / the shop owes the supplier.
export async function recordOpeningOutcome(
  input: {
    shopId: string;
    kind: 'CUSTOMER' | 'SUPPLIER';
    accountId: string;
    asOfDate: string;
    amountPaise: number;
    reason: string;
    clientId: string;
  },
  isRetry = false,
): Promise<WriteOutcome<string>> {
  const outcome = await rpcOutcome(
    'record_account_opening',
    {
      p_shop_id: input.shopId,
      p_account_kind: input.kind,
      p_account_id: input.accountId,
      p_as_of_date: input.asOfDate,
      p_amount_paise: input.amountPaise,
      p_reason: input.reason,
      p_client_id: input.clientId,
    },
    uuidAck,
  );
  // A refused retry is checked by client id: the first send may have committed (O1 Codex review).
  return outcome.kind === 'rejected' && isRetry
    ? verifyRetryRejection('account_openings', input.clientId, outcome)
    : outcome;
}
export function voidOpeningOutcome(
  openingId: string,
  reason: string,
): Promise<WriteOutcome<string>> {
  return rpcOutcome('void_account_opening', { p_opening_id: openingId, p_reason: reason }, uuidAck);
}
export type AccountOpening = {
  id: string;
  account_kind: 'CUSTOMER' | 'SUPPLIER';
  customer_id: string | null;
  party_id: string | null;
  as_of_date: string;
  amount_paise: string;
  status: 'POSTED' | 'VOID';
  reason: string;
  void_reason: string | null;
};
export async function listOpenings(shopId: string): Promise<AccountOpening[]> {
  const { data, error } = await getSupabaseClient()
    .from('account_openings')
    .select(
      'id,account_kind,customer_id,party_id,as_of_date,amount_paise::text,status,reason,void_reason',
    )
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as AccountOpening[];
}
