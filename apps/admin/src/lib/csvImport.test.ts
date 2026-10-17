import { describe, expect, it } from 'vitest';
import { batchRowsFromCsv, parseCsv } from './csvImport';

const items = [
  { id: 'i1', name: 'Sugar', unit1: 'bag', unit2: 'kg', unit3: null },
  { id: 'i2', name: 'Oil', unit1: 'tin', unit2: null, unit3: null },
] as never;
const parties = [{ id: 'p1', name: 'Acme Traders' }] as never;
const H = 'Bill No,Supplier,Date,Item,Unit,Qty,Cost,Cost Type';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,"b,c","d""e"\r\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd"e'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('batchRowsFromCsv', () => {
  it('maps names to suppliers, items and units case-insensitively', () => {
    const r = batchRowsFromCsv(
      parseCsv(
        `${H}\nB1,acme traders,2026-10-16,SUGAR,kg,10,45.50,\nB2,Acme Traders,2026-10-16,Oil,1,2,3000,total`,
      ),
      items,
      parties,
    );
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toEqual({
      billNo: 'B1',
      supplierId: 'p1',
      date: '2026-10-16',
      itemId: 'i1',
      unitLevel: 2,
      qty: '10',
      costMode: 'unit',
      cost: '45.50',
    });
    expect(r.rows[1]).toMatchObject({ itemId: 'i2', unitLevel: 1, costMode: 'total' });
  });
  it('refuses the whole file on any unknown name, unit or column, listing each line', () => {
    const r = batchRowsFromCsv(
      parseCsv(
        `${H}\nB1,Nobody,2026-10-16,Sugar,box,1,1,\nB2,Acme Traders,2026-10-16,Rice,,1,1,weird`,
      ),
      items,
      parties,
    );
    expect(r.rows).toEqual([]);
    expect(r.errors).toEqual([
      'Line 2: no supplier named “Nobody”.',
      'Line 2: Sugar has no unit “box”.',
      'Line 3: no item named “Rice”.',
      'Line 3: cost type must be “unit” or “total”.',
    ]);
    expect(batchRowsFromCsv(parseCsv('Supplier,Item\nx,y'), items, parties).errors[0]).toContain(
      'Missing column',
    );
  });
  it('refuses an ambiguous name', () => {
    const twins = [
      ...(items as unknown as object[]),
      { id: 'i3', name: 'sugar', unit1: 'bag' },
    ] as never;
    const r = batchRowsFromCsv(
      parseCsv(`${H}\nB1,Acme Traders,2026-10-16,Sugar,,1,1,`),
      twins,
      parties,
    );
    expect(r.errors).toEqual(['Line 2: more than one item is named “Sugar”.']);
  });
});
