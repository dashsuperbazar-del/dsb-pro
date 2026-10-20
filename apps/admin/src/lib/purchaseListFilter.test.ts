import { describe, expect, it } from 'vitest';
import { filterBills, listBadge } from './purchaseListFilter';

const bill = (id: string, date: string, status: 'POSTED' | 'VOID') =>
  ({ id, business_date: date, status }) as never;
const rows = [
  bill('a', '2026-10-01', 'POSTED'),
  bill('b', '2026-10-05', 'VOID'),
  bill('c', '2026-10-10', 'POSTED'),
];
const ids = (r: { id: string }[]) => r.map((x) => x.id);

describe('filterBills', () => {
  it('filters by status', () => {
    expect(ids(filterBills(rows, { status: 'all', from: '', to: '' }))).toEqual(['a', 'b', 'c']);
    expect(ids(filterBills(rows, { status: 'posted', from: '', to: '' }))).toEqual(['a', 'c']);
    expect(ids(filterBills(rows, { status: 'void', from: '', to: '' }))).toEqual(['b']);
  });
  it('filters by an inclusive date range', () => {
    expect(ids(filterBills(rows, { status: 'all', from: '2026-10-05', to: '2026-10-10' }))).toEqual(
      ['b', 'c'],
    );
    expect(ids(filterBills(rows, { status: 'all', from: '', to: '2026-10-01' }))).toEqual(['a']);
  });
  it('filters posted bills by ledger settlement and labels them', () => {
    const s = (status: string) => ({ status }) as never;
    const map = new Map([
      ['a', s('settled')],
      ['b', s('void')],
    ]);
    expect(ids(filterBills(rows, { status: 'paid', from: '', to: '' }, map))).toEqual(['a']);
    expect(ids(filterBills(rows, { status: 'unpaid', from: '', to: '' }, map))).toEqual([]);
    expect(listBadge(map.get('a'))).toBe('Paid');
    expect(listBadge(map.get('b'))).toBe('Void');
    expect(listBadge(undefined)).toBeNull();
  });
});
