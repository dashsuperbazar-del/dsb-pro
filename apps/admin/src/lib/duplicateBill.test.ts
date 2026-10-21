import { describe, expect, it } from 'vitest';
import {
  duplicateMessage,
  findDuplicateBill,
  mergeKnownBills,
  type KnownBill,
} from './duplicateBill';

const bill = (over: Partial<KnownBill>): KnownBill => ({
  id: 'b1',
  partyId: 'p1',
  billNo: 'A-12',
  businessDate: '2026-10-18',
  totalPaise: '19450',
  ...over,
});
const cand = (over: Partial<Parameters<typeof findDuplicateBill>[0]> = {}) => ({
  partyId: 'p1',
  billNo: 'a-12 ',
  businessDate: '2026-10-21',
  totalPaise: 100,
  ...over,
});

describe('findDuplicateBill', () => {
  it('matches the same supplier bill number (case/space-insensitive), any date', () => {
    const m = findDuplicateBill(cand({ businessDate: '2026-01-01' }), [bill({})]);
    expect(m?.reason).toBe('bill_no');
    expect(duplicateMessage(m!)).toBe(
      'Possible duplicate of bill #A-12 dated 2026-10-18, ₹194.50 (same supplier and bill number). Post anyway?',
    );
  });
  it('matches same supplier + same total within 3 days only', () => {
    const c = cand({ billNo: null, totalPaise: 19450 });
    expect(findDuplicateBill(c, [bill({})])?.reason).toBe('total');
    expect(findDuplicateBill(c, [bill({ businessDate: '2026-10-17' })])).toBeNull();
    expect(findDuplicateBill(c, [bill({ businessDate: '2026-10-24' })])?.reason).toBe('total');
    expect(findDuplicateBill({ ...c, totalPaise: 19451 }, [bill({})])).toBeNull();
    expect(findDuplicateBill({ ...c, totalPaise: null }, [bill({})])).toBeNull();
  });
  it('ignores other suppliers, void bills and bills without a supplier', () => {
    expect(findDuplicateBill(cand(), [bill({ partyId: 'p2' })])).toBeNull();
    expect(findDuplicateBill(cand(), [bill({ status: 'VOID' })])).toBeNull();
    expect(findDuplicateBill(cand({ partyId: null }), [bill({ partyId: null })])).toBeNull();
  });
  it('prefers a bill-number match over a total match', () => {
    const m = findDuplicateBill(cand({ totalPaise: 500 }), [
      bill({ id: 'x', billNo: 'Z', totalPaise: 500 }),
      bill({ id: 'y', businessDate: '2025-01-01' }),
    ]);
    expect(m).toMatchObject({ reason: 'bill_no', bill: { id: 'y' } });
  });
  it('merges lists, first source wins', () => {
    const merged = mergeKnownBills(
      [bill({ totalPaise: 1 })],
      [bill({ totalPaise: 2 }), bill({ id: 'b2' })],
    );
    expect(merged.map((b) => `${b.id}:${b.totalPaise}`)).toEqual(['b1:1', 'b2:19450']);
  });
});
