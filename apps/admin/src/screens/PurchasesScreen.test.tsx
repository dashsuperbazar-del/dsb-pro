// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { PurchasesScreen } from './PurchasesScreen';
import { shopContext } from '../lib/shopContext';
const api = vi.hoisted(() => ({
  getSession: vi.fn().mockResolvedValue({ user: { id: 'user' } }),
  onAuthStateChange: vi.fn().mockReturnValue(() => {}),
  getShopBusinessDate: vi.fn().mockResolvedValue('2026-10-13'),
  getCurrentMembership: vi.fn().mockResolvedValue({ tenantId: 'tenant', role: 'owner' }),
  getDefaultShopId: vi.fn().mockResolvedValue('shop'),
  listParties: vi.fn().mockResolvedValue([]),
  listPurchaseHistory: vi.fn().mockResolvedValue([]),
  getPurchaseDetail: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
vi.mock('./InventoryScreen', () => ({
  InventoryScreen: ({ onPurchasePosted }: { onPurchasePosted: () => void }) => (
    <button onClick={onPurchasePosted}>Post fixture purchase</button>
  ),
}));
const host = document.createElement('div');
afterEach(() => {
  shopContext.invalidate();
  act(() => render(null, host));
  vi.clearAllMocks();
});
test('a supplier created during purchase entry is refreshed with posted history, never mislabeled as no supplier', async () => {
  await act(async () => {
    render(<PurchasesScreen url="/purchases?new=1" />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelector('button')?.textContent).toBe('Post fixture purchase'),
  );
  api.listParties.mockResolvedValue([{ id: 'p', name: 'New supplier' }]);
  api.listPurchaseHistory.mockResolvedValue([
    {
      id: 'bill',
      party_id: 'p',
      bill_no: 'NEW-1',
      business_date: '2026-10-13',
      created_at: '2026-10-13T12:00:00Z',
      status: 'POSTED',
      total_paise: '12000',
    },
  ]);
  await act(async () => {
    host.querySelector('button')!.click();
  });
  await vi.waitFor(() => expect(host.textContent).toContain('New supplier'));
  expect(host.querySelector('.record-list')?.textContent).toContain('New supplier');
  expect(host.querySelector('.record-list')?.textContent).not.toContain('No supplier');
});
