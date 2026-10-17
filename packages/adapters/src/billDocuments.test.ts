import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ member: vi.fn(), upload: vi.fn(), download: vi.fn(), from: vi.fn() }));
vi.mock('./tenancy', () => ({ getCurrentMembership: mocks.member }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ storage: { from: mocks.from } }) }));
import { billDocumentHash, billDocumentPath, uploadBillDocument, readBillDocument, type BillDocument } from './billDocuments';
const tenant = 'a0000000-0000-0000-0000-000000000001', shop = 'a0000000-0000-0000-0000-000000000002';
const client = 'a0000000-0000-0000-0000-000000000003', id = 'a0000000-0000-0000-0000-000000000004';
function binary(text: string, mime = 'application/pdf'): Blob {
 const bytes = new TextEncoder().encode(text), blob = new Blob([bytes], { type: mime });
 Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.buffer });
 return blob;
}
const blob = binary('%PDF-1.7 test');
async function doc(): Promise<BillDocument> { return { id, path: billDocumentPath(tenant, shop, client, id, blob.type), name: 'bill.pdf', mime: 'application/pdf', size: blob.size, sha256: await billDocumentHash(blob), uploaded: false }; }
beforeEach(() => { vi.resetAllMocks(); mocks.member.mockResolvedValue({ tenantId: tenant, role: 'owner', shopIds: [shop] }); mocks.from.mockReturnValue({ upload: mocks.upload, download: mocks.download }); });
test('cashier, other shop and other tenant cannot request private bill bytes', async () => {
  const d = await doc();
  for (const m of [{ tenantId: tenant, role: 'cashier', shopIds: [shop] }, { tenantId: tenant, role: 'accountant', shopIds: [] }, { tenantId: 'other', role: 'owner', shopIds: [shop] }]) {
    mocks.member.mockResolvedValue(m); await expect(readBillDocument(d.path)).rejects.toThrow('restricted');
  }
  expect(mocks.from).not.toHaveBeenCalled();
});
test('uploads are immutable and a lost answer is confirmed only by matching bytes', async () => {
  const d = await doc(); mocks.upload.mockResolvedValue({ error: { message: 'answer lost' } }); mocks.download.mockResolvedValue({ data: blob, error: null });
  await expect(uploadBillDocument(d, blob)).resolves.toBeUndefined();
  expect(mocks.from).toHaveBeenCalledWith('bill-documents');
  expect(mocks.upload).toHaveBeenCalledWith(d.path, blob, { contentType: 'application/pdf', upsert: false });
  mocks.download.mockResolvedValue({ data: binary('x'.repeat(blob.size)), error: null });
  await expect(uploadBillDocument(d, blob)).rejects.toThrow('not confirmed');
});
test('mismatched local bytes and arbitrary paths are refused before uploading', async () => {
  const d = await doc(); await expect(uploadBillDocument({ ...d, sha256: '0'.repeat(64) }, blob)).rejects.toThrow('do not match');
  await expect(readBillDocument('https://example.com/public.pdf')).rejects.toThrow('Invalid');
  expect(mocks.upload).not.toHaveBeenCalled();
});
