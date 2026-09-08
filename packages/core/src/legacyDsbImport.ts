import { priceForUnitPaise } from './pricing';
import type { UnitTier } from './units';

type JsonObject = Record<string, unknown>;

export type LegacyDsbImportPrice = {
  kind: 'retail' | 'wholesale';
  unitLevel: 1 | 2 | 3;
  pricePaise: number;
};

export type LegacyDsbImportItem = {
  legacyId: string;
  name: string;
  unit1: string;
  unit2: string | null;
  unit3: string | null;
  conv1: number | null;
  conv2: number | null;
  taxRateBp: number;
  isActive: boolean;
  openingStockSmallest: number;
  prices: LegacyDsbImportPrice[];
};

export type LegacyDsbImportParty = {
  legacyId: string;
  name: string;
  phone: string | null;
  gstin: string | null;
  address: string | null;
};

export type LegacyDsbImportCustomer = {
  legacyId: string;
  name: string;
  phone: string | null;
  address: string | null;
  gstin: string | null;
  creditLimitPaise: number;
  notes: string | null;
};

export type LegacyDsbImportPlan = {
  sourceVersion: number;
  exportedAt: string;
  items: LegacyDsbImportItem[];
  parties: LegacyDsbImportParty[];
  customers: LegacyDsbImportCustomer[];
  warnings: string[];
};

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function number(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function positive(value: unknown, fallback = 1): number {
  const n = number(value, fallback);
  return n > 0 ? n : fallback;
}
function paise(value: unknown): number { return Math.max(0, Math.round(number(value) * 100)); }

export function buildLegacyDsbImportPlan(snapshot: unknown): LegacyDsbImportPlan {
  const root = object(snapshot);
  if (!root) throw new Error('Backup must be a JSON object.');
  const sourceVersion = Math.trunc(number(root.version));
  if (sourceVersion !== 3) throw new Error(`Unsupported DSB backup version: ${sourceVersion || 'unknown'}.`);
  const exportedAt = text(root.exportedAt);
  if (!exportedAt || Number.isNaN(Date.parse(exportedAt))) throw new Error('Backup exportedAt timestamp is missing or invalid.');

  const warnings: string[] = [];
  const rawItems = Array.isArray(root.items) ? root.items : [];
  const rawParties = Array.isArray(root.parties) ? root.parties : [];
  const rawCustomers = Array.isArray(root.customers) ? root.customers : [];
  if (!rawItems.length) throw new Error('Backup contains no item master.');

  const items: LegacyDsbImportItem[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawItems) {
    const row = object(raw);
    if (!row) { warnings.push('Skipped a malformed item row.'); continue; }
    const legacyId = text(row.id);
    const name = text(row.name);
    const unit1 = text(row.unit1) || text(row.bigUnit);
    const unit2 = text(row.unit2) || text(row.smallUnit) || null;
    const unit3 = text(row.unit3) || null;
    if (!legacyId || !name) { warnings.push('Skipped an item with no id or name.'); continue; }
    if (seenIds.has(legacyId)) { warnings.push(`Skipped duplicate legacy item id ${legacyId} (${name}).`); continue; }
    seenIds.add(legacyId);
    if (!unit1) { warnings.push(`Skipped ${name}: base unit is missing in legacy DSB.`); continue; }
    if (unit3 && !unit2) { warnings.push(`Skipped ${name}: third unit exists without a secondary unit.`); continue; }

    const conv1 = unit2 ? positive(row.conv1 ?? row.conversion) : null;
    const conv2 = unit3 ? positive(row.conv2) : null;
    const effectiveConv1 = conv1 ?? 1;
    const effectiveConv2 = conv2 ?? 1;
    const requestedPriceUnit = text(row.priceUnit);
    const priceUnit: UnitTier = requestedPriceUnit === '1' || requestedPriceUnit === '3' ? requestedPriceUnit : '2';

    const retailPaise = paise(row.retail);
    const wholesaleSalePaise = paise(row.wholesaleSale);
    const wholesaleQty = positive(row.wholesaleQty, 1);
    const priceLike = {
      unit1, unit2: unit2 ?? undefined, unit3: unit3 ?? undefined,
      conv1: effectiveConv1, conv2: effectiveConv2, priceUnit,
      retailPaise, wholesaleSalePaise, wholesaleQty,
    };
    const levels: Array<1|2|3> = [1];
    if (unit2) levels.push(2);
    if (unit3) levels.push(3);
    const prices: LegacyDsbImportPrice[] = [];
    for (const level of levels) {
      for (const kind of ['retail','wholesale'] as const) {
        const value = priceForUnitPaise(priceLike, kind, String(level) as UnitTier);
        if (value > 0) prices.push({ kind, unitLevel: level, pricePaise: value });
      }
    }
    if (!prices.length) warnings.push(`${name}: no usable sale price in legacy DSB.`);

    const legacyStockBase = number(row.stock);
    let openingStockSmallest = legacyStockBase * effectiveConv1 * effectiveConv2;
    if (legacyStockBase < 0) {
      warnings.push(`${name}: legacy stock is negative (${legacyStockBase} ${unit1}); DSB Pro opening stock is clamped to zero.`);
      openingStockSmallest = 0;
    }
    if (!Number.isFinite(openingStockSmallest) || openingStockSmallest < 0) openingStockSmallest = 0;

    items.push({
      legacyId,name,unit1,unit2,unit3,conv1,conv2,
      taxRateBp: Math.max(0, Math.min(10000, Math.round(number(row.gst) * 100))),
      isActive: row.isActive !== false,
      openingStockSmallest,
      prices,
    });
  }

  const parties: LegacyDsbImportParty[] = [];
  const seenPartyIds = new Set<string>();
  for (const raw of rawParties) {
    const row=object(raw); if(!row) continue;
    const legacyId=text(row.id), name=text(row.name);
    if(!legacyId||!name||seenPartyIds.has(legacyId)) continue;
    seenPartyIds.add(legacyId);
    parties.push({legacyId,name,phone:text(row.phone)||null,gstin:text(row.gstin)||null,address:text(row.address)||null});
  }

  const customers: LegacyDsbImportCustomer[] = [];
  const seenCustomerIds = new Set<string>();
  for (const raw of rawCustomers) {
    const row=object(raw); if(!row) continue;
    const legacyId=text(row.id), name=text(row.name);
    if(!legacyId||!name||seenCustomerIds.has(legacyId)) continue;
    seenCustomerIds.add(legacyId);
    if (name.toLowerCase() === 'walk-in customer') continue;
    customers.push({
      legacyId,name,phone:text(row.phone)||null,address:text(row.address)||null,gstin:text(row.gstin)||null,
      creditLimitPaise:paise(row.creditLimit),notes:text(row.notes)||null,
    });
  }

  return {sourceVersion,exportedAt,items,parties,customers,warnings};
}
