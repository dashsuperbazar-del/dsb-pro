import { describe, it, expect } from 'vitest';
import { toRupeeString } from './paise';

describe('toRupeeString', () => {
  it('formats whole rupees with paise', () => {
    expect(toRupeeString(123456)).toBe('₹1,234.56');
  });

  it('formats zero', () => {
    expect(toRupeeString(0)).toBe('₹0.00');
  });

  it('formats amounts under one rupee', () => {
    expect(toRupeeString(45)).toBe('₹0.45');
  });

  it('formats negative amounts', () => {
    expect(toRupeeString(-500)).toBe('-₹5.00');
  });

  it('applies Indian digit grouping for large amounts', () => {
    expect(toRupeeString(1000000000)).toBe('₹1,00,00,000.00');
  });

  it('throws on non-integer input', () => {
    expect(() => toRupeeString(100.5)).toThrow('integer paise');
  });
});
