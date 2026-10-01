import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';
import { paiseToDecimal } from './money';

describe('compare CSV', () => {
  it('quotes and neutralizes formula-like text, keeps numbers', () => {
    expect(
      toCsv(
        ['Name', 'Amount'],
        [
          [{ text: '=HYPERLINK("x")' }, { num: '-12.50' }],
          [{ text: 'A, B' }, { num: '0.05' }],
        ],
      ),
    ).toBe('Name,Amount\r\n"\'=HYPERLINK(""x"")",-12.50\r\n"A, B",0.05\r\n');
  });
  it('formats paise exactly', () => {
    expect(paiseToDecimal('5')).toBe('0.05');
    expect(paiseToDecimal('-123456')).toBe('-1234.56');
    expect(paiseToDecimal('900719925474099300')).toBe('9007199254740993.00');
    expect(paiseToDecimal(1050)).toBe('10.50');
  });
});
