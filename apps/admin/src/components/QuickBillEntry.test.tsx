// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { QuickBillEntry } from './QuickBillEntry';
import 'fake-indexeddb/auto';
import { draftDocuments, restorePurchaseDraft, scanPurchaseDrafts } from '../lib/purchaseDraft';
import { readLocalDocument } from '../lib/billDocumentStore';
import { BILL_DOCUMENT_PATH } from '@dsb-pro/adapters';

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

if (!Blob.prototype.arrayBuffer)
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as ArrayBuffer);
      r.onerror = () => rej(r.error);
      r.readAsArrayBuffer(this);
    });
  };
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
        tenantId="11111111-1111-4111-8111-111111111111"
        shopId="22222222-2222-4222-8222-222222222222"
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

test('N08: closing with a typed entry asks first; declining keeps it, confirming clears it', async () => {
  await mount();
  const details = host.querySelector('details')!;
  const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await set('Quick bill total', '12');
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(async () => {
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(ask).toHaveBeenCalledWith('Discard unsaved entry?');
  expect(details.open).toBe(true);
  expect((host.querySelector('[aria-label="Quick bill total"]') as HTMLInputElement).value).toBe(
    '12',
  );
  ask.mockReturnValue(true);
  await act(async () => {
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
  });
  expect((host.querySelector('[aria-label="Quick bill total"]') as HTMLInputElement).value).toBe(
    '',
  );
  const after = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
  ask.mockRestore();
});

async function addPdf(name = 'bill.pdf') {
  const input = field('Choose bill PDF (quick bill)') as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['%PDF-1.7 paper bill'], name, { type: 'application/pdf' })],
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await vi.waitFor(() => expect(host.textContent).toContain(name));
}

test('a photo is kept on the device and saved with the draft, bound to the draft bill id, not uploaded yet', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  await mount();
  await set('Quick bill supplier', 'p1', 'change');
  await set('Quick bill number', 'B-9');
  await set('Quick bill total', '50');
  await addPdf();
  expect(host.textContent).toContain('Kept on this device');
  expect(host.textContent).not.toContain('Retry document upload');
  await act(async () => save().click());
  const d = scanPurchaseDrafts(prefix).drafts[0]!.draft;
  const docs = draftDocuments(d);
  expect(docs).toHaveLength(1);
  expect(docs[0]).toMatchObject({ name: 'bill.pdf', uploaded: false, mime: 'application/pdf' });
  expect(BILL_DOCUMENT_PATH.exec(docs[0]!.path)?.[3]).toBe(d.clientId);
  expect(d.document?.id).toBe(docs[0]!.id);
  expect(d.cart).toEqual([]);
  // Bytes were durable before the draft existed, and the draft restores like any other.
  expect(await readLocalDocument(prefix, docs[0]!.id)).not.toBeNull();
  expect(restorePurchaseDraft(d, [], [{ id: 'p1', name: 'Acme' }] as never).documents).toHaveLength(
    1,
  );
  // The form is clear for the next quick bill (new bill id, no photo carried over).
  expect(host.textContent).not.toContain('bill.pdf');
});

test('a photo can be removed before saving; a draft with no photo has none', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await mount();
  await set('Quick bill supplier', 'p1', 'change');
  await set('Quick bill number', 'B-10');
  await set('Quick bill total', '5');
  await addPdf('gone.pdf');
  await act(async () =>
    (host.querySelector('[aria-label="Remove file 1 (quick bill)"]') as HTMLButtonElement).click(),
  );
  expect(host.textContent).not.toContain('gone.pdf');
  await act(async () => save().click());
  expect(draftDocuments(scanPurchaseDrafts(prefix).drafts[0]!.draft)).toEqual([]);
});

test('discarding the unsaved entry drops its pending photo bytes', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  await mount();
  const details = host.querySelector('details')!;
  await addPdf('pending.pdf');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(async () => {
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(host.textContent).not.toContain('pending.pdf');
  expect(scanPurchaseDrafts(prefix).drafts).toHaveLength(0);
});
