// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { PriceHistory } from './PriceHistory';

const api = vi.hoisted(() => ({ listItemPurchasePrices: vi.fn() }));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
beforeEach(() => document.body.append(host));
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});
const row = (date: string, total: number) => ({
  billId: date,
  lineNo: 1,
  createdAt: date,
  businessDate: date,
  partyId: 'p',
  unitName: 'case',
  unitLevel: 1,
  qty: 1,
  baseQty: 10,
  unitPricePaise: total,
  lineTotalPaise: total,
});
const mount = () =>
  act(async () =>
    render(
      <PriceHistory
        shopId="s"
        itemId="i"
        baseUnit="pcs"
        parties={[{ id: 'p', name: 'Acme' }] as never}
      />,
      host,
    ),
  );

test('shows the last cost per base unit, its change and a trend line', async () => {
  api.listItemPurchasePrices.mockResolvedValue([row('2026-10-02', 1100), row('2026-10-01', 1000)]);
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('Last purchase price ₹1.10 per pcs'));
  expect(host.textContent).toContain('up ₹0.10');
  expect(host.textContent).toContain('Acme');
  expect(host.querySelector('svg polyline')).not.toBeNull();
});

test('a failed read says unavailable; no purchases says so', async () => {
  api.listItemPurchasePrices.mockRejectedValueOnce(new Error('x'));
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('unavailable'));
  await act(async () => render(null, host));
  api.listItemPurchasePrices.mockResolvedValue([]);
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('No purchases of this item yet.'));
});
