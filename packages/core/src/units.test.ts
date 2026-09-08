import { describe, expect, it } from 'vitest';
import { calcBigEquiv, entryModeForTier, getUnitSpec, smallestUnitsPerTier, unitTierForName } from './units';

describe('unit engine', () => {
  const item = { unit1: 'Carton', unit2: 'Packet', unit3: 'Piece', conv1: 12, conv2: 10, priceUnit: '2' as const };

  it('matches legacy calcBigEquiv for base quantity', () => {
    expect(calcBigEquiv({ qty: 3, isBigUnit: true }, item)).toBe(3);
  });

  it('matches legacy calcBigEquiv for secondary quantity', () => {
    expect(calcBigEquiv({ qty: 24, isBigUnit: false }, item)).toBe(2);
  });

  it('matches legacy calcBigEquiv for piece quantity', () => {
    expect(calcBigEquiv({ qty: 240, entryMode: 'piece', isBigUnit: false }, item)).toBe(2);
  });

  it('uses snapshotted line conversions before current master values', () => {
    expect(calcBigEquiv({ qty: 20, entryMode: 'piece', conv1: 5, conv2: 2 }, item)).toBe(2);
  });

  it('supports legacy conversion alias', () => {
    expect(calcBigEquiv({ qty: 24, conversion: 12, isBigUnit: false })).toBe(2);
  });

  it('rejects negative quantities', () => {
    expect(() => calcBigEquiv({ qty: -1, isBigUnit: true }, item)).toThrow(/qty/);
  });

  it('strict spec hides stale secondary tier', () => {
    expect(getUnitSpec({ unit1: 'pcs', unit2: 'pcs', conv1: 1 }, true).hasUnit2).toBe(false);
  });

  it('strict spec hides third tier without conversion', () => {
    expect(getUnitSpec({ unit1: 'box', unit2: 'pkt', unit3: 'pc', conv1: 6, conv2: 1 }, true).hasUnit3).toBe(false);
  });

  it('maps unit names to tiers with secondary fallback', () => {
    expect(unitTierForName(item, 'Piece')).toBe('3');
    expect(unitTierForName(item, 'Carton')).toBe('1');
    expect(unitTierForName(item, 'Packet')).toBe('2');
  });

  it('maps tiers to entry modes', () => {
    expect(entryModeForTier('1')).toBe('big');
    expect(entryModeForTier('2')).toBe('small');
    expect(entryModeForTier('3')).toBe('piece');
  });

  it('reports smallest-unit factors', () => {
    expect(smallestUnitsPerTier(item, '1')).toBe(120);
    expect(smallestUnitsPerTier(item, '2')).toBe(10);
    expect(smallestUnitsPerTier(item, '3')).toBe(1);
  });
});
