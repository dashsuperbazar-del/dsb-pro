// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import 'fake-indexeddb/auto';
import { purchaseBillTotals } from '@dsb-pro/core';
import { InventoryScreen } from './InventoryScreen';
import { shopContext } from '../lib/shopContext';
import { resetCatalogDirtyForTests } from '../lib/catalogRead';

// billextras bill entry (v2): payment type, notes, item discount/GST, named charges, several photos and the
// round-off, posted through postPurchaseV2Outcome with the pending-intent retry pattern.
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SHOP = 'a0000000-0000-0000-0000-000000000002';
const api = vi.hoisted(() => ({
  BILL_DOCUMENT_PATH:
    /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(webp|pdf)$/,
  billDocumentPath: vi.fn(
    (tenant, shop, client, id, mime) =>
      `${tenant}/${shop}/${client}/${id}.${mime === 'application/pdf' ? 'pdf' : 'webp'}`,
  ),
  billDocumentHash: vi.fn().mockResolvedValue('a'.repeat(64)),
  uploadBillDocument: vi.fn().mockResolvedValue(undefined),
  readBillDocument: vi.fn(),
  onAuthStateChange: vi.fn().mockReturnValue(() => {}),
  getSession: vi.fn().mockResolvedValue({ user: { id: 'user' } }),
  getCurrentMembership: vi.fn(),
  getDefaultShopId: vi.fn(),
  getShopBusinessDate: vi.fn().mockResolvedValue('2026-10-12'),
  listItems: vi.fn(),
  listParties: vi.fn(),
  listStock: vi.fn().mockResolvedValue([]),
  listCurrentPrices: vi.fn().mockResolvedValue([]),
  setItemPrice: vi.fn(),
  listPurchaseHistory: vi.fn().mockResolvedValue([]),
  getPurchaseDetail: vi.fn(),
  getPurchaseExtras: vi.fn(),
  postPurchaseOutcome: vi.fn(),
  postPurchaseV2Outcome: vi.fn(),
  listItemPurchasePrices: vi.fn().mockResolvedValue([]),
  listItemSaleMovements: vi.fn().mockResolvedValue({ sales: [], returns: [], truncated: false }),
}));
vi.mock('@dsb-pro/adapters', () => api);
const offline = vi.hoisted(() => ({
  getSyncedOfflineCatalog: vi.fn(),
  runSyncNow: vi.fn(),
}));
vi.mock('../lib/offlineSync', () => offline);
const host = document.createElement('div');
const itemA = { id: 'a', name: 'Item A', unit1: 'piece', min_stock: 0 };
let onLine = true;
beforeEach(() => {
  shopContext.invalidate();
  resetCatalogDirtyForTests();
  offline.getSyncedOfflineCatalog.mockResolvedValue(null);
  offline.runSyncNow.mockResolvedValue(undefined);
  api.getCurrentMembership.mockResolvedValue({ tenantId: TENANT, role: 'owner' });
  api.getDefaultShopId.mockResolvedValue(SHOP);
  api.listItems.mockResolvedValue([itemA]);
  api.listParties.mockResolvedValue([{ id: 'p1', name: 'Acme' }]);
  onLine = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  document.body.append(host);
});
afterEach(() => {
  act(() => render(null, host));
  vi.clearAllMocks();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function setField(sel: string, value: string, event = 'input') {
  await act(async () => {
    const el = host.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}
const label = (text: string) => `[aria-label="${text}"]`;
const button = (text: string, root: ParentNode = host) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text)!;
const click = (el: HTMLElement) => act(async () => el.click());
const postButton = () => host.querySelector<HTMLButtonElement>('.bill-bar button')!;
const text = (testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
async function mountEditor() {
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelector('select[name="partyId"] option[value="p1"]')).not.toBeNull(),
  );
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLInputElement>('input[name="date"]')!.value).toBe('2026-10-12'),
  );
}
async function item(
  n: number,
  qty: string,
  rate: string,
  more: { disc?: string; gst?: string } = {},
) {
  if (n > 1) await click(button('+ Add item'));
  await setField(label(`Item ${n} name`), 'Item A');
  await click(button('Item A', host.querySelector(label(`Matches for item ${n}`))!));
  await setField(label(`Item ${n} quantity`), qty);
  await setField(label(`Item ${n} rate ₹`), rate);
  if (more.disc !== undefined) await setField(label(`Item ${n} discount %`), more.disc);
  if (more.gst !== undefined) await setField(label(`Item ${n} GST %`), more.gst);
}
const pay = (type: 'Credit' | 'Cash' | 'UPI') =>
  click(button(type, host.querySelector(label('Payment type'))!));
const withoutSavedAt = (o: Record<string, unknown>) => {
  const copy = { ...o };
  delete copy.savedAt;
  return copy;
};
const committed = (totalPaise: number, roundOffPaise: number, paymentId: string | null = null) => ({
  kind: 'committed',
  value: { billId: 'bill-1', paymentId, totalPaise, roundOffPaise, businessDate: '2026-10-12' },
});

test('GST blank is sent as null (price includes GST); 0 is sent as 0% added; the hint says which', async () => {
  await mountEditor();
  await item(1, '20', '8.71');
  expect(text('item-1-gst-hint')).toBe(
    'GST blank: the rate already includes GST. Nothing is added.',
  );
  expect(text('item-1-amount')).toBe('Amount ₹174.20');
  await item(2, '20', '8.71', { gst: '0' });
  expect(text('item-2-gst-hint')).toBe('0% added: no GST on this item.');
  await item(3, '20', '8.71', { gst: '5' });
  expect(text('item-3-gst-hint')).toBe('5% GST added on top of the rate.');
  // Item total after GST: 20 x 8.71 + 5% = 182.91 (exactly the server line total).
  expect(text('item-3-amount')).toBe('₹174.20 + 5% GST Item total ₹182.91');
  await item(4, '3', '99.99', { disc: '10', gst: '18' });
  expect(text('item-4-amount')).toBe('₹299.97 − 10% discount + 18% GST Item total ₹318.57');
  api.postPurchaseV2Outcome.mockResolvedValue(committed(85000, 7));
  await click(postButton());
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  const [req] = api.postPurchaseV2Outcome.mock.calls[0];
  expect(
    req.lines.map((l: { discountBp: number; gstBp: number | null }) => [l.discountBp, l.gstBp]),
  ).toEqual([
    [0, null],
    [0, 0],
    [0, 500],
    [1000, 1800],
  ]);
});

test('totals block equals core purchaseBillTotals: discount, named charges, round-off, final total', async () => {
  await mountEditor();
  await item(1, '20', '8.71', { gst: '5' });
  await item(2, '1.333', '75.50', { disc: '7', gst: '5' });
  await click(button('+ Add charge'));
  await setField(label('Extra charge 1 name'), 'Transport');
  await setField(label('Extra charge 1 amount ₹'), '25.75');
  await click(button('+ Add charge'));
  await setField(label('Extra charge 2 name'), 'Loading');
  await setField(label('Extra charge 2 amount ₹'), '4');
  expect(text('charges-sum')).toBe('Extra charges ₹29.75');
  await setField('input[name="discount"]', '12.34');
  const core = purchaseBillTotals({
    lines: [
      { qty: '20', unitPricePaise: 871, discountBp: 0, gstBp: 500 },
      { qty: '1.333', unitPricePaise: 7550, discountBp: 700, gstBp: 500 },
    ],
    discountPaise: 1234,
    charges: [
      { label: 'Transport', amountPaise: 2575 },
      { label: 'Loading', amountPaise: 400 },
    ],
  });
  // 182.91 + 98.28 = 281.19 − 12.34 + 29.75 = 298.60 → round off +0.40 → 299.00
  expect(core).toMatchObject({
    subtotalPaise: 28119,
    totalBeforeRoundOffPaise: 29860,
    roundOffPaise: 40,
  });
  const block = text('bill-total');
  expect(block).toContain('Items (2)₹281.19');
  expect(block).toContain('Bill discount−₹12.34');
  expect(block).toContain('Extra charges+₹29.75');
  expect(block).toContain('Total before round off₹298.60');
  expect(text('round-off')).toBe('Round off+₹0.40');
  expect(block).toContain('Bill total₹299.00');
  // Removing a charge row updates the sum and the total.
  await click(host.querySelector<HTMLButtonElement>(label('Remove extra charge 2'))!);
  expect(text('charges-sum')).toBe('Extra charges ₹25.75');
  expect(text('round-off')).toBe('Round off+₹0.40');
  expect(text('bill-total')).toContain('Bill total₹295.00');
  // A started charge row without an amount blocks posting and says which.
  await click(button('+ Add charge'));
  await setField(label('Extra charge 2 name'), 'Packing');
  await click(postButton());
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  expect(host.querySelector('.bill-bar')!.textContent).toContain(
    'Extra charge 2: Enter the amount for “Packing”.',
  );
  await click(host.querySelector<HTMLButtonElement>(label('Remove extra charge 2'))!);
  api.postPurchaseV2Outcome.mockResolvedValue(committed(29500, 40));
  await click(postButton());
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  expect(api.postPurchaseV2Outcome.mock.calls[0][0]).toMatchObject({
    discountPaise: 1234,
    charges: [{ label: 'Transport', amountPaise: 2575 }],
  });
});

test('a cash bill says "Paid in full ₹X now" before Post, needs a supplier, and posts as cash', async () => {
  await mountEditor();
  await item(1, '1', '100.49');
  expect(postButton().textContent).toBe('Post purchase');
  expect(host.querySelector('[data-testid="paid-now"]')).toBeNull();
  await pay('Cash');
  expect(text('paid-now')).toContain('Paid in full ₹100.00 now by Cash');
  expect(postButton().textContent).toBe('Post and pay ₹100.00 by Cash');
  // No supplier: refused before anything is sent.
  await click(postButton());
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  expect(host.textContent).toContain('A Cash bill is paid to a supplier');
  await setField('select[name="partyId"]', 'p1', 'change');
  // A paid bill cannot be dated after today.
  await setField('input[name="date"]', '2026-10-13');
  await click(postButton());
  expect(host.textContent).toContain('cannot be dated after today');
  await setField('input[name="date"]', '2026-10-12');
  await pay('UPI');
  expect(postButton().textContent).toBe('Post and pay ₹100.00 by UPI');
  await pay('Cash');
  api.postPurchaseV2Outcome.mockResolvedValue(committed(10000, -49, 'pay-1'));
  await click(postButton());
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted (1 item)'));
  expect(api.postPurchaseV2Outcome.mock.calls[0][0]).toMatchObject({
    api: 'v2',
    paymentType: 'cash',
    partyId: 'p1',
  });
  expect(host.textContent).toContain('Paid in full ₹100.00 by Cash.');
  // The next bill starts as Credit again.
  expect(
    button('Credit', host.querySelector(label('Payment type'))!).getAttribute('aria-pressed'),
  ).toBe('true');
});

test('notes are kept to 500 characters with a counter and sent trimmed', async () => {
  await mountEditor();
  await item(1, '1', '10');
  const notes = host.querySelector<HTMLTextAreaElement>('textarea[name="notes"]')!;
  expect(notes.maxLength).toBe(500);
  await setField('textarea[name="notes"]', '  Rate agreed on phone  ');
  expect(text('notes-count')).toBe('20/500');
  api.postPurchaseV2Outcome.mockResolvedValue(committed(1000, 0));
  await click(postButton());
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  expect(api.postPurchaseV2Outcome.mock.calls[0][0].notes).toBe('Rate agreed on phone');
});

test('offline: Post is disabled with a clear message and nothing is sent; the draft keeps the new fields', async () => {
  await mountEditor();
  await item(1, '2', '10', { disc: '5', gst: '' });
  await pay('UPI');
  await act(async () => {
    onLine = false;
    window.dispatchEvent(new Event('offline'));
  });
  expect(postButton().disabled).toBe(true);
  expect(text('offline-post')).toContain('Purchases post only online; nothing was sent');
  await act(async () => {
    postButton().form!.requestSubmit(postButton());
  });
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  const key = Object.keys(localStorage).find((k) => k.startsWith('dsb-purchase-draft:'))!;
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
    paymentType: 'upi',
    cards: [{ discount: '5' }],
  });
  await act(async () => {
    onLine = true;
    window.dispatchEvent(new Event('online'));
  });
  expect(host.querySelector('[data-testid="offline-post"]')).toBeNull();
});

test('a lost reply is retried as the same v2 request (same id, same payload), even after a reload', async () => {
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await item(1, '3', '10.03', { gst: '5' });
  await pay('Cash');
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'unknown', message: 'answer lost' });
  await click(postButton());
  await vi.waitFor(() => expect(host.textContent).toContain('Not confirmed: answer lost'));
  expect(host.textContent).toContain('never posts it (or its payment) twice');
  const first = api.postPurchaseV2Outcome.mock.calls[0];
  expect(first[1]).toBe(false);
  // Stored before sending, as a v2 entry.
  const stored = JSON.parse(
    localStorage.getItem(`dsb-pending-purchase:${SHOP}:${first[0].clientId}`)!,
  );
  expect(stored).toMatchObject({ api: 'v2', clientId: first[0].clientId, paymentType: 'cash' });
  expect(host.textContent).toContain('This bill was sent as a Cash bill');
  // Reload: the screen offers only the safe retry of the stored request.
  await act(async () => render(null, host));
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() => expect(postButton().textContent).toBe('Retry same purchase'));
  api.postPurchaseV2Outcome.mockResolvedValueOnce(committed(3200, 4, 'pay-1'));
  await click(postButton());
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted (1 item)'));
  expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(2);
  const [again, isRetry] = api.postPurchaseV2Outcome.mock.calls[1];
  expect(isRetry).toBe(true);
  // The resent request is the stored one (savedAt is storage bookkeeping) and equals the first send.
  expect(withoutSavedAt(again)).toEqual(withoutSavedAt(stored));
  expect(withoutSavedAt(again)).toEqual(JSON.parse(JSON.stringify(first[0])));
  expect(Object.keys(localStorage).filter((k) => k.startsWith('dsb-pending-purchase:'))).toEqual(
    [],
  );
});

test('a payload mismatch is a final refusal shown clearly; nothing is resent', async () => {
  await mountEditor();
  await item(1, '1', '10');
  api.postPurchaseV2Outcome.mockResolvedValue({
    kind: 'rejected',
    code: 'DSB_PAYLOAD_MISMATCH',
    message:
      'This request id was already used for a different purchase (bill b-9). Nothing new was saved; check Purchases before entering the bill again.',
  });
  await click(postButton());
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Not posted, and it cannot be posted from this form'),
  );
  expect(host.textContent).toContain('already used for a different purchase (bill b-9)');
  expect(postButton().textContent).toBe('Post purchase');
  expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1);
  expect(Object.keys(localStorage).filter((k) => k.startsWith('dsb-pending-purchase:'))).toEqual(
    [],
  );
});

test('a v1 purchase left unconfirmed by the previous version is retried as v1, unchanged', async () => {
  const v1 = {
    shopId: SHOP,
    clientId: 'c0000000-0000-0000-0000-000000000001',
    businessDate: '2026-10-11',
    discountPaise: 0,
    extraChargesPaise: 0,
    lines: [{ itemId: 'a', unitLevel: 1, qty: '2', unitPricePaise: 1000 }],
    savedAt: 1,
  };
  localStorage.setItem(`dsb-pending-purchase:${SHOP}:${v1.clientId}`, JSON.stringify(v1));
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() => expect(postButton().textContent).toBe('Retry same purchase'));
  api.postPurchaseOutcome.mockResolvedValue({ kind: 'committed', value: 'bill-v1' });
  await click(postButton());
  await vi.waitFor(() => expect(api.postPurchaseOutcome).toHaveBeenCalledTimes(1));
  const [sent, isRetry] = api.postPurchaseOutcome.mock.calls[0];
  expect(isRetry).toBe(true);
  expect(withoutSavedAt(sent)).toEqual(withoutSavedAt(v1));
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
});

test('several bill photos are uploaded to this bill and sent in order; the first is the bill document', async () => {
  await mountEditor();
  await item(1, '1', '10');
  const picker = host.querySelector<HTMLInputElement>('input[aria-label="Choose bill PDF"]')!;
  for (const name of ['page-1.pdf', 'page-2.pdf']) {
    Object.defineProperty(picker, 'files', {
      configurable: true,
      value: [new File(['%PDF-1.7 ' + name], name, { type: 'application/pdf' })],
    });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await vi.waitFor(() => expect(host.textContent).toContain(name));
    // Picking waits while a file is still being saved or uploaded (the buttons are disabled meanwhile).
    await vi.waitFor(() => expect(button('Choose PDF').disabled).toBe(false));
  }
  await vi.waitFor(() =>
    expect(host.querySelectorAll('[data-testid^="bill-photo-"]')).toHaveLength(2),
  );
  await vi.waitFor(() => expect(api.uploadBillDocument).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(postButton().disabled).toBe(false));
  const paths = api.uploadBillDocument.mock.calls.map((c) => c[0].path as string);
  const key = Object.keys(localStorage).find((k) => k.startsWith('dsb-purchase-draft:'))!;
  const saved = JSON.parse(localStorage.getItem(key)!);
  // Each file is bound to tenant/shop/this bill's request id, and the draft keeps both in order.
  for (const p of paths) expect(p.split('/').slice(0, 3)).toEqual([TENANT, SHOP, saved.clientId]);
  expect(saved.documents.map((d: { path: string }) => d.path)).toEqual(paths);
  expect(saved.document.path).toBe(paths[0]);
  api.postPurchaseV2Outcome.mockResolvedValue(committed(1000, 0));
  await click(postButton());
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  expect(api.postPurchaseV2Outcome.mock.calls[0][0].images).toEqual(paths);
});
