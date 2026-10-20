// "Save as this item's sale price" (salepricing, owner decision 2026-10-20): a typed price is written to the
// item's price list only AFTER its sale is confirmed by the server, through the existing set_item_price, with an
// idempotent request id. Until then the plan waits on this device (per shop). A rejected or missing sale drops
// its plans; a failed write keeps the plan for the next try. No money depends on this: it only changes the
// price offered for later sales.
import { setItemPrice } from '@dsb-pro/adapters';

export type SalePricePlan = {
  saleClientId: string;
  itemId: string;
  itemName: string;
  kind: 'retail' | 'wholesale';
  unitLevel: 1 | 2 | 3;
  pricePaise: number;
};
export type SaleStatus = 'QUEUED' | 'SYNCED' | 'REJECTED' | undefined;

const key = (shopId: string) => `dsb-sale-price-plans:${shopId}`;

export function readSalePricePlans(shopId: string): SalePricePlan[] {
  try {
    const raw = localStorage.getItem(key(shopId));
    const rows: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (r): r is SalePricePlan =>
        !!r &&
        typeof r.saleClientId === 'string' &&
        typeof r.itemId === 'string' &&
        (r.kind === 'retail' || r.kind === 'wholesale') &&
        [1, 2, 3].includes(r.unitLevel) &&
        Number.isSafeInteger(r.pricePaise) &&
        r.pricePaise > 0,
    );
  } catch {
    return [];
  }
}

function writeSalePricePlans(shopId: string, plans: SalePricePlan[]) {
  try {
    if (plans.length) localStorage.setItem(key(shopId), JSON.stringify(plans));
    else localStorage.removeItem(key(shopId));
  } catch {
    // Storage unavailable: the price is simply not saved; the sale itself is unaffected.
  }
}

export function addSalePricePlans(shopId: string, plans: SalePricePlan[]) {
  if (!plans.length) return;
  writeSalePricePlans(shopId, [...readSalePricePlans(shopId), ...plans]);
}

export function salePriceRequestId(plan: SalePricePlan) {
  return `sale-price:${plan.saleClientId}:${plan.itemId}:${plan.kind}:${plan.unitLevel}:${plan.pricePaise}`;
}

/** Writes the prices of confirmed sales. Returns the item names saved and the failures (kept for retry). */
export async function flushSalePricePlans(
  shopId: string,
  statusOf: (saleClientId: string) => Promise<SaleStatus>,
  write: typeof setItemPrice = setItemPrice,
): Promise<{ saved: string[]; failed: string[] }> {
  const saved: string[] = [];
  const failed: string[] = [];
  const keep: SalePricePlan[] = [];
  const initial = readSalePricePlans(shopId);
  for (const plan of initial) {
    const status = await statusOf(plan.saleClientId);
    if (status === 'QUEUED') {
      keep.push(plan);
      continue;
    }
    if (status !== 'SYNCED') continue; // rejected or unknown sale: never save its price
    try {
      await write({
        itemId: plan.itemId,
        shopId,
        kind: plan.kind,
        unitLevel: plan.unitLevel,
        pricePaise: plan.pricePaise,
        clientId: salePriceRequestId(plan),
      });
      saved.push(plan.itemName);
    } catch (e) {
      failed.push(`${plan.itemName}: ${e instanceof Error ? e.message : String(e)}`);
      keep.push(plan);
    }
  }
  // Plans added while this ran (another sale) are kept as they are.
  const seen = new Set(initial.map(salePriceRequestId));
  writeSalePricePlans(shopId, [
    ...keep,
    ...readSalePricePlans(shopId).filter((p) => !seen.has(salePriceRequestId(p))),
  ]);
  return { saved, failed };
}
