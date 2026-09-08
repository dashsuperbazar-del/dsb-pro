export type UnitTier = '1' | '2' | '3';
export type EntryMode = 'big' | 'small' | 'piece';

export interface UnitLike {
  unit1?: string;
  unit2?: string;
  unit3?: string;
  bigUnit?: string;
  smallUnit?: string;
  conv1?: number;
  conv2?: number;
  conversion?: number;
  priceUnit?: UnitTier;
}

export interface UnitSpec {
  unit1: string;
  unit2: string;
  unit3: string;
  conv1: number;
  conv2: number;
  hasUnit2: boolean;
  hasUnit3: boolean;
  priceUnit: UnitTier;
  priceUnitName: string;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Pure port of DSB's getUnitSpec semantics.
 * strict=true hides stale child tiers whose conversion is not actually > 1.
 */
export function getUnitSpec(item: UnitLike | undefined, strict = false): UnitSpec {
  const unit1 = (item?.unit1 || item?.bigUnit || '').trim();
  const unit2 = (item?.unit2 || item?.smallUnit || '').trim();
  const unit3 = (item?.unit3 || '').trim();
  const conv1 = positiveOr(item?.conv1 ?? item?.conversion, 1);
  const conv2 = positiveOr(item?.conv2, 1);

  const hasUnit2 = strict
    ? Boolean(unit2 && unit2.toLowerCase() !== unit1.toLowerCase() && conv1 > 1)
    : Boolean(unit2);
  const hasUnit3 = strict
    ? Boolean(unit3 && conv2 > 1)
    : Boolean(unit2 && unit3);
  const priceUnit: UnitTier = item?.priceUnit === '1' || item?.priceUnit === '3' ? item.priceUnit : '2';
  const priceUnitName = priceUnit === '1' ? unit1 : priceUnit === '3' ? (unit3 || unit2 || unit1) : (unit2 || unit1);

  return { unit1, unit2, unit3, conv1, conv2, hasUnit2, hasUnit3, priceUnit, priceUnitName };
}

export function unitTierForName(item: UnitLike, unitName: string): UnitTier {
  const name = unitName.trim().toLowerCase();
  const unit3 = (item.unit3 || '').trim().toLowerCase();
  const unit1 = (item.unit1 || item.bigUnit || '').trim().toLowerCase();
  if (unit3 && name === unit3) return '3';
  if (unit1 && name === unit1) return '1';
  return '2';
}

export function entryModeForTier(tier: UnitTier): EntryMode {
  if (tier === '1') return 'big';
  if (tier === '3') return 'piece';
  return 'small';
}

export function smallestUnitsPerTier(item: UnitLike, tier: UnitTier): number {
  const { conv1, conv2 } = getUnitSpec(item);
  if (tier === '1') return conv1 * conv2;
  if (tier === '2') return conv2;
  return 1;
}

export interface BigEquivLine {
  qty: number;
  entryMode?: EntryMode;
  isBigUnit?: boolean;
  conv1?: number;
  conv2?: number;
  conversion?: number;
}

/**
 * Exact behavioral port of legacy DSB calcBigEquiv().
 * Invoice-snapshotted conversion values win over the current item master.
 */
export function calcBigEquiv(line: BigEquivLine, masterItem?: UnitLike): number {
  if (!Number.isFinite(line.qty) || line.qty < 0) throw new Error('qty must be a finite non-negative number');
  const conv1 = positiveOr(line.conv1 ?? line.conversion ?? masterItem?.conv1 ?? masterItem?.conversion, 1);
  const conv2 = positiveOr(line.conv2 ?? masterItem?.conv2, 1);
  if (line.entryMode === 'piece') return line.qty / (conv1 * conv2);
  if (line.isBigUnit) return line.qty;
  return line.qty / conv1;
}
