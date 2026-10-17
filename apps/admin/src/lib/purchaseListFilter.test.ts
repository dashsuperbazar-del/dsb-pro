import { describe, expect, it } from 'vitest';
import { filterBills } from './purchaseListFilter';

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
});
