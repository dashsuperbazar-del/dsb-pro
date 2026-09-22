import { describe, expect, it } from 'vitest';
import {
  canonicalQuantity,
  divideHalfUp,
  multiplyPaiseByRatio,
  parseQuantityMicros,
  parseRupeesToPaise,
  quantityTimesPaise,
} from './fixedPoint';

describe('fixed-point financial arithmetic', () => {
  it('rounds exact half-paisa ties upward without binary floating point', () => {
    expect(quantityTimesPaise('0.145', 100)).toBe(15);
    expect(quantityTimesPaise('0.144999', 100)).toBe(14);
    expect(quantityTimesPaise('0.145001', 100)).toBe(15);
    expect(divideHalfUp(29n, 2n)).toBe(15n);
  });

  it('supports the minimum and maximum quantity precision', () => {
    expect(parseQuantityMicros('0.000001')).toBe(1n);
    expect(canonicalQuantity('0002.500000')).toBe('2.5');
  });

  it('parses rupees directly to paise with half-up rounding', () => {
    expect(parseRupeesToPaise('1.004999')).toBe(100);
    expect(parseRupeesToPaise('1.005')).toBe(101);
    expect(parseRupeesToPaise('0')).toBe(0);
  });

  it('uses the same rational rule for converted prices', () => {
    expect(multiplyPaiseByRatio(100, [1], [3])).toBe(33);
    expect(multiplyPaiseByRatio(1, [1], [2])).toBe(1);
  });

  it.each(['1e-6', '1.0000001', '-1', 'NaN', 'Infinity'])(
    'rejects non-canonical or excess-precision quantity %s',
    value => expect(() => parseQuantityMicros(value)).toThrow(),
  );

  it('rejects results outside the JavaScript safe integer range', () => {
    expect(() => quantityTimesPaise('2', Number.MAX_SAFE_INTEGER)).toThrow(/safe integer range/);
  });
});
