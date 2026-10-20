// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
  getPurchaseExtras: vi.fn().mockRejectedValue(new Error('not mocked')),
  voidPaidPurchaseOutcome: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
vi.mock('./InventoryScreen', () => ({
  InventoryScreen: ({ onPurchasePosted }: { onPurchasePosted: () => void }) => (
    <button onClick={onPurchasePosted}>Post fixture purchase</button>
  ),
}));
const host = document.createElement('div');
beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
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

// billextras: paid/unpaid comes only from the ledger-derived settlement, never from the payment type.
const cashDetail = {
  bill: {
    ...bill('cash1', 'CASH-1'),
    party_id: null,
    subtotal_paise: '10049',
    discount_paise: '0',
    extra_charges_paise: '0',
    round_off_paise: '-49',
    total_paise: '10000',
    bill_image_path: null,
  },
  lines: [
    {
      id: 'l1',
      line_no: 1,
      item_name_snapshot: 'Oil',
      qty: '1',
      unit_name_snapshot: 'jar',
      unit_price_paise: '10049',
      line_total_paise: '10049',
    },
  ],
  balance: { outstanding_paise: '0', allocated_paise: '10000', returned_paise: '0' },
};
const extras = (status: string, paymentType = 'cash') => ({
  paymentType,
  notes: 'Paid at the counter',
  lines: [{ lineNo: 1, discountBp: 250, gstBp: 0 }],
  charges: [{ lineNo: 1, label: 'Transport', amountPaise: '0' }],
  images: [],
  settlement: { status, outstandingPaise: null, allocatedPaise: null, returnedPaise: null },
});
async function openCash(role: string, x: unknown) {
  const { clearSnapshots } = await import('../lib/routeSnapshot');
  clearSnapshots();
  shopContext.invalidate();
  api.getCurrentMembership.mockResolvedValue({ tenantId: 'tenant', role });
  api.listPurchaseHistory.mockResolvedValue([bill('cash1', 'CASH-1')]);
  api.getPurchaseDetail.mockResolvedValue(cashDetail);
  if (x instanceof Error) api.getPurchaseExtras.mockRejectedValue(x);
  else api.getPurchaseExtras.mockResolvedValue(x);
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('CASH-1'));
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CASH-1'))!.click();
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="Purchase detail"]')).not.toBeNull(),
  );
}
test('paid badge comes from the settlement: a cash bill whose payment was voided reads Unpaid', async () => {
  await openCash('owner', extras('unpaid'));
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="settlement-badge"]')?.textContent).toBe('Unpaid'),
  );
  const detail = host.querySelector('[aria-label="Purchase detail"]')!.textContent!;
  expect(detail).toContain('Cash bill');
  expect(detail).toContain('Notes: Paid at the counter');
  expect(detail).toContain('− 2.5% discount + 0% GST');
  expect(detail).toContain('Round off −₹0.49');
  expect(detail).not.toMatch(/\bPaid\b(?! at)/);
  await act(async () => render(null, host));
  await openCash('owner', extras('settled'));
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="settlement-badge"]')?.textContent).toBe('Settled'),
  );
  // Extras that cannot be read show no badge at all (never guessed from the payment type).
  await act(async () => render(null, host));
  await openCash('owner', new Error('offline'));
  await vi.waitFor(() => expect(host.textContent).toContain('Payment details could not be loaded'));
  expect(host.querySelector('[data-testid="settlement-badge"]')).toBeNull();
});

test('void of a cash bill: owner voids bill and payment with one request id; others are told why not', async () => {
  await openCash('manager', extras('settled'));
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="void-not-allowed"]')?.textContent).toContain(
      'Only the owner can void a Cash bill',
    ),
  );
  expect(
    [...host.querySelectorAll('button')].some((b) => b.textContent === 'Void bill and its payment'),
  ).toBe(false);
  await act(async () => render(null, host));
  await openCash('owner', extras('settled'));
  const voidButton = () =>
    [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Void bill"] button')][0]!;
  await vi.waitFor(() => expect(voidButton().textContent).toBe('Void bill and its payment'));
  expect(voidButton().disabled).toBe(true); // a reason is required
  await act(async () => {
    const reason = host.querySelector<HTMLInputElement>('[aria-label="Void bill"] input')!;
    reason.value = 'entered twice';
    reason.dispatchEvent(new Event('input', { bubbles: true }));
  });
  api.voidPaidPurchaseOutcome.mockResolvedValueOnce({ kind: 'unknown', message: 'answer lost' });
  await act(async () => voidButton().click());
  await vi.waitFor(() => expect(voidButton().textContent).toBe('Retry void (same request)'));
  expect(host.querySelector<HTMLInputElement>('[aria-label="Void bill"] input')!.readOnly).toBe(
    true,
  );
  api.voidPaidPurchaseOutcome.mockResolvedValueOnce({
    kind: 'committed',
    value: { billId: 'cash1', paymentId: 'pay', paymentVoided: true },
  });
  api.getPurchaseExtras.mockResolvedValue(extras('void'));
  await act(async () => voidButton().click());
  await vi.waitFor(() => expect(host.textContent).toContain('Bill and its payment voided.'));
  const [first, second] = api.voidPaidPurchaseOutcome.mock.calls.map((c) => c[0]);
  expect(first).toEqual({
    purchaseId: 'cash1',
    reason: 'entered twice',
    clientId: expect.any(String),
  });
  expect(second).toEqual(first);
  expect(window.confirm).toHaveBeenCalledTimes(1);
});

test('a credit bill offers no paid-bill void', async () => {
  await openCash('owner', extras('unpaid', 'credit'));
  await vi.waitFor(() => expect(host.textContent).toContain('Credit bill'));
  expect(host.querySelector('[aria-label="Void bill"]')).toBeNull();
});
