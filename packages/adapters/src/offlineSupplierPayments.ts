import { getSupabaseClient } from './client';
import { isUuid, rpcOutcome, type WriteOutcome } from './outcomes';
import { lookupSupplierRequest, type PaymentMode } from './supplierPayments';

// Offline supplier payments (mig 0074). The device reads what is owed, the open bills and a version token for
// each while online, saves a payment with those tokens, and the server applies it only if they still hold.

const VERSION = /^[0-9a-f]{32}$/;
const INT_TEXT = /^-?\d{1,16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type SupplierPayContextBill = {
  billId: string;
  billNo: string | null;
  businessDate: string;
  outstandingPaise: string;
  version: string;
};
export type SupplierPayContextSupplier = {
  partyId: string;
  name: string;
  owedPaise: string;
  version: string;
  bills: SupplierPayContextBill[];
};
export type SupplierPayContext = {
  shopId: string;
  businessDate: string;
  suppliers: SupplierPayContextSupplier[];
};

/** Everything the device keeps for offline "Pay supplier". Throws when the answer is malformed. */
export async function getSupplierPayContext(shopId: string): Promise<SupplierPayContext> {
  const { data, error } = await getSupabaseClient().rpc(
    'get_supplier_pay_context' as never,
    { p_shop_id: shopId } as never,
  );
  if (error) throw new Error(error.message);
  const r = data as Partial<SupplierPayContext> | null;
  if (
    !r ||
    r.shopId !== shopId ||
    !DATE.test(String(r.businessDate)) ||
    !Array.isArray(r.suppliers)
  )
    throw new Error('Malformed supplier payment context.');
  for (const s of r.suppliers) {
    if (
      !isUuid(s.partyId) ||
      typeof s.name !== 'string' ||
      !INT_TEXT.test(String(s.owedPaise)) ||
      !VERSION.test(String(s.version)) ||
      !Array.isArray(s.bills)
    )
      throw new Error('Malformed supplier payment context.');
    for (const b of s.bills)
      if (
        !isUuid(b.billId) ||
        !DATE.test(String(b.businessDate)) ||
        !INT_TEXT.test(String(b.outstandingPaise)) ||
        !VERSION.test(String(b.version))
      )
        throw new Error('Malformed supplier payment context.');
  }
  return r as SupplierPayContext;
}

export type PaySupplierIfUnchangedInput = {
  requestId: string;
  shopId: string;
  partyId: string;
  businessDate: string | null;
  amountPaise: string;
  mode: PaymentMode;
  reference: string | null;
  allocations: { purchaseBillId: string; amountPaise: string }[];
  baseVersions: { supplier: string; bills: Record<string, string> };
};
export type PaySupplierResult = { paymentId: string; allocationIds: string[] };

const ACCESS = /not permitted|permission|not authenticated|tenant/i;
const ack = (data: unknown): PaySupplierResult | null => {
  const r = data as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || !isUuid(r.paymentId)) return null;
  const ids = r.allocationIds === undefined ? [] : r.allocationIds;
  if (!Array.isArray(ids) || !ids.every(isUuid)) return null;
  return { paymentId: r.paymentId, allocationIds: ids as string[] };
};

/**
 * Records a supplier payment only if the supplier and the assigned bills still have the versions the device
 * saw. The same request id replays the stored answer; a refusal is checked against the stored answer, so a
 * resend after a lost answer is never shown as refused.
 */
export async function paySupplierIfUnchangedOutcome(
  input: PaySupplierIfUnchangedInput,
): Promise<WriteOutcome<PaySupplierResult>> {
  if (!isUuid(input.requestId) || !isUuid(input.partyId))
    return { kind: 'rejected', code: 'INVALID_INPUT', message: 'Payment ids must be UUIDs.' };
  if (
    !/^\d+$/.test(input.amountPaise) ||
    input.allocations.some((a) => !/^\d+$/.test(a.amountPaise))
  )
    return { kind: 'rejected', code: 'INVALID_INPUT', message: 'Amounts must be whole paise.' };
  const outcome = await rpcOutcome(
    'pay_supplier_if_unchanged',
    {
      p_shop_id: input.shopId,
      p_party_id: input.partyId,
      p_business_date: input.businessDate,
      p_amount_paise: Number(input.amountPaise),
      p_mode: input.mode,
      p_reference: input.reference,
      p_allocations: input.allocations.map((a) => ({
        purchase_bill_id: a.purchaseBillId,
        amount_paise: Number(a.amountPaise),
      })),
      p_client_id: input.requestId,
      p_base_versions: input.baseVersions,
    },
    ack,
  );
  if (outcome.kind !== 'rejected') return outcome;
  const found = await lookupSupplierRequest(
    input.shopId,
    'supplier.pay.offline.v1',
    input.requestId,
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
      : { kind: 'unknown', message: 'The stored payment answer could not be verified.' };
  }
  // Without access the absence of a stored answer proves nothing.
  if (outcome.code === '42501' || ACCESS.test(outcome.message))
    return {
      kind: 'unknown',
      message: `${outcome.message} (the earlier attempt cannot be verified)`,
    };
  return outcome;
}

/** Plain words for a payment the server refused. The device keeps the full form so it can be redone. */
export function plainOfflineSupplierPaymentRefusal(message: string): string {
  const code = /DSB_[A-Z_]+/.exec(message)?.[0] ?? '';
  switch (code) {
    case 'DSB_BILL_CHANGED':
      return 'A bill this payment was assigned to changed after you saved it (voided, edited, replaced, returned or moved). Nothing was recorded. Open the supplier and pay again.';
    case 'DSB_BILL_ALREADY_PAID':
      return 'A bill this payment was assigned to is already fully paid. Nothing was recorded.';
    case 'DSB_ALLOCATION_EXCEEDS_BILL':
      return 'The amount assigned to a bill is more than is still owed on it. Nothing was recorded.';
    case 'DSB_ALLOCATION_EXCEEDS_PAYMENT':
      return 'The amounts assigned to bills are more than the payment. Nothing was recorded.';
    case 'DSB_BILL_UNAVAILABLE':
      return 'A bill this payment was assigned to no longer exists. Nothing was recorded.';
    case 'DSB_PAYMENT_EXCEEDS_OWED':
      return 'This payment is more than is owed to the supplier now (an earlier payment or a return reduced it). Nothing was recorded.';
    case 'DSB_SUPPLIER_MERGED':
      return 'This supplier was merged into another one after you saved the payment. Nothing was recorded. Pay the kept supplier instead.';
    case 'DSB_SUPPLIER_ARCHIVED':
      return 'This supplier was archived after you saved the payment. Nothing was recorded.';
    case 'DSB_SUPPLIER_CHANGED':
    case 'DSB_SUPPLIER_UNAVAILABLE':
      return 'This supplier changed after you saved the payment. Nothing was recorded. Open the supplier and pay again.';
    case 'DSB_FUTURE_DATE':
      return 'The payment date is after today. Nothing was recorded.';
    case 'DSB_FUTURE_BILL':
      return 'The payment is dated before a bill it was assigned to. Nothing was recorded. Pay again with a date on or after the bill date.';
    default:
      break;
  }
  if (/not permitted|permission/i.test(message))
    return 'Only the owner or a manager can pay a supplier. Nothing was recorded.';
  return message;
}
