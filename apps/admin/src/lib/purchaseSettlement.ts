import type { PurchaseSettlement } from '@dsb-pro/adapters';

// Paid/unpaid of a purchase bill comes only from the ledger (getPurchaseExtras().settlement: allocations
// and returns), never from how the bill was entered: a Cash bill whose payment was voided reads "Unpaid".
export function settlementLabel(s: PurchaseSettlement): string {
  switch (s.status) {
    case 'settled':
      return 'Paid';
    case 'partial':
      return 'Part paid';
    case 'unpaid':
      return 'Owed';
    case 'void':
      return 'Void';
    default:
      return 'Payment status unavailable';
  }
}

/** void_paid_purchase is owner-only (voiding a supplier payment is owner-only). */
export function voidPaidAccess(role: string): boolean {
  return role === 'owner';
}
