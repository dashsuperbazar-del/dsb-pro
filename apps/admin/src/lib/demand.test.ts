import { expect, test } from 'vitest';
import { formatQty, sinceDate, weeklyDemand } from './demand';

const m = (date: string, baseQty: number) => ({ businessDate: date, baseQty });

test('buckets sales minus returns into weeks ending today, oldest first, exact', () => {
  const weeks = weeklyDemand(
    {
      sales: [m('2026-10-18', 0.1), m('2026-10-12', 0.2), m('2026-10-11', 3), m('2026-08-01', 99)],
      returns: [m('2026-10-17', 0.1)],
    },
    '2026-10-18',
    3,
  );
  expect(weeks.map((w) => [w.start, w.end, w.netMicro])).toEqual([
    ['2026-09-28', '2026-10-04', 0],
    ['2026-10-05', '2026-10-11', 3_000_000],
    ['2026-10-12', '2026-10-18', 200_000],
  ]);
  expect(formatQty(weeks[2]!.netMicro)).toBe('0.2');
  expect(formatQty(300_001)).toBe('0.300001');
  expect(formatQty(-1_500_000)).toBe('-1.5');
  expect(sinceDate('2026-10-18', 3)).toBe('2026-09-28');
});

test('rejects a bad today and ignores future dates', () => {
  expect(() => weeklyDemand({ sales: [], returns: [] }, 'x', 8)).toThrow();
  const w = weeklyDemand({ sales: [m('2026-10-19', 5)], returns: [] }, '2026-10-18', 2);
  expect(w.every((x) => x.netMicro === 0)).toBe(true);
});
