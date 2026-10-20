import { getSupabaseClient } from './client';
import { errorMessage, classifyError } from './errors';
import { isUuid, rpcOutcome, type WriteOutcome } from './outcomes';
import { deriveSettlement, type PurchaseSettlement } from './purchaseExtras';

// Void of a credit (or v1) purchase bill through void_purchase (0046). That RPC takes no reason, so the
// reason is carried inside the request id, which the server keeps on every
// PURCHASE_VOID stock movement (`<id>:stock:<line>`). A retry of a committed void returns the bill id
// (the body's VOID short-circuit), so resending is always safe.
const PREFIX = 'purchase.void.v1:';
export const VOID_REASON_MAX = 200;

export function purchaseVoidRequestId(requestUuid: string, tag: { reason: string }): string {
  if (!isUuid(requestUuid)) throw new Error('void request id must be a UUID');
  const reason = tag.reason.trim().replace(/\s+/g, ' ');
  if (!reason || reason.length > VOID_REASON_MAX)
    throw new Error(`Reason required (1-${VOID_REASON_MAX} characters).`);
  // ':' separates the parts of the id (and the server appends ':stock:<n>'); refused so the parse is exact.
  if (reason.includes(':')) throw new Error('The reason cannot contain a colon (:).');
  return `${PREFIX}${requestUuid}:reason:${reason}`;
}

export type PurchaseVoidInfo = { reason: string };

/** Parses a PURCHASE_VOID movement client id (`<request id>:stock:<line>`); other ids give null. */
export function parsePurchaseVoidId(clientId: string): PurchaseVoidInfo | null {
  const m =
    /^purchase\.void\.v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:reason:([^:]{1,200}):stock:\d+$/i.exec(
      clientId,
    );
  return m ? { reason: m[1]! } : null;
}

export async function voidPurchaseOutcome(input: {
  purchaseId: string;
  clientId: string;
}): Promise<WriteOutcome<string>> {
  return rpcOutcome(
    'void_purchase',
    { p_purchase_id: input.purchaseId, p_client_id: input.clientId },
    (data) => (data === input.purchaseId ? input.purchaseId : null),
  );
}

/** Reason of a voided bill, from its void stock movement. Null when not recorded. */
export async function getPurchaseVoidInfo(
  shopId: string,
  billId: string,
): Promise<PurchaseVoidInfo | null> {
  const { data, error } = await getSupabaseClient()
    .from('stock_movements')
    .select('client_id')
    .eq('shop_id', shopId)
    .eq('source_type', 'PURCHASE_VOID')
    .eq('source_id', billId)
    .limit(1);
  if (error) throw new Error(errorMessage(classifyError(error), error));
  const row = (data ?? [])[0] as { client_id: string } | undefined;
  if (!row) return null;
  return parsePurchaseVoidId(row.client_id);
}

/** Ledger settlement of many bills at once (100 per request). Bills without a row are omitted. */
export async function listPurchaseSettlements(
  shopId: string,
  bills: { id: string; status: string }[],
): Promise<Map<string, PurchaseSettlement>> {
  const out = new Map<string, PurchaseSettlement>();
  const posted = bills.filter((b) => b.status !== 'VOID');
  for (const b of bills) if (b.status === 'VOID') out.set(b.id, deriveSettlement('VOID', null));
  for (let i = 0; i < posted.length; i += 100) {
    const chunk = posted.slice(i, i + 100);
    const { data, error } = await getSupabaseClient()
      .from('purchase_bill_outstanding' as never)
      .select('purchase_bill_id,outstanding_paise::text,allocated_paise::text,returned_paise::text')
      .eq('shop_id', shopId)
      .in('purchase_bill_id', chunk.map((b) => b.id) as never);
    if (error) throw new Error(errorMessage(classifyError(error), error));
    for (const r of (data ?? []) as unknown as {
      purchase_bill_id: string;
      outstanding_paise: string;
      allocated_paise: string;
      returned_paise: string;
    }[])
      out.set(r.purchase_bill_id, deriveSettlement('POSTED', r));
  }
  return out;
}
