import { describe, expect, it } from 'vitest';
import { formatQuantity } from './formatQuantity';

describe('formatQuantity (display only)', () => {
  it('trims trailing zeros from numeric(18,6) text', () => {
    expect(formatQuantity('5.000000')).toBe('5');
    expect(formatQuantity('2.500000')).toBe('2.5');
    expect(formatQuantity('0.125000')).toBe('0.125');
    expect(formatQuantity('10.000001')).toBe('10.000001');
    expect(formatQuantity('100')).toBe('100');
    expect(formatQuantity('-3.250000')).toBe('-3.25');
    expect(formatQuantity('-0.000000')).toBe('0');
  });
  it('handles numbers without float noise and passes through odd input', () => {
    expect(formatQuantity(5)).toBe('5');
    expect(formatQuantity(2.5)).toBe('2.5');
    expect(formatQuantity(0.1 + 0.2)).toBe('0.3');
    expect(formatQuantity(null)).toBe('');
    expect(formatQuantity(undefined)).toBe('');
    expect(formatQuantity('abc')).toBe('abc');
  });
});
