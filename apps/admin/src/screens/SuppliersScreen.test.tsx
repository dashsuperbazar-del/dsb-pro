// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SuppliersScreen } from './SuppliersScreen';

const api = vi.hoisted(() => ({
  getCurrentMembership: vi.fn().mockResolvedValue({ role: 'owner', shopIds: ['shop'] }),
  getSupplierOutstanding: vi.fn().mockResolvedValue([]),
  getShopBusinessDate: vi.fn().mockResolvedValue('2026-10-14'),
  listParties: vi.fn().mockResolvedValue([{ id: 'supplier', name: 'Acme' }]),
  listSupplierBills: vi.fn().mockResolvedValue([
    {
      purchase_bill_id: 'bill',
      bill_no: 'ACME-1',
      business_date: '2026-10-14',
      total_paise: '800000',
      returned_paise: '0',
      allocated_paise: '0',
      outstanding_paise: '800000',
    },
  ]),
  listSupplierPayments: vi.fn().mockResolvedValue([]),
}));
vi.mock('@dsb-pro/adapters', () => api);
vi.mock('../lib/offlineSync', () => ({
  waitForOfflineRuntime: vi.fn().mockResolvedValue(undefined),
  listOpenFinancialAttempts: vi.fn().mockResolvedValue([]),
  listFinancialDrafts: vi.fn().mockResolvedValue([]),
}));
const host = document.createElement('div');
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const paid = () =>
  [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('Amount paid'))!
    .querySelector('input')!;
async function mount(linked = false) {
  await act(async () =>
    render(
      <SuppliersScreen
        url={`/suppliers?supplier=supplier&view=payment${linked ? '&bill=bill' : ''}`}
      />,
      host,
    ),
  );
  await vi.waitFor(() => expect(button('Full')).toBeDefined());
}
async function amount(value: string) {
  await act(async () => {
    paid().value = value;
    paid().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
afterEach(() => act(() => render(null, host)));

test('Full preserves the entered cash and the advance remainder in the actual payment review', async () => {
  await mount();
  await amount('10000');
  await act(async () => button('Full').click());
  expect(paid().value).toBe('10000');
  expect(host.querySelector<HTMLInputElement>('[aria-label="Allocate to ACME-1"]')!.value).toBe(
    '8000.00',
  );
  await act(async () => {
    host
      .querySelector('form:not(.party-editor)')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(host.querySelector('[aria-label="Confirm payment"]')!.textContent).toContain(
    'remaining advance ₹2,000.00',
  );
});
test('Full never infers cash paid, even with a blank or smaller payment amount', async () => {
  await mount();
  await act(async () => button('Full').click());
  expect(paid().value).toBe('');
  await amount('5000');
  await act(async () => button('Full').click());
  expect(paid().value).toBe('5000');
  await act(async () => {
    host
      .querySelector('form:not(.party-editor)')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => button('Confirm and record').click());
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(
      'Bill allocations exceed the payment amount.',
    ),
  );
});
test('a linked bill selects its allocation but requires an explicit amount paid', async () => {
  await mount(true);
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLInputElement>('[aria-label="Allocate to ACME-1"]')!.value).toBe(
      '8000.00',
    ),
  );
  expect(paid().value).toBe('');
});
