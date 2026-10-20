import {
  canonicalQuantity,
  purchaseBillTotals,
  PURCHASE_PAYMENT_TYPES,
  type PurchasePaymentType,
} from '@dsb-pro/core';
import { getSupabaseClient } from './client';
import { errorMessage, classifyError } from './errors';
import { isUuid, rpcOutcome, type WriteOutcome } from './outcomes';

// billextras (mig 0064): purchase bills with payment type, notes, per-line discount/GST, named charges and
// several images. Purchases are online-only (no outbox). post_purchase_v2 replays an exact same-id request
// with the stored answer (same bill and payment ids), so resending after an unknown outcome is safe, and
// get_financial_request('purchase.post.v2') reads that stored answer.

export type PurchaseV2Line = {
  itemId: string;
  unitLevel: 1 | 2 | 3;
  qty: string;
  unitPricePaise: number;
  discountBp?: number;
  /**
   * Required and never defaulted. null = GST field left blank: the price is taken as entered (GST-inclusive
   * at the item's master rate), nothing is added. A number = that GST % (basis points) is ADDED on top of the
   * discounted amount; 0 means "0% added". The UI must send null for a blank field, never 0 or ''.
   */
  gstBp: number | null;
};
export type PurchaseV2Request = {
  shopId: string;
  clientId: string;
  partyId?: string | null;
  billNo?: string | null;
  businessDate?: string | null;
  discountPaise?: number;
  paymentType?: PurchasePaymentType;
  notes?: string | null;
  lines: PurchaseV2Line[];
  charges?: { label: string; amountPaise: number }[];
  images?: string[];
};
export type PurchaseV2Result = {
  billId: string;
  paymentId: string | null;
  /** Rounded bill total (old DSB: nearest rupee, half up). */
  totalPaise: number;
  roundOffPaise: number;
  businessDate: string;
};

/** The exact p_bill payload, with the line and bill totals the server must agree with. */
export function buildPurchaseV2Payload(input: PurchaseV2Request) {
  const paymentType = input.paymentType ?? 'credit';
  if (!PURCHASE_PAYMENT_TYPES.includes(paymentType)) throw new Error('Choose credit, cash or UPI.');
  if (paymentType !== 'credit' && !input.partyId)
    throw new Error('A cash or UPI bill needs a supplier.');
  for (const l of input.lines)
    if (l.gstBp !== null && !(Number.isInteger(l.gstBp) && l.gstBp >= 0 && l.gstBp <= 10_000))
      throw new Error('GST must be blank (null) or whole basis points between 0 and 10000.');
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 500) throw new Error('Notes are limited to 500 characters.');
  const charges = (input.charges ?? []).map((c) => ({
    label: c.label.trim(),
    amountPaise: c.amountPaise,
  }));
  if (charges.some((c) => !c.label || c.label.length > 60))
    throw new Error('Each extra charge needs a name (up to 60 characters).');
  const totals = purchaseBillTotals({
    lines: input.lines,
    discountPaise: input.discountPaise ?? 0,
    charges,
  });
  return {
    totals,
    bill: {
      party_id: input.partyId ?? null,
      bill_no: input.billNo?.trim() || null,
      business_date: input.businessDate ?? null,
      discount_paise: input.discountPaise ?? 0,
      payment_type: paymentType,
      notes,
      round_off_paise: totals.roundOffPaise,
      total_paise: totals.totalPaise,
      lines: input.lines.map((l, i) => ({
        item_id: l.itemId,
        unit_level: l.unitLevel,
        qty: canonicalQuantity(l.qty),
        unit_price_paise: l.unitPricePaise,
        discount_bp: l.discountBp ?? 0,
        gst_bp: l.gstBp,
        line_total_paise: totals.lineTotalsPaise[i],
      })),
      charges: charges.map((c) => ({ label: c.label, amount_paise: c.amountPaise })),
      images: input.images ?? [],
    },
  };
}

export type PurchaseRequestLookup =
  | { kind: 'not_found' }
  | { kind: 'committed'; result: unknown; currentStatus: string | null }
  | { kind: 'unavailable'; message: string };

/** Reads the stored answer of a purchase request (post or paid void) by its request id. */
export async function lookupPurchaseRequest(
  shopId: string,
  operation: 'purchase.post.v2' | 'purchase.void_paid.v1',
  clientId: string,
): Promise<PurchaseRequestLookup> {
  try {
    const { data, error } = await getSupabaseClient().rpc(
      'get_financial_request' as never,
      { p_shop_id: shopId, p_operation: operation, p_client_id: clientId } as never,
    );
    if (error)
      return { kind: 'unavailable', message: error.message ?? 'No answer from the server.' };
    const r = data as { state?: string; result?: unknown; currentStatus?: string | null } | null;
    if (r?.state === 'NOT_FOUND') return { kind: 'not_found' };
    if (r?.state === 'COMMITTED')
      return { kind: 'committed', result: r.result, currentStatus: r.currentStatus ?? null };
    return { kind: 'unavailable', message: 'Unexpected request-status answer.' };
  } catch (error) {
    return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

const MISMATCH = /^DSB_PAYLOAD_MISMATCH/;

export async function postPurchaseV2Outcome(
  input: PurchaseV2Request,
  isRetry = false,
): Promise<WriteOutcome<PurchaseV2Result>> {
  let payload: ReturnType<typeof buildPurchaseV2Payload>;
  try {
    payload = buildPurchaseV2Payload(input);
  } catch (error) {
    // Nothing was sent: a definitive local refusal.
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'rejected', code: 'INVALID_INPUT', message };
  }
  const paid = payload.bill.payment_type !== 'credit' && payload.totals.totalPaise > 0;
  const ack = (data: unknown): PurchaseV2Result | null => {
    const r = data as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || !isUuid(r.billId)) return null;
    if (r.totalPaise !== String(payload.totals.totalPaise)) return null;
    if (r.roundOffPaise !== String(payload.totals.roundOffPaise)) return null;
    if (paid ? !isUuid(r.paymentId) : r.paymentId !== null) return null;
    if (typeof r.businessDate !== 'string') return null;
    return {
      billId: r.billId,
      paymentId: (r.paymentId as string | null) ?? null,
      totalPaise: payload.totals.totalPaise,
      roundOffPaise: payload.totals.roundOffPaise,
      businessDate: r.businessDate,
    };
  };
  const outcome = await rpcOutcome(
    'post_purchase_v2',
    { p_shop_id: input.shopId, p_client_id: input.clientId, p_bill: payload.bill },
    ack,
  );
  if (outcome.kind === 'committed') return outcome;

  // The same frozen request always normalizes identically, so a payload mismatch means this id already
  // belongs to a DIFFERENT purchase (another request, or a v1 bill). That is final: resending can never
  // succeed. The user must check Purchases before entering the bill again under a new id.
  if (outcome.kind === 'unknown' && MISMATCH.test(outcome.message)) {
    const found = await lookupPurchaseRequest(input.shopId, 'purchase.post.v2', input.clientId);
    if (found.kind === 'unavailable') return { kind: 'unknown', message: found.message };
    const billId =
      found.kind === 'committed' && isUuid((found.result as { billId?: unknown })?.billId)
        ? (found.result as { billId: string }).billId
        : null;
    return {
      kind: 'rejected',
      code: 'DSB_PAYLOAD_MISMATCH',
      message: `This request id was already used for a different purchase${
        billId ? ` (bill ${billId})` : ''
      }. Nothing new was saved; check Purchases before entering the bill again.`,
    };
  }
  if (outcome.kind !== 'rejected' || !isRetry) return outcome;

  // A refused retry may follow a committed first send (e.g. a permission revoked in between): the stored
  // answer decides. Only a definitive NOT_FOUND keeps the rejection.
  const found = await lookupPurchaseRequest(input.shopId, 'purchase.post.v2', input.clientId);
  if (found.kind === 'not_found') return outcome;
  if (found.kind === 'unavailable')
    return {
      kind: 'unknown',
      message: `${outcome.message} (the earlier attempt cannot be verified)`,
    };
  const value = ack(found.result);
  return value
    ? { kind: 'committed', value }
    : { kind: 'unknown', message: 'The stored purchase answer could not be verified.' };
}

/** Owner only: voids a cash/UPI bill and its automatic payment together. Same-id retry returns the same answer. */
export async function voidPaidPurchaseOutcome(input: {
  purchaseId: string;
  reason: string;
  clientId: string;
}): Promise<WriteOutcome<{ billId: string; paymentId: string | null; paymentVoided: boolean }>> {
  return rpcOutcome(
    'void_paid_purchase',
    { p_purchase_id: input.purchaseId, p_reason: input.reason, p_client_id: input.clientId },
    (data) => {
      const r = data as Record<string, unknown> | null;
      if (!r || r.billId !== input.purchaseId || typeof r.paymentVoided !== 'boolean') return null;
      if (r.paymentId !== null && !isUuid(r.paymentId)) return null;
      return {
        billId: r.billId as string,
        paymentId: (r.paymentId as string | null) ?? null,
        paymentVoided: r.paymentVoided,
      };
    },
  );
}

/**
 * Settlement derived from the ledger (allocations and returns), never from payment_type: a cash bill whose
 * payment was voided separately shows 'unpaid'.
 */
export type PurchaseSettlement = {
  status: 'settled' | 'partial' | 'unpaid' | 'void' | 'unknown';
  outstandingPaise: string | null;
  allocatedPaise: string | null;
  returnedPaise: string | null;
};
export type PurchaseExtras = {
  /** How the bill was entered. Display only; use `settlement` for whether it is paid. */
  paymentType: PurchasePaymentType;
  notes: string | null;
  lines: { lineNo: number; discountBp: number; gstBp: number | null }[];
  charges: { lineNo: number; label: string; amountPaise: string }[];
  /** Ordered; an old bill without image rows falls back to its single bill_image_path. */
  images: string[];
  settlement: PurchaseSettlement;
};

export function deriveSettlement(
  billStatus: string,
  row: { outstanding_paise: string; allocated_paise: string; returned_paise: string } | null,
): PurchaseSettlement {
  if (billStatus === 'VOID')
    return { status: 'void', outstandingPaise: null, allocatedPaise: null, returnedPaise: null };
  if (!row)
    return { status: 'unknown', outstandingPaise: null, allocatedPaise: null, returnedPaise: null };
  const status =
    BigInt(row.outstanding_paise) === 0n
      ? 'settled'
      : BigInt(row.allocated_paise) > 0n || BigInt(row.returned_paise) > 0n
        ? 'partial'
        : 'unpaid';
  return {
    status,
    outstandingPaise: row.outstanding_paise,
    allocatedPaise: row.allocated_paise,
    returnedPaise: row.returned_paise,
  };
}

export async function getPurchaseExtras(shopId: string, billId: string): Promise<PurchaseExtras> {
  const client = getSupabaseClient();
  const fail = (error: unknown) => new Error(errorMessage(classifyError(error), error));
  const [bill, lines, charges, images, balance] = await Promise.all([
    client
      .from('purchase_bills')
      .select('status,payment_type,notes,bill_image_path')
      .eq('shop_id', shopId)
      .eq('id', billId)
      .single(),
    client
      .from('purchase_bill_items')
      .select('line_no,discount_bp,gst_bp')
      .eq('shop_id', shopId)
      .eq('purchase_bill_id', billId)
      .order('line_no'),
    client
      .from('purchase_bill_charges')
      .select('line_no,label,amount_paise::text')
      .eq('shop_id', shopId)
      .eq('purchase_bill_id', billId)
      .order('line_no'),
    client
      .from('purchase_bill_images')
      .select('sort_order,storage_path')
      .eq('shop_id', shopId)
      .eq('purchase_bill_id', billId)
      .order('sort_order'),
    client
      .from('purchase_bill_outstanding' as never)
      .select('outstanding_paise::text,allocated_paise::text,returned_paise::text')
      .eq('shop_id', shopId)
      .eq('purchase_bill_id', billId)
      .maybeSingle(),
  ]);
  for (const r of [bill, lines, charges, images, balance]) if (r.error) throw fail(r.error);
  const b = bill.data as {
    status: string;
    payment_type: PurchasePaymentType;
    notes: string | null;
    bill_image_path: string | null;
  };
  const imageRows = (images.data ?? []) as { storage_path: string }[];
  return {
    paymentType: b.payment_type,
    notes: b.notes,
    lines: (
      (lines.data ?? []) as { line_no: number; discount_bp: number; gst_bp: number | null }[]
    ).map((l) => ({
      lineNo: l.line_no,
      discountBp: l.discount_bp,
      gstBp: l.gst_bp,
    })),
    charges: (
      (charges.data ?? []) as unknown as { line_no: number; label: string; amount_paise: string }[]
    ).map((c) => ({ lineNo: c.line_no, label: c.label, amountPaise: c.amount_paise })),
    images: imageRows.length
      ? imageRows.map((i) => i.storage_path)
      : b.bill_image_path
        ? [b.bill_image_path]
        : [],
    settlement: deriveSettlement(
      b.status,
      balance.data as unknown as {
        outstanding_paise: string;
        allocated_paise: string;
        returned_paise: string;
      } | null,
    ),
  };
}
