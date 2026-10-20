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

const bill = (id: string, no: string) => ({
  id,
  party_id: null,
  bill_no: no,
  business_date: '2026-10-13',
  created_at: '2026-10-13T12:00:00Z',
  status: 'POSTED',
  total_paise: '5000',
});

test('SP2: a revisit shows the last list at once, labelled, then the fresh list replaces it', async () => {
  const { clearSnapshots } = await import('../lib/routeSnapshot');
  clearSnapshots();
  api.listPurchaseHistory.mockResolvedValue([bill('b1', 'OLD-1')]);
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('OLD-1'));
  expect(host.querySelector('[data-testid="snapshot-note"]')).toBeNull();
  await act(async () => render(null, host));
  let finish!: (rows: unknown[]) => void;
  api.listPurchaseHistory.mockReturnValue(new Promise((r) => (finish = r)));
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('OLD-1'));
  expect(host.querySelector('[data-testid="snapshot-note"]')?.textContent).toContain('refreshing');
  await act(async () => finish([bill('b2', 'NEW-2')]));
  await vi.waitFor(() => expect(host.textContent).toContain('NEW-2'));
  expect(host.textContent).not.toContain('OLD-1');
  expect(host.querySelector('[data-testid="snapshot-note"]')).toBeNull();
});

test('SP2: a different signed-in user never sees the previous user list', async () => {
  const { clearSnapshots, putSnapshot } = await import('../lib/routeSnapshot');
  clearSnapshots();
  putSnapshot('purchases', 'someone-else', 'shop', { rows: [bill('x', 'SECRET-1')], parties: [] });
  let finish!: (rows: unknown[]) => void;
  api.listPurchaseHistory.mockReturnValue(new Promise((r) => (finish = r)));
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  expect(host.textContent).not.toContain('SECRET-1');
  await act(async () => finish([]));
});

test('SP2: a role that lost access clears the saved list instead of showing it', async () => {
  const { clearSnapshots, putSnapshot } = await import('../lib/routeSnapshot');
  clearSnapshots();
  putSnapshot('purchases', 'user', 'shop', { rows: [bill('x', 'SAVED-1')], parties: [] });
  api.getCurrentMembership.mockResolvedValueOnce({ tenantId: 'tenant', role: 'cashier' });
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('restricted by your role'));
  expect(host.textContent).not.toContain('SAVED-1');
});

test('bill detail shows the round-off only when it is not zero', async () => {
  const { clearSnapshots } = await import('../lib/routeSnapshot');
  clearSnapshots();
  api.listPurchaseHistory.mockResolvedValue([bill('r1', 'RND-1'), bill('r0', 'OLD-0')]);
  const detail = (round: string | undefined) => ({
    bill: {
      ...bill('r1', 'RND-1'),
      subtotal_paise: '18291',
      discount_paise: '0',
      extra_charges_paise: '0',
      round_off_paise: round,
      total_paise: '18300',
      bill_image_path: null,
    },
    lines: [],
    balance: null,
  });
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('RND-1'));
  api.getPurchaseDetail.mockResolvedValueOnce(detail('9'));
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('RND-1'))!.click();
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Round off +₹0.09'));
  api.getPurchaseDetail.mockResolvedValueOnce(detail(undefined));
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('OLD-0'))!.click();
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Lines ₹182.91'));
  expect(host.textContent).not.toContain('Round off');
});
