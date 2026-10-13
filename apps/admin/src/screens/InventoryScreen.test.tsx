// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { InventoryScreen } from './InventoryScreen';
const api = vi.hoisted(() => ({
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
  listPurchaseHistory: vi.fn().mockResolvedValue([]),
  getPurchaseDetail: vi.fn(),
  postPurchaseOutcome: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
beforeEach(() => {
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
  await act(async () => {
    (host.querySelector('[aria-label="Edit purchase line 1"]') as HTMLButtonElement).click();
  });
  const post = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Post purchase')!;
  expect(post.disabled).toBe(true);
  const qty = host.querySelector<HTMLInputElement>('input[name="qty"]')!;
  await act(async () => {
    qty.value = '3';
    qty.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const update = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Update line')!;
  await act(async () => {
    update.click();
  });
  expect(post.disabled).toBe(false);
  expect(host.querySelectorAll('[aria-label^="Edit purchase line"]')).toHaveLength(1);
  expect(host.querySelector('[aria-label="Purchase cart"]')?.textContent).toContain('₹3.00');
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
    expect(host.querySelector('[aria-label="Purchase cart"]')?.textContent).toContain('₹2.00');
    await act(async () => {
      render(<InventoryScreen purchaseOnly purchaseRepeatId="old" />, host);
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Purchase cart"]')?.textContent).toContain('₹2.00');
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
  await enter(host, 'extra', '0.35');
  await act(async () => {
    (host.querySelector('[aria-label="Edit purchase line 1"]') as HTMLButtonElement).click();
  });
  await enter(host, 'qty', '3.25');
  await enter(host, 'price', '1.45');
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
  expect(host.querySelector<HTMLInputElement>('input[name="extra"]')!.value).toBe('0.35');
  expect(host.querySelector<HTMLInputElement>('input[name="qty"]')!.value).toBe('3.25');
  expect(host.querySelector<HTMLInputElement>('input[name="price"]')!.value).toBe('1.45');
  expect(
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Post purchase')!.disabled,
  ).toBe(true);
  expect(api.postPurchaseOutcome).not.toHaveBeenCalled();
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Update line')!.click();
  });
  api.postPurchaseOutcome.mockResolvedValue({ kind: 'confirmed', value: {} });
  await act(async () => {
    host
      .querySelector('input[name="billNo"]')!
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted'));
  expect(api.postPurchaseOutcome.mock.calls[0][0]).toMatchObject({
    clientId,
    billNo: 'UNFINISHED',
    discountPaise: 75,
    extraChargesPaise: 35,
    lines: [{ itemId: 'a', qty: '3.25', unitPricePaise: 145 }],
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
  expect(api.postPurchaseOutcome).not.toHaveBeenCalled();
  expect(Object.keys(localStorage).some((k) => k.startsWith('dsb-purchase-draft:user:shop:'))).toBe(
    true,
  );
  api.onAuthStateChange.mockReturnValue(() => {});
});
