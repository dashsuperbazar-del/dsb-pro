import { describe, expect, it } from 'vitest';
import { priceForUnitFromAnchorPaise, priceForUnitPaise } from './pricing';

describe('sale pricing', () => {
  const item = {
    unit1: 'Carton', unit2: 'Packet', unit3: 'Piece', conv1: 12, conv2: 10,
    priceUnit: '2' as const, retailPaise: 4500, wholesaleSalePaise: 40000, wholesaleQty: 10,
  };

  it('converts secondary anchor retail to base', () => {
    expect(priceForUnitPaise(item, 'retail', '1')).toBe(54000);
  });

  it('keeps secondary anchor retail unchanged', () => {
    expect(priceForUnitPaise(item, 'retail', '2')).toBe(4500);
  });

  it('converts secondary anchor retail to piece', () => {
    expect(priceForUnitPaise(item, 'retail', '3')).toBe(450);
  });

  it('divides wholesaleSale by wholesaleQty before tier conversion', () => {
    expect(priceForUnitPaise(item, 'wholesale', '2')).toBe(4000);
    expect(priceForUnitPaise(item, 'wholesale', '1')).toBe(48000);
  });

  it('falls back to retail if wholesale is unset', () => {
    expect(priceForUnitPaise({ ...item, wholesaleSalePaise: 0 }, 'wholesale', '2')).toBe(4500);
  });

  it('falls back to wholesale if retail is unset', () => {
    expect(priceForUnitPaise({ ...item, retailPaise: 0 }, 'retail', '2')).toBe(4000);
  });

  it('supports base-unit anchor', () => {
    const baseAnchored = { ...item, priceUnit: '1' as const, retailPaise: 120000 };
    expect(priceForUnitPaise(baseAnchored, 'retail', '2')).toBe(10000);
    expect(priceForUnitPaise(baseAnchored, 'retail', '3')).toBe(1000);
  });

  it('supports piece anchor', () => {
    const pieceAnchored = { ...item, priceUnit: '3' as const, retailPaise: 250 };
    expect(priceForUnitPaise(pieceAnchored, 'retail', '2')).toBe(2500);
    expect(priceForUnitPaise(pieceAnchored, 'retail', '1')).toBe(30000);
  });

  it('rounds only when crossing the integer-paise boundary', () => {
    expect(priceForUnitFromAnchorPaise(100, '1', '2', 3, 1)).toBe(33);
  });

  it('rejects invalid paise values', () => {
    expect(() => priceForUnitFromAnchorPaise(1.5, '1', '2', 2, 1)).toThrow(/integer paise/);
  });
});
