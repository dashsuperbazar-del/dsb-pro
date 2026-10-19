import {
  canonicalQuantity,
  purchaseBillTotals,
  PURCHASE_PAYMENT_TYPES,
  type PurchasePaymentType,
} from '@dsb-pro/core';
import { getSupabaseClient } from './client';
import { errorMessage, classifyError } from './errors';
import { isUuid, rpcOutcome, verifyRetryRejection, type WriteOutcome } from './outcomes';

// billextras (mig 0064): purchase bills with payment type, notes, per-line discount/GST, named charges and
// several images. Purchases are online-only (no outbox). post_purchase_v2 replays an exact same-id request
// with the stored answer (same bill and payment ids), so resending after an unknown outcome is safe.

export type PurchaseV2Line = {
  itemId: string;
  unitLevel: 1 | 2 | 3;
  qty: string;
  unitPricePaise: number;
  discountBp?: number;
  gstBp?: number | null;
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
  totalPaise: number;
  businessDate: string;
};

/** The exact p_bill payload, with the line and bill totals the server must agree with. */
export function buildPurchaseV2Payload(input: PurchaseV2Request) {
  const paymentType = input.paymentType ?? 'credit';
  if (!PURCHASE_PAYMENT_TYPES.includes(paymentType)) throw new Error('Choose credit, cash or UPI.');
  if (paymentType !== 'credit' && !input.partyId)
    throw new Error('A cash or UPI bill needs a supplier.');
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
      total_paise: totals.totalPaise,
      lines: input.lines.map((l, i) => ({
        item_id: l.itemId,
        unit_level: l.unitLevel,
        qty: canonicalQuantity(l.qty),
        unit_price_paise: l.unitPricePaise,
        discount_bp: l.discountBp ?? 0,
        gst_bp: l.gstBp ?? null,
        line_total_paise: totals.lineTotalsPaise[i],
      })),
      charges: charges.map((c) => ({ label: c.label, amount_paise: c.amountPaise })),
      images: input.images ?? [],
    },
  };
}

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
  const outcome = await rpcOutcome(
    'post_purchase_v2',
    { p_shop_id: input.shopId, p_client_id: input.clientId, p_bill: payload.bill },
    (data): PurchaseV2Result | null => {
      const r = data as Record<string, unknown> | null;
      if (!r || typeof r !== 'object' || !isUuid(r.billId)) return null;
      if (r.totalPaise !== String(payload.totals.totalPaise)) return null;
      if (paid ? !isUuid(r.paymentId) : r.paymentId !== null) return null;
      if (typeof r.businessDate !== 'string') return null;
      return {
        billId: r.billId,
        paymentId: (r.paymentId as string | null) ?? null,
        totalPaise: payload.totals.totalPaise,
        businessDate: r.businessDate,
      };
    },
  );
  if (outcome.kind !== 'rejected' || !isRetry) return outcome;
  // A refused retry may follow a committed first send: a bill found by its id is committed. A paid bill's
  // payment id cannot be confirmed from the bill row, so that stays unknown (resend the same request).
  const checked = await verifyRetryRejection('purchase_bills', input.clientId, outcome);
  if (checked.kind !== 'committed') return checked;
  if (paid)
    return {
      kind: 'unknown',
      message: 'The bill was saved earlier; send the same request again to confirm its payment.',
    };
  return {
    kind: 'committed',
    value: {
      billId: checked.value,
      paymentId: null,
      totalPaise: payload.totals.totalPaise,
      businessDate: input.businessDate ?? '',
    },
  };
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

export type PurchaseExtras = {
  paymentType: PurchasePaymentType;
  notes: string | null;
  lines: { lineNo: number; discountBp: number; gstBp: number | null }[];
  charges: { lineNo: number; label: string; amountPaise: string }[];
  /** Ordered; an old bill without image rows falls back to its single bill_image_path. */
  images: string[];
};

export async function getPurchaseExtras(shopId: string, billId: string): Promise<PurchaseExtras> {
  const client = getSupabaseClient();
  const fail = (error: unknown) => new Error(errorMessage(classifyError(error), error));
  const [bill, lines, charges, images] = await Promise.all([
    client
      .from('purchase_bills')
      .select('payment_type,notes,bill_image_path')
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
  ]);
  for (const r of [bill, lines, charges, images]) if (r.error) throw fail(r.error);
  const b = bill.data as {
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
  };
}
