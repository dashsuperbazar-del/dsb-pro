import { getUnitSpec, type UnitLike, type UnitTier } from './units';
import { multiplyPaiseByRatio } from './fixedPoint';

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
  const factors = (tier: UnitTier): number[] => tier === '1' ? [conv1, conv2] : tier === '2' ? [conv2] : [];
  return multiplyPaiseByRatio(anchorPricePaise, factors(targetTier), factors(anchorTier));
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

  const useWholesale = priceType === 'wholesale' ? wholesaleSale > 0 : retail === 0 && wholesaleSale > 0;
  const anchorPaise = useWholesale ? wholesaleSale : retail;
  if (!anchorPaise) return 0;
  const factors = (tier: UnitTier): number[] => tier === '1' ? [conv1, conv2] : tier === '2' ? [conv2] : [];
  return multiplyPaiseByRatio(
    anchorPaise,
    factors(targetTier),
    [...(useWholesale ? [wholesaleQty] : []), ...factors(priceUnit)],
  );
}
