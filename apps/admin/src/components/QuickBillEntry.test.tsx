// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { QuickBillEntry } from './QuickBillEntry';
import { scanPurchaseDrafts } from '../lib/purchaseDraft';

const host = document.createElement('div');
const prefix = 'dsb-purchase-draft:u:s:';
const field = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
async function set(label: string, value: string, event = 'input') {
  await act(async () => {
    const el = field(label) as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}
const save = () =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save quick bill')!;

beforeEach(() => {
  localStorage.clear();
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});

async function mount(onSaved = vi.fn()) {
  await act(async () =>
    render(
      <QuickBillEntry
        parties={[{ id: 'p1', name: 'Acme' }] as never}
        today="2026-10-17"
        draftPrefix={prefix}
        disabled={false}
        onSaved={onSaved}
      />,
      host,
    ),
  );
  return onSaved;
}

test('saves an unposted line-free draft with the paper total', async () => {
  const onSaved = await mount();
  await set('Quick bill supplier', 'p1', 'change');
  await set('Quick bill number', 'B-1');
  await set('Quick bill total', '999.99');
  await act(async () => save().click());
  const drafts = scanPurchaseDrafts(prefix).drafts;
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.draft).toMatchObject({ cart: [], expectedTotalPaise: '99999', billNo: 'B-1' });
  expect(onSaved).toHaveBeenCalled();
  expect(host.textContent).toContain('Nothing is posted yet');
  // The same bill again is refused, so a double tap cannot create two drafts.
  await set('Quick bill number', 'B-1');
  await set('Quick bill total', '999.99');
  await act(async () => save().click());
  expect(scanPurchaseDrafts(prefix).drafts).toHaveLength(1);
  expect(host.textContent).toContain('already saved');
});

test('a bad entry saves nothing', async () => {
  await mount();
  await act(async () => save().click());
  expect(scanPurchaseDrafts(prefix).drafts).toHaveLength(0);
  expect(host.textContent).toContain('Choose a supplier.');
});
