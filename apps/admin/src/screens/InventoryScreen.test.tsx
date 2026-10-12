// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { InventoryScreen } from './InventoryScreen';
const api = vi.hoisted(() => ({
  getCurrentMembership: vi.fn().mockResolvedValue({ tenantId: 'tenant', role: 'owner' }),
  getDefaultShopId: vi.fn().mockResolvedValue('shop'),
  getShopBusinessDate: vi.fn().mockResolvedValue('2026-10-12'),
  listItems: vi.fn().mockResolvedValue([
    { id: 'a', name: 'Item A', unit1: 'piece', min_stock: 0 },
    { id: 'b', name: 'Item B', unit1: 'piece', min_stock: 0 },
  ]),
  listParties: vi.fn().mockResolvedValue([]),
  listStock: vi.fn().mockResolvedValue([]),
  listCurrentPrices: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
afterEach(() => {
  act(() => render(null, host));
  vi.clearAllMocks();
  localStorage.clear();
});
test('a late price response cannot relabel old prices as the newly selected item', async () => {
  let finish!: (rows: unknown[]) => void;
  api.listCurrentPrices.mockImplementation((id) =>
    id === 'a'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([{ kind: 'retail', price_paise: 2000 }]),
  );
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelectorAll('select option[value="b"]').length).toBeGreaterThan(0),
  );
  const picker = host.querySelector('select')!;
  await act(async () => {
    picker.value = 'a';
    picker.dispatchEvent(new Event('change'));
  });
  await vi.waitFor(() => expect(api.listCurrentPrices).toHaveBeenCalledWith('a'));
  expect(host.querySelector('[aria-label="item peek"]')?.textContent).toContain('Loading…');
  await act(async () => {
    picker.value = 'b';
    picker.dispatchEvent(new Event('change'));
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="item peek"]')?.textContent).toContain('retail ₹20.00'),
  );
  await act(async () => {
    finish([{ kind: 'retail', price_paise: 9900 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector('[aria-label="item peek"]')?.textContent).toContain('Item B');
  expect(host.querySelector('[aria-label="item peek"]')?.textContent).not.toContain('₹99.00');
});
test('item-specific price and barcode edits stay on the same item and cannot carry into another', async () => {
  let finish!: (rows: unknown[]) => void;
  api.listCurrentPrices.mockImplementation((id) =>
    id === 'a'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([]),
  );
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelectorAll('select option[value="a"]').length).toBeGreaterThan(0),
  );
  const picker = host.querySelector('select')!;
  await act(async () => {
    picker.value = 'a';
    picker.dispatchEvent(new Event('change'));
  });
  await vi.waitFor(() => expect(api.listCurrentPrices).toHaveBeenCalledWith('a'));
  const price = host.querySelector<HTMLInputElement>('input[placeholder="₹ price"]')!;
  const barcode = host.querySelector<HTMLInputElement>('input[name="barcode"]')!;
  price.value = '42';
  barcode.value = 'CODE-A';
  await act(async () => {
    finish([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector('input[placeholder="₹ price"]')).toBe(price);
  expect(price.value).toBe('42');
  expect(barcode.value).toBe('CODE-A');
  await act(async () => {
    picker.value = 'b';
    picker.dispatchEvent(new Event('change'));
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="item peek"]')?.textContent).toContain('Item B'),
  );
  expect(host.querySelector<HTMLInputElement>('input[placeholder="₹ price"]')!.value).toBe('');
  expect(host.querySelector<HTMLInputElement>('input[name="barcode"]')!.value).toBe('');
});
