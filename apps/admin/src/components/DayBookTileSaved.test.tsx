// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DayBookTile, stamp, isOld } from './DayBookTile';

const api = vi.hoisted(() => ({
  getDefaultShopId: vi.fn().mockRejectedValue(new Error('offline')),
  getShopBusinessDate: vi.fn(),
  getDayBook: vi.fn(),
  hasAnyItem: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const snap = vi.hoisted(() => ({ at: 0 }));
vi.mock('../lib/routeSnapshot', () => ({
  snapshotUserId: async () => 'u',
  putSnapshot: vi.fn(),
  peekSnapshot: () => ({
    userId: 'u',
    shopId: 's',
    at: snap.at,
    value: {
      date: '2026-10-30',
      row: {
        business_date: '2026-10-30',
        sales_paise: 100,
        receipts_paise: 100,
        payments_paise: 0,
        expenses_paise: 0,
        net_cashflow_paise: 100,
      },
    },
  }),
}));
const host = document.createElement('div');
afterEach(() => act(() => render(null, host)));

test('stamp adds the date for another day or an old snapshot', () => {
  const now = new Date(2026, 9, 31, 9, 0).getTime();
  expect(isOld(new Date(2026, 9, 30, 23, 10).getTime(), now)).toBe(true);
  expect(stamp(new Date(2026, 9, 30, 23, 10).getTime(), now)).toContain('30 Oct');
  expect(isOld(new Date(2026, 9, 31, 8, 30).getTime(), now)).toBe(false);
  expect(stamp(new Date(2026, 9, 31, 8, 30).getTime(), now)).not.toContain('Oct');
});

test("yesterday's saved figures are not called Today and carry their date", async () => {
  snap.at = Date.now() - 24 * 3600_000;
  await act(async () => {
    render(<DayBookTile />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="daybook-saved"]')).not.toBeNull(),
  );
  expect(host.querySelector('h2')?.textContent).not.toMatch(/^Today/);
  expect(host.querySelector('[data-testid="daybook-saved"]')?.textContent).toMatch(/[A-Z][a-z]{2}/);
});
