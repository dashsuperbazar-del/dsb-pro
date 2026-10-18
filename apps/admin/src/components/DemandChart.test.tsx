// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DemandChart } from './DemandChart';

const api = vi.hoisted(() => ({ listItemSaleMovements: vi.fn() }));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
beforeEach(() => document.body.append(host));
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
  api.listItemSaleMovements.mockReset();
});
const mount = () =>
  act(async () =>
    render(<DemandChart shopId="s" itemId="i" baseUnit="<b>pcs" today="2026-10-18" />, host),
  );

test('shows weekly net units with bars, an aria summary and a text fallback', async () => {
  api.listItemSaleMovements.mockResolvedValue({
    sales: [
      { businessDate: '2026-10-18', baseQty: 2.5 },
      { businessDate: '2026-10-10', baseQty: 4 },
    ],
    returns: [{ businessDate: '2026-10-17', baseQty: 0.5 }],
    truncated: false,
  });
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('Sold in last 8 weeks: 6 <b>pcs'));
  expect(api.listItemSaleMovements).toHaveBeenCalledWith('s', 'i', '2026-08-24');
  const svg = host.querySelector('svg[role="img"]')!;
  expect(svg.getAttribute('aria-label')).toContain('6 <b>pcs over 8 weeks');
  expect(host.querySelectorAll('svg rect').length).toBe(8);
  expect(host.querySelector('b')).toBeNull();
  expect(host.textContent).toContain('2026-10-12 to 2026-10-18: 2');
});

test('loading, error and empty states', async () => {
  let resolve!: (v: unknown) => void;
  api.listItemSaleMovements.mockReturnValueOnce(new Promise((r) => (resolve = r)));
  await mount();
  expect(host.textContent).toContain('Loading sales');
  await act(async () => resolve({ sales: [], returns: [], truncated: false }));
  await vi.waitFor(() => expect(host.textContent).toContain('No sales of this item'));
  await act(async () => render(null, host));
  api.listItemSaleMovements.mockRejectedValueOnce(new Error('x'));
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('Sales history is unavailable'));
});

test('says when the read was capped', async () => {
  api.listItemSaleMovements.mockResolvedValue({
    sales: [{ businessDate: '2026-10-18', baseQty: 1 }],
    returns: [],
    truncated: true,
  });
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('may be incomplete'));
});
