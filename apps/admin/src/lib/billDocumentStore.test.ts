// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import {
  documentBytes,
  saveLocalDocument,
  readLocalDocument,
  removeLocalDocument,
} from './billDocumentStore';
import { prepareBillDocument } from './prepareBillDocument';
function binary(text: string, mime = 'application/pdf'): Blob {
  const bytes = new TextEncoder().encode(text),
    blob = new Blob([bytes], { type: mime });
  Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.buffer });
  return blob;
}
afterEach(() => {
  vi.unstubAllGlobals();
});
test('binary document survives reopening, stays user/shop scoped, and cannot overwrite an existing ID', async () => {
  const file = binary('%PDF-1.7 ORIGINAL');
  await saveLocalDocument('user-a:shop-a:', 'photo-a', file);
  const restored = await readLocalDocument('user-a:shop-a:', 'photo-a');
  expect(new Uint8Array(await documentBytes(restored!))).toEqual(
    new Uint8Array(await file.arrayBuffer()),
  );
  expect(await readLocalDocument('user-b:shop-a:', 'photo-a')).toBeNull();
  expect(await readLocalDocument('user-a:shop-b:', 'photo-a')).toBeNull();
  await expect(saveLocalDocument('user-a:shop-a:', 'photo-a', binary('REPLACED'))).rejects.toThrow(
    'could not keep',
  );
  expect((await readLocalDocument('user-a:shop-a:', 'photo-a'))!.size).toBe(file.size);
  await removeLocalDocument('user-a:shop-a:', 'photo-a');
});
test('unavailable local storage never reports a saved document', async () => {
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('blocked');
    },
  });
  await expect(saveLocalDocument('scope:', 'id', binary('bytes'))).rejects.toThrow('blocked');
});
test('PDF bytes remain exact; spoofed types, empty and oversized documents are refused', async () => {
  const file = new File(['%PDF-1.7 original'], 'bill.pdf', { type: 'application/pdf' });
  const prepared = await prepareBillDocument(file);
  expect(new Uint8Array(await documentBytes(prepared))).toEqual(
    new Uint8Array(await documentBytes(file)),
  );
  await expect(
    prepareBillDocument(new File(['html script'], 'wrong.pdf', { type: 'application/pdf' })),
  ).rejects.toThrow('valid PDF');
  await expect(
    prepareBillDocument(new File([], 'empty.pdf', { type: 'application/pdf' })),
  ).rejects.toThrow('non-empty');
  await expect(
    prepareBillDocument(
      new File(['%PDF-', new Uint8Array(5 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' }),
    ),
  ).rejects.toThrow('valid PDF');
  await expect(
    prepareBillDocument(new File(['<svg>'], 'script.svg', { type: 'image/svg+xml' })),
  ).rejects.toThrow('JPEG');
});
