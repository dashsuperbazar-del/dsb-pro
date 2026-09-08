import { getUnitSpec, type UnitLike, type UnitTier } from './units';

export type PriceType = 'retail' | 'wholesale';

export interface PricedItem extends UnitLike {
  retailPaise?: number;
  wholesaleSalePaise?: number;
  wholesaleQty?: number;
}

function assertPaise(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer paise value`);
}

/**
 * Converts an anchor-unit price to another unit tier. This is the integer-paise
 * equivalent of legacy DSB priceForUnitFromAnchor(). Rounding happens only at
 * the public money boundary so no fractional paise leaves packages/core.
 */
export function priceForUnitFromAnchorPaise(
  anchorPricePaise: number,
  anchorTier: UnitTier,
  targetTier: UnitTier,
  conv1: number,
  conv2: number,
): number {
  assertPaise(anchorPricePaise, 'anchorPricePaise');
  if (!Number.isFinite(conv1) || conv1 <= 0 || !Number.isFinite(conv2) || conv2 <= 0) {
    throw new Error('conversion factors must be finite positive numbers');
  }
  const toSmallest: Record<UnitTier, number> = {
    '1': conv1 * conv2,
    '2': conv2,
    '3': 1,
  };
  return Math.round(anchorPricePaise * toSmallest[targetTier] / toSmallest[anchorTier]);
}

/**
 * Port of DSB priceForUnit(): retail is per priceUnit anchor; wholesaleSale is
 * the price for wholesaleQty anchor units. If the selected price type is zero,
 * DSB falls back to the other configured sale price.
 */
export function priceForUnitPaise(item: PricedItem, priceType: PriceType, targetTier: UnitTier): number {
  const { conv1, conv2, priceUnit } = getUnitSpec(item);
  const retail = item.retailPaise ?? 0;
  const wholesaleSale = item.wholesaleSalePaise ?? 0;
  const wholesaleQty = item.wholesaleQty ?? 1;
  assertPaise(retail, 'retailPaise');
  assertPaise(wholesaleSale, 'wholesaleSalePaise');
  if (!Number.isFinite(wholesaleQty) || wholesaleQty <= 0) throw new Error('wholesaleQty must be positive');

  const wholesalePerAnchor = wholesaleSale > 0 ? wholesaleSale / wholesaleQty : 0;
  const preferred = priceType === 'wholesale' ? wholesalePerAnchor : retail;
  const fallback = priceType === 'wholesale' ? retail : wholesalePerAnchor;
  const anchor = preferred || fallback;
  if (!anchor) return 0;

  return Math.round(anchor * ({ '1': conv1 * conv2, '2': conv2, '3': 1 }[targetTier]) /
    ({ '1': conv1 * conv2, '2': conv2, '3': 1 }[priceUnit]));
}
