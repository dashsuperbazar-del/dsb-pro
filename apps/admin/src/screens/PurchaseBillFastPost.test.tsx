// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import 'fake-indexeddb/auto';
import { InventoryScreen } from './InventoryScreen';
import { shopContext } from '../lib/shopContext';
import { resetCatalogDirtyForTests } from '../lib/catalogRead';

// Fast post: once the server has confirmed the bill the form is free at once; the stock reload, sale prices
// and list refresh finish in the background. The duplicate check never waits more than a moment.
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
  listSupplierPurchaseLines: vi.fn().mockResolvedValue([]),
  listSupplierBillsForDuplicateCheck: vi.fn().mockResolvedValue([]),
  findSupplierBillDuplicates: vi.fn().mockResolvedValue([]),
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
  listOfflineItems: vi.fn(async () => []),
  listOfflineBillChanges: vi.fn(async () => []),
  closeRejectedBillChange: vi.fn(),
  queueBillChangeOffline: vi.fn(),
  queueItemOffline: vi.fn(),
  queuePurchaseOffline: vi.fn(),
  closeRejectedPurchase: vi.fn(),
  getOfflineSuppliers: vi.fn(async () => null),
  getOfflineSuppliersSavedAt: vi.fn(async () => null),
  getOfflineStock: vi.fn(async () => []),
  getOfflineItems: vi.fn(async () => []),
  getOfflineBusinessDate: vi.fn(async () => null),
  getOfflineRuntimeIdentity: vi.fn(() => null),
  waitForOfflineRuntime: vi.fn(async () => undefined),
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
  api.findSupplierBillDuplicates.mockResolvedValue([]);
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
const postButton = () => host.querySelector<HTMLButtonElement>('.bill-bar button.primary')!;
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

const committed = () => ({
  kind: 'committed',
  value: {
    billId: 'bill-1',
    paymentId: null,
    totalPaise: 1000,
    roundOffPaise: 0,
    businessDate: '2026-10-12',
  },
});
// Makes the NEXT n catalogue reads (the reload after a post) wait until released.
function slowReloads(n: number) {
  const gates: { release: () => void; fail: (e: Error) => void }[] = [];
  for (let i = 0; i < n; i++)
    api.listItems.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          gates.push({ release: () => resolve([itemA]), fail: reject });
        }),
    );
  return gates;
}
const busyLabel = () => postButton().textContent;

test('the form is free and the message is shown while the stock reload is still running', async () => {
  await mountEditor();
  await item(1, '1', '10');
  const gates = slowReloads(1);
  api.postPurchaseV2Outcome.mockResolvedValue(committed());
  await click(postButton());
  await vi.waitFor(() => expect(host.textContent).toContain('Purchase posted (1 item).'));
  expect(host.textContent).toContain('Updating stock…');
  expect(host.textContent).not.toContain('and stock updated');
  expect(busyLabel()).not.toBe('Posting…');
  expect(host.querySelector<HTMLInputElement>(label('Item 1 name'))!.value).toBe('');
  await vi.waitFor(() => expect(gates).toHaveLength(1));
  await act(async () => gates[0]!.release());
  await vi.waitFor(() =>
    expect(host.textContent).toContain('Purchase posted (1 item) and stock updated.'),
  );
  expect(host.textContent).not.toContain('Updating stock');
});

test('a failed stock reload is still reported, after the bill was announced as posted', async () => {
  await mountEditor();
  await item(1, '1', '10');
  const gates = slowReloads(1);
  api.postPurchaseV2Outcome.mockResolvedValue(committed());
  await click(postButton());
  await vi.waitFor(() => expect(gates).toHaveLength(1));
  expect(host.textContent).toContain('Updating stock…');
  await act(async () => gates[0]!.fail(new Error('network down')));
  await vi.waitFor(() => expect(host.textContent).toContain('Refresh failed: Error: network down'));
  expect(host.textContent).toContain('Purchase posted (1 item) and stock updated.');
});

test('a second post while the first reload is in flight is safe: both posted, the late first reload stays silent', async () => {
  await mountEditor();
  await item(1, '1', '10');
  const gates = slowReloads(2);
  api.postPurchaseV2Outcome.mockResolvedValue(committed());
  await click(postButton());
  await vi.waitFor(() => expect(gates).toHaveLength(1));
  await item(1, '2', '11');
  await click(postButton());
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(2));
  const [first, second] = api.postPurchaseV2Outcome.mock.calls.map(([r]) => r);
  expect(second.clientId).not.toBe(first.clientId);
  await vi.waitFor(() => expect(gates).toHaveLength(2));
  // The first reload ends late: it must not announce "stock updated" for the newer post.
  await act(async () => gates[0]!.release());
  expect(host.textContent).toContain('Updating stock…');
  expect(host.textContent).not.toContain('and stock updated');
  await act(async () => gates[1]!.release());
  await vi.waitFor(() => expect(host.textContent).toContain('and stock updated.'));
});

test('a reload that ends after the screen is gone does not touch it', async () => {
  await mountEditor();
  await item(1, '1', '10');
  const gates = slowReloads(1);
  api.postPurchaseV2Outcome.mockResolvedValue(committed());
  await click(postButton());
  await vi.waitFor(() => expect(gates).toHaveLength(1));
  await act(async () => render(null, host));
  await act(async () => gates[0]!.release());
  expect(host.textContent).toBe('');
});

test('a slow supplier-bill read delays Post by at most about a second and a half, and never blocks it', async () => {
  api.listSupplierBillsForDuplicateCheck.mockImplementation(() => new Promise(() => {}));
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await item(1, '1', '10');
  api.postPurchaseV2Outcome.mockResolvedValue(committed());
  const started = Date.now();
  await click(postButton());
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1), {
    timeout: 4000,
  });
  const waited = Date.now() - started;
  expect(waited).toBeGreaterThanOrEqual(1400);
  expect(waited).toBeLessThan(3000);
  expect(window.confirm).not.toHaveBeenCalled();
});

test('the supplier bills are read when the supplier is chosen, so Post does not wait for them', async () => {
  api.listSupplierBillsForDuplicateCheck.mockResolvedValue([
    {
      id: 'old-1',
      status: 'POSTED',
      bill_no: 'INV-9',
      business_date: '2026-10-10',
      total_paise: 1000,
    },
  ]);
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await vi.waitFor(() => expect(api.listSupplierBillsForDuplicateCheck).toHaveBeenCalledTimes(1));
  await item(1, '1', '10');
  await setField('input[name="billNo"]', 'inv-9');
  api.postPurchaseV2Outcome.mockResolvedValue(committed());
  let readsAtCheck = -1;
  vi.mocked(window.confirm).mockImplementation(() => {
    readsAtCheck = api.listSupplierBillsForDuplicateCheck.mock.calls.length;
    return true;
  });
  await click(postButton());
  await vi.waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
  expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain('INV-9');
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  // The read was reused for the check (not repeated at Post time).
  expect(readsAtCheck).toBe(1);
});

test('a bill voided on another device does not raise the duplicate warning (backlog 0070)', async () => {
  api.listSupplierBillsForDuplicateCheck.mockResolvedValue([
    {
      id: 'old-1',
      status: 'VOID',
      bill_no: 'INV-9',
      business_date: '2026-10-10',
      total_paise: 1000,
    },
  ]);
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await vi.waitFor(() => expect(api.listSupplierBillsForDuplicateCheck).toHaveBeenCalledTimes(1));
  await item(1, '1', '10');
  await setField('input[name="billNo"]', 'inv-9');
  api.postPurchaseV2Outcome.mockResolvedValue(committed());
  await click(postButton());
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  expect(window.confirm).not.toHaveBeenCalled();
});

const deepRow = (over = {}) => ({
  id: 'ancient-1',
  status: 'POSTED',
  bill_no: 'INV-9',
  business_date: '2025-01-10',
  total_paise: '7777',
  ...over,
});
async function postWithBillNo(no: string) {
  await mountEditor();
  await setField('select[name="partyId"]', 'p1', 'change');
  await vi.waitFor(() => expect(api.listSupplierBillsForDuplicateCheck).toHaveBeenCalled());
  await item(1, '1', '10');
  await setField('input[name="billNo"]', no);
  api.postPurchaseV2Outcome.mockResolvedValue(committed());
  await click(postButton());
}

test('the same bill number older than the latest-1,000 list still warns (server lookup), and is only a confirm', async () => {
  api.listSupplierBillsForDuplicateCheck.mockResolvedValue([]);
  api.findSupplierBillDuplicates.mockResolvedValue([deepRow()]);
  await postWithBillNo('inv-9');
  await vi.waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
  expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain('INV-9');
  expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain('2025-01-10');
  // The lookup was asked for this supplier and bill number.
  expect(api.findSupplierBillDuplicates.mock.calls[0]![1]).toBe('p1');
  expect(api.findSupplierBillDuplicates.mock.calls[0]![2]).toBe('inv-9');
  // "Post anyway" posts; nothing was blocked or posted by the check itself.
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
});

test('declining the warning posts nothing', async () => {
  api.listSupplierBillsForDuplicateCheck.mockResolvedValue([]);
  api.findSupplierBillDuplicates.mockResolvedValue([deepRow()]);
  vi.mocked(window.confirm).mockReturnValue(false);
  await postWithBillNo('INV-9');
  await vi.waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(api.postPurchaseV2Outcome).not.toHaveBeenCalled();
});

test('a failed server lookup is no warning and does not block the post', async () => {
  api.listSupplierBillsForDuplicateCheck.mockResolvedValue([]);
  api.findSupplierBillDuplicates.mockRejectedValue(new Error('network'));
  await postWithBillNo('INV-9');
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  expect(window.confirm).not.toHaveBeenCalled();
});

test('a VOID copy from the server lookup outranks a stale cached POSTED copy', async () => {
  api.listSupplierBillsForDuplicateCheck.mockResolvedValue([deepRow({ id: 'x-1' })]);
  api.findSupplierBillDuplicates.mockResolvedValue([deepRow({ id: 'x-1', status: 'VOID' })]);
  await postWithBillNo('INV-9');
  await vi.waitFor(() => expect(api.postPurchaseV2Outcome).toHaveBeenCalledTimes(1));
  expect(window.confirm).not.toHaveBeenCalled();
});
