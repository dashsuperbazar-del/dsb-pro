// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DayBookTile } from './DayBookTile';
const api = vi.hoisted(() => ({
  getDefaultShopId: vi.fn().mockResolvedValue('shop'),
  getShopBusinessDate: vi.fn().mockResolvedValue('2026-10-12'),
  getDayBook: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
afterEach(() => {
  act(() => render(null, host));
  vi.clearAllMocks();
});
test('an unresolved day book shows placeholders, then confirmed empty data shows zero', async () => {
  let finish!: (rows: never[]) => void;
  api.getDayBook.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    render(<DayBookTile />, host);
  });
  expect(host.textContent).not.toContain('₹0.00');
  expect(host.textContent).toContain('—');
  await act(async () => {
    finish([]);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('₹0.00'));
  expect(host.textContent).toContain('Net money flow');
});
test('failed totals remain an explicit unavailable state, never zero', async () => {
  api.getDayBook.mockRejectedValue(new Error('unavailable'));
  await act(async () => {
    render(<DayBookTile />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('unavailable'),
  );
  expect(host.textContent).not.toContain('₹0.00');
});
