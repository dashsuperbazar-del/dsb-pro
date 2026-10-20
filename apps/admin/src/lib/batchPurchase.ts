import type { Item, Party } from '@dsb-pro/adapters';
import { canonicalQuantity, parseRupeesToPaise } from '@dsb-pro/core';
import { deriveUnitCostFromTotal } from './purchaseCost';
import type { PurchaseDraft } from './purchaseDraft';
import { validStatementDates } from './supplierStatement';

export type BatchRow = {
  billNo: string;
  supplierId: string;
  date: string;
  itemId: string;
  unitLevel: 1 | 2 | 3;
  qty: string;
  costMode: 'unit' | 'total';
  cost: string;
};
export type BatchError = { row: number; message: string };

const RUPEES = /^\d+(\.\d{1,2})?$/;

// Batch entry only ever produces unposted purchase DRAFTS (one single-line bill per row). Nothing is posted
// here: each draft is resumed and posted through the normal purchase path, with its own posting identity.
// All rows are checked first; one bad row means nothing is saved, so a batch is never half-applied.
export function buildBatchDrafts(
  rows: BatchRow[],
  items: Item[],
  parties: Party[],
  ctx: {
    now: number;
    newId: () => string;
    today: string;
    /** Supplier and bill number of drafts already saved on this device. */
    existing?: Array<{ supplier: string; billNo: string }>;
  },
): { drafts: PurchaseDraft[]; errors: BatchError[] } {
  if (rows.length === 0)
    return { drafts: [], errors: [{ row: 0, message: 'Add at least one bill to the batch.' }] };
  const errors: BatchError[] = [];
  const drafts: PurchaseDraft[] = [];
  const seen = new Set<string>();
  rows.forEach((r, index) => {
    const n = index + 1;
    const fail = (message: string) => errors.push({ row: n, message });
    const before = errors.length;
    if (!parties.some((p) => p.id === r.supplierId)) fail('Choose a supplier.');
    const item = items.find((i) => i.id === r.itemId);
    if (!item) fail('Choose an item.');
    if (item) {
      const unit = r.unitLevel === 1 ? item.unit1 : r.unitLevel === 2 ? item.unit2 : item.unit3;
      if (!unit) fail('That item has no such unit.');
    }
    if (!validStatementDates(null, r.date)) fail('Enter a valid bill date.');
    else if (r.date > ctx.today) fail('The bill date is in the future.');
    const billNo = r.billNo.trim();
    if (r.supplierId && billNo) {
      const key = `${r.supplierId}:${billNo.toLowerCase()}`;
      if (seen.has(key)) fail('This supplier and bill number appear twice in the batch.');
      else if (
        ctx.existing?.some(
          (d) =>
            d.supplier === r.supplierId && d.billNo.trim().toLowerCase() === billNo.toLowerCase(),
        )
      )
        fail(
          'A draft for this supplier and bill number is already saved. Open Saved purchase drafts, or remove this row.',
        );
      seen.add(key);
    }
    let qty = '';
    let qtyOk = false;
    try {
      if (!r.qty.trim()) throw new Error('empty');
      qty = canonicalQuantity(r.qty);
      if (/^0(\.0*)?$/.test(qty)) throw new Error('zero');
      qtyOk = true;
    } catch {
      fail('Enter a quantity greater than zero (at most 6 decimals).');
    }
    let unitPricePaise = -1;
    if (r.costMode === 'total') {
      // A bad quantity is already reported above; do not repeat it as a cost error.
      if (qtyOk) {
        const d = deriveUnitCostFromTotal(r.qty, r.cost);
        if (!d.ok) fail(d.message);
        else if (!d.exact)
          fail('That total cannot be stored exactly; enter the cost per unit instead.');
        else unitPricePaise = d.unitPaise;
      }
    } else if (!RUPEES.test(r.cost.trim())) {
      fail('Enter the cost per unit in rupees (at most 2 decimals).');
    } else unitPricePaise = parseRupeesToPaise(r.cost.trim());
    if (errors.length > before || !item) return;
    drafts.push({
      version: 2,
      clientId: ctx.newId(),
      savedAt: ctx.now,
      supplier: r.supplierId,
      billNo,
      businessDate: r.date,
      discount: '',
      extra: '',
      cart: [{ item, unitLevel: r.unitLevel, qty, unitPricePaise }],
      search: '',
      lineItem: null,
      unitLevel: 1,
      qty: '',
      price: '',
      editingLine: null,
    });
  });
  return errors.length ? { drafts: [], errors } : { drafts, errors: [] };
}
