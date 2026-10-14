// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SupplierStatement } from './SupplierStatement';

const api = vi.hoisted(() => ({ getSupplierLedger: vi.fn(), getShopSettings: vi.fn() }));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
const props = { shopId: 'shop', partyId: 'A', supplierName: 'Acme', businessDate: '2026-10-14' };
const data = (partyId = 'A', from: string | null = null, to = '2026-10-14') => ({
  shopId: 'shop',
  partyId,
  from,
  to,
  openingBalancePaise: '0',
  closingBalancePaise: '10000',
  entries: [
    {
      id: 'bill',
      date: '2026-10-14',
      kind: 'PURCHASE',
      document: '<img src=x onerror=alert(1)>',
      amountPaise: '10000',
      runningBalancePaise: '10000',
    },
  ],
});
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
async function mount(p = props) {
  await act(async () => render(<SupplierStatement {...p} />, host));
}
async function ready() {
  await vi.waitFor(() => expect(button('Download CSV').disabled).toBe(false));
}
async function date(which: 'from' | 'to', value: string) {
  await act(async () => {
    const input = host.querySelectorAll('input')[which === 'from' ? 0 : 1];
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  document.body.append(host);
  api.getSupplierLedger
    .mockReset()
    .mockImplementation((_shop, party, from, to) => Promise.resolve(data(party, from, to)));
  api.getShopSettings
    .mockReset()
    .mockResolvedValue({ id: 'shop', name: 'Corner Store', address: null, gstin: null });
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});
afterEach(() => {
  act(() => render(null, host));
  host.remove();
  vi.restoreAllMocks();
});

test('prepares the selected shop and supplier from fresh server data, with no executable HTML', async () => {
  await mount();
  await ready();
  expect(api.getSupplierLedger).toHaveBeenCalledWith('shop', 'A', null, '2026-10-14');
  expect(host.textContent).toContain('Corner Store · Acme');
  expect(host.textContent).toContain('₹100.00');
  expect(host.querySelector('img')).toBeNull();
});
test('late old-supplier results never enable an export for the new selection', async () => {
  let resolve!: (v: unknown) => void;
  api.getSupplierLedger.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await mount();
  await mount({ ...props, partyId: 'B', supplierName: 'Beta' });
  await ready();
  await act(async () => {
    resolve(data('A'));
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(host.textContent).toContain('Corner Store · Beta');
  expect(host.textContent).not.toContain('Corner Store · Acme');
});
test('editing dates invalidates old exports immediately and ignores outstanding responses', async () => {
  let resolve!: (v: unknown) => void;
  api.getSupplierLedger.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await mount();
  await date('from', '2026-10-14');
  await act(async () => resolve(data()));
  expect(button('Download CSV').disabled).toBe(true);
  await act(async () => button('Prepare statement').click());
  await ready();
  expect(api.getSupplierLedger).toHaveBeenLastCalledWith('shop', 'A', '2026-10-14', '2026-10-14');
  await date('to', '2026-10-13');
  expect(button('Print A4 / PDF').disabled).toBe(true);
  await act(async () => button('Prepare statement').click());
  expect(host.textContent).toContain('From no later than Through');
});
test('a failed refresh or missing fresh shop profile cannot export an earlier statement', async () => {
  await mount();
  await ready();
  api.getShopSettings.mockRejectedValueOnce(new Error('Profile unavailable'));
  await act(async () => button('Prepare statement').click());
  await vi.waitFor(() => expect(host.textContent).toContain('Profile unavailable'));
  expect(button('Download CSV').disabled).toBe(true);
  expect(host.querySelector('[aria-label="Prepared supplier statement"]')).toBeNull();
});
test('clipboard rejection gives complete selectable text, while share cancellation is quiet', async () => {
  await mount();
  await ready();
  await act(async () => button('Copy text').click());
  expect(host.querySelector('textarea')?.value).toContain('Closing: ₹100.00');
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: vi.fn().mockRejectedValue({ name: 'AbortError' }),
  });
  await act(async () => button('Prepare statement').click());
  await ready();
  await act(async () => button('Share text').click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
test('prints the exact prepared statement through the existing A4 receipt layout and reports unavailable printing', async () => {
  const large = data();
  large.openingBalancePaise = '9007199254740993';
  large.closingBalancePaise = '9007199254750993';
  large.entries[0].runningBalancePaise = '9007199254750993';
  api.getSupplierLedger.mockResolvedValueOnce(large);
  await mount();
  await ready();
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  await act(async () => button('Print A4 / PDF').click());
  expect(print).toHaveBeenCalledOnce();
  const target = host.querySelector('[aria-label="Printable supplier statement"]')!;
  expect(target.textContent).toContain('Corner Store');
  expect(target.textContent).toContain('Acme');
  expect(target.textContent).toContain('Closing: ₹9,00,71,99,25,47,509.93');
  expect(target.innerHTML).toContain('&lt;img');
  expect(target.querySelector('img')).toBeNull();
  print.mockImplementation(() => {
    throw new Error('Unavailable');
  });
  await act(async () => button('Print A4 / PDF').click());
  expect(host.textContent).toContain('Printing is unavailable in this browser');
});
