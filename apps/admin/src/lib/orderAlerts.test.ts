import { expect, test } from 'vitest';
import { newlyArrived, summarise } from './orderAlerts';

test('the first poll never alerts; a new NEW order does', () => {
  const rows = [{ id: 'a', status: 'NEW' }];
  expect(newlyArrived(null, rows)).toEqual([]);
  expect(newlyArrived(new Set(['a']), rows)).toEqual([]);
  expect(newlyArrived(new Set(['a']), [...rows, { id: 'b', status: 'NEW' }])).toEqual(['b']);
  expect(newlyArrived(new Set(), [{ id: 'c', status: 'CONFIRMED' }])).toEqual([]);
});

test('counts new, open and soon-expiring orders (out for delivery never expires)', () => {
  const now = Date.parse('2026-11-09T10:00:00Z');
  const p = summarise(
    [
      { id: 'a', status: 'NEW', expiresAt: '2026-11-09T10:05:00Z' },
      { id: 'b', status: 'READY', expiresAt: '2026-11-09T11:00:00Z' },
      { id: 'c', status: 'OUT_FOR_DELIVERY', expiresAt: '2026-11-09T09:00:00Z' },
    ],
    now,
  );
  expect(p).toEqual({ fresh: 1, open: 3, expiring: 1 });
});
