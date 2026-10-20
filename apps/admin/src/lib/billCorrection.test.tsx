// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

const api = vi.hoisted(() => ({
  voidPurchaseOutcome: vi.fn(),
  voidPaidPurchaseOutcome: vi.fn(),
  purchaseVoidRequestId: (id: string, tag: { correctedBy?: string; reason?: string }) =>
    tag.correctedBy
      ? `purchase.void.v1:${id}:corrected-by:${tag.correctedBy}`
      : `purchase.void.v1:${id}:reason:${tag.reason}`,
  VOID_REASON_MAX: 200,
  getPurchaseVoidInfo: vi.fn().mockResolvedValue(null),
  findCorrectedBill: vi.fn().mockResolvedValue(null),
}));
vi.mock('@dsb-pro/adapters', () => api);
import {
  completeCorrection,
  correctionBlocker,
  listCorrections,
  loadCorrection,
  pendingVoids,
  saveCorrection,
  type CorrectionRecord,
} from './billCorrection';
import { BillCorrectionLinks, CorrectionAlerts } from '../components/BillCorrection';

const ORIGINAL = '55555555-5555-4555-8555-555555555555';
const NEW_BILL = '77777777-7777-4777-8777-777777777777';
const rec = (over: Partial<CorrectionRecord> = {}): CorrectionRecord => ({
  v: 1,
  shopId: 'shop',
  newClientId: 'draft-1',
  originalId: ORIGINAL,
  originalLabel: 'bill A-1',
  originalPaymentType: 'credit',
  voidRequestId: '22222222-2222-4222-8222-222222222222',
  state: 'draft',
  savedAt: Date.now(),
  ...over,
});
const host = document.createElement('div');
beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => render(null, host));
  vi.clearAllMocks();
});

test('reload mid-correction: the record is found again by the draft client id', () => {
  saveCorrection(rec());
  // A "reload": nothing in memory, only storage.
  expect(loadCorrection('shop', 'draft-1')).toMatchObject({
    originalId: ORIGINAL,
    state: 'draft',
  });
  expect(loadCorrection('other-shop', 'draft-1')).toBeNull();
  expect(pendingVoids('shop')).toEqual([]);
  // An abandoned draft-stage record expires; a posted one never does.
  saveCorrection(rec({ newClientId: 'old', savedAt: 0 }));
  saveCorrection(
    rec({ newClientId: 'old-posted', savedAt: 0, state: 'posted', newBillId: NEW_BILL }),
  );
  expect(listCorrections('shop').map((r) => r.newClientId)).toEqual(['old-posted', 'draft-1']);
});

test('edit -> post -> auto void: a credit original is voided with "corrected by" the new bill, record removed', async () => {
  const posted = rec({ state: 'posted', newBillId: NEW_BILL, newBillLabel: 'bill A-1' });
  saveCorrection(posted);
  api.voidPurchaseOutcome.mockResolvedValueOnce({ kind: 'committed', value: ORIGINAL });
  const r = await completeCorrection(posted);
  expect(r.done).toBe(true);
  expect(api.voidPurchaseOutcome).toHaveBeenCalledWith({
    purchaseId: ORIGINAL,
    clientId: `purchase.void.v1:${posted.voidRequestId}:corrected-by:${NEW_BILL}`,
  });
  expect(loadCorrection('shop', 'draft-1')).toBeNull();
});

test('a cash original is voided with its payment by the owner path, reason "Corrected by …"', async () => {
  const posted = rec({
    originalPaymentType: 'cash',
    state: 'posted',
    newBillId: NEW_BILL,
    newBillLabel: 'bill B-2',
  });
  api.voidPaidPurchaseOutcome.mockResolvedValueOnce({
    kind: 'committed',
    value: { billId: ORIGINAL, paymentId: null, paymentVoided: true },
  });
  await completeCorrection(posted);
  expect(api.voidPaidPurchaseOutcome).toHaveBeenCalledWith({
    purchaseId: ORIGINAL,
    reason: 'Corrected by bill B-2',
    clientId: posted.voidRequestId,
  });
});

test('void failure -> persistent alert -> Retry sends the same request and clears the alert', async () => {
  const posted = rec({ state: 'posted', newBillId: NEW_BILL, newBillLabel: 'bill A-1 (new)' });
  saveCorrection(posted);
  api.voidPurchaseOutcome.mockResolvedValueOnce({
    kind: 'rejected',
    code: 'P0001',
    message: 'void posted returns before voiding the purchase',
  });
  const first = await completeCorrection(posted);
  expect(first.done).toBe(false);
  expect(first.message).toContain('Void those returns first');
  await act(async () => {
    render(<CorrectionAlerts shopId="shop" />, host);
  });
  const alert = host.querySelector('[data-testid="correction-alert"]')!;
  expect(alert.textContent).toContain('bill A-1 is still live');
  expect(alert.textContent).toContain('Void those returns first');
  api.voidPurchaseOutcome.mockResolvedValueOnce({ kind: 'committed', value: ORIGINAL });
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry void')!.click();
  });
  await vi.waitFor(() => expect(host.querySelector('[data-testid="correction-alert"]')).toBeNull());
  const [a, b] = api.voidPurchaseOutcome.mock.calls.map((c) => c[0]);
  expect(b).toEqual(a);
});

test('an unconfirmed void keeps the record (never silently both bills)', async () => {
  const posted = rec({ state: 'posted', newBillId: NEW_BILL });
  saveCorrection(posted);
  api.voidPurchaseOutcome.mockResolvedValueOnce({ kind: 'unknown', message: 'Failed to fetch' });
  const r = await completeCorrection(posted);
  expect(r.message).toContain('never voids twice');
  expect(pendingVoids('shop')).toHaveLength(1);
});

test('blockers come from the ledger balance', () => {
  const d = (alloc: string, ret: string) => ({
    balance: { allocated_paise: alloc, returned_paise: ret },
  });
  expect(correctionBlocker(d('100', '0'), 'credit')).toContain('payment');
  expect(correctionBlocker(d('100', '0'), 'cash')).toBe('');
  expect(correctionBlocker(d('0', '1'), 'cash')).toContain('returns');
  expect(correctionBlocker({ balance: null }, 'credit')).toBe('');
});

test('bill detail shows the link both ways', async () => {
  api.getPurchaseVoidInfo.mockResolvedValueOnce({ reason: null, correctedBy: NEW_BILL });
  const onOpen = vi.fn();
  await act(async () => {
    render(
      <BillCorrectionLinks shopId="shop" billId={ORIGINAL} status="VOID" onOpen={onOpen} />,
      host,
    );
  });
  await vi.waitFor(() => expect(host.querySelector('[data-testid="corrected-by"]')).not.toBeNull());
  await act(async () => host.querySelector<HTMLButtonElement>('.link')!.click());
  expect(onOpen).toHaveBeenCalledWith(NEW_BILL);
  api.findCorrectedBill.mockResolvedValueOnce(ORIGINAL);
  await act(async () => {
    render(
      <BillCorrectionLinks shopId="shop" billId={NEW_BILL} status="POSTED" onOpen={onOpen} />,
      host,
    );
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="correction-of"]')).not.toBeNull(),
  );
});
