import { expect, test } from 'vitest';
import { summarizeLowStock, summarizeSuppliers } from './attention';

test('low stock: count, worst three by shortfall, and an honest empty', () => {
  expect(summarizeLowStock([])).toEqual({ count: 0, worst: [] });
  const rows = [
    { item_id: 'a', item_name: 'Oil', unit_name: 'jar', on_hand: 1, min_stock: 5, shortfall: 4 },
    { item_id: 'b', item_name: 'Rice', unit_name: 'kg', on_hand: 0, min_stock: 50, shortfall: 50 },
    { item_id: 'c', item_name: 'Tea', unit_name: 'box', on_hand: 2, min_stock: 4, shortfall: 2 },
    { item_id: 'd', item_name: 'Salt', unit_name: 'kg', on_hand: 9, min_stock: 10, shortfall: 1 },
  ];
  const s = summarizeLowStock(rows);
  expect(s.count).toBe(4);
  expect(s.worst.map((r) => r.item_name)).toEqual(['Rice', 'Oil', 'Tea']);
});

test('suppliers: only positive net balances are owed, summed exactly; advances are not netted away', () => {
  const row = (id: string, net: string, stranded = 0) => ({
    partyId: id,
    partyName: id,
    grossOpenBills: '0',
    unallocatedCashAdvances: '0',
    returnCredits: '0',
    netLedgerBalance: net,
    strandedAllocationsOnVoidBills: stranded,
  });
  const s = summarizeSuppliers([
    row('a', '9007199254740993'),
    row('b', '-500'),
    row('c', '7'),
    row('d', '0', 2),
  ]);
  expect(s.owedCount).toBe(2);
  expect(s.owedPaise).toBe('9007199254741000');
  expect(s.strandedSuppliers).toBe(1);
});
