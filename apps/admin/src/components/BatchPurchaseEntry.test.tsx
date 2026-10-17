// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { Item, Party } from '@dsb-pro/adapters';
import { BatchPurchaseEntry } from './BatchPurchaseEntry';
import { purchaseDraftPrefix, scanPurchaseDrafts } from '../lib/purchaseDraft';

const host = document.createElement('div');
const prefix = purchaseDraftPrefix('u', 's');
const items = [
  {
    id: 'i1',
    name: 'Oil',
    sku: null,
    unit1: 'case',
    unit2: 'jar',
    unit3: null,
    conv1: 6,
    conv2: null,
  },
  {
    id: 'i2',
    name: 'Rice',
    sku: null,
    unit1: 'bag',
    unit2: null,
    unit3: null,
    conv1: null,
    conv2: null,
  },
] as Item[];
const parties = [{ id: 's1', name: 'Acme' }] as Party[];
const onSaved = vi.fn();
async function mount(disabled = false) {
  await act(async () =>
    render(
      <BatchPurchaseEntry
        items={items}
        parties={parties}
        today="2026-10-17"
        draftPrefix={prefix}
        disabled={disabled}
        onSaved={onSaved}
      />,
      host,
    ),
  );
}
async function set(label: string, value: string) {
  await act(async () => {
    const el = host.querySelector(`[aria-label="${label}"]`) as
      HTMLInputElement | HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
const button = (text: RegExp) =>
  [...host.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''))!;
beforeEach(() => {
  document.body.append(host);
  onSaved.mockReset();
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => render(null, host));
  host.remove();
});
async function fillOne(n = 1, bill = 'B-1') {
  await set(`Batch supplier ${n}`, 's1');
  await set(`Batch bill number ${n}`, bill);
  await set(`Batch item ${n}`, 'i1');
  await set(`Batch quantity ${n}`, '4');
  await set(`Batch cost ${n}`, '25');
}

test('valid rows are saved as separate drafts and the grid is cleared for the next batch', async () => {
  await mount();
  await fillOne();
  await act(async () => button(/Add another bill/).click());
  await fillOne(2, 'B-2');
  await act(async () => button(/Save 2 drafts/).click());
  const { drafts } = scanPurchaseDrafts(prefix);
  expect(drafts).toHaveLength(2);
  expect(new Set(drafts.map((d) => d.draft.clientId)).size).toBe(2);
  expect(drafts.map((d) => d.draft.billNo).sort()).toEqual(['B-1', 'B-2']);
  expect(host.textContent).toContain('Saved 2 drafts. Nothing is posted yet');
  expect(onSaved).toHaveBeenCalledOnce();
  expect(host.querySelectorAll('fieldset')).toHaveLength(1);
});

test('one bad row saves nothing, names the row, and keeps what was typed', async () => {
  await mount();
  await fillOne();
  await act(async () => button(/Add another bill/).click());
  await fillOne(2, 'B-2');
  await set('Batch quantity 2', '0');
  await act(async () => button(/Save 2 drafts/).click());
  expect(scanPurchaseDrafts(prefix).drafts).toHaveLength(0);
  expect(host.textContent).toContain('Bill 2:');
  expect((host.querySelector('[aria-label="Batch bill number 1"]') as HTMLInputElement).value).toBe(
    'B-1',
  );
  expect(onSaved).not.toHaveBeenCalled();
});

test('a storage failure part-way keeps only the unsaved rows so a retry cannot duplicate', async () => {
  await mount();
  await fillOne();
  await act(async () => button(/Add another bill/).click());
  await fillOne(2, 'B-2');
  const real = Storage.prototype.setItem;
  let calls = 0;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    k: string,
    v: string,
  ) {
    if (++calls === 2) throw new Error('quota');
    return real.call(this, k, v);
  });
  await act(async () => button(/Save 2 drafts/).click());
  vi.restoreAllMocks();
  expect(scanPurchaseDrafts(prefix).drafts).toHaveLength(1);
  expect(host.textContent).toContain('Saved 1 of 2 drafts');
  expect(host.querySelectorAll('fieldset')).toHaveLength(1);
  expect((host.querySelector('[aria-label="Batch bill number 1"]') as HTMLInputElement).value).toBe(
    'B-2',
  );
});

test('saving is disabled while the purchase screen cannot accept drafts', async () => {
  await mount(true);
  expect((button(/Save 1 draft/) as HTMLButtonElement).disabled).toBe(true);
});
