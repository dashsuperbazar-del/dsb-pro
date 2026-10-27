// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { PaySupplierPanel } from './PaySupplierPanel';

const V = '0123456789abcdef0123456789abcdef';
const PARTY = '11111111-1111-4111-8111-111111111111';
const BILL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const copy = {
  shopId: 'shop',
  savedAt: Date.now() - 5 * 60_000,
  businessDate: '2026-10-26',
  suppliers: [
    {
      partyId: PARTY,
      name: 'Acme Traders',
      owedPaise: '1500000',
      version: V,
      bills: [
        {
          billId: BILL,
          billNo: 'A-1',
          businessDate: '2026-10-01',
          outstandingPaise: '1000000',
          version: V,
        },
      ],
    },
  ],
};
const api = vi.hoisted(() => ({
  waitForOfflineRuntime: vi.fn(),
  getOfflineRuntimeIdentity: vi.fn(),
  getSavedSupplierPayCopy: vi.fn(),
  refreshSupplierPayCopy: vi.fn(),
  listOfflineSupplierPayments: vi.fn(),
  queueSupplierPaymentOffline: vi.fn(),
  closeRejectedSupplierPayment: vi.fn(),
  runSyncNow: vi.fn(),
}));
vi.mock('../lib/offlineSync', () => api);
vi.mock('../lib/useUserId', () => ({ useUserId: () => 'user-1' }));

const host = document.createElement('div');
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const field = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.includes(label))!
    .querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const choose = async (value: string) =>
  act(async () => {
    const el = field('Supplier to pay') as HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
const submit = async () =>
  act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
const online = (value: boolean) =>
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });

async function mount() {
  await act(async () => render(<PaySupplierPanel />, host));
  await vi.waitFor(() => expect(host.textContent).toContain('Supplier to pay'));
}
beforeEach(() => {
  document.body.append(host);
  online(false);
  api.waitForOfflineRuntime.mockReset().mockResolvedValue(undefined);
  api.getOfflineRuntimeIdentity.mockReset().mockReturnValue({ role: 'owner', shopId: 'shop' });
  api.getSavedSupplierPayCopy.mockReset().mockResolvedValue(copy);
  api.refreshSupplierPayCopy.mockReset().mockRejectedValue(new Error('offline'));
  api.listOfflineSupplierPayments.mockReset().mockResolvedValue([]);
  api.queueSupplierPaymentOffline
    .mockReset()
    .mockImplementation(async (i) => ({ ...i, status: 'QUEUED' }));
  api.closeRejectedSupplierPayment.mockReset().mockResolvedValue(undefined);
  api.runSyncNow.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
  online(true);
});

test('a cashier or an unknown device identity sees nothing', async () => {
  api.getOfflineRuntimeIdentity.mockReturnValue({ role: 'cashier', shopId: 'shop' });
  await act(async () => render(<PaySupplierPanel />, host));
  await act(async () => undefined);
  expect(host.textContent).toBe('');
  api.getOfflineRuntimeIdentity.mockReturnValue(null);
  await act(async () => render(null, host));
  await act(async () => render(<PaySupplierPanel />, host));
  expect(host.textContent).toBe('');
});

test('offline: the supplier list comes from the device copy with its age; nothing is fetched', async () => {
  await mount();
  expect(host.querySelector('[data-testid="pay-copy-note"]')!.textContent).toMatch(
    /offline.*saved on this device 5 min ago/,
  );
  expect(field('Supplier to pay').textContent).toContain('Acme Traders — owed ₹15,000.00');
  expect(api.refreshSupplierPayCopy).not.toHaveBeenCalled();
});

test('shows the first-time message when no copy was ever saved', async () => {
  api.getSavedSupplierPayCopy.mockResolvedValue(null);
  await act(async () => render(<PaySupplierPanel />, host));
  await vi.waitFor(() => expect(host.querySelector('[data-testid="pay-no-copy"]')).not.toBeNull());
  expect(host.textContent).toContain('Connect once to load it');
  expect(host.querySelector('form')).toBeNull();
});

test('validation messages are inline and nothing is queued', async () => {
  await mount();
  await choose(PARTY);
  await type(field('Amount to pay') as HTMLInputElement, '0');
  await submit();
  expect(host.querySelector('#pay-amount-error')!.textContent).toMatch(/more than zero/);
  await type(field('Amount to pay') as HTMLInputElement, '15000.01');
  await submit();
  expect(host.querySelector('#pay-amount-error')!.textContent).toMatch(
    /more than is owed to Acme Traders/,
  );
  await type(field('Amount to pay') as HTMLInputElement, '1000');
  await type(field('Assign to bill A-1') as HTMLInputElement, '1500');
  await submit();
  expect(host.textContent).toMatch(/more than the payment/);
  expect(api.queueSupplierPaymentOffline).not.toHaveBeenCalled();
});

test('typing is not reset by a re-render; review states it is not yet in the balance; double tap saves once', async () => {
  await mount();
  await choose(PARTY);
  const amount = field('Amount to pay') as HTMLInputElement;
  await type(amount, '6000');
  await type(field('Note / reference') as HTMLInputElement, 'cheque 12');
  // A re-render of the panel (the supplier select state) must keep what was typed.
  await choose(PARTY);
  expect((field('Amount to pay') as HTMLInputElement).value).toBe('6000');
  await type(field('Assign to bill A-1') as HTMLInputElement, '6000');
  await submit();
  const review = host.querySelector('[data-testid="pay-review"]')!;
  expect(review.textContent).toContain('Saved on this device, not yet in the supplier’s balance.');
  expect(review.textContent).toContain('A-1 ₹6,000.00');
  await act(async () => {
    const save = button('Save on this device');
    save.click();
    save.click();
  });
  await vi.waitFor(() => expect(api.queueSupplierPaymentOffline).toHaveBeenCalledTimes(1));
  const sent = api.queueSupplierPaymentOffline.mock.calls[0]![0];
  expect(sent).toMatchObject({
    shopId: 'shop',
    partyId: PARTY,
    partyName: 'Acme Traders',
    amountPaise: '600000',
    mode: 'cash',
    reference: 'cheque 12',
    allocations: [{ purchaseBillId: BILL, billLabel: 'A-1', amountPaise: '600000' }],
    baseVersions: { supplier: V, bills: { [BILL]: V } },
    limits: { owedPaise: '1500000', bills: { [BILL]: '1000000' } },
  });
  expect(sent.clientId).toMatch(/^[0-9a-f-]{36}$/);
  await vi.waitFor(() =>
    expect(host.textContent).toContain(
      'Saved on this device, not yet in the supplier’s balance. It is sent',
    ),
  );
});

test('a refusal on save (queue limit) is shown and the form comes back with its values', async () => {
  api.queueSupplierPaymentOffline.mockRejectedValue(
    new Error('Bill A-1 has only ₹10.00 left to pay.'),
  );
  await mount();
  await choose(PARTY);
  await type(field('Amount to pay') as HTMLInputElement, '500');
  await submit();
  await act(async () => button('Save on this device').click());
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/only ₹10.00/),
  );
  expect(host.querySelector('[data-testid="pay-review"]')).toBeNull();
  expect((field('Amount to pay') as HTMLInputElement).value).toBe('500');
});

const record = (over = {}) => ({
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  shopId: 'shop',
  partyId: PARTY,
  partyName: 'Acme Traders',
  businessDate: '2026-10-26',
  amountPaise: '600000',
  mode: 'upi',
  reference: 'utr 9',
  allocations: [{ purchaseBillId: BILL, billLabel: 'A-1', amountPaise: '600000' }],
  baseVersions: { supplier: V, bills: { [BILL]: V } },
  form: {
    partyId: PARTY,
    amount: '6000',
    mode: 'upi',
    reference: 'utr 9',
    date: '2026-10-26',
    allocs: { [BILL]: '6000' },
  },
  status: 'QUEUED',
  createdAt: 1,
  syncedAt: null,
  resultPaymentId: null,
  rejectionCode: null,
  rejectionReason: null,
  closedAt: null,
  ...over,
});

test('a queued payment is listed as saved on this device and does not change the owed figure', async () => {
  api.listOfflineSupplierPayments.mockResolvedValue([record()]);
  await mount();
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="offline-supplier-payment"]')).not.toBeNull(),
  );
  const row = host.querySelector('[data-testid="offline-supplier-payment"]')!;
  expect(row.textContent).toContain('Saved on this device — will sync');
  expect(row.textContent).toContain('not yet in the supplier’s balance');
  expect(field('Supplier to pay').textContent).toContain('owed ₹15,000.00');
  await choose(PARTY);
  expect(host.querySelector('[data-testid="pay-supplier-owed"]')!.textContent).toMatch(
    /₹15,000.00 as saved.*saved from this device and not in these figures: ₹6,000.00 \(left to pay ₹9,000.00\)/,
  );
});

test('a refused payment shows the reason and the full form; Redo fills it in again and closes the old one on save', async () => {
  api.listOfflineSupplierPayments.mockResolvedValue([
    record({
      status: 'REJECTED',
      rejectionCode: 'DSB_BILL_CHANGED',
      rejectionReason: 'A bill this payment was assigned to changed. Nothing was recorded.',
    }),
  ]);
  await mount();
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Refused by the server — not recorded'),
  );
  const row = host.querySelector('[data-testid="offline-supplier-payment"]')!;
  expect(row.querySelector('[role="alert"]')!.textContent).toContain('Nothing was recorded');
  expect(row.textContent).toContain('Acme Traders · ₹6,000.00 · upi');
  expect(row.textContent).toContain('A-1 ₹6,000.00');
  await act(async () => button('Redo this payment').click());
  expect((field('Amount to pay') as HTMLInputElement).value).toBe('6000');
  expect((field('Paid by') as HTMLSelectElement).value).toBe('upi');
  expect((field('Note / reference') as HTMLInputElement).value).toBe('utr 9');
  expect((field('Assign to bill A-1') as HTMLInputElement).value).toBe('6000');
  await submit();
  await act(async () => button('Save on this device').click());
  await vi.waitFor(() => expect(api.queueSupplierPaymentOffline).toHaveBeenCalledTimes(1));
  // A NEW request id: the refused payment's own id is never reused.
  expect(api.queueSupplierPaymentOffline.mock.calls[0]![0].clientId).not.toBe(record().clientId);
  await vi.waitFor(() =>
    expect(api.closeRejectedSupplierPayment).toHaveBeenCalledWith(record().clientId),
  );
});

test('online: the copy is refreshed from the server and the age note is plain', async () => {
  online(true);
  api.refreshSupplierPayCopy.mockResolvedValue({ ...copy, savedAt: Date.now() });
  await mount();
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="pay-copy-note"]')!.textContent).toMatch(/just now/),
  );
  expect(host.querySelector('[data-testid="pay-copy-note"]')!.className).toBe('muted');
  expect(api.refreshSupplierPayCopy).toHaveBeenCalledWith('shop');
});

test('online but the refresh failed: warns the figures may be out of date', async () => {
  online(true);
  await mount();
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="pay-copy-note"]')!.textContent).toMatch(
      /Could not refresh/,
    ),
  );
});

test('a payment SYNCED after the stale copy was saved still reduces owed and the bill limit', async () => {
  online(true); // refresh fails (mock rejects): the stale copy stays
  api.listOfflineSupplierPayments.mockResolvedValue([
    record({ status: 'SYNCED', syncedAt: copy.savedAt + 1000 }),
  ]);
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('Could not refresh'));
  await choose(PARTY);
  expect(host.querySelector('[data-testid="pay-supplier-owed"]')!.textContent).toMatch(
    /not in these figures: ₹6,000.00 \(left to pay ₹9,000.00\)/,
  );
  expect(host.textContent).toContain('₹ left ₹4,000.00');
});

test('a payment synced BEFORE the copy was saved is not subtracted twice', async () => {
  api.listOfflineSupplierPayments.mockResolvedValue([
    record({ status: 'SYNCED', syncedAt: copy.savedAt - 1000 }),
  ]);
  await mount();
  await choose(PARTY);
  expect(host.querySelector('[data-testid="pay-supplier-owed"]')!.textContent).not.toContain(
    'left to pay',
  );
});

test('the confirm step shows the payment date clearly', async () => {
  await mount();
  await choose(PARTY);
  await type(field('Amount to pay') as HTMLInputElement, '500');
  await submit();
  expect(host.querySelector('[data-testid="pay-review-date"]')!.textContent).toMatch(
    /^\d{4}-\d{2}-\d{2}$/,
  );
});
