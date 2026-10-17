// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { AttentionTile } from './AttentionTile';

const api = vi.hoisted(() => ({
  getDefaultShopId: vi.fn(),
  getLowStockReport: vi.fn(),
  getSupplierOutstanding: vi.fn(),
  getSupplierPaymentsDue: vi.fn(),
  getShopBusinessDate: vi.fn(),
  getSession: vi.fn().mockResolvedValue(null),
  onAuthStateChange: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
const sup = (id: string, net: string, stranded = 0) => ({
  partyId: id,
  partyName: id,
  grossOpenBills: '0',
  unallocatedCashAdvances: '0',
  returnCredits: '0',
  netLedgerBalance: net,
  strandedAllocationsOnVoidBills: stranded,
});
beforeEach(() => {
  document.body.append(host);
  api.getDefaultShopId.mockReset().mockResolvedValue('shop');
  api.getShopBusinessDate.mockReset().mockResolvedValue('2026-10-17');
  api.getSupplierPaymentsDue.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});
async function mount() {
  await act(async () => render(<AttentionTile />, host));
}

test('shows low stock, the exact amount owed, and a stranded-allocation warning', async () => {
  api.getLowStockReport
    .mockReset()
    .mockResolvedValue([
      { item_id: 'a', item_name: 'Oil', unit_name: 'jar', on_hand: 1, min_stock: 5, shortfall: 4 },
    ]);
  api.getSupplierOutstanding.mockReset().mockResolvedValue([sup('a', '123456'), sup('b', '0', 1)]);
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('₹1,234.56'));
  expect(host.textContent).toContain('1 item below minimum stock: Oil (1 jar)');
  expect(host.textContent).toContain('1 supplier has payments still allocated to voided bills');
});

test('a failed report says unavailable and never claims all clear', async () => {
  api.getLowStockReport.mockReset().mockRejectedValue(new Error('x'));
  api.getSupplierOutstanding.mockReset().mockResolvedValue([]);
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('No supplier balance is owed.'));
  expect(host.textContent).toContain('Low stock is unavailable right now.');
  expect(host.textContent).not.toContain('No items below minimum stock.');
});

test('lists due scheduled payments, and an unavailable reminder is not shown as all clear', async () => {
  api.getLowStockReport.mockReset().mockResolvedValue([]);
  api.getSupplierOutstanding.mockReset().mockResolvedValue([]);
  api.getSupplierPaymentsDue.mockReset().mockResolvedValue([
    {
      scheduleId: 's',
      partyId: 'p',
      partyName: 'Acme',
      dueDay: 5,
      dueDate: '2026-10-05',
      expectedAmountPaise: '250000',
      paidThisMonthPaise: '100000',
      remainingPaise: '150000',
      daysOverdue: 12,
    },
  ]);
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('Acme (₹1,500.00, 12 days late)'));
  expect(api.getSupplierPaymentsDue).toHaveBeenCalledWith('shop', '2026-10-17');
  api.getSupplierPaymentsDue.mockReset().mockRejectedValue(new Error('x'));
  await act(async () => render(null, host));
  await mount();
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Supplier payment reminders are unavailable right now.'),
  );
  expect(host.textContent).not.toContain('No scheduled supplier payment is due.');
});

test('SP2: a revisit shows last figures at once, labelled, until fresh ones land', async () => {
  const { clearSnapshots } = await import('../lib/routeSnapshot');
  clearSnapshots();
  api.getSession.mockResolvedValue({ user: { id: 'u' } });
  api.getLowStockReport.mockReset().mockResolvedValue([]);
  api.getSupplierOutstanding.mockReset().mockResolvedValue([sup('a', '123456')]);
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('₹1,234.56'));
  await act(async () => render(null, host));
  api.getSupplierOutstanding.mockReset().mockReturnValue(new Promise(() => {}));
  await mount();
  await vi.waitFor(() => expect(host.textContent).toContain('₹1,234.56'));
  expect(host.querySelector('[data-testid="snapshot-note"]')).not.toBeNull();
});
