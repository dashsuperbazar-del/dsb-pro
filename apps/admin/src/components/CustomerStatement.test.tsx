// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { CustomerStatement } from './CustomerStatement';

const api = vi.hoisted(() => ({
  readCustomerLedgerForStatement: vi.fn(),
  getShopSettings: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
const props = {
  shopId: 'shop',
  customerId: 'c1',
  customerName: 'Asha',
  businessDate: '2026-10-14',
};
const row = (id: string, debit: number, credit: number) => ({
  customer_id: 'c1',
  business_date: '2026-10-10',
  created_at: `2026-10-10T00:00:0${id}Z`,
  entry_type: debit ? 'SALE' : 'PAYMENT',
  ref_id: id,
  reference: '<img src=x onerror=alert(1)>',
  debit_paise: debit,
  credit_paise: credit,
});
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
async function mount(p = props) {
  await act(async () => render(<CustomerStatement {...p} />, host));
}
beforeEach(() => {
  document.body.append(host);
  api.getShopSettings
    .mockReset()
    .mockResolvedValue({ id: 'shop', name: 'Shop', address: null, gstin: null });
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});

test('prepares a verified statement and renders ledger text as text, not markup', async () => {
  api.readCustomerLedgerForStatement
    .mockReset()
    .mockResolvedValue({ rows: [row('1', 10000, 0), row('2', 0, 4000)], balancePaise: 6000 });
  await mount();
  await vi.waitFor(() => expect(button('Download CSV').disabled).toBe(false));
  expect(host.textContent).toContain('Closing ₹60.00');
  expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(host.querySelector('img')).toBeNull();
});

test('a ledger that does not match the stored balance produces no statement', async () => {
  api.readCustomerLedgerForStatement
    .mockReset()
    .mockResolvedValue({ rows: [row('1', 10000, 0)], balancePaise: 9999 });
  await mount();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/reconcile/i);
  expect(button('Download CSV').disabled).toBe(true);
  expect(host.querySelector('[aria-label="Prepared customer statement"]')).toBeNull();
});

test('a slow answer for the previous customer is ignored after switching', async () => {
  let release: (v: unknown) => void = () => {};
  api.readCustomerLedgerForStatement
    .mockReset()
    .mockImplementationOnce(() => new Promise((r) => (release = r)))
    .mockResolvedValue({ rows: [], balancePaise: 0 });
  await mount();
  await mount({ ...props, customerId: 'c2', customerName: 'Ben' });
  await vi.waitFor(() => expect(button('Download CSV').disabled).toBe(false));
  await act(async () => release({ rows: [row('1', 500, 0)], balancePaise: 500 }));
  expect(host.textContent).toContain('Ben');
  expect(host.textContent).not.toContain('Asha');
});
