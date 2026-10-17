// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
vi.mock('@dsb-pro/adapters', () => ({ listSupplierBills: vi.fn(), getShopBusinessDate: vi.fn() }));
vi.mock('../lib/offlineSync', () => ({
  listOpenFinancialAttempts: vi.fn(),
  listFinancialDrafts: vi.fn(),
  newFinancialDraft: vi.fn(),
  sendFinancialAttempt: vi.fn(),
}));
import { BulkSupplierPayments } from './BulkSupplierPayments';
import type { BulkDeps } from '../lib/bulkSupplierPayment';

const host = document.createElement('div');
beforeEach(() => document.body.append(host));
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});
const sup = (id: string, net: string) => ({
  partyId: id,
  partyName: id,
  grossOpenBills: net,
  unallocatedCashAdvances: '0',
  returnCredits: '0',
  netLedgerBalance: net,
  strandedAllocationsOnVoidBills: 0,
});
const btn = (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === t);
async function type(label: string, v: string) {
  await act(async () => {
    const el = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('review then record: each supplier recorded once, amounts cleared, owed-only list', async () => {
  const send = vi.fn(async (id: string) => ({ id, state: 'COMMITTED' }) as never);
  const deps: BulkDeps = {
    lock: (_s, _p, fn) => fn(),
    listOpen: async () => [],
    listDrafts: async () => [],
    businessDate: async () => '2026-10-17',
    listBills: async () => [],
    newDraft: async (i) => ({ id: i.accountId }) as never,
    send,
  };
  const onDone = vi.fn();
  await act(async () =>
    render(
      <BulkSupplierPayments
        shopId="s"
        businessDate="2026-10-17"
        suppliers={[sup('Acme', '50000'), sup('Paid', '0')]}
        onDone={onDone}
        deps={deps}
      />,
      host,
    ),
  );
  expect(host.querySelector('[aria-label="Amount paid to Paid"]')).toBeNull();
  await act(async () => btn('Review')!.click());
  expect(host.textContent).toContain('Enter an amount for at least one supplier.');
  await type('Amount paid to Acme', '100');
  await act(async () => btn('Review')!.click());
  expect(host.textContent).toContain('Record 1 payment totalling ₹100.00 by cash?');
  await act(async () => btn('Record payments')!.click());
  await vi.waitFor(() => expect(host.textContent).toContain('Acme: recorded ₹100.00'));
  expect(send).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('[aria-label="Amount paid to Acme"]')!.value).toBe(
    '',
  );
  expect(btn('Record payments')).toBeUndefined();
});

test('review lists each amount and warns when it is more than owed; a lost answer clears that row', async () => {
  const deps: BulkDeps = {
    lock: (_s, _p, fn) => fn(),
    listOpen: async () => [],
    listDrafts: async () => [],
    businessDate: async () => '2026-10-17',
    listBills: async () => [],
    newDraft: async (i) => ({ id: i.accountId }) as never,
    send: async (id) => ({ id, state: 'UNKNOWN' }) as never,
  };
  await act(async () =>
    render(
      <BulkSupplierPayments
        shopId="s"
        businessDate="2026-10-17"
        suppliers={[sup('Acme', '10000')]}
        onDone={() => {}}
        deps={deps}
      />,
      host,
    ),
  );
  await type('Amount paid to Acme', '500');
  await act(async () => btn('Review')!.click());
  expect(host.textContent).toContain('₹400.00 more than owed, kept as advance');
  await act(async () => btn('Record payments')!.click());
  await vi.waitFor(() => expect(host.textContent).toContain('answer was lost'));
  expect(host.querySelector<HTMLInputElement>('[aria-label="Amount paid to Acme"]')!.value).toBe(
    '',
  );
});
