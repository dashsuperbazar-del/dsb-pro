// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SupplierSchedulePanel } from './SupplierSchedulePanel';

const api = vi.hoisted(() => ({
  listSupplierSchedules: vi.fn(),
  saveSupplierSchedule: vi.fn(),
  removeSupplierSchedule: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const input = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.includes(label))!
    .querySelector('input')!;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
beforeEach(() => {
  document.body.append(host);
  api.listSupplierSchedules.mockReset().mockResolvedValue([]);
  api.saveSupplierSchedule.mockReset().mockResolvedValue('id');
  api.removeSupplierSchedule.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});
async function mount() {
  await act(async () =>
    render(<SupplierSchedulePanel shopId="shop" partyId="p" partyName="Acme" />, host),
  );
  await vi.waitFor(() => expect(host.textContent).toContain('Due day of month'));
}

test('saves a day and an exact amount as paise text, and says no money was recorded', async () => {
  await mount();
  await type(input('Due day'), '5');
  await type(input('Expected amount'), '2500.50');
  await act(async () => button('Save schedule').click());
  await vi.waitFor(() => expect(host.textContent).toContain('No money was recorded'));
  expect(api.saveSupplierSchedule).toHaveBeenCalledWith(
    expect.objectContaining({
      shopId: 'shop',
      partyId: 'p',
      dueDay: 5,
      expectedAmountPaise: '250050',
      active: true,
    }),
  );
});

test('refuses a bad day without calling the server', async () => {
  await mount();
  await type(input('Due day'), '31');
  await act(async () => button('Save schedule').click());
  expect(host.textContent).toContain('Due day must be a whole number from 1 to 28.');
  expect(api.saveSupplierSchedule).not.toHaveBeenCalled();
});

test('shows the current schedule and removes it', async () => {
  api.listSupplierSchedules.mockResolvedValue([
    { id: 's1', partyId: 'p', dueDay: 7, expectedAmountPaise: '100000', note: null, active: false },
  ]);
  await mount();
  expect(host.textContent).toContain('day 7 of each month, about ₹1,000.00 (paused)');
  await act(async () => button('Remove schedule').click());
  expect(api.removeSupplierSchedule).toHaveBeenCalledWith('s1');
});

test('a failed load shows the error and no form', async () => {
  api.listSupplierSchedules.mockRejectedValue(new Error('offline'));
  await act(async () =>
    render(<SupplierSchedulePanel shopId="shop" partyId="p" partyName="Acme" />, host),
  );
  await vi.waitFor(() => expect(host.textContent).toContain('offline'));
  expect(host.textContent).not.toContain('Due day of month');
});
