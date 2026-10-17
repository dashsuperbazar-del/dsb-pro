import { describe, expect, it } from 'vitest';
import { buildQuickBillDraft, paperTotalCheck } from './quickBill';
import { restorePurchaseDraft } from './purchaseDraft';

const parties = [{ id: 'p1', name: 'Acme' }] as never;
const ctx = { now: 1, newId: () => 'id1', today: '2026-10-17' };
const ok = { supplierId: 'p1', billNo: ' B-7 ', date: '2026-10-16', total: '1250.50' };

describe('buildQuickBillDraft', () => {
  it('saves a line-free draft carrying the exact paper total', () => {
    const r = buildQuickBillDraft(ok, parties, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft).toMatchObject({
      supplier: 'p1',
      billNo: 'B-7',
      businessDate: '2026-10-16',
      cart: [],
      expectedTotalPaise: '125050',
    });
    // The draft is readable by the normal restore path.
    expect(restorePurchaseDraft(r.draft, [], parties).expectedTotalPaise).toBe('125050');
  });
  it('reports every problem and saves nothing', () => {
    const r = buildQuickBillDraft(
      { supplierId: 'x', billNo: ' ', date: '2026-10-18', total: '10.005' },
      parties,
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(4);
  });
  it('refuses a zero total and a duplicate of a saved draft', () => {
    expect(buildQuickBillDraft({ ...ok, total: '0' }, parties, ctx).ok).toBe(false);
    const dup = buildQuickBillDraft(ok, parties, {
      ...ctx,
      existing: [{ supplier: 'p1', billNo: 'b-7' }],
    });
    expect(dup.ok).toBe(false);
  });
});

describe('paperTotalCheck', () => {
  it('compares exact paise and flags an unknown payable', () => {
    expect(paperTotalCheck(undefined, 5)).toBeNull();
    expect(paperTotalCheck('125050', 125050)).toEqual({ matches: true, diffPaise: 0 });
    expect(paperTotalCheck('125050', 125000)).toEqual({ matches: false, diffPaise: -50 });
    expect(paperTotalCheck('125050', null)).toEqual({ matches: false, diffPaise: null });
  });
});

describe('purchase draft check', () => {
  it('refuses an unreadable paper total', () => {
    const r = buildQuickBillDraft(ok, parties, ctx);
    if (!r.ok) throw new Error('setup');
    expect(() =>
      restorePurchaseDraft({ ...r.draft, expectedTotalPaise: '0' }, [], parties),
    ).toThrow(/paper bill total/);
  });
});

describe('paper total edges', () => {
  const total = (t: string) => {
    const r = buildQuickBillDraft({ ...ok, total: t }, parties, ctx);
    return r.ok ? r.draft.expectedTotalPaise : null;
  };
  it('converts exactly and accepts the largest allowed total', () => {
    expect(total('0.01')).toBe('1');
    expect(total('1.5')).toBe('150');
    expect(total('007')).toBe('700');
    const max = buildQuickBillDraft({ ...ok, total: '999999999999.99' }, parties, ctx);
    expect(max.ok && restorePurchaseDraft(max.draft, [], parties).expectedTotalPaise).toBe(
      '99999999999999',
    );
  });
  it('refuses zero in any spelling', () => {
    expect(total('0.00')).toBeNull();
    expect(total('0')).toBeNull();
  });
});
