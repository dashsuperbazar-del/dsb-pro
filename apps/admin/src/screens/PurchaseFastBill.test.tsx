// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import 'fake-indexeddb/auto';
import { InventoryScreen } from './InventoryScreen';
import { shopContext } from '../lib/shopContext';
import { resetCatalogDirtyForTests } from '../lib/catalogRead';

// Fast bill entry: a typical credit bill is typed with the keyboard (name, Enter, qty, Enter, rate,
// Enter …) and posted with one tap; optional parts stay closed but keep and show their values; the
// supplier's usual items are added in one go with empty quantities. Nothing here changes what posts.
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SHOP = 'a0000000-0000-0000-0000-000000000002';
const api = vi.hoisted(() => ({
  BILL_DOCUMENT_PATH:
    /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(webp|pdf)$/,
  billDocumentPath: vi.fn(),
  billDocumentHash: vi.fn(),
  uploadBillDocument: vi.fn(),
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
  listSupplierPurchaseLines: vi.fn().mockResolvedValue([]),
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
  // Offline purchases (docs/OFFLINE_PURCHASES_PLAN.md).
  cacheOfflineSuppliers: vi.fn(async () => undefined),
  listOfflinePurchases: vi.fn(async () => []),
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
// The last supplier is remembered per user and shop on this device.
const LAST = `dsb-last-supplier:user:${SHOP}`;
const one = (id: string, name: string) => ({ id, name, unit1: 'piece', min_stock: 0 });
const ITEMS = [
  one('a', 'Sugar 1kg'),
  one('b', 'Tea 250g'),
  { id: 'c', name: 'Rice bag', unit1: 'bag', unit2: 'pack', conv1: 10, min_stock: 0 },
  one('d', 'Oil 1L'),
  one('e', 'Salt 1kg'),
];
beforeEach(() => {
  shopContext.invalidate();
  resetCatalogDirtyForTests();
  offline.getSyncedOfflineCatalog.mockResolvedValue(null);
  offline.runSyncNow.mockResolvedValue(undefined);
  api.getCurrentMembership.mockResolvedValue({ tenantId: TENANT, role: 'owner' });
  api.getDefaultShopId.mockResolvedValue(SHOP);
  api.listItems.mockResolvedValue(ITEMS);
  api.listParties.mockResolvedValue([
    { id: 'p1', name: 'Ravi Traders' },
    { id: 'p2', name: 'Beta' },
  ]);
  api.listSupplierPurchaseLines.mockResolvedValue([]);
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  document.body.append(host);
});
afterEach(() => {
  act(() => render(null, host));
  vi.clearAllMocks();
  localStorage.clear();
  vi.restoreAllMocks();
});

// Interaction counters: a tap (click or focusing a field by touch) and a key (one character or Enter).
let taps = 0;
let keys = 0;
const label = (text: string) => `[aria-label="${text}"]`;
const field = <T extends HTMLElement = HTMLInputElement>(text: string) =>
  host.querySelector<T>(label(text))!;
const button = (text: string, root: ParentNode = host) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text)!;
const postButton = () => host.querySelector<HTMLButtonElement>('.bill-bar button.primary')!;
const text = (testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
const rows = () => host.querySelectorAll('section[aria-label^="Item "]');
async function tap(el: HTMLElement) {
  taps++;
  await act(async () => {
    el.focus();
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}
/** Types into the focused field, as the keyboard would. */
async function typeText(value: string) {
  keys += value.length;
  await act(async () => {
    const el = document.activeElement as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function enter() {
  keys++;
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => {
    document.activeElement!.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(ev.defaultPrevented).toBe(true);
}
async function setField(sel: string, value: string, event = 'input') {
  await act(async () => {
    const el = host.querySelector<HTMLInputElement | HTMLSelectElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}
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
  await vi.waitFor(() => expect(field('Item 1 name').closest('fieldset')!.disabled).toBe(false));
}
const committed = (totalPaise: number) => ({
  kind: 'committed',
  value: {
    billId: 'bill-1',
    paymentId: null,
    totalPaise,
    roundOffPaise: 0,
    businessDate: '2026-10-12',
  },
});
const line = (
  bill: string,
  date: string,
  item: string,
  pricePaise: number,
  more: Partial<{ unit: 1 | 2 | 3; unitName: string; disc: number; gst: number | null }> = {},
) => ({
  purchase_bill_id: bill,
  business_date: date,
  created_at: `${date}T10:00:00Z`,
  line_no: 1,
  item_id: item,
  item_name_snapshot: ITEMS.find((i) => i.id === item)!.name,
  unit_level: more.unit ?? 1,
  unit_name_snapshot: more.unitName ?? 'piece',
  conv1_snapshot: (ITEMS.find((i) => i.id === item) as { conv1?: number }).conv1 ?? null,
  conv2_snapshot: null,
  unit_price_paise: String(pricePaise),
  discount_bp: more.disc ?? 0,
  gst_bp: more.gst ?? null,
});

test('a typical 5-item credit bill: remembered supplier, keyboard entry, one tap to post; optional parts closed', async () => {
  localStorage.setItem(LAST, 'p1');
  await mountEditor();
  // The last supplier is already chosen; its usual items list is offered (empty here).
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLSelectElement>('select[name="partyId"]')!.value).toBe('p1'),
  );
  // Optional parts are closed by default: per-row extras hidden, bill details closed.
  expect(host.querySelector('.bill-details-toggle')!.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('#bill-details-body')!.hasAttribute('hidden')).toBe(true);
  expect(text('bill-details-badge')).toBe('discount, charges, notes, photos');
  taps = 0;
  keys = 0;
  const bill = [
    ['sug', '10', '42'],
    ['tea', '5', '120'],
    ['rice', '2', '310'],
    ['oil', '12', '135'],
    ['salt', '20', '18'],
  ];
  await tap(field('Item 1 name'));
  for (const [i, [name, qty, rate]] of bill.entries()) {
    const n = i + 1;
    expect(document.activeElement).toBe(field(`Item ${n} name`));
    await typeText(name!);
    await enter(); // the only match is chosen; the quantity is next
    expect(document.activeElement).toBe(field(`Item ${n} quantity`));
    await typeText(qty!);
    await enter();
    expect(document.activeElement).toBe(field(`Item ${n} rate ₹`));
    await typeText(rate!);
    if (n < bill.length) await enter(); // the next row's item name (a row is added)
    // Every extra of this row is in the closed "More" part, and the row says nothing is set there.
    expect(host.querySelector(`[data-testid="item-${n}-more"]`)!.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector(`[data-testid="item-${n}-badge"]`)).toBeNull();
  }
  expect(rows()).toHaveLength(5);
  // A one-unit item shows no unit chips; the two-unit rice bag does, on its first unit.
  expect(host.querySelector(label('Item 1 purchased in'))).toBeNull();
  expect(
    button('bag', field<HTMLElement>('Item 3 purchased in')).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(text('bill-total')).toContain('Bill total₹3,620.00');
  api.postPurchaseV2Outcome.mockResolvedValue(committed(362000));
  await tap(postButton());
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  const [req] = api.postPurchaseV2Outcome.mock.calls[0];
  expect(req).toMatchObject({ partyId: 'p1', paymentType: 'credit' });
  expect(
    req.lines.map((l: { itemId: string; qty: string; unitPricePaise: number }) => [
      l.itemId,
      l.qty,
      l.unitPricePaise,
    ]),
  ).toEqual([
    ['a', '10', 4200],
    ['b', '5', 12000],
    ['c', '2', 31000],
    ['d', '12', 13500],
    ['e', '20', 1800],
  ]);
  // Supplier remembered: 0 taps. Then one tap into the first name and one on Post.
  expect(taps).toBe(2);
  // 17 name letters + 8 qty digits + 13 rate digits + 14 Enters.
  expect(keys).toBe(17 + 8 + 13 + 14);
});

test('a value in a closed part is kept, shown as a badge, and posted; a problem there opens it', async () => {
  await mountEditor();
  await setField(label('Item 1 name'), 'Sugar 1kg');
  await tap(button('Sugar 1kg', field<HTMLElement>('Matches for item 1')));
  await setField(label('Item 1 quantity'), '10');
  await setField(label('Item 1 rate ₹'), '100');
  const more = field<HTMLButtonElement>('More for item 1');
  expect(more.getAttribute('aria-expanded')).toBe('false');
  await tap(more);
  expect(host.querySelector('[data-testid="item-1-more"]')!.hasAttribute('hidden')).toBe(false);
  await setField(label('Item 1 discount %'), '2');
  await setField(label('Item 1 GST %'), '5');
  await tap(more);
  // Closed again: the values stay, the badge names them, the row total includes them.
  expect(host.querySelector('[data-testid="item-1-more"]')!.hasAttribute('hidden')).toBe(true);
  expect(text('item-1-badge')).toBe('−2% +5% GST');
  expect(field('Item 1 discount %').value).toBe('2');
  expect(text('item-1-amount')).toBe('₹1,000.00 − 2% discount + 5% GST Item total ₹1,029.00');
  // A discount typo is never hidden: the part opens and says what is wrong.
  await setField(label('Item 1 discount %'), '200');
  expect(host.querySelector('[data-testid="item-1-more"]')!.hasAttribute('hidden')).toBe(false);
  expect(text('item-1-amount')).toContain('Enter the discount as a %');
  await setField(label('Item 1 discount %'), '2');
  // Bill details: closed, but its summary lists what is set inside.
  await setField('input[name="discount"]', '9');
  await setField('textarea[name="notes"]', 'Rate on phone');
  expect(host.querySelector('.bill-details-toggle')!.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('#bill-details-body')!.hasAttribute('hidden')).toBe(true);
  expect(text('bill-details-badge')).toBe('discount ₹9 · notes');
  api.postPurchaseV2Outcome.mockResolvedValue(committed(102000));
  await tap(postButton());
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  expect(api.postPurchaseV2Outcome.mock.calls[0][0]).toMatchObject({
    discountPaise: 900,
    notes: 'Rate on phone',
    lines: [{ discountBp: 200, gstBp: 500, unitPricePaise: 10000 }],
  });
});

test('usual items: each item once, most bought first; ticked items become rows with empty qty and the last rate', async () => {
  // Three bills of Ravi Traders, newest first. Sugar on all 3; tea on 2; rice on 2 (newest); salt on 1.
  api.listSupplierPurchaseLines.mockResolvedValue([
    line('b3', '2026-10-11', 'a', 4300, { disc: 200 }),
    line('b3', '2026-10-11', 'c', 3200, { unit: 2, unitName: 'pack', gst: 500 }),
    line('b2', '2026-10-05', 'a', 4100),
    line('b2', '2026-10-05', 'b', 11800),
    line('b2', '2026-10-05', 'c', 30000),
    line('b1', '2026-10-01', 'a', 4000),
    line('b1', '2026-10-01', 'b', 11500),
    line('b1', '2026-10-01', 'e', 1700),
  ]);
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await vi.waitFor(() => expect(host.querySelectorAll('.usual-row')).toHaveLength(4));
  expect(api.listSupplierPurchaseLines).toHaveBeenCalledWith(SHOP, 'p1');
  const names = [...host.querySelectorAll('.usual-name')].map((n) => n.textContent);
  // Sugar (3 bills), then rice (2, bought most recently), tea (2), salt (1).
  expect(names).toEqual(['Sugar 1kg', 'Rice bag', 'Tea 250g', 'Salt 1kg']);
  expect(host.querySelector('.usual-row')!.textContent).toContain(
    'piece · ₹43.00 · −2% · 2026-10-11',
  );
  await tap(field('Sugar 1kg'));
  await tap(field('Rice bag'));
  await tap(button('Add 2 items'));
  expect(rows()).toHaveLength(2);
  // Quantity empty (must be typed), last rate and unit, discount/GST of that last line.
  expect(field('Item 1 name').value).toBe('Sugar 1kg');
  expect(field('Item 1 quantity').value).toBe('');
  expect(field('Item 1 rate ₹').value).toBe('43.00');
  expect(field('Item 1 discount %').value).toBe('2');
  expect(text('item-1-suggested')).toBe('Last rate (2026-10-11) · check');
  expect(field('Item 2 rate ₹').value).toBe('32.00');
  expect(field('Item 2 GST %').value).toBe('5');
  expect(
    button('pack', field<HTMLElement>('Item 2 purchased in')).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(document.activeElement).toBe(field('Item 1 quantity'));
  // Nothing posts until the quantities are typed.
  expect(postButton().disabled).toBe(true);
  // qty, Enter, Enter (keeps the suggested rate) goes to the next added row's quantity.
  await typeText('3');
  await enter();
  expect(document.activeElement).toBe(field('Item 1 rate ₹'));
  await enter();
  expect(document.activeElement).toBe(field('Item 2 quantity'));
  await tap(postButton());
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  expect(host.querySelector('.bill-bar')!.textContent).toContain(
    'Item 2: Enter a purchase quantity',
  );
  // Already on the bill: shown as added, cannot be added twice.
  await tap(button(host.querySelector('.usual-toggle')!.textContent!));
  expect(field('Sugar 1kg (on the bill)').disabled).toBe(true);
  await tap(field('Tea 250g'));
  await tap(button('Add 1 item'));
  expect(rows()).toHaveLength(3);
  expect([...rows()].map((r) => r.querySelector<HTMLInputElement>('input')!.value)).toEqual([
    'Sugar 1kg',
    'Rice bag',
    'Tea 250g',
  ]);
  // Choosing an item by hand also starts in the unit it was last bought in from this supplier.
  await tap(button('+ Add item'));
  await setField(label('Item 4 name'), 'rice');
  await act(async () => {
    field('Item 4 name').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  expect(
    button('pack', field<HTMLElement>('Item 4 purchased in')).getAttribute('aria-pressed'),
  ).toBe('true');
});

test('usual items: a supplier switch during the read adds nothing; a failed read says so', async () => {
  let release!: (v: unknown) => void;
  api.listSupplierPurchaseLines.mockImplementation((_shop: string, party: string) =>
    party === 'p1' ? new Promise((resolve) => (release = resolve)) : Promise.resolve([]),
  );
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await vi.waitFor(() => expect(host.textContent).toContain("Reading this supplier's bills…"));
  await setField('select[name="partyId"]', 'p2', 'change');
  await vi.waitFor(() =>
    expect(host.textContent).toContain('No earlier bills from this supplier.'),
  );
  await act(async () => release([line('b1', '2026-10-01', 'a', 4000)]));
  expect(host.querySelectorAll('.usual-row')).toHaveLength(0);
  expect(rows()).toHaveLength(1);
  expect(field('Item 1 name').value).toBe('');
  expect(host.textContent).toContain('Usual items from Beta');
  // A read that fails is shown with a retry; nothing is added.
  api.listSupplierPurchaseLines.mockRejectedValue(new Error('offline'));
  await setField('select[name="partyId"]', 'p1', 'change');
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Usual items could not be read: offline'),
  );
  api.listSupplierPurchaseLines.mockResolvedValue([line('b1', '2026-10-01', 'a', 4000)]);
  await tap(button('Try again'));
  await vi.waitFor(() => expect(host.querySelectorAll('.usual-row')).toHaveLength(1));
  expect(rows()).toHaveLength(1);
});

test('the supplier of the last posted bill starts the next bill; Cash keeps its post button text', async () => {
  await mountEditor();
  expect(host.querySelector<HTMLSelectElement>('select[name="partyId"]')!.value).toBe('');
  await setField('select[name="partyId"]', 'p2', 'change');
  await setField(label('Item 1 name'), 'Oil 1L');
  await tap(button('Oil 1L', field<HTMLElement>('Matches for item 1')));
  await setField(label('Item 1 quantity'), '2');
  await setField(label('Item 1 rate ₹'), '50.40');
  // Payment type sits next to the total in the post bar.
  await tap(button('Cash', host.querySelector('.bill-bar [aria-label="Payment type"]')!));
  expect(postButton().textContent).toBe('Post and pay ₹101.00 by Cash');
  expect(host.querySelector('.bill-bar')!.textContent).toContain('incl. round off +₹0.20');
  api.postPurchaseV2Outcome.mockResolvedValue({
    kind: 'committed',
    value: {
      billId: 'b',
      paymentId: 'pay',
      totalPaise: 10100,
      roundOffPaise: 20,
      businessDate: '2026-10-12',
    },
  });
  await tap(postButton());
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted (1 item)'));
  expect(localStorage.getItem(LAST)).toBe('p2');
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLSelectElement>('select[name="partyId"]')!.value).toBe('p2'),
  );
});

const enterIn = (labelText: string) =>
  act(async () => {
    field(labelText).focus();
    field(labelText).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });

test('Enter picks an item only when its name is unambiguous: two items with one name go to the list', async () => {
  api.listItems.mockResolvedValue([...ITEMS, { ...one('a2', 'Sugar 1kg') }]);
  await mountEditor();
  await setField(label('Item 1 name'), 'Sugar 1kg');
  await enterIn('Item 1 name');
  // Not chosen: both "Sugar 1kg" items are offered, the first one has the focus to tap.
  expect(field('Item 1 name').value).toBe('Sugar 1kg');
  const matches = field<HTMLElement>('Matches for item 1');
  expect([...matches.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
    'Sugar 1kg',
    'Sugar 1kg',
  ]);
  expect(document.activeElement).toBe(matches.querySelector('button'));
  expect(field('Item 1 quantity').value).toBe('');
  // One exact name (even with other partial matches) is picked.
  await setField(label('Item 1 name'), 'Tea 250g');
  await enterIn('Item 1 name');
  expect(host.querySelector(label('Matches for item 1'))).toBeNull();
  expect(document.activeElement).toBe(field('Item 1 quantity'));
});

test('usual items: a unit renamed or recounted since the last bill gets neither the old unit nor the old rate', async () => {
  // The rice bag's pack was 10 per bag on the last bill; it is 12 now.
  api.listItems.mockResolvedValue(ITEMS.map((i) => (i.id === 'c' ? { ...i, conv1: 12 } : i)));
  api.listSupplierPurchaseLines.mockResolvedValue([
    {
      ...line('b1', '2026-10-01', 'c', 3200, { unit: 2, unitName: 'pack', disc: 100 }),
      conv1_snapshot: 10,
    },
  ]);
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await vi.waitFor(() => expect(host.querySelectorAll('.usual-row')).toHaveLength(1));
  await tap(field('Rice bag'));
  await tap(button('Add 1 item'));
  expect(
    button('bag', field<HTMLElement>('Item 1 purchased in')).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(field('Item 1 rate ₹').value).toBe('');
  expect(host.querySelector('[data-testid="item-1-suggested"]')).toBeNull();
  expect(field('Item 1 discount %').value).toBe('1');
  // Choosing it by hand does not default to the old pack either.
  await tap(button('+ Add item'));
  await setField(label('Item 2 name'), 'Rice bag');
  await enterIn('Item 2 name');
  expect(
    button('bag', field<HTMLElement>('Item 2 purchased in')).getAttribute('aria-pressed'),
  ).toBe('true');
});

test('the remembered supplier never lands on a resumed draft or a repeat, nor comes back once cleared', async () => {
  localStorage.setItem(LAST, 'p1');
  await mountEditor();
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLSelectElement>('select[name="partyId"]')!.value).toBe('p1'),
  );
  // Cleared by hand: stays cleared while the bill is entered.
  await setField('select[name="partyId"]', '', 'change');
  await setField('input[name="billNo"]', 'NOSUP-1');
  await setField(label('Item 1 name'), 'Oil 1L');
  await enterIn('Item 1 name');
  await vi.waitFor(() => expect(host.textContent).toContain('Draft saved on this device'));
  expect(host.querySelector<HTMLSelectElement>('select[name="partyId"]')!.value).toBe('');
  // Reopened: a fresh bill gets the supplier, but resuming the draft (no supplier) keeps none.
  await act(async () => render(null, host));
  await mountEditor();
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')?.disabled,
    ).toBe(false),
  );
  await tap(button('Resume draft'));
  expect(host.querySelector<HTMLInputElement>('input[name="billNo"]')!.value).toBe('NOSUP-1');
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  expect(host.querySelector<HTMLSelectElement>('select[name="partyId"]')!.value).toBe('');
  // A repeat of a bill of another supplier keeps that supplier.
  await act(async () => render(null, host));
  localStorage.clear();
  localStorage.setItem(LAST, 'p1');
  api.getPurchaseDetail.mockResolvedValue({
    bill: {
      id: 'old',
      status: 'POSTED',
      party_id: 'p2',
      bill_no: 'R',
      business_date: '2026-10-10',
      discount_paise: '0',
      extra_charges_paise: '0',
    },
    lines: [
      {
        line_no: 1,
        item_id: 'd',
        item_name_snapshot: 'Oil 1L',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '2',
        unit_price_paise: '5000',
      },
    ],
    balance: null,
  });
  api.getPurchaseExtras.mockResolvedValue({
    paymentType: 'credit',
    notes: null,
    lines: [],
    charges: [],
    images: [],
    settlement: { status: 'unpaid' },
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="old" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from R'));
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  expect(host.querySelector<HTMLSelectElement>('select[name="partyId"]')!.value).toBe('p2');
});

test('bill details: a problem opens them again after they were closed by hand', async () => {
  await mountEditor();
  const toggle = host.querySelector<HTMLButtonElement>('.bill-details-toggle')!;
  const body = () => host.querySelector('#bill-details-body')!;
  await tap(toggle);
  expect(body().hasAttribute('hidden')).toBe(false);
  await tap(button('+ Add charge'));
  await setField(label('Extra charge 1 name'), 'Transport');
  await setField(label('Extra charge 1 amount ₹'), '10');
  await tap(toggle);
  expect(body().hasAttribute('hidden')).toBe(true);
  expect(text('bill-details-badge')).toBe('1 charge ₹10.00');
  // The amount becomes unreadable (e.g. a restored value): the section opens and says why.
  await setField(label('Extra charge 1 amount ₹'), 'abc');
  expect(body().hasAttribute('hidden')).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(body().textContent).toContain('Extra charge 1:');
  // Fixed: it stays open (it never folds while typing); closing by hand works again.
  await setField(label('Extra charge 1 amount ₹'), '12');
  expect(body().hasAttribute('hidden')).toBe(false);
  await tap(toggle);
  expect(body().hasAttribute('hidden')).toBe(true);
});

test('usual items: the message counts exactly the rows added; payment type is not next to + Add item', async () => {
  api.listSupplierPurchaseLines.mockResolvedValue([
    line('b1', '2026-10-01', 'a', 4000),
    line('b1', '2026-10-01', 'b', 11500),
  ]);
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await vi.waitFor(() => expect(host.querySelectorAll('.usual-row')).toHaveLength(2));
  // Sugar is typed by hand first; then both are ticked from the reopened list.
  await setField(label('Item 1 name'), 'Sugar 1kg');
  await enterIn('Item 1 name');
  await tap(host.querySelector<HTMLButtonElement>('.usual-toggle')!);
  expect(field('Sugar 1kg (on the bill)').disabled).toBe(true);
  await tap(field('Tea 250g'));
  await tap(button('Add 1 item'));
  expect(rows()).toHaveLength(2);
  expect(host.textContent).toContain('Added 1 item.');
  expect(document.activeElement).toBe(field('Item 2 quantity'));
  // The payment buttons sit in their own group; "+ Add item" is outside it, next to the total.
  const pay = host.querySelector('.bill-bar [aria-label="Payment type"]')!;
  const add = button('+ Add item', host.querySelector('.bill-bar')!);
  expect(pay.contains(add)).toBe(false);
  expect(add.closest('fieldset')).toBeNull();
});
