// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SearchScreen } from './SearchScreen';
import { shopContext } from '../lib/shopContext';

const items = Array.from({ length: 25 }, (_, i) => ({
  id: `i${i}`,
  name: `Tea ${String(i).padStart(2, '0')}`,
  sku: null,
  unit1: 'packet',
  unit2: null,
  unit3: null,
  min_stock: 5,
}));
const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  getCurrentMembership: vi.fn(),
  getDefaultShopId: vi.fn(),
  getShopBusinessDate: vi.fn(),
  onAuthStateChange: vi.fn().mockReturnValue(() => {}),
  findBillsByCode: vi.fn().mockResolvedValue([]),
  getSupplierOutstanding: vi.fn().mockResolvedValue([]),
  listCustomerBalances: vi.fn().mockResolvedValue([]),
  listCustomers: vi.fn().mockResolvedValue([]),
  listItems: vi.fn(),
  listParties: vi.fn().mockResolvedValue([]),
  listPurchaseHistory: vi.fn().mockResolvedValue([]),
  listRecentSales: vi.fn().mockResolvedValue([]),
  listRetailPrices: vi.fn().mockResolvedValue([]),
  listStock: vi.fn().mockResolvedValue([{ item_id: 'i0', qty_base: 3 }]),
}));
vi.mock('@dsb-pro/adapters', () => api);
vi.mock('../lib/offlineSync', () => ({
  getSyncedOfflineCatalog: vi.fn().mockResolvedValue(null),
  getOfflineCustomers: vi.fn().mockResolvedValue([]),
}));
const host = document.createElement('div');
beforeEach(() => {
  api.listItems.mockResolvedValue(items);
  document.body.append(host);
  vi.spyOn(shopContext, 'get').mockResolvedValue({
    membership: { role: 'owner', tenantId: 't' },
    session: { user: { id: 'u1' } },
    shopId: 's1',
  } as never);
  localStorage.clear();
});
afterEach(() => {
  render(null, host);
  host.remove();
  vi.restoreAllMocks();
});
const flush = () => act(() => new Promise((r) => setTimeout(r, 400)));

test('shows 10 rows, "Show 15 more" is not capped to 10, shows stock and a low-stock chip', async () => {
  await act(async () => render(<SearchScreen />, host));
  await flush();
  const box = host.querySelector('input[type="search"]') as HTMLInputElement;
  await act(async () => {
    box.value = 'tea';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
  await flush();
  const group = host.querySelector('section[aria-label="Items"]') as HTMLElement;
  expect(group.querySelectorAll('a.result-row')).toHaveLength(10);
  expect(group.textContent).toContain('3 packet');
  expect(group.textContent).toContain('Low stock');
  const more = [...group.querySelectorAll('button')].find((b) =>
    /^Show 15 more/.test(b.textContent ?? ''),
  )!;
  expect(more).toBeTruthy();
  await act(async () => more.click());
  expect(group.querySelectorAll('a.result-row')).toHaveLength(25);
  expect(group.textContent).not.toContain('type more to narrow');
});

test('the first non-empty group is open; clear empties the box; a recent search is kept', async () => {
  await act(async () => render(<SearchScreen />, host));
  await flush();
  const box = host.querySelector('input[type="search"]') as HTMLInputElement;
  await act(async () => {
    box.value = 'tea 1';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
  const toggle = host.querySelector('.home-row-toggle') as HTMLButtonElement;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(JSON.parse(localStorage.getItem('dsb-pro:recent-searches:u1')!)).toEqual(['tea 1']);
  await act(async () =>
    (host.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement).click(),
  );
  expect(box.value).toBe('');
  expect(host.querySelector('[aria-label="Recent searches"]')?.textContent).toContain('tea 1');
});
