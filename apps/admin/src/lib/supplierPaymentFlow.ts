import {
  allocateSupplierPayment,
  recordSupplierPayment,
  releaseSupplierAllocation,
  voidSupplierPayment,
  type PaymentMode,
  type SupplierBill,
  type SupplierWriteOutcome,
} from '@dsb-pro/adapters';
import type { FinancialAttempt } from './offlineSync';

export type RecordPayload = {
  shopId: string;
  partyId: string;
  businessDate: string | null;
  amountPaise: string;
  mode: PaymentMode;
  reference: string | null;
  allocations: { purchaseBillId: string; amountPaise: string }[];
};

// Each operation is sent with the attempt's own id as the request id -- never a fresh one.
export function supplierSender(attempt: FinancialAttempt): Promise<SupplierWriteOutcome> {
  const p = attempt.payload as Record<string, unknown>;
  switch (attempt.operation) {
    case 'supplier.record.v1':
      return recordSupplierPayment({ requestId: attempt.id, ...(p as RecordPayload) });
    case 'supplier.allocate.v1':
      return allocateSupplierPayment({
        requestId: attempt.id,
        paymentId: String(p.paymentId),
        allocations: p.allocations as RecordPayload['allocations'],
      });
    case 'supplier.void.v1':
      return voidSupplierPayment({
        requestId: attempt.id,
        paymentId: String(p.paymentId),
        reason: String(p.reason),
      });
    case 'supplier.release.v1':
      return releaseSupplierAllocation({
        requestId: attempt.id,
        allocationId: String(p.allocationId),
        reason: String(p.reason),
      });
    default:
      // Customer attempts belong to the Customers screen; never send them from here.
      return Promise.resolve({ kind: 'unknown', message: 'Not a supplier request.' });
  }
}

// Oldest bill first (date, then id). Exact integer paise; whatever is left over stays as an advance.
export function fifoAllocate(
  bills: Pick<SupplierBill, 'purchase_bill_id' | 'business_date' | 'outstanding_paise'>[],
  amountPaise: bigint,
): { allocations: { purchaseBillId: string; amountPaise: string }[]; remainderPaise: bigint } {
  let remaining = amountPaise;
  const allocations: { purchaseBillId: string; amountPaise: string }[] = [];
  for (const bill of [...bills].sort(
    (a, b) =>
      a.business_date.localeCompare(b.business_date) ||
      a.purchase_bill_id.localeCompare(b.purchase_bill_id),
  )) {
    const due = BigInt(bill.outstanding_paise);
    const take = remaining < due ? remaining : due;
    if (take > 0n) {
      allocations.push({ purchaseBillId: bill.purchase_bill_id, amountPaise: take.toString() });
      remaining -= take;
    }
  }
  return { allocations, remainderPaise: remaining };
}
