// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DuplicateBillsCheck, PartyMergePanel } from './PartyMergePanel';

const api = vi.hoisted(() => ({
  mergeParties: vi.fn(),
  listSupplierDuplicateBills: vi.fn(),
}));
vi.mock('@dsb-pro/adapters', () => api);
const host = document.createElement('div');
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const pick = async (value: string) =>
  act(async () => {
    const s = host.querySelector('select')!;
    s.value = value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
const click = async (text: string) => act(async () => button(text)!.click());
beforeEach(() => {
  document.body.append(host);
  api.mergeParties.mockReset().mockResolvedValue('m1');
  api.listSupplierDuplicateBills.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});
const others = [
  { id: 'k', name: 'Ramesh Trader' },
  { id: 'z', name: 'Zed' },
];
async function mount(onMerged = vi.fn(), blockedReason: string | null = null) {
  await act(async () =>
    render(
      <PartyMergePanel
        party={{ id: 'd', name: 'Ramesh Traders' }}
        others={others}
        blockedReason={blockedReason}
        onMerged={onMerged}
      />,
      host,
    ),
  );
  return onMerged;
}

test('merges only after an explicit confirmation, then hands over the kept supplier', async () => {
  const onMerged = await mount();
  await pick('k');
  await click('Merge Ramesh Traders into Ramesh Trader');
  expect(api.mergeParties).not.toHaveBeenCalled();
  expect(host.textContent).toContain('archive');
  await click('Yes, merge');
  expect(api.mergeParties).toHaveBeenCalledTimes(1);
  const call = api.mergeParties.mock.calls[0]![0];
  expect(call).toMatchObject({ sourcePartyId: 'd', targetPartyId: 'k' });
  expect(call.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(onMerged).toHaveBeenCalledWith('k', 'Ramesh Trader');
});

test('a failed attempt keeps its request id, so trying again is the same merge', async () => {
  api.mergeParties.mockRejectedValueOnce(new Error('Network down'));
  await mount();
  await pick('k');
  await click('Merge Ramesh Traders into Ramesh Trader');
  await click('Yes, merge');
  expect(host.textContent).toContain('Network down');
  await click('Yes, merge');
  const [first, second] = api.mergeParties.mock.calls.map((c) => c[0].requestId);
  expect(second).toBe(first);
});

test('changing the kept supplier starts a new request', async () => {
  api.mergeParties.mockRejectedValueOnce(new Error('Network down'));
  await mount();
  await pick('k');
  await click('Merge Ramesh Traders into Ramesh Trader');
  await click('Yes, merge');
  await pick('z');
  await click('Merge Ramesh Traders into Zed');
  await click('Yes, merge');
  const [first, second] = api.mergeParties.mock.calls.map((c) => c[0].requestId);
  expect(second).not.toBe(first);
});

test('a pending payment blocks the merge', async () => {
  await mount(vi.fn(), 'A payment is waiting. Send or discard it first.');
  expect(host.querySelector('select')).toBeNull();
  expect(host.textContent).toContain('Send or discard it first');
});

test('the self-check lists identical bills and removes nothing', async () => {
  api.listSupplierDuplicateBills.mockResolvedValue([
    { billNo: 'rt-1', businessDate: '2026-09-10', totalPaise: '10000', billIds: ['a', 'b'] },
  ]);
  await act(async () =>
    render(<DuplicateBillsCheck shopId="s" partyId="k" partyName="Ramesh Trader" />, host),
  );
  await vi.waitFor(() => expect(host.textContent).toContain('Possible duplicate bills'));
  expect(host.textContent).toContain('Bill rt-1');
  expect(host.textContent).toContain('2 bills');
  expect(host.textContent).toContain('Nothing was removed automatically');
});

test('the self-check says so when nothing is identical', async () => {
  await act(async () =>
    render(<DuplicateBillsCheck shopId="s" partyId="k" partyName="Ramesh Trader" />, host),
  );
  await vi.waitFor(() => expect(host.textContent).toContain('No identical bills'));
});
