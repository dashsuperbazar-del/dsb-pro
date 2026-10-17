// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { CustomersScreen } from './CustomersScreen';
import { clearSnapshots, peekSnapshot, putSnapshot } from '../lib/routeSnapshot';

const api = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  archiveCustomer: vi.fn(),
  getCurrentMembership: vi.fn(),
  getDefaultShopId: vi.fn().mockResolvedValue('shop'),
  getShopBusinessDate: vi.fn().mockResolvedValue('2026-10-17'),
  listCustomerBalances: vi.fn(),
  listCustomerLedger: vi.fn().mockResolvedValue([]),
  listCustomerOutstandingInvoices: vi.fn().mockResolvedValue([]),
  listCustomers: vi.fn(),
  recordCustomerPaymentV2: vi.fn(),
  lookupFinancialRequest: vi.fn(),
  voidPayment: vi.fn(),
  getSession: vi.fn().mockResolvedValue({ user: { id: 'u' } }),
  onAuthStateChange: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
vi.mock('../lib/offlineSync', () => ({
  listOpenFinancialAttempts: vi.fn().mockResolvedValue([]),
  newFinancialDraft: vi.fn(),
  reconcileFinancialAttempt: vi.fn(),
  sendFinancialAttempt: vi.fn(),
  waitForOfflineRuntime: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../components/CustomerStatement', () => ({ CustomerStatement: () => null }));

const host = document.createElement('div');
const customer = (id: string, name: string) => ({ id, name, phone: null });
beforeEach(() => {
  clearSnapshots();
  document.body.append(host);
  api.getCurrentMembership.mockResolvedValue({ tenantId: 't', role: 'owner' });
  api.listCustomers.mockResolvedValue([customer('c1', 'Fresh Customer')]);
  api.listCustomerBalances.mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});
const mount = () => act(async () => render(<CustomersScreen />, host));

test('SP2: a revisit lists saved customers at once and replaces them with the fresh list', async () => {
  putSnapshot('customers', 'u', 'shop', {
    customers: [customer('c0', 'Saved Customer')],
    balances: {},
  });
  let finish!: (v: unknown) => void;
  api.listCustomers.mockReturnValue(new Promise((r) => (finish = r)));
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('Saved Customer'));
  expect(host.querySelector('[data-testid="snapshot-note"]')).not.toBeNull();
  await act(async () => finish([customer('c1', 'Fresh Customer')]));
  await vi.waitFor(() => expect(host.textContent).toContain('Fresh Customer'));
  expect(host.textContent).not.toContain('Saved Customer');
  expect(peekSnapshot('customers', 'u')?.value).toMatchObject({
    customers: [{ name: 'Fresh Customer' }],
  });
});

test('SP2: a failed refresh warns; lost membership clears the saved list', async () => {
  putSnapshot('customers', 'u', 'shop', {
    customers: [customer('c0', 'Saved Customer')],
    balances: {},
  });
  api.listCustomerBalances.mockRejectedValueOnce(new Error('offline'));
  await mount();
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="snapshot-note"]')?.textContent).toContain(
      'Could not refresh',
    ),
  );
  await act(async () => render(null, host));
  api.getCurrentMembership.mockResolvedValueOnce(null);
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('No tenant membership'));
  expect(host.textContent).not.toContain('Saved Customer');
  expect(peekSnapshot('customers', 'u')).toBeNull();
});
