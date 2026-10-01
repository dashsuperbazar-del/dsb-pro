import { describe, expect, it } from 'vitest';
import { rupees } from './money';

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
