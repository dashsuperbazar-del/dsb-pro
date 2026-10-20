// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import 'fake-indexeddb/auto';
import { InventoryScreen } from './InventoryScreen';
import { shopContext } from '../lib/shopContext';
import { markCatalogDirty, resetCatalogDirtyForTests } from '../lib/catalogRead';
import { ITEM_FIELD_LABELS, ITEM_UNITS_HINT } from '../lib/newItem';
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
  createItem: vi.fn(),
  findItemByClientId: vi.fn(),
  listStock: vi.fn().mockResolvedValue([]),
  listCurrentPrices: vi.fn(),
  listPurchaseHistory: vi.fn().mockResolvedValue([]),
  getPurchaseDetail: vi.fn(),
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
const offline = vi.hoisted(() => ({
  getSyncedOfflineCatalog: vi.fn(),
  runSyncNow: vi.fn(),
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
test('a late price response cannot relabel old prices as the newly selected item', async () => {
  let finish!: (rows: unknown[]) => void;
  api.listCurrentPrices.mockImplementation((id) =>
    id === 'a'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([{ kind: 'retail', price_paise: 2000 }]),
  );
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelectorAll('select option[value="b"]').length).toBeGreaterThan(0),
  );
  const picker = host.querySelector('select')!;
  await act(async () => {
    picker.value = 'a';
    picker.dispatchEvent(new Event('change'));
  });
  await vi.waitFor(() => expect(api.listCurrentPrices).toHaveBeenCalledWith('a'));
  expect(host.querySelector('[aria-label="item peek"]')?.textContent).toContain('Loading…');
  await act(async () => {
    picker.value = 'b';
    picker.dispatchEvent(new Event('change'));
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="item peek"]')?.textContent).toContain('retail ₹20.00'),
  );
  await act(async () => {
    finish([{ kind: 'retail', price_paise: 9900 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector('[aria-label="item peek"]')?.textContent).toContain('Item B');
  expect(host.querySelector('[aria-label="item peek"]')?.textContent).not.toContain('₹99.00');
});
test('item-specific price and barcode edits stay on the same item and cannot carry into another', async () => {
  let finish!: (rows: unknown[]) => void;
  api.listCurrentPrices.mockImplementation((id) =>
    id === 'a'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([]),
  );
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelectorAll('select option[value="a"]').length).toBeGreaterThan(0),
  );
  const picker = host.querySelector('select')!;
  await act(async () => {
    picker.value = 'a';
    picker.dispatchEvent(new Event('change'));
  });
  await vi.waitFor(() => expect(api.listCurrentPrices).toHaveBeenCalledWith('a'));
  const price = host.querySelector<HTMLInputElement>('input[placeholder="₹ price"]')!;
  const barcode = host.querySelector<HTMLInputElement>('input[name="barcode"]')!;
  price.value = '42';
  barcode.value = 'CODE-A';
  await act(async () => {
    finish([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector('input[placeholder="₹ price"]')).toBe(price);
  expect(price.value).toBe('42');
  expect(barcode.value).toBe('CODE-A');
  await act(async () => {
    picker.value = 'b';
    picker.dispatchEvent(new Event('change'));
  });
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="item peek"]')?.textContent).toContain('Item B'),
  );
  expect(host.querySelector<HTMLInputElement>('input[placeholder="₹ price"]')!.value).toBe('');
  expect(host.querySelector<HTMLInputElement>('input[name="barcode"]')!.value).toBe('');
});

test('new purchase shortcuts never replace an exact request awaiting confirmation', async () => {
  localStorage.setItem(
    'dsb-pending-purchase:shop',
    JSON.stringify({
      clientId: 'frozen',
      shopId: 'shop',
      partyId: 'p',
      billNo: 'pending',
      businessDate: '2026-10-01',
      lines: [{ itemId: 'a', unitLevel: 1, qty: '2', unitPricePaise: 100 }],
    }),
  );
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="old" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Retry same purchase'));
  expect(api.getPurchaseDetail).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Resolve the pending purchase');
});
test('editing a repeated purchase line updates one row rather than duplicating stock entry', async () => {
  api.getPurchaseDetail.mockResolvedValue({
    bill: {
      id: 'old',
      status: 'POSTED',
      party_id: null,
      bill_no: 'OLD',
      business_date: '2026-01-01',
      discount_paise: '0',
      extra_charges_paise: '0',
    },
    lines: [
      {
        item_id: 'a',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '2',
        unit_price_paise: '100',
      },
    ],
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="old" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from OLD'));
  const post = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Post purchase')!;
  expect(post.disabled).toBe(false);
  // The repeated item is a card, edited in place: no separate edit/update step, no second row.
  await enterLabel(host, 'Item 1 quantity', '3');
  expect(post.disabled).toBe(false);
  expect(host.querySelectorAll('section[aria-label^="Item "]')).toHaveLength(1);
  expect(host.querySelector('[data-testid="bill-total"]')?.textContent).toContain('₹3.00');
  expect(host.querySelector('.bill-bar')?.textContent).toContain('Total ₹3.00');
});

test('opening the purchase bill list preserves the repeated draft without a replacement prompt', async () => {
  api.getPurchaseDetail.mockResolvedValue({
    bill: {
      id: 'old',
      status: 'POSTED',
      party_id: null,
      bill_no: 'OLD',
      business_date: '2026-01-01',
      discount_paise: '0',
      extra_charges_paise: '0',
    },
    lines: [
      {
        item_id: 'a',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '2',
        unit_price_paise: '100',
      },
    ],
  });
  const prompt = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    await act(async () => {
      render(<InventoryScreen purchaseOnly purchaseRepeatId="old" />, host);
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from OLD'));
    await act(async () => {
      render(<InventoryScreen purchaseOnly purchaseContextActive={false} />, host);
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="bill-total"]')?.textContent).toContain('₹2.00');
    await act(async () => {
      render(<InventoryScreen purchaseOnly purchaseRepeatId="old" />, host);
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="bill-total"]')?.textContent).toContain('₹2.00');
  } finally {
    prompt.mockRestore();
  }
});

test('a cancelled slow repeat can be loaded again when its purchase task is reopened', async () => {
  let finish!: (v: unknown) => void;
  api.getPurchaseDetail.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="slow" />, host);
  });
  await vi.waitFor(() => expect(api.getPurchaseDetail).toHaveBeenCalledTimes(1));
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseContextActive={false} />, host);
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="slow" />, host);
  });
  await vi.waitFor(() => expect(api.getPurchaseDetail).toHaveBeenCalledTimes(2));
  await act(async () => {
    finish({
      bill: {
        id: 'slow',
        status: 'POSTED',
        party_id: null,
        bill_no: 'SLOW',
        business_date: '2026-01-01',
        discount_paise: '0',
        extra_charges_paise: '0',
      },
      lines: [
        {
          item_id: 'a',
          unit_level: 1,
          unit_name_snapshot: 'piece',
          conv1_snapshot: null,
          conv2_snapshot: null,
          qty: '2',
          unit_price_paise: '100',
        },
      ],
    });
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from SLOW'));
});

async function enterLabel(host: HTMLElement, label: string, value: string) {
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function enter(host: HTMLElement, name: string, value: string) {
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
test('reload restores all draft fields and unfinished edit without posting; confirmed posting removes it', async () => {
  const detail = {
    bill: {
      id: 'draft-source',
      status: 'POSTED',
      party_id: null,
      bill_no: 'SOURCE',
      business_date: '2026-01-01',
      discount_paise: '50',
      extra_charges_paise: '20',
    },
    lines: [
      {
        item_id: 'a',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '2',
        unit_price_paise: '100',
      },
    ],
  };
  api.getPurchaseDetail.mockResolvedValue(detail);
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="draft-source" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from SOURCE'));
  await enter(host, 'billNo', 'UNFINISHED');
  await enter(host, 'date', '2026-10-01');
  await enter(host, 'discount', '0.75');
  // The repeated bill's single extra amount became one named row; it is edited and a second row added.
  expect(host.querySelector<HTMLInputElement>('[aria-label="Extra charge 1 name"]')!.value).toBe(
    'Extra charges',
  );
  await enterLabel(host, 'Extra charge 1 amount ₹', '0.35');
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === '+ Add charge')!.click();
  });
  await enterLabel(host, 'Extra charge 2 name', 'Loading');
  await enterLabel(host, 'Extra charge 2 amount ₹', '1');
  await enterLabel(host, 'Item 1 quantity', '3.25');
  await enterLabel(host, 'Item 1 rate ₹', '1.45');
  await enterLabel(host, 'Item 1 discount %', '5');
  await act(async () => {
    const notes = host.querySelector<HTMLTextAreaElement>('textarea[name="notes"]')!;
    notes.value = 'Rate agreed on phone';
    notes.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    [...host.querySelectorAll('[aria-label="Payment type"] button')]
      .find((b) => b.textContent === 'UPI')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // An unfinished second card (no item chosen yet) is part of the draft too.
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === '+ Add item')!.click();
  });
  await enterLabel(host, 'Item 2 name', 'Item');
  await enterLabel(host, 'Item 2 quantity', '1');
  await vi.waitFor(() => expect(host.textContent).toContain('Draft saved on this device'));
  const before = Object.keys(localStorage).filter((k) => k.startsWith('dsb-purchase-draft:'));
  const clientId = JSON.parse(localStorage.getItem(before[0])!).clientId;
  await act(async () => {
    render(null, host);
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')?.disabled,
    ).toBe(false),
  );
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')!.click();
  });
  expect(host.querySelector<HTMLInputElement>('input[name="billNo"]')!.value).toBe('UNFINISHED');
  expect(host.querySelector<HTMLInputElement>('input[name="date"]')!.value).toBe('2026-10-01');
  expect(host.querySelector<HTMLInputElement>('input[name="discount"]')!.value).toBe('0.75');
  const field = (label: string) =>
    host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.value;
  expect(field('Extra charge 1 name')).toBe('Extra charges');
  expect(field('Extra charge 1 amount ₹')).toBe('0.35');
  expect(field('Extra charge 2 name')).toBe('Loading');
  expect(field('Extra charge 2 amount ₹')).toBe('1');
  expect(field('Item 1 discount %')).toBe('5');
  expect(field('Item 1 GST %')).toBe('');
  expect(host.querySelector<HTMLTextAreaElement>('textarea[name="notes"]')!.value).toBe(
    'Rate agreed on phone',
  );
  expect(
    [...host.querySelectorAll('[aria-label="Payment type"] button')]
      .find((b) => b.textContent === 'UPI')!
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(field('Item 1 quantity')).toBe('3.25');
  expect(field('Item 1 rate ₹')).toBe('1.45');
  expect(field('Item 2 name')).toBe('Item');
  expect(field('Item 2 quantity')).toBe('1');
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  // A started card that cannot post blocks the bill and says which item needs a look.
  await act(async () => {
    host
      .querySelector('input[name="billNo"]')!
      .closest('form')!
      .requestSubmit(host.querySelector<HTMLButtonElement>('.bill-bar button'));
  });
  expect(host.textContent).toContain('Item 2: Choose the item.');
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="Remove item 2"]')!.click();
  });
  // A UPI bill needs a supplier: refused before anything is sent; the bill goes as credit instead.
  await act(async () => {
    host
      .querySelector('input[name="billNo"]')!
      .closest('form')!
      .requestSubmit(host.querySelector<HTMLButtonElement>('.bill-bar button'));
  });
  expect(host.textContent).toContain('A UPI bill is paid to a supplier');
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  await act(async () => {
    [...host.querySelectorAll('[aria-label="Payment type"] button')]
      .find((b) => b.textContent === 'Credit')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'confirmed', value: {} });
  await act(async () => {
    host
      .querySelector('input[name="billNo"]')!
      .closest('form')!
      .requestSubmit(host.querySelector<HTMLButtonElement>('.bill-bar button'));
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted'));
  expect(api.postPurchaseV2Outcome.mock.calls[0][0]).toMatchObject({
    clientId,
    billNo: 'UNFINISHED',
    discountPaise: 75,
    paymentType: 'credit',
    notes: 'Rate agreed on phone',
    charges: [
      { label: 'Extra charges', amountPaise: 35 },
      { label: 'Loading', amountPaise: 100 },
    ],
    lines: [{ itemId: 'a', qty: '3.25', unitPricePaise: 145, discountBp: 500, gstBp: null }],
  });
  expect(Object.keys(localStorage).filter((k) => k.startsWith('dsb-purchase-draft:'))).toEqual([]);
});

test('a signed-in account change hides prior drafts and blocks the old editor', async () => {
  let changed!: (session: { user: { id: string } } | null) => void;
  api.onAuthStateChange.mockImplementation((callback) => {
    changed = callback;
    return () => {};
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() => expect(host.querySelector('input[name="billNo"]')).not.toBeNull());
  await enter(host, 'billNo', 'PRIVATE-BILL');
  await vi.waitFor(() => expect(host.textContent).toContain('Draft saved on this device'));
  await act(async () => {
    changed({ user: { id: 'different-user' } });
  });
  expect(host.textContent).toContain('Your signed-in account changed');
  expect(host.textContent).not.toContain('PRIVATE-BILL');
  expect(host.querySelector('input[name="billNo"]')).toBeNull();
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  expect(Object.keys(localStorage).some((k) => k.startsWith('dsb-purchase-draft:user:shop:'))).toBe(
    true,
  );
  api.onAuthStateChange.mockReturnValue(() => {});
});

test('a rejected restored payload never rotates its identity into a new potentially duplicate bill', async () => {
  api.getPurchaseDetail.mockResolvedValue({
    bill: {
      id: 'source',
      status: 'POSTED',
      party_id: null,
      bill_no: 'SOURCE',
      business_date: '2026-01-01',
      discount_paise: '0',
      extra_charges_paise: '0',
    },
    lines: [
      {
        item_id: 'a',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '2',
        unit_price_paise: '100',
      },
    ],
  });
  api.postPurchaseV2Outcome.mockResolvedValue({
    kind: 'rejected',
    message: 'DSB_PAYLOAD_MISMATCH: client_id already used for a different purchase',
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="source" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from SOURCE'));
  const submit = async () =>
    act(async () => {
      host
        .querySelector('input[name="billNo"]')!
        .closest('form')!
        .requestSubmit(host.querySelector<HTMLButtonElement>('.bill-bar button'));
    });
  await submit();
  await vi.waitFor(() => expect(host.textContent).toContain('DSB_PAYLOAD_MISMATCH'));
  await enter(host, 'billNo', 'changed-but-same-draft');
  await submit();
  expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(2);
  expect(api.postPurchaseV2Outcome.mock.calls[1][0].clientId).toBe(
    api.postPurchaseV2Outcome.mock.calls[0][0].clientId,
  );
  expect(host.querySelector('[data-testid="bill-total"]')?.textContent).toContain('₹2.00');
});

test('UNKNOWN posting hides the unposted draft label and retains the exact request ahead of draft recovery', async () => {
  api.getPurchaseDetail.mockResolvedValue({
    bill: {
      id: 'unknown-source',
      status: 'POSTED',
      party_id: null,
      bill_no: 'UNKNOWN-SOURCE',
      business_date: '2026-01-01',
      discount_paise: '0',
      extra_charges_paise: '0',
    },
    lines: [
      {
        item_id: 'a',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '2',
        unit_price_paise: '100',
      },
    ],
  });
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'unknown', message: 'answer lost' });
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="unknown-source" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from UNKNOWN-SOURCE'));
  await vi.waitFor(() => expect(host.textContent).toContain('Draft saved on this device'));
  await act(async () => {
    host
      .querySelector('input[name="billNo"]')!
      .closest('form')!
      .requestSubmit(host.querySelector<HTMLButtonElement>('.bill-bar button'));
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Not confirmed'));
  expect(host.textContent).not.toContain('not posted');
  const first = api.postPurchaseV2Outcome.mock.calls[0][0];
  await act(async () => {
    render(null, host);
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Retry same purchase'));
  expect(
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')!.disabled,
  ).toBe(true);
  await act(async () => {
    host
      .querySelector('input[name="billNo"]')!
      .closest('form')!
      .requestSubmit(host.querySelector<HTMLButtonElement>('.bill-bar button'));
  });
  const retry = { ...api.postPurchaseV2Outcome.mock.calls[1][0] };
  delete retry.savedAt; // local persistence metadata is never part of the RPC payload
  expect(retry).toEqual(JSON.parse(JSON.stringify(first)));
});

test('purchase controls cannot accept a click during the transient initial context load', async () => {
  let finish!: (date: string) => void;
  api.getShopBusinessDate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() => expect(api.getShopBusinessDate).toHaveBeenCalled());
  const create = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Create & select supplier',
  )!;
  expect(create.disabled).toBe(true);
  expect(
    host.querySelector<HTMLInputElement>('input[name="billNo"]')!.closest('fieldset')!.disabled,
  ).toBe(true);
  await act(async () => {
    finish('2026-10-12');
  });
  await vi.waitFor(() => expect(create.disabled).toBe(false));
  expect(
    host.querySelector<HTMLInputElement>('input[name="billNo"]')!.closest('fieldset')!.disabled,
  ).toBe(false);
});

test('bill bytes and complete draft are durable before upload; reload resumes the same document and blocks premature posting', async () => {
  const tenant = 'a0000000-0000-0000-0000-000000000001',
    shop = 'a0000000-0000-0000-0000-000000000002';
  api.getCurrentMembership.mockResolvedValue({ tenantId: tenant, role: 'owner' });
  api.getDefaultShopId.mockResolvedValue(shop);
  api.getPurchaseDetail.mockResolvedValue({
    bill: {
      id: 'photo-source',
      status: 'POSTED',
      party_id: null,
      bill_no: 'PHOTO-SOURCE',
      business_date: '2026-01-01',
      discount_paise: '0',
      extra_charges_paise: '0',
    },
    lines: [
      {
        item_id: 'a',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '2',
        unit_price_paise: '100',
      },
    ],
  });
  let finish!: () => void;
  let storedAtUpload: unknown;
  api.uploadBillDocument
    .mockImplementationOnce((doc) => {
      const key = Object.keys(localStorage).find(
        (k) =>
          k.startsWith('dsb-purchase-draft:') &&
          JSON.parse(localStorage.getItem(k)!).document?.id === doc.id,
      )!;
      storedAtUpload = JSON.parse(localStorage.getItem(key)!);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValue(undefined);
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="photo-source" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from PHOTO-SOURCE'));
  await enter(host, 'billNo', 'PHOTO-DRAFT');
  const picker = host.querySelector<HTMLInputElement>('input[aria-label="Choose bill PDF"]')!;
  Object.defineProperty(picker, 'files', {
    configurable: true,
    value: [new File(['%PDF-1.7 sample'], 'bill.pdf', { type: 'application/pdf' })],
  });
  await act(async () => {
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await vi.waitFor(() => expect(api.uploadBillDocument).toHaveBeenCalledTimes(1));
  expect(storedAtUpload).toMatchObject({
    billNo: 'PHOTO-DRAFT',
    cart: [{ qty: '2', unitPricePaise: 100 }],
    document: { uploaded: false, name: 'bill.pdf' },
  });
  expect(
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Post purchase')!.disabled,
  ).toBe(true);
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  const original = api.uploadBillDocument.mock.calls[0][0];
  await act(async () => {
    render(null, host);
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')?.disabled,
    ).toBe(false),
  );
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')!.click();
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Upload confirmed'));
  expect(api.uploadBillDocument.mock.calls[1][0].path).toBe(original.path);
  expect(host.querySelector<HTMLInputElement>('input[name="billNo"]')!.value).toBe('PHOTO-DRAFT');
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  await act(async () => {
    finish();
  });
  api.postPurchaseV2Outcome.mockResolvedValue({ kind: 'confirmed', value: {} });
  await act(async () => {
    host
      .querySelector('input[name="billNo"]')!
      .closest('form')!
      .requestSubmit(host.querySelector<HTMLButtonElement>('.bill-bar button'));
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted'));
  expect(api.postPurchaseV2Outcome.mock.calls[0][0]).toMatchObject({
    images: [original.path],
    clientId: (storedAtUpload as { clientId: string }).clientId,
  });
});

test('a failed document preparation cannot silently post without the intended attachment', async () => {
  api.getPurchaseDetail.mockResolvedValue({
    bill: {
      id: 'bad-file-source',
      status: 'POSTED',
      party_id: null,
      bill_no: 'BAD-FILE-SOURCE',
      business_date: '2026-01-01',
      discount_paise: '0',
      extra_charges_paise: '0',
    },
    lines: [
      {
        item_id: 'a',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '2',
        unit_price_paise: '100',
      },
    ],
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="bad-file-source" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from BAD-FILE-SOURCE'));
  const picker = host.querySelector<HTMLInputElement>('input[aria-label="Choose bill PDF"]')!;
  Object.defineProperty(picker, 'files', {
    configurable: true,
    value: [new File(['not a PDF'], 'bad.pdf', { type: 'application/pdf' })],
  });
  await act(async () => {
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Choose a valid PDF'));
  const post = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Post purchase')!;
  expect(post.disabled).toBe(true);
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  await act(async () => {
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Continue without attachment')!
      .click();
  });
  expect(post.disabled).toBe(false);
});

test('picker eviction preserves the document intent and requires a decision after restoring the complete draft', async () => {
  api.getPurchaseDetail.mockResolvedValue({
    bill: {
      id: 'picker-source',
      status: 'POSTED',
      party_id: null,
      bill_no: 'PICKER-SOURCE',
      business_date: '2026-01-01',
      discount_paise: '0',
      extra_charges_paise: '0',
    },
    lines: [
      {
        item_id: 'a',
        unit_level: 1,
        unit_name_snapshot: 'piece',
        conv1_snapshot: null,
        conv2_snapshot: null,
        qty: '2',
        unit_price_paise: '100',
      },
    ],
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly purchaseRepeatId="picker-source" />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Draft repeated from PICKER-SOURCE'));
  await enter(host, 'billNo', 'PICKER-DRAFT');
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Gallery')!.click();
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Document selection needs review'));
  await act(async () => {
    render(null, host);
  });
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')?.disabled,
    ).toBe(false),
  );
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')!.click();
  });
  expect(host.querySelector<HTMLInputElement>('input[name="billNo"]')!.value).toBe('PICKER-DRAFT');
  expect(host.querySelector('[data-testid="bill-total"]')?.textContent).toContain('₹2.00');
  expect(host.textContent).toContain('Document selection needs review');
  const post = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Post purchase')!;
  expect(post.disabled).toBe(true);
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  await act(async () => {
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Continue without attachment')!
      .click();
  });
  expect(post.disabled).toBe(false);
});

test('resume stays disabled through the catalogue-to-new-context gap and preserves the draft afterwards', async () => {
  localStorage.setItem(
    'dsb-purchase-draft:user:shop:resume-client:writer',
    JSON.stringify({
      version: 1,
      clientId: 'resume-client',
      savedAt: 1,
      supplier: '',
      billNo: 'RESUME-GAP',
      businessDate: '2026-10-01',
      discount: '',
      extra: '',
      search: '',
      lineItem: null,
      unitLevel: 1,
      qty: '',
      price: '',
      editingLine: null,
      cart: [
        {
          item: { id: 'a', name: 'Item A', unit1: 'piece' },
          unitLevel: 1,
          qty: '2',
          unitPricePaise: 100,
        },
      ],
    }),
  );
  let finishCatalogue!: (date: string) => void, finishContext!: (date: string) => void;
  api.getShopBusinessDate
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCatalogue = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishContext = resolve;
        }),
    );
  let exposed = 0;
  const observer = new MutationObserver(() => {
    const resume = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Resume draft',
    );
    const formLoading = host
      .querySelector<HTMLInputElement>('input[name="billNo"]')
      ?.closest('fieldset')?.disabled;
    if (resume && !resume.disabled && formLoading) exposed++;
  });
  observer.observe(host, { subtree: true, childList: true, attributes: true });
  try {
    await act(async () => {
      render(<InventoryScreen purchaseOnly />, host);
    });
    await vi.waitFor(() => expect(api.getShopBusinessDate).toHaveBeenCalledTimes(1));
    finishCatalogue('2026-10-12');
    await vi.waitFor(() => expect(api.getShopBusinessDate).toHaveBeenCalledTimes(2));
    expect(exposed).toBe(0);
    const resume = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Resume draft',
    )!;
    expect(resume.disabled).toBe(true);
    await act(async () => {
      finishContext('2026-10-12');
    });
    await vi.waitFor(() => expect(resume.disabled).toBe(false));
    await act(async () => {
      resume.click();
    });
    expect(host.querySelector<HTMLInputElement>('input[name="billNo"]')!.value).toBe('RESUME-GAP');
    expect(host.querySelector<HTMLInputElement>('input[name="date"]')!.value).toBe('2026-10-01');
    expect(host.querySelector('[data-testid="bill-total"]')?.textContent).toContain('₹2.00');
    expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  } finally {
    observer.disconnect();
  }
});

test('VF-016: an unreadable snapshot is listed apart, discardable, and never hides or fails a real draft', async () => {
  const { purchaseDraftPrefix, savePurchaseDraft } = await import('../lib/purchaseDraft');
  const prefix = purchaseDraftPrefix('user', 'shop');
  const item = { id: 'a', name: 'Item A', unit1: 'piece', min_stock: 0 } as never;
  savePurchaseDraft(prefix, 'other-window', {
    version: 1,
    clientId: '11111111-1111-4111-8111-111111111111',
    savedAt: 1,
    supplier: '',
    billNo: 'KEPT',
    businessDate: '2026-10-12',
    discount: '',
    extra: '',
    cart: [{ item, unitLevel: 1, qty: '1', unitPricePaise: 100 }],
    search: '',
    lineItem: null,
    unitLevel: 1,
    qty: '',
    price: '',
    editingLine: null,
  });
  localStorage.setItem(prefix + 'broken:w', '{');
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() => expect(host.textContent).toContain('KEPT'));
  expect(host.textContent).toContain('1 saved draft is unreadable');
  expect(host.textContent).not.toContain('Draft recovery unavailable');
  await enter(host, 'billNo', 'NEW');
  await vi.waitFor(() => expect(host.textContent).toContain('Draft saved on this device'));
  expect(host.textContent).not.toContain('Draft not saved');
  await act(async () => {
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Discard unreadable draft')!
      .click();
  });
  expect(localStorage.getItem(prefix + 'broken:w')).toBeNull();
  expect(host.textContent).not.toContain('unreadable on this device');
  expect(host.textContent).toContain('KEPT');
});

const deviceItem = (id: string, name: string) => ({
  id,
  name,
  unit1: 'piece',
  min_stock: 0,
  sku: null,
  unit2: null,
  unit3: null,
  conv1: null,
  conv2: null,
  tax_rate_bp: 0,
  image_path: null,
});
const hasOption = (id: string) => host.querySelectorAll(`select option[value="${id}"]`).length > 0;

test('SP1: after a completed device sync the catalog comes from the device and is not downloaded again', async () => {
  offline.getSyncedOfflineCatalog.mockResolvedValue({
    key: 'k1',
    tenantId: 'tenant',
    userId: 'user',
    items: [deviceItem('d1', 'Device One')],
  });
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() => expect(hasOption('d1')).toBe(true));
  expect(api.listItems).not.toHaveBeenCalled();
  expect(offline.runSyncNow).toHaveBeenCalledTimes(1);
});

test('SP1: a change synced from another device appears after the incremental cycle', async () => {
  offline.getSyncedOfflineCatalog
    .mockResolvedValueOnce({
      key: 'k1',
      tenantId: 'tenant',
      userId: 'user',
      items: [deviceItem('d1', 'Device One')],
    })
    .mockResolvedValue({
      key: 'k1',
      tenantId: 'tenant',
      userId: 'user',
      items: [deviceItem('d1', 'Device One'), deviceItem('d2', 'From Another Phone')],
    });
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() => expect(hasOption('d2')).toBe(true));
  expect(api.listItems).not.toHaveBeenCalled();
});

test('SP1: rows for a different identity are never applied to this screen', async () => {
  offline.getSyncedOfflineCatalog
    .mockResolvedValueOnce({
      key: 'user-a',
      tenantId: 'tenant',
      userId: 'user',
      items: [deviceItem('a1', 'User A Item')],
    })
    .mockResolvedValue({
      key: 'user-b',
      tenantId: 'tenant',
      userId: 'user',
      items: [deviceItem('b1', 'User B Item')],
    });
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() => expect(offline.runSyncNow).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(hasOption('a1')).toBe(true);
  expect(hasOption('b1')).toBe(false);
});

test('SP1: a device cache that has not finished a sync falls back to the server catalog', async () => {
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() => expect(hasOption('a')).toBe(true));
  expect(api.listItems).toHaveBeenCalledTimes(1);
  expect(offline.runSyncNow).not.toHaveBeenCalled();
});

test('SP1: rows that belong to another user or tenant are not used even when a sync has completed', async () => {
  offline.getSyncedOfflineCatalog.mockResolvedValue({
    key: 'other',
    tenantId: 'someone-elses-tenant',
    userId: 'user',
    items: [deviceItem('x1', 'Foreign Item')],
  });
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() => expect(hasOption('a')).toBe(true));
  expect(hasOption('x1')).toBe(false);
  expect(api.listItems).toHaveBeenCalledTimes(1);
});

test('SP1: after our own write the device copy is not trusted until a later sync cycle has covered it', async () => {
  markCatalogDirty(Date.now() + 60_000); // a write that no completed cycle has started after yet
  offline.getSyncedOfflineCatalog.mockImplementation(async (input?: { notBefore?: number }) =>
    input?.notBefore
      ? null
      : {
          key: 'k1',
          tenantId: 'tenant',
          userId: 'user',
          items: [deviceItem('d1', 'Stale Device')],
        },
  );
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() => expect(hasOption('a')).toBe(true));
  expect(api.listItems).toHaveBeenCalledTimes(1);
  expect(hasOption('d1')).toBe(false);
  resetCatalogDirtyForTests();
});

test('SP1: a failing incremental sync leaves the device list in place and shows no error', async () => {
  offline.getSyncedOfflineCatalog.mockResolvedValue({
    key: 'k1',
    tenantId: 'tenant',
    userId: 'user',
    items: [deviceItem('d1', 'Device One')],
  });
  offline.runSyncNow.mockRejectedValue(new Error('offline'));
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() => expect(offline.runSyncNow).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(hasOption('d1')).toBe(true);
  expect(host.textContent).not.toContain('offline');
});

test('P06: a quick bill checks items against its paper total before posting and never leaks into the next purchase', async () => {
  const prefix = 'dsb-purchase-draft:user:shop:';
  localStorage.setItem(
    `${prefix}quick-1:w`,
    JSON.stringify({
      version: 1,
      clientId: 'quick-1',
      savedAt: Date.now(),
      supplier: '',
      billNo: 'PAPER-9',
      businessDate: '2026-10-11',
      discount: '',
      extra: '',
      cart: [
        {
          item: { id: 'a', name: 'Item A', unit1: 'piece' },
          unitLevel: 1,
          qty: '2',
          unitPricePaise: 100,
        },
      ],
      search: '',
      lineItem: null,
      unitLevel: 1,
      qty: '',
      price: '',
      editingLine: null,
      expectedTotalPaise: '300',
    }),
  );
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')?.disabled,
    ).toBe(false),
  );
  expect(host.textContent).toContain('paper total ₹3.00');
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Resume draft')!.click();
  });
  const paper = () => host.querySelector('[data-testid="paper-total"]')?.textContent ?? '';
  expect(paper()).toContain('Items are ₹1.00 short of it.');
  const submit = () =>
    act(async () => {
      host
        .querySelector('input[name="billNo"]')!
        .closest('form')!
        .requestSubmit(host.querySelector<HTMLButtonElement>('.bill-bar button'));
    });
  // Declining the mismatch posts nothing and leaves no pending request behind.
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await submit();
  expect(confirmSpy).toHaveBeenCalledTimes(1);
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  expect(localStorage.getItem('dsb-pending-purchase:shop')).toBeNull();
  // An unknown outcome locks the request; the retry resends it without asking again.
  confirmSpy.mockReturnValue(true);
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'unknown', message: 'network' });
  await submit();
  await vi.waitFor(() => expect(host.textContent).toContain('Not confirmed'));
  expect(confirmSpy).toHaveBeenCalledTimes(2);
  api.postPurchaseV2Outcome.mockResolvedValueOnce({ kind: 'confirmed', value: {} });
  await submit();
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted'));
  expect(confirmSpy).toHaveBeenCalledTimes(2);
  expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(2);
  // The next purchase carries no paper total, on screen or in its autosaved draft.
  expect(host.querySelector('[data-testid="paper-total"]')).toBeNull();
  await enter(host, 'billNo', 'NEXT');
  await vi.waitFor(() => expect(host.textContent).toContain('Draft saved on this device'));
  const saved = Object.keys(localStorage)
    .filter((k) => k.startsWith(prefix))
    .map((k) => JSON.parse(localStorage.getItem(k)!));
  expect(saved.length).toBeGreaterThan(0);
  expect(saved.every((d) => d.expectedTotalPaise === undefined)).toBe(true);
});

test('P03: an item created inside a bill card goes through the Add item adapter, joins the list and is selected', async () => {
  const fresh = {
    id: 'n',
    name: 'New Rice',
    sku: null,
    unit1: 'bag',
    unit2: 'pkt',
    unit3: null,
    conv1: 10,
    conv2: null,
    min_stock: 0,
  };
  // The first answer is lost after the server may have saved it; the retry must reuse its identity.
  api.createItem
    .mockRejectedValueOnce(new Error("Something didn't save. Please try again in a moment."))
    .mockResolvedValueOnce(fresh);
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  const nameBox = () => host.querySelector<HTMLInputElement>('[aria-label="Item 1 name"]')!;
  await vi.waitFor(() => expect(nameBox().closest('fieldset')!.disabled).toBe(false));
  await enterLabel(host, 'Item 1 name', 'New Rice');
  const tap = (text: string) =>
    act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click();
    });
  await tap('+ Create “New Rice”');
  await enterLabel(host, 'Item 1 big unit', 'bag');
  await enterLabel(host, 'Item 1 small unit', 'pkt');
  await enterLabel(host, 'Item 1 small units per big', '10');
  await tap('Save item');
  await vi.waitFor(() => expect(host.textContent).toContain("Something didn't save"));
  const reads = api.listItems.mock.calls.length;
  api.listItems.mockResolvedValue([
    { id: 'a', name: 'Item A', unit1: 'piece', min_stock: 0 },
    { id: 'b', name: 'Item B', unit1: 'piece', min_stock: 0 },
    fresh,
  ]);
  await tap('Save item');
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="Item 1 purchased in"]')).toBeTruthy(),
  );
  const expected = {
    tenantId: 'tenant',
    name: 'New Rice',
    sku: undefined,
    unit1: 'bag',
    unit2: 'pkt',
    unit3: undefined,
    conv1: 10,
    conv2: undefined,
    clientId: expect.any(String),
  };
  expect(api.createItem).toHaveBeenNthCalledWith(1, expected);
  expect(api.createItem).toHaveBeenNthCalledWith(2, expected);
  expect(api.createItem.mock.calls[1]![0].clientId).toBe(api.createItem.mock.calls[0]![0].clientId);
  await vi.waitFor(() => expect(api.listItems.mock.calls.length).toBeGreaterThan(reads));
  expect(nameBox().value).toBe('New Rice');
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
  api.listItems.mockResolvedValue([
    { id: 'a', name: 'Item A', unit1: 'piece', min_stock: 0 },
    { id: 'b', name: 'Item B', unit1: 'piece', min_stock: 0 },
  ]);
});

const CLIENT_ID_CONFLICT =
  'duplicate key value violates unique constraint "items_tenant_id_client_id_key"';
async function createInCardTwice(lookup: () => Promise<unknown>) {
  // The first answer is lost after the server saved the item; the retry is refused as a duplicate client id.
  api.createItem
    .mockRejectedValueOnce(new Error("Something didn't save. Please try again in a moment."))
    .mockRejectedValueOnce(new Error(CLIENT_ID_CONFLICT));
  api.findItemByClientId.mockImplementationOnce(lookup);
  await act(async () => {
    render(<InventoryScreen purchaseOnly />, host);
  });
  await vi.waitFor(() =>
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Item 1 name"]')!.closest('fieldset')!
        .disabled,
    ).toBe(false),
  );
  await enterLabel(host, 'Item 1 name', 'Lost Rice');
  const tap = (text: string) =>
    act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click();
    });
  await tap('+ Create “Lost Rice”');
  await enterLabel(host, 'Item 1 big unit', 'bag');
  await tap('Save item');
  await vi.waitFor(() => expect(host.textContent).toContain("Something didn't save"));
  await tap('Save item');
  await vi.waitFor(() => expect(api.findItemByClientId).toHaveBeenCalledTimes(1));
  const clientId = api.createItem.mock.calls[1]![0].clientId;
  expect(clientId).toBe(api.createItem.mock.calls[0]![0].clientId);
  expect(api.findItemByClientId).toHaveBeenCalledWith('tenant', clientId);
}

test('P03: a retry refused as a duplicate client id finds the saved item and selects it, with no raw error', async () => {
  const saved = {
    id: 'lost',
    name: 'Lost Rice',
    sku: null,
    unit1: 'bag',
    unit2: null,
    unit3: null,
    conv1: null,
    conv2: null,
    min_stock: 0,
  };
  await createInCardTwice(async () => saved);
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="Item 1 purchased in"]')).toBeTruthy(),
  );
  expect(host.querySelector('[aria-label="New item for item 1"]')).toBeNull();
  expect(host.textContent).not.toContain('duplicate key');
  expect(host.textContent).toContain('Created Lost Rice');
  expect(api.createItem).toHaveBeenCalledTimes(2);
});

test('P03: when the saved item cannot be found after a duplicate client id, the card says so plainly', async () => {
  await createInCardTwice(async () => {
    throw new Error('network down');
  });
  await vi.waitFor(() =>
    expect(host.textContent).toContain(
      'Could not confirm the new item. Check Stock, then search for it here.',
    ),
  );
  expect(host.textContent).not.toContain('duplicate key');
  expect(host.querySelector('[aria-label="Item 1 purchased in"]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('[aria-label="Item 1 big unit"]')!.value).toBe('bag');
});

test('P03: a duplicate client id with no item found by it is reported the same plain way', async () => {
  await createInCardTwice(async () => null);
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Could not confirm the new item. Check Stock'),
  );
  expect(host.textContent).not.toContain('duplicate key');
});

test('P03: an item found by client id with other units than submitted is not reported as created', async () => {
  await createInCardTwice(async () => ({
    id: 'lost',
    name: 'Lost Rice',
    sku: null,
    unit1: 'bag',
    unit2: 'pkt',
    unit3: null,
    conv1: 5,
    conv2: null,
    min_stock: 0,
  }));
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Saved earlier as: Lost Rice — bag; 5 pkt per bag.'),
  );
  expect(host.textContent).not.toContain('Created Lost Rice');
  expect(host.querySelector('[aria-label="Item 1 purchased in"]')).toBeNull();
});

test('P03: the Add item form uses the same labels, trimming and unit rules as the card form', async () => {
  api.createItem.mockResolvedValue({ id: 'z', name: 'Tea' });
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  const form = host.querySelector<HTMLFormElement>('#stock-add-item form')!;
  const labels = [...form.querySelectorAll('label')].map((l) =>
    l.childNodes[0]!.textContent!.trim(),
  );
  for (const label of Object.values(ITEM_FIELD_LABELS)) expect(labels).toContain(label);
  expect(host.querySelector('#stock-item-details')!.textContent).toContain(ITEM_UNITS_HINT);
  const set = (name: string, value: string) => {
    form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value = value;
  };
  set('name', ' Tea ');
  set('unit1', ' box ');
  set('unit2', 'pkt');
  await vi.waitFor(() => expect(form.querySelector('button')!.disabled).toBe(false));
  await act(async () => {
    form.requestSubmit();
  });
  expect(api.createItem).not.toHaveBeenCalled();
  expect(host.textContent).toContain(
    'Enter how many small units make one big unit (more than zero).',
  );
  set('conv1', '10');
  await act(async () => {
    form.requestSubmit();
  });
  await vi.waitFor(() =>
    expect(api.createItem).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Tea', unit1: 'box', unit2: 'pkt', conv1: 10 }),
    ),
  );
  api.createItem.mockReset();
});

test('SP2b: a revisit of the stock screen lists the last catalogue at once; a write since then skips it', async () => {
  const { clearSnapshots } = await import('../lib/routeSnapshot');
  clearSnapshots();
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelectorAll('option[value="a"]').length).toBeGreaterThan(0),
  );
  await act(async () => render(null, host));
  api.listItems.mockReturnValueOnce(new Promise(() => {}));
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelectorAll('option[value="a"]').length).toBeGreaterThan(0),
  );
  expect(host.querySelector('[data-testid="snapshot-note"]')?.textContent).toContain('refreshing');
  await act(async () => render(null, host));
  markCatalogDirty(Date.now() + 1000);
  api.listItems.mockReturnValueOnce(new Promise(() => {}));
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(host.querySelectorAll('option[value="a"]').length).toBe(0);
});

test('SP4: after a cold start the stock screen lists the saved catalogue from disk, labelled, then refreshes', async () => {
  const rs = await import('../lib/routeSnapshot');
  rs.clearSnapshots();
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelectorAll('option[value="a"]').length).toBeGreaterThan(0),
  );
  await act(async () => render(null, host));
  await rs.snapshotDiskIdle();
  rs.forgetSnapshotsInMemory(); // the tab was closed: only the disk copy is left
  let finish!: (v: unknown) => void;
  api.listItems.mockReturnValueOnce(new Promise((r) => (finish = r)));
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await vi.waitFor(() =>
    expect(host.querySelectorAll('option[value="a"]').length).toBeGreaterThan(0),
  );
  expect(host.querySelector('[data-testid="snapshot-note"]')?.textContent).toContain('refreshing');
  await act(async () => finish([]));
  await vi.waitFor(() => expect(host.querySelector('[data-testid="snapshot-note"]')).toBeNull());
  rs.clearSnapshots();
  await rs.snapshotDiskIdle();
});

test('SP4: a disk snapshot of another user never renders after a cold start', async () => {
  const rs = await import('../lib/routeSnapshot');
  rs.clearSnapshots();
  await rs.snapshotDiskIdle();
  const { openRouteSnapshotDb } = await import('@dsb-pro/sync');
  await (
    await openRouteSnapshotDb()
  ).snapshots.put({
    key: 'someone-else:inventory',
    userId: 'someone-else',
    name: 'inventory',
    shopId: 'shop',
    at: Date.now(),
    json: '{"items":[],"parties":[],"stock":[]}',
    size: 36,
  });
  rs.forgetSnapshotsInMemory();
  api.listItems.mockReturnValueOnce(new Promise(() => {}));
  await act(async () => {
    render(<InventoryScreen />, host);
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(host.querySelector('[data-testid="snapshot-note"]')).toBeNull();
  expect(rs.peekSnapshot('inventory', 'someone-else')).toBeNull();
});
