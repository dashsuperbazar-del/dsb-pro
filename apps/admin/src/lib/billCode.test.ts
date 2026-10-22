import { describe, expect, it } from 'vitest';
import { billCodeMatch, normalizeBillCode } from './billCode';
import { searchBills, type SearchBill } from './globalSearch';

describe('bill code search', () => {
  it('ignores case, dashes and spaces', () => {
    expect(normalizeBillCode(' k7m2-qx9p ')).toBe('K7M2QX9P');
    expect(normalizeBillCode(null)).toBe('');
    expect(billCodeMatch('K7M2-QX9P', 'k7m2qx9p')).toBe('exact');
    expect(billCodeMatch('K7M2-QX9P', 'K7M2 QX9P')).toBe('exact');
    expect(billCodeMatch('K7M2-QX9P', 'k7m2-qx9p')).toBe('exact');
  });
  it('matches a part of the code from 4 characters, also across the dash', () => {
    expect(billCodeMatch('K7M2-QX9P', 'K7M2')).toBe('partial');
    expect(billCodeMatch('K7M2-QX9P', 'qx9p')).toBe('partial');
    expect(billCodeMatch('K7M2-QX9P', 'M2-QX')).toBe('partial');
    expect(billCodeMatch('K7M2-QX9P', 'K7M')).toBeNull();
    expect(billCodeMatch('K7M2-QX9P', 'K7')).toBeNull();
    expect(billCodeMatch('K7M2-QX9P', 'ZZZZ')).toBeNull();
  });
  it('an older row without a code never matches and never throws', () => {
    expect(billCodeMatch(null, 'K7M2')).toBeNull();
    expect(billCodeMatch(undefined, 'K7M2')).toBeNull();
    expect(billCodeMatch('', 'K7M2')).toBeNull();
  });
  it('global search finds a bill or invoice by its code, exact first, and keeps number search', () => {
    const bills: SearchBill[] = [
      {
        id: 'p1',
        number: 'A-12',
        code: 'K7M2-QX9P',
        partyName: 'Gupta',
        date: '2026-10-01',
        totalPaise: '100',
      },
      {
        id: 'p2',
        number: null,
        code: 'XK7M-2ABC',
        partyName: 'Sharma',
        date: '2026-10-02',
        totalPaise: '200',
      },
      {
        id: 'p3',
        number: 'B-7',
        partyName: 'Old row, no code',
        date: '2026-10-03',
        totalPaise: '300',
      },
    ];
    expect(searchBills('k7m2-qx9p', bills).rows.map((b) => b.id)).toEqual(['p1']);
    expect(searchBills('k7m2', bills).rows.map((b) => b.id)).toEqual(['p2', 'p1']);
    expect(searchBills('a-12', bills).rows.map((b) => b.id)).toEqual(['p1']);
    expect(searchBills('b-7', bills).rows.map((b) => b.id)).toEqual(['p3']);
    // Three characters of a code is not a code search.
    expect(searchBills('k7m', bills).rows).toEqual([]);
  });
});
