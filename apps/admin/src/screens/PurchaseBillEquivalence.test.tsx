// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import 'fake-indexeddb/auto';
import { InventoryScreen } from './InventoryScreen';
import { shopContext } from '../lib/shopContext';
import { resetCatalogDirtyForTests } from '../lib/catalogRead';
import { purchaseBillTotals, quantityTimesPaise } from '@dsb-pro/core';
const api = vi.hoisted(() => ({
  BILL_DOCUMENT_PATH:
    /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(webp|pdf)$/,
  billDocumentPath: vi.fn(
    (tenant, shop, client, id, mime) =>
      `${tenant}/${shop}/${client}/${id}.${mime === 'application/pdf' ? 'pdf' : 'webp'}`,
  ),
  billDocumentHash: vi.fn().mockResolvedValue('a'.repeat(64)),
  uploadBillDocument: vi.fn(),
  readBillDocument: vi.fn(),
  onAuthStateChange: vi.fn().mockReturnValue(() => {}),
  getSession: vi.fn().mockResolvedValue({ user: { id: 'user' } }),
  getCurrentMembership: vi.fn().mockResolvedValue({ tenantId: 'tenant', role: 'owner' }),
  getDefaultShopId: vi.fn().mockResolvedValue('shop'),
  getShopBusinessDate: vi.fn().mockResolvedValue('2026-10-12'),
  listItems: vi.fn().mockResolvedValue([
    { id: 'a', name: 'Item A', unit1: 'piece', min_stock: 0 },
    { id: 'b', name: 'Item B', unit1: 'piece', min_stock: 0 },
  ]),
  listParties: vi.fn().mockResolvedValue([]),
  listStock: vi.fn().mockResolvedValue([]),
  listCurrentPrices: vi.fn(),
  setItemPrice: vi.fn(),
  listPurchaseHistory: vi.fn().mockResolvedValue([]),
  getPurchaseDetail: vi.fn(),
  listSupplierPurchaseLines: vi.fn().mockResolvedValue([]),
  postPurchaseOutcome: vi.fn(),
  postPurchaseV2Outcome: vi.fn(),
  getPurchaseExtras: vi.fn().mockResolvedValue({
    paymentType: 'credit',
    notes: null,
    lines: [],
    charges: [],
    images: [],
    settlement: { status: 'unpaid' },
  }),
  listItemPurchasePrices: vi.fn().mockResolvedValue([]),
  listItemSaleMovements: vi.fn().mockResolvedValue({ sales: [], returns: [], truncated: false }),
}));
vi.mock('@dsb-pro/adapters', () => api);
// A real post_purchase_v2 answer for a credit bill (the screen reads only kind and the paid fields).
const COMMITTED_CREDIT = {
  billId: 'b0000000-0000-0000-0000-000000000001',
  paymentId: null,
  totalPaise: 0,
  roundOffPaise: 0,
  businessDate: '2026-10-12',
};
const offline = vi.hoisted(() => ({
  getSyncedOfflineCatalog: vi.fn(),
  runSyncNow: vi.fn(),
  // Offline purchases (docs/OFFLINE_PURCHASES_PLAN.md).
  cacheOfflineSuppliers: vi.fn(async () => undefined),
  listOfflinePurchases: vi.fn(async () => []),
  listOfflineItems: vi.fn(async () => []),
  listOfflineBillChanges: vi.fn(async () => []),
  closeRejectedBillChange: vi.fn(),
  queueBillChangeOffline: vi.fn(),
  queueItemOffline: vi.fn(),
  queuePurchaseOffline: vi.fn(),
  closeRejectedPurchase: vi.fn(),
  getOfflineSuppliers: vi.fn(async () => null),
  getOfflineStock: vi.fn(async () => []),
  getOfflineItems: vi.fn(async () => []),
  getOfflineBusinessDate: vi.fn(async () => null),
  getOfflineRuntimeIdentity: vi.fn(() => null),
  waitForOfflineRuntime: vi.fn(async () => undefined),
}));
vi.mock('../lib/offlineSync', () => offline);
const host = document.createElement('div');
beforeEach(() => {
  // The shared context is a module singleton; every test starts from a cold, cache-free state.
  shopContext.invalidate();
  resetCatalogDirtyForTests();
  offline.getSyncedOfflineCatalog.mockResolvedValue(null);
  offline.runSyncNow.mockResolvedValue(undefined);
  api.getCurrentMembership.mockResolvedValue({ tenantId: 'tenant', role: 'owner' });
  api.getDefaultShopId.mockResolvedValue('shop');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  act(() => render(null, host));
  vi.clearAllMocks();
  localStorage.clear();
  vi.restoreAllMocks();
});

// Payload equivalence. The card editor now posts to post_purchase_v2 (billextras). GOLDEN keeps the bill the
// old single "Add purchase line" editor posted at main 1ee18e6 (supplier Acme, bill G-1, discount 5.50,
// extra 2.25; Item A 2 @ 10.50; Item C 1.5 pack as total 30; Item A 3 @ 0.07): the same lines, quantities,
// unit costs and adjustments, now as a v2 request. With no discount/GST every line total equals the old
// qty x cost (core purchaseBillTotals), and the old single extra amount is one named charge. Only clientId
// is random per bill. Both the new cards and an old-format draft must produce it byte for byte.
const GOLDEN = {
  api: 'v2',
  shopId: 'shop',
  partyId: 'p1',
  billNo: 'G-1',
  businessDate: '2026-10-12',
  discountPaise: 550,
  paymentType: 'credit',
  notes: null,
  lines: [
    { itemId: 'a', unitLevel: 1, qty: '2', unitPricePaise: 1050, discountBp: 0, gstBp: null },
    { itemId: 'c', unitLevel: 2, qty: '1.5', unitPricePaise: 2000, discountBp: 0, gstBp: null },
    { itemId: 'a', unitLevel: 1, qty: '3', unitPricePaise: 7, discountBp: 0, gstBp: null },
  ],
  charges: [{ label: 'Extra charges', amountPaise: 225 }],
  images: [],
};
const GOLDEN_KEYS = [
  'api',
  'shopId',
  'clientId',
  'partyId',
  'billNo',
  'businessDate',
  'discountPaise',
  'paymentType',
  'notes',
  'lines',
  'charges',
  'images',
];
// The old v1 request for the same bill (main 1ee18e6): every money figure must match the v2 one.
const OLD_V1 = {
  discountPaise: 550,
  extraChargesPaise: 225,
  lines: [
    { qty: '2', unitPricePaise: 1050 },
    { qty: '1.5', unitPricePaise: 2000 },
    { qty: '3', unitPricePaise: 7 },
  ],
};
async function addCharge(n: number, name: string, amount: string) {
  await click(button('+ Add charge'));
  await setField(label(`Extra charge ${n} name`), name);
  await setField(label(`Extra charge ${n} amount ₹`), amount);
}
const itemA = { id: 'a', name: 'Item A', unit1: 'piece', min_stock: 0 };
const itemC = { id: 'c', name: 'Item C', unit1: 'box', unit2: 'pack', conv1: 12, min_stock: 0 };
beforeEach(() => {
  api.listItems.mockResolvedValue([itemA, itemC]);
  api.listParties.mockResolvedValue([{ id: 'p1', name: 'Acme' }]);
  api.listPurchaseHistory.mockResolvedValue([]);
  document.body.append(host);
});

async function setField(sel: string, value: string, event = 'input') {
  await act(async () => {
    const el = host.querySelector<HTMLInputElement | HTMLSelectElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}
const label = (text: string) => `[aria-label="${text}"]`;
const button = (text: string, root: ParentNode = host) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text)!;
const click = (el: HTMLElement) => act(async () => el.click());
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
async function pickItem(n: number, name: string) {
  await setField(label(`Item ${n} name`), name);
  await click(button(name, host.querySelector(label(`Matches for item ${n}`))!));
}

test('the card editor posts exactly the payload the old add-line editor posted', async () => {
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await setField('input[name="billNo"]', 'G-1');
  await pickItem(1, 'Item A');
  await setField(label('Item 1 quantity'), '2');
  await setField(label('Item 1 rate ₹'), '10.50');
  await click(button('+ Add item'));
  await pickItem(2, 'Item C');
  await click(button('pack', host.querySelector(label('Item 2 purchased in'))!));
  await setField(label('Item 2 quantity'), '1.5');
  await click(button('Total', host.querySelector(label('Item 2 cost entered as'))!));
  await setField(label('Item 2 total ₹'), '30');
  await click(button('+ Add item'));
  await pickItem(3, 'Item A');
  await setField(label('Item 3 quantity'), '3');
  await setField(label('Item 3 rate ₹'), '0.07');
  await addCharge(1, 'Extra charges', '2.25');
  await setField('input[name="discount"]', '5.50');
  expect(host.querySelector('[data-testid="item-2-amount"]')!.textContent).toBe('Amount ₹30.00');
  const total = host.querySelector('[data-testid="bill-total"]')!.textContent!;
  expect(total).toContain('Items (3)₹51.21');
  expect(total).toContain('Bill discount−₹5.50');
  expect(total).toContain('Extra charges+₹2.25');
  expect(total).toContain('Total before round off₹47.96');
  expect(host.querySelector('[data-testid="round-off"]')!.textContent).toBe('Round off+₹0.04');
  expect(total).toContain('Bill total₹48.00');
  expect(host.querySelector('.bill-bar')!.textContent).toContain('Total ₹48.00');
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'committed', value: COMMITTED_CREDIT });
  await click(button('Post purchase'));
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  const [request, isRetry] = api.postPurchaseV2Outcome.mock.calls[0];
  expect(isRetry).toBe(false);
  expect(Object.keys(request)).toEqual(GOLDEN_KEYS);
  expect(request).toStrictEqual({ ...GOLDEN, clientId: expect.any(String) });
  // Same money as the old v1 request, and exactly what the server will compute (core totals).
  expect(
    request.lines.map((l: { qty: string; unitPricePaise: number }) => [l.qty, l.unitPricePaise]),
  ).toEqual(OLD_V1.lines.map((l) => [l.qty, l.unitPricePaise]));
  const t = purchaseBillTotals({
    lines: request.lines,
    discountPaise: request.discountPaise,
    charges: request.charges,
  });
  expect(t.subtotalPaise).toBe(
    OLD_V1.lines.reduce((s, l) => s + quantityTimesPaise(l.qty, l.unitPricePaise), 0),
  );
  expect(t.extraChargesPaise).toBe(OLD_V1.extraChargesPaise);
  expect(t).toMatchObject({ totalBeforeRoundOffPaise: 4796, roundOffPaise: 4, totalPaise: 4800 });
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted (3 items)'));
  // The next bill starts with one empty card.
  expect(host.querySelectorAll('section[aria-label^="Item "]')).toHaveLength(1);
});

test('a draft saved by the old add-line editor resumes as cards and posts the identical payload', async () => {
  const old = {
    version: 1,
    clientId: 'old-client',
    savedAt: Date.now(),
    supplier: 'p1',
    billNo: 'G-1',
    businessDate: '2026-10-12',
    discount: '5.50',
    extra: '2.25',
    cart: [
      { item: itemA, unitLevel: 1, qty: '2', unitPricePaise: 1050 },
      { item: itemC, unitLevel: 2, qty: '1.5', unitPricePaise: 2000 },
    ],
    // The old form, half way through the third line (it was never added to the cart).
    search: 'Item A',
    lineItem: itemA,
    unitLevel: 1,
    qty: '3',
    price: '0.07',
    costMode: 'unit',
    editingLine: null,
  };
  localStorage.setItem('dsb-purchase-draft:user:shop:old-client:w', JSON.stringify(old));
  await mountEditor();
  await vi.waitFor(() => expect(button('Resume draft')?.disabled).toBe(false));
  await click(button('Resume draft'));
  expect(host.querySelectorAll('section[aria-label^="Item "]')).toHaveLength(3);
  expect(host.querySelector<HTMLInputElement>(label('Item 2 rate ₹'))!.value).toBe('20.00');
  expect(
    button('pack', host.querySelector(label('Item 2 purchased in'))!).getAttribute('aria-pressed'),
  ).toBe('true');
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'committed', value: COMMITTED_CREDIT });
  await click(button('Post purchase'));
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  const [request, isRetry] = api.postPurchaseV2Outcome.mock.calls[0];
  expect(isRetry).toBe(false);
  expect(Object.keys(request)).toEqual(GOLDEN_KEYS);
  expect(request).toStrictEqual({ ...GOLDEN, clientId: 'old-client' });
});

test('fast bill layout: items, the live bill total, then closed bill details (charges, discount), and one post bar', async () => {
  api.listPurchaseHistory.mockResolvedValue([
    { id: 'last', party_id: 'p1', status: 'POSTED', business_date: '2026-10-10' },
  ]);
  api.getPurchaseDetail.mockResolvedValue({
    bill: {
      id: 'last',
      status: 'POSTED',
      party_id: 'p1',
      bill_no: 'L',
      business_date: '2026-10-10',
      discount_paise: '0',
      extra_charges_paise: '0',
    },
    lines: [
      {
        item_id: 'a',
        item_name_snapshot: 'Item A',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '4',
        unit_price_paise: '1050',
      },
      {
        item_id: 'c',
        item_name_snapshot: 'Item C',
        unit_level: 2,
        unit_name_snapshot: 'pack',
        conv1_snapshot: 12,
        conv2_snapshot: null,
        qty: '6',
        unit_price_paise: '2000',
      },
    ],
  });
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await vi.waitFor(() => expect(host.textContent).toContain('↺ Repeat last bill'));
  expect(host.textContent).not.toMatch(/\blines?\b/i);
  await click(button('↺ Repeat last bill'));
  await vi.waitFor(() =>
    expect(host.querySelectorAll('section[aria-label^="Item "]')).toHaveLength(2),
  );
  const order = [
    host.querySelector(label('Item 2'))!,
    host.querySelector('[data-testid="bill-total"]')!,
    host.querySelector('.bill-details')!,
    host.querySelector('input[name="discount"]')!,
    host.querySelector('[aria-label="Extra charges"]')!,
    host.querySelector('.bill-bar')!,
  ];
  // Bill details start closed; nothing in them is set, and the summary says what they hold.
  expect(host.querySelector('.bill-details-toggle')!.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('#bill-details-body')!.hasAttribute('hidden')).toBe(true);
  for (let i = 1; i < order.length; i++)
    expect(
      order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  expect(host.querySelector('[data-testid="bill-total"]')!.textContent).toContain('₹162.00');
  // ₹162.00 needs no round-off: the round-off line is shown only when it is not zero.
  expect(host.querySelector('[data-testid="bill-total"]')!.textContent).not.toContain('Round off');
  // One button in the bar posts; the others (payment type, + Add item) are plain buttons.
  expect(host.querySelectorAll('.bill-bar button:not([type="button"])')).toHaveLength(1);
  expect(host.querySelector('.bill-bar [aria-label="Payment type"]')).not.toBeNull();
});

test('Enter in the rate moves to the next item row (added when needed) and never posts a partial bill', async () => {
  await mountEditor();
  await pickItem(1, 'Item A');
  await setField(label('Item 1 quantity'), '2');
  await setField(label('Item 1 rate ₹'), '10.50');
  const rate = host.querySelector<HTMLInputElement>(label('Item 1 rate ₹'))!;
  rate.focus();
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => {
    rate.dispatchEvent(enter);
  });
  expect(enter.defaultPrevented).toBe(true);
  // Enter in the rate goes to the next item's name: a new row is added after the last one.
  expect(host.querySelectorAll('section[aria-label^="Item "]')).toHaveLength(2);
  expect(document.activeElement).toBe(host.querySelector(label('Item 2 name')));
  // Even an implicit submission that slips through (no Post button as submitter) posts nothing.
  await act(async () => {
    rate.form!.requestSubmit();
  });
  await act(async () => {
    rate.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
});

test('a refused post focuses the first item that needs a look and says so in the post bar', async () => {
  await mountEditor();
  await pickItem(1, 'Item A');
  await setField(label('Item 1 quantity'), '2');
  await setField(label('Item 1 rate ₹'), '10.50');
  await click(button('+ Add item'));
  await pickItem(2, 'Item C');
  await setField(label('Item 2 quantity'), '1');
  await click(button('Post purchase'));
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(host.querySelector(label('Item 2 rate ₹')));
  expect(host.querySelector('.bill-bar')!.textContent).toContain(
    'Item 2: Enter the cost per unit.',
  );
});

test('sale prices typed on the cards leave the posted payload identical', async () => {
  api.listCurrentPrices.mockResolvedValue([]);
  api.setItemPrice.mockResolvedValue('price-id');
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await setField('input[name="billNo"]', 'G-1');
  await pickItem(1, 'Item A');
  await setField(label('Item 1 quantity'), '2');
  await setField(label('Item 1 rate ₹'), '10.50');
  await setField(label('Item 1 retail ₹'), '15');
  await click(button('+ Add item'));
  await pickItem(2, 'Item C');
  await click(button('pack', host.querySelector(label('Item 2 purchased in'))!));
  await setField(label('Item 2 quantity'), '1.5');
  await click(button('Total', host.querySelector(label('Item 2 cost entered as'))!));
  await setField(label('Item 2 total ₹'), '30');
  await setField(label('Item 2 wholesale qty'), '12');
  await setField(label('Item 2 wholesale price ₹'), '240');
  await click(button('+ Add item'));
  await pickItem(3, 'Item A');
  await setField(label('Item 3 quantity'), '3');
  await setField(label('Item 3 rate ₹'), '0.07');
  await addCharge(1, 'Extra charges', '2.25');
  await setField('input[name="discount"]', '5.50');
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'committed', value: COMMITTED_CREDIT });
  await click(button('Post purchase'));
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  const [request, isRetry] = api.postPurchaseV2Outcome.mock.calls[0];
  expect(isRetry).toBe(false);
  expect(Object.keys(request)).toEqual(GOLDEN_KEYS);
  expect(request).toStrictEqual({ ...GOLDEN, clientId: expect.any(String) });
  await vi.waitFor(() => expect(host.textContent).toContain('Sale prices updated: 2.'));
});
