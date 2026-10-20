import { describe, expect, it } from 'vitest';
import { roundOffLabel, rupees } from './money';

describe('rupees', () => {
  it('groups in Indian style without floating point', () => {
    expect(rupees('0')).toBe('₹0.00');
    expect(rupees('5')).toBe('₹0.05');
    expect(rupees('123456789')).toBe('₹12,34,567.89');
    expect(rupees('-100000')).toBe('−₹1,000.00');
    expect(rupees(1050)).toBe('₹10.50');
  });
  it('keeps values beyond the safe integer range exact', () => {
    expect(rupees('900719925474099300')).toBe('₹9,00,71,99,25,47,40,993.00');
  });
});

describe('roundOffLabel', () => {
  it('shows a signed round-off only when it is not zero', () => {
    expect(roundOffLabel('9')).toBe('Round off +₹0.09');
    expect(roundOffLabel('-49')).toBe('Round off −₹0.49');
    expect(roundOffLabel(50)).toBe('Round off +₹0.50');
    expect(roundOffLabel('0')).toBeNull();
    expect(roundOffLabel(undefined)).toBeNull();
  });
});
