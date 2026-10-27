import { describe, expect, it } from 'vitest';
import { addQuantity, defaultSellLevel, pickPrice, pushRecent, stockState } from './posPicker';

const p = (kind: string, level: number, shop: string | null, paise: number) => ({
  kind,
  unit_level: level,
  shop_id: shop,
  price_paise: paise,
});

describe('posPicker', () => {
  it('prefers the shop price over the all-shops price, per kind and unit', () => {
    const rows = [
      p('retail', 1, null, 100),
      p('retail', 1, 's1', 120),
      p('wholesale', 1, null, 90),
    ];
    expect(pickPrice(rows, 's1', 'retail', 1)?.price_paise).toBe(120);
    expect(pickPrice(rows, 's2', 'retail', 1)?.price_paise).toBe(100);
    expect(pickPrice(rows, 's1', 'wholesale', 1)?.price_paise).toBe(90);
    expect(pickPrice(rows, 's1', 'retail', 2)).toBeUndefined();
  });
  it('defaults to the largest unit', () => {
    expect(defaultSellLevel({ unit2: null, unit3: null })).toBe(1);
    expect(defaultSellLevel({ unit2: 'box', unit3: null })).toBe(2);
    expect(defaultSellLevel({ unit2: 'box', unit3: 'case' })).toBe(3);
  });
  it('adds quantities exactly', () => {
    expect(addQuantity('1', '1')).toBe('2');
    expect(addQuantity('0.1', '0.2')).toBe('0.3');
    expect(addQuantity('2.5', '1')).toBe('3.5');
    expect(addQuantity('', '1')).toBeNull();
    expect(addQuantity('abc', '1')).toBeNull();
  });
  it('stock chips: unknown shows none', () => {
    expect(stockState(null, 5)).toBeNull();
    expect(stockState(0, 0)).toBe('out');
    expect(stockState(-2, 0)).toBe('out');
    expect(stockState(3, 5)).toBe('low');
    expect(stockState(9, 5)).toBeNull();
    expect(stockState(3, 0)).toBeNull();
  });
  it('recent list keeps an item once, newest first', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });
});
