import { getSupabaseClient } from './client';
import { getCurrentMembership } from './tenancy';

export type BillDocument = {
  id: string;
  path: string;
  name: string;
  mime: 'image/webp' | 'application/pdf';
  size: number;
  sha256: string;
  uploaded: boolean;
};
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const BILL_DOCUMENT_PATH = new RegExp(
  `^(${uuid})/(${uuid})/(${uuid})/(${uuid})\\.(webp|jpg|png|pdf)$`,
);
export function billDocumentPath(
  tenantId: string,
  shopId: string,
  clientId: string,
  id: string,
  mime: string,
) {
  const path = `${tenantId}/${shopId}/${clientId}/${id}.${mime === 'application/pdf' ? 'pdf' : 'webp'}`;
  if (!BILL_DOCUMENT_PATH.test(path)) throw new Error('Invalid bill document identity.');
  return path;
}
export async function billDocumentHash(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
async function authorize(path: string, write: boolean) {
  const parts = BILL_DOCUMENT_PATH.exec(path);
  if (!parts) throw new Error('Invalid bill document path.');
  const m = await getCurrentMembership();
  if (
    !m ||
    m.tenantId !== parts[1] ||
    !m.shopIds.includes(parts[2]) ||
    !(write ? ['owner', 'manager'] : ['owner', 'manager', 'accountant']).includes(m.role)
  )
    throw new Error('Bill documents are restricted to your permitted shop and role.');
}
export async function readBillDocument(path: string): Promise<Blob> {
  await authorize(path, false);
  const { data, error } = await getSupabaseClient().storage.from('bill-documents').download(path);
  if (error || !data) throw new Error('Bill document could not be opened. Retry when connected.');
  return data;
}
export async function uploadBillDocument(doc: BillDocument, blob: Blob): Promise<void> {
  await authorize(doc.path, true);
  if (
    !blob.size ||
    blob.size > 5 * 1024 * 1024 ||
    blob.size !== doc.size ||
    blob.type !== doc.mime ||
    (await billDocumentHash(blob)) !== doc.sha256
  )
    throw new Error('Saved bill document bytes do not match the upload.');
  const { error } = await getSupabaseClient()
    .storage.from('bill-documents')
    .upload(doc.path, blob, { contentType: doc.mime, upsert: false });
  if (!error) return;
  // A lost upload answer or immutable-path conflict can be confirmed only by identical bytes.
  // This never overwrites a file or creates a new posting identity.
  try {
    const stored = await readBillDocument(doc.path);
    if (stored.size === doc.size && (await billDocumentHash(stored)) === doc.sha256) return;
  } catch {
    /* preserve original failure */
  }
  throw new Error('Document upload is not confirmed. Keep this draft and retry the same upload.');
}
