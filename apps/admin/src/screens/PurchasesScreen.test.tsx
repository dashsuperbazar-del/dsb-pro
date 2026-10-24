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
  voidPurchaseOutcome: vi.fn(),
  getPurchaseBillVersion: vi.fn(async () => null),
  VOID_REASON_MAX: 200,
  purchaseVoidRequestId: (id: string, tag: { reason?: string; correctedBy?: string }) =>
    tag.reason !== undefined ? `purchase.void.v1:${id}:reason:${tag.reason.trim()}` : 'unused',
  listPurchaseSettlements: vi.fn().mockResolvedValue(new Map()),
  getPurchaseVoidInfo: vi.fn().mockResolvedValue(null),
  getPurchaseEditLinks: vi.fn().mockResolvedValue({ editedFromId: null, replacedById: null } as {
    editedFromId: string | null;
    replacedById: string | null;
  } | null),
  listOpenRemarks: vi.fn().mockResolvedValue([]),
  listDocumentRemarks: vi.fn().mockResolvedValue([]),
  listRemarkHistory: vi.fn().mockResolvedValue([]),
  addRemarkOutcome: vi.fn(),
  editRemarkOutcome: vi.fn(),
  settleRemarkOutcome: vi.fn(),
  reopenRemarkOutcome: vi.fn(),
  plainRemarkRefusal: () => '',
  REMARK_MAX_LENGTH: 300,
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
  localStorage.removeItem('dsb-pending-purchase-void:user:shop:cash1');
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
  await vi.waitFor(() => expect(host.textContent).toContain('Items ₹182.91'));
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
async function openCash(role: string, x: unknown, d: unknown = cashDetail) {
  const { clearSnapshots } = await import('../lib/routeSnapshot');
  clearSnapshots();
  shopContext.invalidate();
  api.getCurrentMembership.mockResolvedValue({ tenantId: 'tenant', role });
  api.listPurchaseHistory.mockResolvedValue([bill('cash1', 'CASH-1')]);
  api.getPurchaseDetail.mockResolvedValue(d);
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
  // Extras that cannot be read say so (never guessed from the payment type).
  await act(async () => render(null, host));
  await openCash('owner', new Error('offline'));
  await vi.waitFor(() => expect(host.textContent).toContain('Payment details could not be loaded'));
  expect(host.querySelector('[data-testid="settlement-badge"]')?.textContent).toBe(
    'Payment status unavailable',
  );
  expect(host.textContent).not.toContain('Settled');
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

const voidBtn = () =>
  [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Void bill"] button')][0]!;
async function typeReason(text: string) {
  await act(async () => {
    const reason = host.querySelector<HTMLInputElement>('[aria-label="Void bill"] input')!;
    reason.value = text;
    reason.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const creditDetail = (allocated = '0', returned = '0') => ({
  ...cashDetail,
  balance: { outstanding_paise: '10000', allocated_paise: allocated, returned_paise: returned },
});

test('a credit bill: plain "Void bill" (never the paid-bill void), reason required, confirm says stock and balance reverse, same id on retry', async () => {
  await openCash('manager', extras('unpaid', 'credit'), creditDetail());
  await vi.waitFor(() => expect(voidBtn().textContent).toBe('Void bill'));
  expect(host.textContent).not.toContain('Void bill and its payment');
  expect(voidBtn().disabled).toBe(true);
  await typeReason('entered twice');
  expect(host.textContent).toContain('Staff who can see this bill can read the reason');
  api.voidPurchaseOutcome.mockResolvedValueOnce({ kind: 'unknown', message: 'answer lost' });
  await act(async () => voidBtn().click());
  expect(vi.mocked(window.confirm).mock.calls[0]![0]).toMatch(/stock comes off.*supplier balance/i);
  await vi.waitFor(() => expect(voidBtn().textContent).toBe('Retry void (same request)'));
  // Leaving the bill (even the screen) while the outcome is unknown keeps the same request.
  await act(async () => render(null, host));
  await openCash('manager', extras('unpaid', 'credit'), creditDetail());
  await vi.waitFor(() => expect(voidBtn().textContent).toBe('Retry void (same request)'));
  expect(host.querySelector<HTMLInputElement>('[aria-label="Void bill"] input')!.value).toBe(
    'entered twice',
  );
  api.voidPurchaseOutcome.mockResolvedValueOnce({ kind: 'committed', value: 'cash1' });
  await act(async () => voidBtn().click());
  await vi.waitFor(() => expect(host.textContent).toContain('Bill voided.'));
  expect(localStorage.getItem('dsb-pending-purchase-void:user:shop:cash1')).toBeNull();
  const [a, b] = api.voidPurchaseOutcome.mock.calls.map((c) => c[0]);
  expect(a.clientId).toMatch(/^purchase\.void\.v1:.+:reason:entered twice$/);
  expect(b).toEqual(a);
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(api.voidPaidPurchaseOutcome).not.toHaveBeenCalled();
});

test('credit void refused by the server says what to do; a known payment/return blocks the void', async () => {
  await openCash('owner', extras('unpaid', 'credit'), creditDetail());
  await vi.waitFor(() => expect(voidBtn().textContent).toBe('Void bill'));
  await typeReason('wrong supplier');
  api.voidPurchaseOutcome.mockResolvedValueOnce({
    kind: 'rejected',
    code: 'P0001',
    message: 'purchase has active allocations; void or release allocations first',
  });
  await act(async () => voidBtn().click());
  await vi.waitFor(() => expect(host.textContent).toContain('Release or void that payment first'));
  expect(voidBtn().textContent).toBe('Void bill');
  // Known from the ledger before sending: no void button.
  await act(async () => render(null, host));
  await openCash('owner', extras('partial', 'credit'), creditDetail('0', '500'));
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="void-blocked"]')?.textContent).toContain(
      'supplier returns',
    ),
  );
});

test('role gating: an accountant cannot void a credit bill; a manager can', async () => {
  await openCash('accountant', extras('unpaid', 'credit'), creditDetail());
  await vi.waitFor(() => expect(host.textContent).toContain('Credit bill'));
  expect(host.querySelector('[aria-label="Void bill"] button')).toBeNull();
  expect(host.querySelector('[data-testid="void-not-allowed"]')?.textContent).toContain(
    'Only the owner or a manager',
  );
  expect(host.querySelector('[data-testid="edit-bill"]')).toBeNull();
  await act(async () => render(null, host));
  await openCash('manager', extras('unpaid', 'credit'), creditDetail());
  await vi.waitFor(() => expect(voidBtn().textContent).toBe('Void bill'));
  // 0066: a manager may correct the bill (one server transaction); an accountant never sees it.
  await vi.waitFor(() => expect(host.textContent).toContain('Edit bill'));
});

test('list shows Paid/Partial/Unpaid/Void from the ledger and filters by it', async () => {
  const { clearSnapshots } = await import('../lib/routeSnapshot');
  clearSnapshots();
  shopContext.invalidate();
  api.getCurrentMembership.mockResolvedValue({ tenantId: 'tenant', role: 'owner' });
  api.listPurchaseHistory.mockResolvedValue([bill('p1', 'PAID-1'), bill('u1', 'UNPAID-1')]);
  const st = (status: string) => ({ status });
  api.listPurchaseSettlements.mockResolvedValue(
    new Map([
      ['p1', st('settled')],
      ['u1', st('unpaid')],
    ]),
  );
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll('[data-testid="list-settlement"]')].map((e) => e.textContent),
    ).toEqual(['Paid', 'Unpaid']),
  );
  const select = [...host.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'unpaid'),
  )!;
  await act(async () => {
    select.value = 'unpaid';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelector('.record-list')!.textContent).toContain('UNPAID-1');
  expect(host.querySelector('.record-list')!.textContent).not.toMatch(/\bPAID-1/);
  expect(host.querySelectorAll('.record-list > button').length).toBe(1);
});

test('a reopened cached bill is marked refreshing, and a failed refresh flags it out of date with Retry', async () => {
  await openCash('owner', extras('settled'));
  await vi.waitFor(() => expect(host.textContent).toContain('Void bill and its payment'));
  const closeBtn = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Close detail',
  )!;
  await act(async () => closeBtn.click());
  let fail!: (e: Error) => void;
  api.getPurchaseDetail.mockReturnValueOnce(new Promise((_, r) => (fail = r)));
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CASH-1'))!.click();
  });
  // The cached bill shows at once, labelled, and cannot be voided until the fresh read arrives.
  expect(host.textContent).toContain('Oil');
  expect(host.textContent).toContain('Refreshing…');
  const voidBtn = () =>
    [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Void bill and its payment'),
    );
  expect(voidBtn()?.disabled ?? true).toBe(true);
  await act(async () => fail(new Error('network down')));
  await vi.waitFor(() => expect(host.textContent).toContain('may be out of date'));
  expect(host.textContent).toContain('network down');
  expect(voidBtn()?.disabled ?? true).toBe(true);
  api.getPurchaseDetail.mockResolvedValue(cashDetail);
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click();
  });
  await vi.waitFor(() => expect(host.textContent).not.toContain('may be out of date'));
  expect(host.textContent).not.toContain('Refreshing…');
});

test('a remount (sign-out, other user or shop) never shows a bill cached by the previous screen', async () => {
  await openCash('owner', extras('settled'));
  await vi.waitFor(() => expect(host.textContent).toContain('Oil'));
  act(() => render(null, host));
  let hold!: (v: unknown) => void;
  api.getPurchaseDetail.mockReturnValueOnce(new Promise((r) => (hold = r)));
  // The list itself is held so no list refresh can clear the cache first.
  api.listPurchaseHistory.mockReturnValueOnce(new Promise(() => {}));
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('CASH-1'));
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CASH-1'))!.click();
  });
  expect(host.textContent).not.toContain('Oil');
  await act(async () => hold(cashDetail));
});

test('"Edit bill" (0066): offered to owner/manager on a posted bill only when the edit links can be read', async () => {
  const editLink = () => host.querySelector<HTMLAnchorElement>('[data-testid="edit-bill"]');
  await openCash('manager', extras('unpaid', 'credit'), creditDetail());
  await vi.waitFor(() => expect(editLink()).not.toBeNull());
  expect(editLink()!.getAttribute('href')).toContain('?new=1&edit=cash1');
  // A database without 0066 (links unreadable): no edit is offered.
  await act(async () => render(null, host));
  api.getPurchaseEditLinks.mockResolvedValueOnce(null);
  await openCash('manager', extras('unpaid', 'credit'), creditDetail());
  await vi.waitFor(() => expect(host.textContent).toContain('Void bill'));
  expect(editLink()).toBeNull();
  // A corrected bill names its original.
  await act(async () => render(null, host));
  api.getPurchaseEditLinks.mockResolvedValueOnce({ editedFromId: 'old1', replacedById: null });
  await openCash('owner', extras('unpaid', 'credit'), creditDetail());
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="bill-edited-from"]')?.textContent).toContain(
      'Open the original',
    ),
  );
});

test('remarks (0067): "Pending" badge and filter from open remarks; the bill view shows its remark box', async () => {
  const { clearSnapshots } = await import('../lib/routeSnapshot');
  clearSnapshots();
  api.listPurchaseHistory.mockResolvedValue([bill('r1', 'RND-1'), bill('r0', 'OLD-0')]);
  api.listOpenRemarks.mockResolvedValue([
    {
      id: 'rm1',
      docKind: 'purchase',
      docId: 'r1',
      docNo: 'RND-1',
      partyName: null,
      businessDate: '2026-10-13',
      docStatus: 'POSTED',
      body: '5 kg sugar short',
      createdAt: '2026-10-13T10:00:00Z',
      version: 1,
    },
  ]);
  api.listDocumentRemarks.mockResolvedValue([
    {
      id: 'rm1',
      docId: 'r1',
      fromEarlierBill: false,
      body: '5 kg sugar short',
      status: 'OPEN',
      version: 1,
      createdBy: 'user',
      createdAt: '2026-10-13T10:00:00Z',
      settledBy: null,
      settledAt: null,
    },
  ]);
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelectorAll('[data-testid="list-pending"]').length).toBe(1),
  );
  const select = [...host.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'pending'),
  )!;
  await act(async () => {
    select.value = 'pending';
    select.dispatchEvent(new Event('change'));
  });
  expect(host.textContent).toContain('RND-1');
  expect(host.textContent).not.toContain('OLD-0');
  api.getPurchaseDetail.mockResolvedValueOnce({
    bill: { ...bill('r1', 'RND-1'), bill_image_path: null },
    lines: [],
    balance: null,
  });
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('RND-1'))!.click();
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="remark"]')?.textContent).toContain('5 kg sugar short'),
  );
  expect(api.listDocumentRemarks).toHaveBeenCalledWith('purchase', 'r1');
  expect(host.textContent).toContain('Mark settled');
  api.listOpenRemarks.mockResolvedValue([]);
  api.listDocumentRemarks.mockResolvedValue([]);
});

test('bill codes: the list shows them, search finds a bill by its code (case, dashes, 4+ characters), old rows without one still work', async () => {
  const { clearSnapshots } = await import('../lib/routeSnapshot');
  clearSnapshots();
  api.listPurchaseHistory.mockResolvedValue([
    { ...bill('c1', 'SUP-1'), bill_code: 'K7M2-QX9P' },
    { ...bill('c2', ''), bill_code: 'ZZ4W-HH8N' },
    bill('c3', 'OLD-3'),
  ]);
  await act(async () => {
    render(<PurchasesScreen url="/purchases" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('OLD-3'));
  // A bill with no supplier bill no. is named by its code, never by a raw id; both show when both exist.
  expect(host.textContent).toContain('SUP-1 · K7M2-QX9P');
  expect(host.textContent).toContain('ZZ4W-HH8N');
  const search = host.querySelector<HTMLInputElement>('.search-field input')!;
  const type = async (value: string) => {
    await act(async () => {
      search.value = value;
      search.dispatchEvent(new Event('input'));
    });
  };
  await type('k7m2qx');
  expect(host.textContent).toContain('SUP-1');
  expect(host.textContent).not.toContain('OLD-3');
  expect(host.textContent).not.toContain('ZZ4W-HH8N');
  await type('zz4w-hh');
  expect(host.textContent).toContain('ZZ4W-HH8N');
  expect(host.textContent).not.toContain('SUP-1');
  await type('k7m');
  expect(host.textContent).not.toContain('K7M2-QX9P');
  await type('OLD-3');
  expect(host.textContent).toContain('OLD-3');
});
