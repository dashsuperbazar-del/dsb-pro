import { expect, test } from 'vitest';
import { searchBills, GLOBAL_SEARCH_LIMIT } from './globalSearch';

const bills = [
  {
    id: 'b1',
    number: 'A-12',
    partyName: 'Gupta Traders',
    date: '2026-10-01',
    totalPaise: '125050',
  },
  {
    id: 'b2',
    number: 'INV-125',
    partyName: 'Sharma Agencies',
    date: '2026-10-05',
    totalPaise: 99900,
  },
  { id: 'b3', number: null, partyName: 'Gupta Foods', date: '2026-10-09', totalPaise: '1250' },
];
test('bills match number, party and amount', () => {
  expect(searchBills('a-12', bills).rows.map((b) => b.id)).toEqual(['b1']);
  expect(searchBills('gupta', bills).rows.map((b) => b.id)).toEqual(['b3', 'b1']);
  expect(searchBills('1250.5', bills).rows.map((b) => b.id)).toEqual(['b1']);
  expect(searchBills('₹1,250.50', bills).rows.map((b) => b.id)).toEqual(['b1']);
  expect(searchBills('999', bills).rows.map((b) => b.id)).toEqual(['b2']);
  expect(searchBills('125', bills).rows.map((b) => b.id)).toEqual(['b2']);
  expect(searchBills('1', bills)).toEqual({ rows: [], total: 0 });
});
test('bill results are bounded', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `x${i}`,
    number: `N${i}`,
    partyName: 'Same',
    date: '2026-10-01',
    totalPaise: 100,
  }));
  const r = searchBills('same', many);
  expect(r.rows).toHaveLength(GLOBAL_SEARCH_LIMIT);
  expect(r.total).toBe(25);
});
