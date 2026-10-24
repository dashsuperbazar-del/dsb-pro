// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import 'fake-indexeddb/auto';
import { InventoryScreen } from './InventoryScreen';
import { shopContext } from '../lib/shopContext';
import { resetCatalogDirtyForTests } from '../lib/catalogRead';
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

// Biscuit: bought in ctn (12 pkt), pkt (10 pcs), pcs. Soap: ctn of 12 pcs.
const biscuit = {
  id: 'bis',
  name: 'Biscuit',
  unit1: 'ctn',
  unit2: 'pkt',
  unit3: 'pcs',
  conv1: 12,
  conv2: 10,
  min_stock: 0,
};
const soap = { id: 'soap', name: 'Soap', unit1: 'ctn', unit2: 'pcs', conv1: 12, min_stock: 0 };
const price = (
  kind: string,
  unit_level: number,
  price_paise: number,
  shop_id: string | null = 'shop',
) => ({
  id: `${kind}${unit_level}`,
  item_id: 'bis',
  shop_id,
  kind,
  unit_level,
  price_paise,
  effective_from: '2026-10-01',
  effective_to: null,
});
const host = document.createElement('div');
beforeEach(() => {
  shopContext.invalidate();
  resetCatalogDirtyForTests();
  offline.getSyncedOfflineCatalog.mockResolvedValue(null);
  offline.runSyncNow.mockResolvedValue(undefined);
  api.getCurrentMembership.mockResolvedValue({ tenantId: 'tenant', role: 'owner' });
  api.getDefaultShopId.mockResolvedValue('shop');
  api.listItems.mockResolvedValue([biscuit, soap]);
  api.listCurrentPrices.mockImplementation(async (id: string) =>
    id === 'bis'
      ? [price('retail', 3, 1000), price('wholesale', 3, 900), price('retail', 2, 9500, null)]
      : [],
  );
  api.setItemPrice.mockResolvedValue('price-id');
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
    const el = host.querySelector<HTMLInputElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}
const label = (text: string) => `[aria-label="${text}"]`;
const input = (text: string) => host.querySelector<HTMLInputElement>(label(text))!;
const button = (text: string, root: ParentNode = host) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text)!;
const click = (el: HTMLElement) => act(async () => el.click());
async function mountEditor() {
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLInputElement>('input[name="date"]')!.value).toBe('2026-10-12'),
  );
}
async function pickItem(n: number, name: string) {
  await setField(label(`Item ${n} name`), name);
  await click(button(name, host.querySelector(label(`Matches for item ${n}`))!));
}
async function fillCard(n: number, name: string) {
  await pickItem(n, name);
  await setField(label(`Item ${n} quantity`), '2');
  await setField(label(`Item ${n} rate ₹`), '50');
}
const post = () => click(button('Post purchase'));

test('the item master conversion shows under the purchased-in chips', async () => {
  await mountEditor();
  await pickItem(1, 'Biscuit');
  expect(host.querySelector('[data-testid="item-1-conversion"]')!.textContent).toBe(
    '1 ctn = 12 pkt · 1 pkt = 10 pcs',
  );
  await click(button('+ Add item'));
  await pickItem(2, 'Soap');
  expect(host.querySelector('[data-testid="item-2-conversion"]')!.textContent).toBe(
    '1 ctn = 12 pcs',
  );
  // Read only: no input edits the conversion.
  expect(host.querySelector(label('Item 1 purchased in'))!.querySelector('input')).toBeNull();
});

test('the sale price box is prefilled with the current prices for the chosen unit', async () => {
  await mountEditor();
  await pickItem(1, 'Biscuit');
  await vi.waitFor(() => expect(input('Item 1 retail ₹').value).toBe('10.00'));
  expect(
    button('pcs', host.querySelector(label('Item 1 prices entered per'))!).getAttribute(
      'aria-pressed',
    ),
  ).toBe('true');
  // The current wholesale is a hint, never a value that a typed qty would divide.
  expect(input('Item 1 wholesale qty').value).toBe('');
  expect(input('Item 1 wholesale price ₹').value).toBe('');
  expect(host.textContent).toContain('Current wholesale ₹9.00 per pcs');
  await click(button('pkt', host.querySelector(label('Item 1 prices entered per'))!));
  expect(input('Item 1 retail ₹').value).toBe('95.00');
  expect(input('Item 1 wholesale price ₹').value).toBe('');
  expect(host.textContent).toContain('Retail ₹ per pkt');
});

test('blank or unchanged prices write nothing; the bill still posts', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await vi.waitFor(() => expect(input('Item 1 retail ₹').value).toBe('10.00'));
  await setField(label('Item 1 retail ₹'), '10');
  await setField(label('Item 1 wholesale price ₹'), '');
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'committed', value: COMMITTED_CREDIT });
  await post();
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted (1 item)'));
  expect(api.setItemPrice).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('Sale price');
});

test('a wholesale qty alone never divides the current wholesale price; it blocks posting', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await vi.waitFor(() => expect(host.textContent).toContain('Current wholesale ₹9.00 per pcs'));
  await setField(label('Item 1 wholesale qty'), '12');
  expect(host.querySelector('[data-testid="item-1-sale-problem"]')!.textContent).toBe(
    'Enter the wholesale price for 12 pcs, or clear the wholesale qty.',
  );
  await post();
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  expect(api.setItemPrice).not.toHaveBeenCalled();
});

test('a price that is not a number is a problem, not a blank', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12..5');
  expect(host.querySelector('[data-testid="item-1-sale-problem"]')!.textContent).toMatch(
    /retail price in rupees/,
  );
  await post();
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
});

test('wholesale price for N units that is not whole paise per unit is refused before posting', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 wholesale qty'), '12');
  await setField(label('Item 1 wholesale price ₹'), '100');
  expect(host.querySelector('[data-testid="item-1-sale-problem"]')!.textContent).toContain(
    '₹100.00 for 12 pcs is not a whole number of paise per pcs',
  );
  await post();
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  expect(host.querySelector('.bill-bar')!.textContent).toContain('Item 1: ₹100.00 for 12 pcs');
  expect(document.activeElement).toBe(input('Item 1 wholesale price ₹'));
  // ₹108 for 12 is exactly ₹9.00 per pcs: shown, and allowed.
  await setField(label('Item 1 wholesale price ₹'), '108');
  expect(host.textContent).toContain('Wholesale ₹9.00 per pcs');
});

test('prices are written only after the bill posts, one call each, with derived client ids', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  await setField(label('Item 1 wholesale qty'), '12');
  await setField(label('Item 1 wholesale price ₹'), '120');
  const order: string[] = [];
  api.postPurchaseV2Outcome.mockImplementation(async () => {
    order.push('post');
    expect(api.setItemPrice).not.toHaveBeenCalled();
    return { kind: 'committed', value: COMMITTED_CREDIT };
  });
  api.setItemPrice.mockImplementation(async (w: { kind: string }) => {
    order.push(w.kind);
    return 'id';
  });
  await post();
  await vi.waitFor(() => expect(host.textContent).toContain('Sale prices updated: 2.'));
  expect(order).toEqual(['post', 'retail', 'wholesale']);
  const bill = api.postPurchaseV2Outcome.mock.calls[0][0].clientId as string;
  expect(api.setItemPrice.mock.calls.map((c) => c[0])).toEqual([
    {
      itemId: 'bis',
      shopId: 'shop',
      kind: 'retail',
      unitLevel: 3,
      pricePaise: 1250,
      clientId: `bill-price:${bill}:bis:retail:3:1250`,
    },
    {
      itemId: 'bis',
      shopId: 'shop',
      kind: 'wholesale',
      unitLevel: 3,
      pricePaise: 1000,
      clientId: `bill-price:${bill}:bis:wholesale:3:1000`,
    },
  ]);
  expect(Object.keys(localStorage).filter((k) => k.startsWith('dsb-bill-sale-prices'))).toEqual([]);
  // Current prices are read again after the write, so the next bill compares against fresh prices.
  api.listCurrentPrices.mockResolvedValue([price('retail', 3, 1250)]);
  await pickItem(1, 'Biscuit');
  await vi.waitFor(() => expect(input('Item 1 retail ₹').value).toBe('12.50'));
});

test('a refused bill writes no price', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'rejected', message: 'no' });
  await post();
  await vi.waitFor(() => expect(host.textContent).toContain('Not posted: no.'));
  expect(api.setItemPrice).not.toHaveBeenCalled();
  expect(Object.keys(localStorage).some((k) => k.startsWith('dsb-bill-sale-prices'))).toBe(false);
});

test('an unconfirmed bill writes prices only once its retry confirms', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'unknown', message: 'timeout' });
  await post();
  await vi.waitFor(() => expect(host.textContent).toContain('Not confirmed: timeout'));
  expect(api.setItemPrice).not.toHaveBeenCalled();
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'committed', value: COMMITTED_CREDIT });
  await click(button('Retry same purchase'));
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(2));
  expect(api.postPurchaseV2Outcome.mock.calls[1][1]).toBe(true);
  await vi.waitFor(() => expect(api.setItemPrice).toHaveBeenCalledTimes(1));
  expect(api.setItemPrice.mock.calls[0][0]).toMatchObject({ kind: 'retail', pricePaise: 1250 });
});

test('a bill that confirms more than a day after its prices were entered writes none by itself', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'unknown', message: 'timeout' });
  await post();
  await vi.waitFor(() => expect(host.textContent).toContain('Not confirmed: timeout'));
  const later = Date.now() + 25 * 3_600_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'committed', value: COMMITTED_CREDIT });
  await click(button('Retry same purchase'));
  await vi.waitFor(() =>
    expect(host.textContent).toContain(
      'Sale price for Biscuit (retail ₹12.50 per pcs) was not written',
    ),
  );
  expect(api.setItemPrice).not.toHaveBeenCalled();
  expect(host.textContent).toContain('1 day ago');
  await click(host.querySelector<HTMLButtonElement>(label('Retry sale price for Biscuit'))!);
  await vi.waitFor(() => expect(api.setItemPrice).toHaveBeenCalledTimes(1));
});

test('a failed price write keeps the bill posted and offers a retry with the same client id', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'committed', value: COMMITTED_CREDIT });
  api.setItemPrice.mockRejectedValueOnce(new Error('network down'));
  await post();
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Bill saved. Sale price not updated for Biscuit'),
  );
  expect(host.textContent).toContain('Purchase posted (1 item)');
  const first = api.setItemPrice.mock.calls[0][0];
  // The alert shows its age and the item's current price next to Retry and Discard.
  const alert = () => host.querySelector<HTMLElement>('.price-retry')!;
  await vi.waitFor(() => expect(alert().textContent).toContain('Now ₹10.00'));
  expect(alert().textContent).toContain('just now');
  expect(alert().querySelector(label('Discard sale price for Biscuit'))).not.toBeNull();
  // After a reload the bill's state is not known here: it asks to check the bill, never says saved.
  act(() => render(null, host));
  await mountEditor();
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Check that the bill was posted, then Retry or Discard.'),
  );
  expect(host.textContent).not.toContain('Bill saved.');
  await click(host.querySelector<HTMLButtonElement>(label('Retry sale price for Biscuit'))!);
  await vi.waitFor(() => expect(host.textContent).toContain('Sale price updated for Biscuit.'));
  expect(api.setItemPrice).toHaveBeenCalledTimes(2);
  expect(api.setItemPrice.mock.calls[1][0]).toEqual(first);
  expect(host.textContent).not.toContain('Sale price not updated');
  expect(Object.keys(localStorage).some((k) => k.startsWith('dsb-bill-sale-prices'))).toBe(false);
});

test('roles that cannot set prices see no sale price box', async () => {
  api.getCurrentMembership.mockResolvedValue({ tenantId: 'tenant', role: 'accountant' });
  await mountEditor();
  await pickItem(1, 'Biscuit');
  expect(host.querySelector(label('Item 1 purchased in'))).not.toBeNull();
  expect(host.querySelector(label('Item 1 sale prices'))).toBeNull();
  expect(api.listCurrentPrices).not.toHaveBeenCalled();
});

test('a typed sale price counts as unsaved entry for the leave guard', async () => {
  await mountEditor();
  await pickItem(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '11');
  const ev = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
  // The typed price is in the autosaved draft too.
  const drafts = Object.keys(localStorage).filter((k) => k.startsWith('dsb-purchase-draft:'));
  expect(drafts).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(drafts[0]!)!).cards[0].sale).toEqual({
    level: 3,
    retail: '11',
  });
});

const key = (bill: string, user = 'user') => `dsb-bill-sale-prices:${user}:shop:${bill}:old-window`;
const stored = (bill: string, savedAt: number) =>
  JSON.stringify({
    bill,
    savedAt,
    writes: [
      {
        clientId: `bill-price:${bill}:bis:retail:3`,
        itemId: 'bis',
        itemName: 'Biscuit',
        kind: 'retail',
        unitLevel: 3,
        unitName: 'pcs',
        pricePaise: 1250,
      },
    ],
  });

test('a retry alert can be discarded; it is then gone for good', async () => {
  localStorage.setItem(key('b1'), stored('b1', Date.now() - 60_000));
  await mountEditor();
  await vi.waitFor(() => expect(host.querySelector('.price-retry')).not.toBeNull());
  await click(host.querySelector<HTMLButtonElement>(label('Discard sale price for Biscuit'))!);
  expect(host.querySelector('.price-retry')).toBeNull();
  expect(localStorage.getItem(key('b1'))).toBeNull();
  expect(api.setItemPrice).not.toHaveBeenCalled();
});

test('a plan older than a day is offered only for discard', async () => {
  localStorage.setItem(key('b2'), stored('b2', Date.now() - 2 * 86_400_000));
  await mountEditor();
  await vi.waitFor(() => expect(host.textContent).toContain('expired'));
  expect(host.textContent).toContain('2 days ago');
  expect(host.querySelector(label('Retry sale price for Biscuit'))).toBeNull();
  expect(host.querySelector(label('Discard sale price for Biscuit'))).not.toBeNull();
});

test('an error a retry cannot fix (item gone) is offered only for discard', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'committed', value: COMMITTED_CREDIT });
  api.setItemPrice.mockRejectedValueOnce(new Error('item not in tenant'));
  await post();
  await vi.waitFor(() =>
    expect(host.textContent).toContain('cannot be written: item not in tenant'),
  );
  expect(host.querySelector(label('Retry sale price for Biscuit'))).toBeNull();
  await click(host.querySelector<HTMLButtonElement>(label('Discard sale price for Biscuit'))!);
  expect(host.querySelector('.price-retry')).toBeNull();
});

test('another user’s stored sale prices are never shown or written', async () => {
  localStorage.setItem(key('b3', 'someone-else'), stored('b3', Date.now() - 60_000));
  await mountEditor();
  await pickItem(1, 'Biscuit');
  expect(host.querySelector('.price-retry')).toBeNull();
  expect(localStorage.getItem(key('b3', 'someone-else'))).not.toBeNull();
});

const priceKeys = () =>
  Object.keys(localStorage).filter((k) => k.startsWith('dsb-bill-sale-prices'));

test('a bill refused on its retry after a reload leaves no stored price and no alert', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'unknown', message: 'timeout' });
  await post();
  await vi.waitFor(() => expect(host.textContent).toContain('Not confirmed: timeout'));
  expect(priceKeys()).toHaveLength(1);
  act(() => render(null, host));
  await mountEditor();
  await vi.waitFor(() => expect(button('Retry same purchase')).toBeTruthy());
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'rejected', message: 'no' });
  await click(button('Retry same purchase'));
  await vi.waitFor(() => expect(host.textContent).toContain('Not posted: no.'));
  expect(priceKeys()).toEqual([]);
  act(() => render(null, host));
  await mountEditor();
  await pickItem(1, 'Biscuit');
  expect(host.querySelector('.price-retry')).toBeNull();
  expect(api.setItemPrice).not.toHaveBeenCalled();
});

test('a bill confirmed on its retry after a reload writes the prices planned before the reload', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'unknown', message: 'timeout' });
  await post();
  await vi.waitFor(() => expect(host.textContent).toContain('Not confirmed: timeout'));
  const bill = api.postPurchaseV2Outcome.mock.calls[0][0].clientId as string;
  act(() => render(null, host));
  await mountEditor();
  await vi.waitFor(() => expect(button('Retry same purchase')).toBeTruthy());
  // The pending bill's plan is not offered as an alert while the bill is unconfirmed.
  expect(host.querySelector('.price-retry')).toBeNull();
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'committed', value: COMMITTED_CREDIT });
  await click(button('Retry same purchase'));
  await vi.waitFor(() => expect(api.setItemPrice).toHaveBeenCalledTimes(1));
  expect(api.setItemPrice.mock.calls[0][0]).toMatchObject({
    kind: 'retail',
    pricePaise: 1250,
    clientId: `bill-price:${bill}:bis:retail:3:1250`,
  });
  await vi.waitFor(() => expect(priceKeys()).toEqual([]));
});

test('discarding removes the price from every stored plan of that bill', async () => {
  const w = {
    clientId: 'bill-price:b9:bis:retail:3:1250',
    itemId: 'bis',
    itemName: 'Biscuit',
    kind: 'retail',
    unitLevel: 3,
    unitName: 'pcs',
    pricePaise: 1250,
  };
  const plan = JSON.stringify({ bill: 'b9', savedAt: Date.now() - 60_000, writes: [w] });
  localStorage.setItem('dsb-bill-sale-prices:user:shop:b9:win-a', plan);
  localStorage.setItem('dsb-bill-sale-prices:user:shop:b9:win-b', plan);
  await mountEditor();
  await vi.waitFor(() => expect(host.querySelectorAll('.price-retry')).toHaveLength(2));
  for (const b of host.querySelectorAll<HTMLButtonElement>(label('Discard sale price for Biscuit')))
    await click(b);
  expect(host.querySelector('.price-retry')).toBeNull();
  expect(priceKeys()).toEqual([]);
});

// A stored ("check"/"late") price whose item price was changed by someone else after the bill was entered.
const storedWithOld = (bill: string, oldPaise: number | null | undefined) => {
  const plan = JSON.parse(stored(bill, Date.now() - 60_000));
  if (oldPaise !== undefined) plan.writes[0].oldPaise = oldPaise;
  return JSON.stringify(plan);
};
const retryButton = () =>
  host.querySelector<HTMLButtonElement>(label('Retry sale price for Biscuit'))!;
test.each([
  ['the planned old price', 900],
  ['no planned old price (stored by the previous version)', undefined],
] as const)(
  'Retry asks before replacing a price changed since the bill (%s)',
  async (_name, oldPaise) => {
    localStorage.setItem(key('b9'), storedWithOld('b9', oldPaise));
    // The current retail per pcs is ₹10.00 (beforeEach), not the ₹9.00 the bill saw.
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mountEditor();
    await vi.waitFor(() => expect(retryButton()).not.toBeNull());
    await click(retryButton());
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0]![0]).toContain('Now ₹10.00. Replace with ₹12.50?');
    expect(api.setItemPrice).not.toHaveBeenCalled();
    expect(host.querySelector('.price-retry')).not.toBeNull();
    ask.mockReturnValue(true);
    await click(retryButton());
    await vi.waitFor(() => expect(host.textContent).toContain('Sale price updated for Biscuit.'));
    expect(api.setItemPrice).toHaveBeenCalledTimes(1);
  },
);
test('Retry writes without asking when the price is still what the bill saw', async () => {
  localStorage.setItem(key('b10'), storedWithOld('b10', 1000));
  const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await mountEditor();
  await vi.waitFor(() => expect(retryButton()).not.toBeNull());
  await click(retryButton());
  await vi.waitFor(() => expect(host.textContent).toContain('Sale price updated for Biscuit.'));
  expect(ask).not.toHaveBeenCalled();
});
test('the sale price plan records the price the bill saw', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  let saved = '';
  api.postPurchaseV2Outcome.mockImplementation(async () => {
    saved = localStorage.getItem(priceKeys()[0]!)!;
    return { kind: 'committed', value: COMMITTED_CREDIT };
  });
  await post();
  await vi.waitFor(() => expect(api.setItemPrice).toHaveBeenCalled());
  expect(JSON.parse(saved).writes[0].oldPaise).toBe(1000);
});

// Biscuit retail per pcs is ₹10.00 when the bill is entered; someone changes it to ₹11.00 later.
const changedTo1100 = () =>
  api.listCurrentPrices.mockImplementation(async (id: string) =>
    id === 'bis' ? [price('retail', 3, 1100), price('wholesale', 3, 900)] : [],
  );
test('Retry of a failed write asks too when the price was changed since the bill', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'committed', value: COMMITTED_CREDIT });
  api.setItemPrice.mockRejectedValueOnce(new Error('network down'));
  await post();
  await vi.waitFor(() => expect(host.textContent).toContain('Sale price not updated for Biscuit'));
  changedTo1100();
  const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await click(retryButton());
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  expect(ask.mock.calls[0]![0]).toContain('Now ₹11.00. Replace with ₹12.50?');
  expect(api.setItemPrice).toHaveBeenCalledTimes(1); // only the failed first write
  expect(host.querySelector('.price-retry')).not.toBeNull();
});
test('a bill confirmed after a reload does not write a price changed since; it asks to check instead', async () => {
  await mountEditor();
  await fillCard(1, 'Biscuit');
  await setField(label('Item 1 retail ₹'), '12.50');
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'unknown', message: 'timeout' });
  await post();
  await vi.waitFor(() => expect(host.textContent).toContain('Not confirmed: timeout'));
  act(() => render(null, host));
  changedTo1100();
  await mountEditor();
  await vi.waitFor(() => expect(button('Retry same purchase')).toBeTruthy());
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'committed', value: COMMITTED_CREDIT });
  await click(button('Retry same purchase'));
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Check that the bill was posted, then Retry or Discard.'),
  );
  expect(api.setItemPrice).not.toHaveBeenCalled();
  expect(priceKeys()).toHaveLength(1);
  const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(retryButton());
  await vi.waitFor(() => expect(host.textContent).toContain('Sale price updated for Biscuit.'));
  expect(ask.mock.calls[0]![0]).toContain('Now ₹11.00. Replace with ₹12.50?');
  expect(api.setItemPrice).toHaveBeenCalledTimes(1);
});
