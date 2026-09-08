import { describe, expect, it } from 'vitest';
import { priceForUnitPaise } from './pricing';
import { calculateInvoiceTotals } from './totals';
import { SCREENSHOT_ITEMS } from './screenshot-items.fixture';

type K = keyof typeof SCREENSHOT_ITEMS;
type M = 'retail' | 'wholesale';
type T = '1' | '2' | '3';
type C = [string, K, M, T, number, number, number, number, number];

const CASES: C[] = [
  ['SYN-01','pp3x3','retail','1',1,0,0,24000,24000],
  ['SYN-02','pp3x3','retail','2',0.5,1250,750,24,760],
  ['SYN-03','pp5x6','retail','1',7,333,1,24000,162407],
  ['SYN-04','pp5x6','retail','2',2,0,2500,24,2548],
  ['SYN-05','butterBake','retail','1',1.25,1250,199,40000,43949],
  ['SYN-06','butterBake','retail','2',0.1,333,50,1000,147],
  ['SYN-07','marie','retail','1',3,0,0,72000,216000],
  ['SYN-08','marie','retail','2',4,1250,750,6000,21750],
  ['SYN-09','marie','retail','3',1,333,1,500,484],
  ['SYN-10','honey','retail','1',0.5,0,2500,1000,3000],
  ['SYN-11','atta','retail','1',7,1250,199,25000,153324],
  ['SYN-12','pp3x3','retail','1',2,333,50,24000,46452],
  ['SYN-13','pp3x3','retail','2',1.25,0,0,24,30],
  ['SYN-14','pp5x6','retail','1',0.1,1250,750,24000,2850],
  ['SYN-15','pp5x6','retail','2',3,333,1,24,71],
  ['SYN-16','butterBake','retail','1',4,0,2500,40000,162500],
  ['SYN-17','butterBake','retail','2',1,1250,199,1000,1074],
  ['SYN-18','marie','retail','1',0.5,333,50,72000,34851],
  ['SYN-19','marie','retail','2',7,0,0,6000,42000],
  ['SYN-20','marie','retail','3',2,1250,750,500,1625],
  ['SYN-21','honey','retail','1',1.25,333,1,1000,1209],
  ['SYN-22','atta','retail','1',0.1,0,2500,25000,5000],
  ['SYN-23','pp3x3','retail','1',3,1250,199,24000,63199],
  ['SYN-24','pp3x3','retail','2',4,333,50,24,143],
  ['SYN-25','pp5x6','retail','1',1,0,0,24000,24000],
  ['SYN-26','pp3x3','wholesale','1',2,2500,50,24000,36050],
  ['SYN-27','pp3x3','wholesale','2',1.25,1000,0,24,27],
  ['SYN-28','pp5x6','wholesale','1',0.1,500,750,22000,2840],
  ['SYN-29','pp5x6','wholesale','2',3,2500,1,22,50],
  ['SYN-30','butterBake','wholesale','1',4,1000,2500,36000,132100],
  ['SYN-31','butterBake','wholesale','2',1,500,199,900,1054],
  ['SYN-32','marie','wholesale','1',0.5,2500,50,64800,24350],
  ['SYN-33','marie','wholesale','2',7,1000,0,5400,34020],
  ['SYN-34','marie','wholesale','3',2,500,750,450,1605],
  ['SYN-35','honey','wholesale','1',1.25,2500,1,900,845],
  ['SYN-36','atta','wholesale','1',0.1,1000,2500,24000,4660],
  ['SYN-37','pp3x3','wholesale','1',3,500,199,24000,68599],
  ['SYN-38','pp3x3','wholesale','2',4,2500,50,24,122],
  ['SYN-39','pp5x6','wholesale','1',1,1000,0,22000,19800],
  ['SYN-40','pp5x6','wholesale','2',0.5,500,750,22,760],
  ['SYN-41','butterBake','wholesale','1',7,2500,1,36000,189001],
  ['SYN-42','butterBake','wholesale','2',2,1000,2500,900,4120],
  ['SYN-43','marie','wholesale','1',1.25,500,199,64800,77149],
  ['SYN-44','marie','wholesale','2',0.1,2500,50,5400,455],
  ['SYN-45','marie','wholesale','3',3,1000,0,450,1215],
  ['SYN-46','honey','wholesale','1',4,500,750,900,4170],
  ['SYN-47','atta','wholesale','1',1,2500,1,24000,18001],
  ['SYN-48','pp3x3','wholesale','1',0.5,1000,2500,24000,13300],
  ['SYN-49','pp3x3','wholesale','2',7,500,199,24,359],
  ['SYN-50','pp5x6','wholesale','1',2,2500,50,22000,33050],
];

describe('50-case screenshot-backed pricing/totals stress suite', () => {
  it('contains exactly 50 cases balanced across retail and wholesale', () => {
    expect(CASES).toHaveLength(50);
    expect(CASES.filter(c => c[2] === 'retail')).toHaveLength(25);
    expect(CASES.filter(c => c[2] === 'wholesale')).toHaveLength(25);
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

  it.each(CASES)('%s %s %s tier %s', (id, key, mode, tier, qty, discountBps, extraPaise, expectedUnitPricePaise, expectedGrandTotalPaise) => {
    const item = SCREENSHOT_ITEMS[key];
    const actualUnitPricePaise = priceForUnitPaise(item, mode, tier);
    expect(actualUnitPricePaise, `${id} unit price`).toBe(expectedUnitPricePaise);
    const total = calculateInvoiceTotals(
      [{ qty, unitPricePaise: actualUnitPricePaise, discountBps, taxRateBps: item.taxRateBps }],
      extraPaise ? [{ name: 'Synthetic stress extra', amountPaise: extraPaise }] : [],
    );
    expect(total.grandTotalPaise, `${id} grand total`).toBe(expectedGrandTotalPaise);
  });
});
