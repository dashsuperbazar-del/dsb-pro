import { getSupabaseClient } from './client';
import { errorMessage, classifyError } from './errors';
import { isUuid, rpcOutcome, type WriteOutcome } from './outcomes';
import { deriveSettlement, type PurchaseSettlement } from './purchaseExtras';

// Void of a credit (or v1) purchase bill through void_purchase (0046). That RPC takes no reason, so the
// reason (or the correcting bill) is carried inside the request id, which the server keeps on every
// PURCHASE_VOID stock movement (`<id>:stock:<line>`). A retry of a committed void returns the bill id
// (the body's VOID short-circuit), so resending is always safe.
const PREFIX = 'purchase.void.v1:';
export const VOID_REASON_MAX = 200;

export function purchaseVoidRequestId(
  requestUuid: string,
  tag: { reason: string } | { correctedBy: string },
): string {
  if (!isUuid(requestUuid)) throw new Error('void request id must be a UUID');
  if ('correctedBy' in tag) {
    if (!isUuid(tag.correctedBy)) throw new Error('correcting bill id must be a UUID');
    return `${PREFIX}${requestUuid}:corrected-by:${tag.correctedBy}`;
  }
  const reason = tag.reason.trim().replace(/\s+/g, ' ');
  if (!reason || reason.length > VOID_REASON_MAX)
    throw new Error(`Reason required (1-${VOID_REASON_MAX} characters).`);
  return `${PREFIX}${requestUuid}:reason:${reason}`;
}

export type PurchaseVoidInfo = { reason: string | null; correctedBy: string | null };

/** Parses a PURCHASE_VOID movement client id; ids written by other paths give nulls. */
export function parsePurchaseVoidId(clientId: string): PurchaseVoidInfo {
  const stockAt = clientId.lastIndexOf(':stock:');
  const id = stockAt >= 0 ? clientId.slice(0, stockAt) : clientId;
  const m = /^purchase\.void\.v1:[0-9a-f-]{36}:(reason|corrected-by):(.+)$/i.exec(id);
  if (!m) return { reason: null, correctedBy: null };
  if (m[1] === 'reason') return { reason: m[2]!, correctedBy: null };
  return isUuid(m[2]) ? { reason: null, correctedBy: m[2] } : { reason: null, correctedBy: null };
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

/** Reason / correcting bill of a voided bill, from its void stock movement. Null when not recorded. */
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
  const info = parsePurchaseVoidId(row.client_id);
  return info.reason || info.correctedBy ? info : null;
}

/** The bill that `newBillId` corrected (voided with "corrected by" it), or null. */
export async function findCorrectedBill(shopId: string, newBillId: string): Promise<string | null> {
  if (!isUuid(newBillId)) return null;
  const { data, error } = await getSupabaseClient()
    .from('stock_movements')
    .select('source_id')
    .eq('shop_id', shopId)
    .eq('source_type', 'PURCHASE_VOID')
    .like('client_id', `${PREFIX}%:corrected-by:${newBillId}:stock:%`)
    .limit(1);
  if (error) throw new Error(errorMessage(classifyError(error), error));
  const row = (data ?? [])[0] as { source_id: string } | undefined;
  return row?.source_id ?? null;
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
