import type { Party } from '@dsb-pro/adapters';
import { parseRupeesToPaise } from '@dsb-pro/core';
import type { PurchaseDraft } from './purchaseDraft';
import { validStatementDates } from './supplierStatement';

export type QuickBillInput = { supplierId: string; billNo: string; date: string; total: string };

// P06 quick bill: record the paper bill's supplier, number, date and TOTAL now and itemize later. It only
// ever saves an unposted DRAFT with no lines; no money or stock moves until the itemized bill is posted
// through the normal purchase path, which checks the items against this paper total. The duplicate check
// covers drafts on this device only; it cannot see bills already posted.
export function buildQuickBillDraft(
  input: QuickBillInput,
  parties: Party[],
  ctx: {
    now: number;
    newId: () => string;
    today: string;
    existing?: Array<{ supplier: string; billNo: string }>;
  },
): { ok: true; draft: PurchaseDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!parties.some((p) => p.id === input.supplierId)) errors.push('Choose a supplier.');
  const billNo = input.billNo.trim();
  if (!billNo) errors.push('Enter the bill number from the paper bill.');
  if (!validStatementDates(null, input.date)) errors.push('Enter a valid bill date.');
  else if (input.date > ctx.today) errors.push('The bill date is in the future.');
  const total = input.total.trim();
  let totalPaise = 0;
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(total))
    errors.push('Enter the bill total in rupees (at most 2 decimals).');
  else {
    totalPaise = parseRupeesToPaise(total);
    if (totalPaise <= 0) errors.push('The bill total must be greater than zero.');
  }
  if (
    input.supplierId &&
    billNo &&
    ctx.existing?.some(
      (d) =>
        d.supplier === input.supplierId && d.billNo.trim().toLowerCase() === billNo.toLowerCase(),
    )
  )
    errors.push(
      'A draft for this supplier and bill number is already saved on this device. Open it instead.',
    );
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      version: 1,
      clientId: ctx.newId(),
      savedAt: ctx.now,
      supplier: input.supplierId,
      billNo,
      businessDate: input.date,
      discount: '',
      extra: '',
      cart: [],
      search: '',
      lineItem: null,
      unitLevel: 1,
      qty: '',
      price: '',
      editingLine: null,
      expectedTotalPaise: String(totalPaise),
    },
  };
}

// Compares what will be posted with the paper total. Exact integer paise; null when there is no paper total.
export function paperTotalCheck(
  expectedTotalPaise: string | undefined,
  payablePaise: number | null,
): { matches: boolean; diffPaise: number | null } | null {
  if (!expectedTotalPaise) return null;
  if (payablePaise === null) return { matches: false, diffPaise: null };
  const diff = payablePaise - Number(expectedTotalPaise);
  return { matches: diff === 0, diffPaise: diff };
}
