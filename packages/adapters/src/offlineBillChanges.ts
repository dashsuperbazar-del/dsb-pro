import { getSupabaseClient } from './client';
import { isUuid, rpcOutcome, type WriteOutcome } from './outcomes';
import { lookupPurchaseRequest } from './purchaseExtras';

// Offline bill edit / void (mig 0072). The device reads the bill's version token with the bill and sends it
// with the queued request; the server applies the change only if the bill is unchanged since then.

const VERSION = /^[0-9a-f]{32}$/;

/** The bill's version token, or null when it cannot be read (then nothing can be saved offline). */
export async function getPurchaseBillVersion(billId: string): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseClient().rpc(
      'get_purchase_bill_version' as never,
      { p_bill_id: billId } as never,
    );
    if (error) return null;
    return typeof data === 'string' && VERSION.test(data) ? data : null;
  } catch {
    return null;
  }
}

const ACCESS = /not permitted|permission|not authenticated|tenant/i;

/**
 * Voids a credit bill only if it still has `baseVersion` and no payment is assigned. The same request id
 * replays the stored answer; a refusal is checked against the stored answer, so a resend after a lost
 * answer is never shown as refused.
 */
export async function voidPurchaseIfUnchangedOutcome(input: {
  shopId: string;
  purchaseId: string;
  clientId: string;
  reason: string;
  baseVersion: string;
}): Promise<WriteOutcome<{ billId: string }>> {
  const ack = (data: unknown) => {
    const r = data as Record<string, unknown> | null;
    return r && r.billId === input.purchaseId && r.voided === true
      ? { billId: input.purchaseId }
      : null;
  };
  if (!isUuid(input.purchaseId) || !isUuid(input.clientId))
    return { kind: 'rejected', code: 'INVALID_INPUT', message: 'Void request ids must be UUIDs.' };
  const outcome = await rpcOutcome(
    'void_purchase_if_unchanged',
    {
      p_purchase_id: input.purchaseId,
      p_client_id: input.clientId,
      p_reason: input.reason,
      p_base_version: input.baseVersion,
    },
    ack,
  );
  if (outcome.kind !== 'rejected') return outcome;
  const found = await lookupPurchaseRequest(
    input.shopId,
    'purchase.void.offline.v1',
    input.clientId,
  );
  if (found.kind === 'unavailable')
    return {
      kind: 'unknown',
      message: `${outcome.message} (the earlier attempt cannot be verified)`,
    };
  if (found.kind === 'committed') {
    const value = ack(found.result);
    return value
      ? { kind: 'committed', value }
      : { kind: 'unknown', message: 'The stored void answer could not be verified.' };
  }
  // Without access the absence of a stored answer proves nothing.
  if (outcome.code === '42501' || ACCESS.test(outcome.message))
    return {
      kind: 'unknown',
      message: `${outcome.message} (the earlier attempt cannot be verified)`,
    };
  return outcome;
}

/** Plain words for a refused offline void. */
export function plainOfflineVoidRefusal(message: string): string {
  if (/DSB_BILL_CHANGED/.test(message))
    return 'This bill changed after the void was saved on this device (edited, voided, paid or returned elsewhere). Nothing was changed. Open the bill and decide again.';
  if (/DSB_VOID_HAS_PAYMENTS/.test(message))
    return 'A payment is assigned to this bill. Release or void that payment first (online), then void the bill.';
  if (/returns/i.test(message))
    return 'This bill has supplier returns. Void those returns first, then void the bill.';
  if (/not permitted|permission/i.test(message))
    return 'Only the owner or a manager can void a bill.';
  return message;
}
