import { describe, expect, it } from 'vitest';
import { priceForUnitPaise } from './pricing';
import { calculateInvoiceTotals } from './totals';
import { SCREENSHOT_ITEMS } from './screenshot-items.fixture';

type FixtureKey = keyof typeof SCREENSHOT_ITEMS;
type Case = {
  id: string; item: FixtureKey; mode: 'retail' | 'wholesale'; tier: '1' | '2' | '3';
  qty: number; discountBps: number; extraPaise: number;
  expectedUnitPricePaise: number; expectedGrandTotalPaise: number;
};

/**
 * 50 deterministic synthetic invoices built only from real item-master values
 * supplied by the user via DSB screenshots on 2026-09-08.
 *
 * These are stress/golden cases, NOT historical invoice parity evidence.
 * Expected prices/totals are frozen constants so the production functions do
 * not generate their own expected answers.
 */
const CASES: Case[] = [
  { id: 'SYN-01', item: 'pp3x3', mode: 'retail', tier: '1', qty: 1, discountBps: 0, extraPaise: 0, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 24000 },
  { id: 'SYN-02', item: 'pp3x3', mode: 'retail', tier: '2', qty: 0.5, discountBps: 1250, extraPaise: 750, expectedUnitPricePaise: 24, expectedGrandTotalPaise: 760 },
  { id: 'SYN-03', item: 'pp5x6', mode: 'retail', tier: '1', qty: 7, discountBps: 333, extraPaise: 1, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 162407 },
  { id: 'SYN-04', item: 'pp5x6', mode: 'retail', tier: '2', qty: 2, discountBps: 0, extraPaise: 2500, expectedUnitPricePaise: 24, expectedGrandTotalPaise: 2548 },
  { id: 'SYN-05', item: 'butterBake', mode: 'retail', tier: '1', qty: 1.25, discountBps: 1250, extraPaise: 199, expectedUnitPricePaise: 40000, expectedGrandTotalPaise: 43949 },
  { id: 'SYN-06', item: 'butterBake', mode: 'retail', tier: '2', qty: 0.1, discountBps: 333, extraPaise: 50, expectedUnitPricePaise: 1000, expectedGrandTotalPaise: 147 },
  { id: 'SYN-07', item: 'marie', mode: 'retail', tier: '1', qty: 3, discountBps: 0, extraPaise: 0, expectedUnitPricePaise: 72000, expectedGrandTotalPaise: 216000 },
  { id: 'SYN-08', item: 'marie', mode: 'retail', tier: '2', qty: 4, discountBps: 1250, extraPaise: 750, expectedUnitPricePaise: 6000, expectedGrandTotalPaise: 21750 },
  { id: 'SYN-09', item: 'marie', mode: 'retail', tier: '3', qty: 1, discountBps: 333, extraPaise: 1, expectedUnitPricePaise: 500, expectedGrandTotalPaise: 484 },
  { id: 'SYN-10', item: 'honey', mode: 'retail', tier: '1', qty: 0.5, discountBps: 0, extraPaise: 2500, expectedUnitPricePaise: 1000, expectedGrandTotalPaise: 3000 },
  { id: 'SYN-11', item: 'atta', mode: 'retail', tier: '1', qty: 7, discountBps: 1250, extraPaise: 199, expectedUnitPricePaise: 25000, expectedGrandTotalPaise: 153324 },
  { id: 'SYN-12', item: 'pp3x3', mode: 'retail', tier: '1', qty: 2, discountBps: 333, extraPaise: 50, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 46452 },
  { id: 'SYN-13', item: 'pp3x3', mode: 'retail', tier: '2', qty: 1.25, discountBps: 0, extraPaise: 0, expectedUnitPricePaise: 24, expectedGrandTotalPaise: 30 },
  { id: 'SYN-14', item: 'pp5x6', mode: 'retail', tier: '1', qty: 0.1, discountBps: 1250, extraPaise: 750, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 2850 },
  { id: 'SYN-15', item: 'pp5x6', mode: 'retail', tier: '2', qty: 3, discountBps: 333, extraPaise: 1, expectedUnitPricePaise: 24, expectedGrandTotalPaise: 71 },
  { id: 'SYN-16', item: 'butterBake', mode: 'retail', tier: '1', qty: 4, discountBps: 0, extraPaise: 2500, expectedUnitPricePaise: 40000, expectedGrandTotalPaise: 162500 },
  { id: 'SYN-17', item: 'butterBake', mode: 'retail', tier: '2', qty: 1, discountBps: 1250, extraPaise: 199, expectedUnitPricePaise: 1000, expectedGrandTotalPaise: 1074 },
  { id: 'SYN-18', item: 'marie', mode: 'retail', tier: '1', qty: 0.5, discountBps: 333, extraPaise: 50, expectedUnitPricePaise: 72000, expectedGrandTotalPaise: 34851 },
  { id: 'SYN-19', item: 'marie', mode: 'retail', tier: '2', qty: 7, discountBps: 0, extraPaise: 0, expectedUnitPricePaise: 6000, expectedGrandTotalPaise: 42000 },
  { id: 'SYN-20', item: 'marie', mode: 'retail', tier: '3', qty: 2, discountBps: 1250, extraPaise: 750, expectedUnitPricePaise: 500, expectedGrandTotalPaise: 1625 },
  { id: 'SYN-21', item: 'honey', mode: 'retail', tier: '1', qty: 1.25, discountBps: 333, extraPaise: 1, expectedUnitPricePaise: 1000, expectedGrandTotalPaise: 1209 },
  { id: 'SYN-22', item: 'atta', mode: 'retail', tier: '1', qty: 0.1, discountBps: 0, extraPaise: 2500, expectedUnitPricePaise: 25000, expectedGrandTotalPaise: 5000 },
  { id: 'SYN-23', item: 'pp3x3', mode: 'retail', tier: '1', qty: 3, discountBps: 1250, extraPaise: 199, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 63199 },
  { id: 'SYN-24', item: 'pp3x3', mode: 'retail', tier: '2', qty: 4, discountBps: 333, extraPaise: 50, expectedUnitPricePaise: 24, expectedGrandTotalPaise: 143 },
  { id: 'SYN-25', item: 'pp5x6', mode: 'retail', tier: '1', qty: 1, discountBps: 0, extraPaise: 0, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 24000 },
  { id: 'SYN-26', item: 'pp3x3', mode: 'wholesale', tier: '1', qty: 2, discountBps: 2500, extraPaise: 50, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 36050 },
  { id: 'SYN-27', item: 'pp3x3', mode: 'wholesale', tier: '2', qty: 1.25, discountBps: 1000, extraPaise: 0, expectedUnitPricePaise: 24, expectedGrandTotalPaise: 27 },
  { id: 'SYN-28', item: 'pp5x6', mode: 'wholesale', tier: '1', qty: 0.1, discountBps: 500, extraPaise: 750, expectedUnitPricePaise: 22000, expectedGrandTotalPaise: 2840 },
  { id: 'SYN-29', item: 'pp5x6', mode: 'wholesale', tier: '2', qty: 3, discountBps: 2500, extraPaise: 1, expectedUnitPricePaise: 22, expectedGrandTotalPaise: 51 },
  { id: 'SYN-30', item: 'butterBake', mode: 'wholesale', tier: '1', qty: 4, discountBps: 1000, extraPaise: 2500, expectedUnitPricePaise: 36000, expectedGrandTotalPaise: 132100 },
  { id: 'SYN-31', item: 'butterBake', mode: 'wholesale', tier: '2', qty: 1, discountBps: 500, extraPaise: 199, expectedUnitPricePaise: 900, expectedGrandTotalPaise: 1054 },
  { id: 'SYN-32', item: 'marie', mode: 'wholesale', tier: '1', qty: 0.5, discountBps: 2500, extraPaise: 50, expectedUnitPricePaise: 64800, expectedGrandTotalPaise: 24350 },
  { id: 'SYN-33', item: 'marie', mode: 'wholesale', tier: '2', qty: 7, discountBps: 1000, extraPaise: 0, expectedUnitPricePaise: 5400, expectedGrandTotalPaise: 34020 },
  { id: 'SYN-34', item: 'marie', mode: 'wholesale', tier: '3', qty: 2, discountBps: 500, extraPaise: 750, expectedUnitPricePaise: 450, expectedGrandTotalPaise: 1605 },
  { id: 'SYN-35', item: 'honey', mode: 'wholesale', tier: '1', qty: 1.25, discountBps: 2500, extraPaise: 1, expectedUnitPricePaise: 900, expectedGrandTotalPaise: 845 },
  { id: 'SYN-36', item: 'atta', mode: 'wholesale', tier: '1', qty: 0.1, discountBps: 1000, extraPaise: 2500, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 4660 },
  { id: 'SYN-37', item: 'pp3x3', mode: 'wholesale', tier: '1', qty: 3, discountBps: 500, extraPaise: 199, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 68599 },
  { id: 'SYN-38', item: 'pp3x3', mode: 'wholesale', tier: '2', qty: 4, discountBps: 2500, extraPaise: 50, expectedUnitPricePaise: 24, expectedGrandTotalPaise: 122 },
  { id: 'SYN-39', item: 'pp5x6', mode: 'wholesale', tier: '1', qty: 1, discountBps: 1000, extraPaise: 0, expectedUnitPricePaise: 22000, expectedGrandTotalPaise: 19800 },
  { id: 'SYN-40', item: 'pp5x6', mode: 'wholesale', tier: '2', qty: 0.5, discountBps: 500, extraPaise: 750, expectedUnitPricePaise: 22, expectedGrandTotalPaise: 760 },
  { id: 'SYN-41', item: 'butterBake', mode: 'wholesale', tier: '1', qty: 7, discountBps: 2500, extraPaise: 1, expectedUnitPricePaise: 36000, expectedGrandTotalPaise: 189001 },
  { id: 'SYN-42', item: 'butterBake', mode: 'wholesale', tier: '2', qty: 2, discountBps: 1000, extraPaise: 2500, expectedUnitPricePaise: 900, expectedGrandTotalPaise: 4120 },
  { id: 'SYN-43', item: 'marie', mode: 'wholesale', tier: '1', qty: 1.25, discountBps: 500, extraPaise: 199, expectedUnitPricePaise: 64800, expectedGrandTotalPaise: 77149 },
  { id: 'SYN-44', item: 'marie', mode: 'wholesale', tier: '2', qty: 0.1, discountBps: 2500, extraPaise: 50, expectedUnitPricePaise: 5400, expectedGrandTotalPaise: 455 },
  { id: 'SYN-45', item: 'marie', mode: 'wholesale', tier: '3', qty: 3, discountBps: 1000, extraPaise: 0, expectedUnitPricePaise: 450, expectedGrandTotalPaise: 1215 },
  { id: 'SYN-46', item: 'honey', mode: 'wholesale', tier: '1', qty: 4, discountBps: 500, extraPaise: 750, expectedUnitPricePaise: 900, expectedGrandTotalPaise: 4170 },
  { id: 'SYN-47', item: 'atta', mode: 'wholesale', tier: '1', qty: 1, discountBps: 2500, extraPaise: 1, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 18001 },
  { id: 'SYN-48', item: 'pp3x3', mode: 'wholesale', tier: '1', qty: 0.5, discountBps: 1000, extraPaise: 2500, expectedUnitPricePaise: 24000, expectedGrandTotalPaise: 13300 },
  { id: 'SYN-49', item: 'pp3x3', mode: 'wholesale', tier: '2', qty: 7, discountBps: 500, extraPaise: 199, expectedUnitPricePaise: 24, expectedGrandTotalPaise: 359 },
  { id: 'SYN-50', item: 'pp5x6', mode: 'wholesale', tier: '1', qty: 2, discountBps: 2500, extraPaise: 50, expectedUnitPricePaise: 22000, expectedGrandTotalPaise: 33050 },
];

describe('50-case screenshot-backed pricing/totals stress suite', () => {
  it('contains exactly 50 cases balanced across retail and wholesale', () => {
    expect(CASES).toHaveLength(50);
    expect(CASES.filter(c => c.mode === 'retail')).toHaveLength(25);
    expect(CASES.filter(c => c.mode === 'wholesale')).toHaveLength(25);
  });

  it('uses only items with complete visible retail and wholesale sale pricing', () => {
    for (const item of Object.values(SCREENSHOT_ITEMS)) {
      expect(item.retailPaise).toBeGreaterThan(0);
      expect(item.wholesaleSalePaise).toBeGreaterThan(0);
      expect(item.wholesaleQty).toBeGreaterThan(0);
      expect(item.purchasePaise).toBeGreaterThan(0);
      expect(item.unit1).not.toBe('');
      expect(item.conv1).toBeGreaterThan(0);
      expect(item.conv2).toBeGreaterThan(0);
    }
  });

  it.each(CASES)('$id $mode $item tier $tier', testCase => {
    const item = SCREENSHOT_ITEMS[testCase.item];
    const actualUnitPrice = priceForUnitPaise(item, testCase.mode, testCase.tier);
    expect(actualUnitPrice).toBe(testCase.expectedUnitPricePaise);

    const totals = calculateInvoiceTotals(
      [{
        qty: testCase.qty,
        unitPricePaise: actualUnitPrice,
        discountBps: testCase.discountBps,
        taxRateBps: item.taxRateBps,
      }],
      testCase.extraPaise ? [{ name: 'Synthetic stress extra', amountPaise: testCase.extraPaise }] : [],
    );
    expect(totals.grandTotalPaise).toBe(testCase.expectedGrandTotalPaise);
  });
});
