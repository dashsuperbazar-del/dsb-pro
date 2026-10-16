import { expect, test } from 'vitest';
import {
  prepareCustomerStatement,
  customerStatementCsv,
  customerStatementText,
  type LedgerRow,
} from './customerStatement';

const row = (
  id: string,
  date: string,
  type: LedgerRow['entry_type'],
  debit: number,
  credit: number,
  at = `${date}T10:00:00Z`,
): LedgerRow => ({
  customer_id: 'c1',
  business_date: date,
  created_at: at,
  entry_type: type,
  ref_id: id,
  reference: `Doc ${id}`,
  debit_paise: debit,
  credit_paise: credit,
});
const rows = [
  row('a', '2026-09-01', 'SALE', 10000, 0),
  row('b', '2026-09-10', 'PAYMENT', 0, 4000),
  row('c', '2026-10-02', 'SALE', 2500, 0),
  row('d', '2026-10-05', 'SALE_RETURN', 0, 500),
  row('e', '2026-10-06', 'REFUND', 300, 0),
];
const profile = { id: 's', name: 'Shop', address: 'Road', gstin: null };
const make = (r = rows, bal = 8300, from: string | null = '2026-10-01', to = '2026-10-31') =>
  prepareCustomerStatement(
    r,
    bal,
    { shopId: 's', customerId: 'c1', from, to },
    profile,
    'Asha',
    'T',
  );

test('opening is everything before From; running balance follows debit minus credit', () => {
  const s = make();
  expect(s.openingBalancePaise).toBe('6000');
  expect(s.entries.map((e) => [e.kind, e.amountPaise, e.runningBalancePaise])).toEqual([
    ['SALE', '2500', '8500'],
    ['SALE_RETURN', '-500', '8000'],
    ['REFUND', '300', '8300'],
  ]);
  expect(s.closingBalancePaise).toBe('8300');
});

test('the full ledger must equal the server balance, otherwise no statement is produced', () => {
  expect(() => make(rows, 8300 + 1)).toThrow(/reconcile/i);
  // closing at an earlier date is fine: reconciliation uses the whole ledger
  expect(make(rows, 8300, null, '2026-09-30').closingBalancePaise).toBe('6000');
});

test('rows are ordered by date, then creation time, then id regardless of input order', () => {
  const s = make([...rows].reverse());
  expect(s.entries.map((e) => e.id)).toEqual(['c', 'd', 'e']);
});

test('invalid amounts, unknown types and rows of another customer are refused', () => {
  expect(() => make([...rows, { ...row('x', '2026-10-03', 'SALE', 1.5, 0) }], 8300)).toThrow();
  expect(() => make([...rows, { ...row('x', '2026-10-03', 'SALE', -5, 0) }], 8300)).toThrow();
  expect(() =>
    make(
      [...rows, { ...row('x', '2026-10-03', 'SALE', 5, 0), entry_type: 'OTHER' as never }],
      8305,
    ),
  ).toThrow();
  expect(() =>
    make([...rows, { ...row('x', '2026-10-03', 'SALE', 5, 0), customer_id: 'zz' }], 8305),
  ).toThrow();
});

test('bad dates are refused', () => {
  expect(() => make(rows, 8300, '2026-11-01', '2026-10-01')).toThrow();
  expect(() => make(rows, 8300, null, '2026-13-40')).toThrow();
});

test('text and CSV carry the sign convention, exact rupees, and neutralise formulas', () => {
  const s = make([...rows.slice(0, 4), { ...rows[4], reference: '=HYPERLINK("x")' }]);
  const t = customerStatementText(s);
  expect(t).toContain('Customer statement');
  expect(t).toContain('owes the shop');
  expect(t).toContain('Opening: ₹60.00');
  const csv = customerStatementCsv(s);
  expect(csv).toContain("'=HYPERLINK");
  expect(csv).toContain('83.00');
});
