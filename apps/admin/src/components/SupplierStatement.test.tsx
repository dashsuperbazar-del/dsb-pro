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
test('printing opens only the escaped prepared statement and handles popup denial', async () => {
  await mount();
  await ready();
  let onLoad: (() => void) | undefined;
  // Writing a completed blank document implicitly opens it and removes Window listeners.
  const write = vi.fn<(html: string) => void>(() => {
    onLoad = undefined;
  });
  const print = vi.fn();
  const popup = {
    opener: window,
    document: { write, close: vi.fn(), styleSheets: [{}] },
    addEventListener: vi.fn((_type: string, callback: () => void) => {
      onLoad = callback;
    }),
    focus: vi.fn(),
    print,
  };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  await act(async () => button('Print A4 / PDF').click());
  expect(popup.opener).toBeNull();
  expect(write.mock.calls[0][0]).toContain('&lt;img');
  expect(write.mock.calls[0][0]).not.toContain('<img');
  expect(print).not.toHaveBeenCalled();
  onLoad?.();
  expect(print).toHaveBeenCalledOnce();
  popup.document.styleSheets = [];
  await act(async () => button('Print A4 / PDF').click());
  await act(async () => onLoad?.());
  expect(host.textContent).toContain('Print styles could not be loaded');
  expect(print).toHaveBeenCalledOnce();
  vi.mocked(window.open).mockReturnValue(null);
  await act(async () => button('Print A4 / PDF').click());
  expect(host.textContent).toContain('Print window blocked');
});
