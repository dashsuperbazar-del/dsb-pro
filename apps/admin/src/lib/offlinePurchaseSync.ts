import {
  completeOfflinePurchase,
  markOfflinePurchaseDocumentUploaded,
  rejectOfflinePurchase,
  type DsbSyncDb,
  type OfflinePurchaseDocument,
  type OutboxEntry,
} from '@dsb-pro/sync';
import type {
  PurchaseRequestLookup,
  PurchaseV2Request,
  PurchaseV2Result,
  WriteOutcome,
} from '@dsb-pro/adapters';

// One queued offline purchase, sent by the sync engine (docs/OFFLINE_PURCHASES_PLAN.md).
// Order: photos not yet confirmed are uploaded (immutable path, identical bytes are idempotent), then the
// frozen request goes to post_purchase_v2. committed → SYNCED; a definitive refusal → REJECTED (visible,
// form kept); anything else throws so the caller marks the outbox row for retry — the queue stays
// blocked behind it, exactly like an offline sale with an unknown outcome.

export type PurchaseSyncDeps = {
  post: (request: PurchaseV2Request, isRetry: boolean) => Promise<WriteOutcome<PurchaseV2Result>>;
  lookup: (shopId: string, clientId: string) => Promise<PurchaseRequestLookup>;
  upload: (doc: OfflinePurchaseDocument, blob: Blob) => Promise<void>;
  readLocal: (scope: string, id: string) => Promise<Blob | null>;
  removeLocal: (scope: string, id: string) => Promise<void>;
};

export const PHOTO_MISSING =
  'A bill photo saved with this bill is no longer on this device, so the bill was not posted. Correct this bill: attach the photo again or remove it.';

export async function syncQueuedPurchase(
  db: DsbSyncDb,
  sending: OutboxEntry,
  deps: PurchaseSyncDeps,
): Promise<'synced' | 'rejected'> {
  const record = await db.offlinePurchases.get(sending.clientId);
  if (!record) throw new Error('Queued purchase record is missing on this device.');
  if (record.status === 'SYNCED') {
    await db.outbox.where('clientId').equals(sending.clientId).delete();
    return 'synced';
  }
  const request = sending.payload as PurchaseV2Request;
  if (request.clientId !== record.clientId || request.shopId !== record.shopId)
    throw new Error('Queued purchase request does not match its record.');
  // A retry may follow a committed first send: the server's stored answer decides any refusal.
  // Always treated as a possible retry: a send interrupted by a crash or restart leaves attempts at 1 with the
  // outcome unknown, so any refusal is checked against the server's stored answer before it is believed.
  const isRetry = true;
  let alreadyPosted = false;
  for (const doc of record.documents) {
    if (doc.uploaded || alreadyPosted) continue;
    const blob = await deps.readLocal(record.documentScope, doc.id);
    if (!blob) {
      const found = await deps.lookup(record.shopId, record.clientId);
      if (found.kind === 'unavailable')
        throw new Error(
          `Bill photo missing; the earlier attempt cannot be verified: ${found.message}`,
        );
      if (found.kind === 'not_found') {
        await rejectOfflinePurchase(
          db,
          record.clientId,
          'DSB_BILL_DOCUMENT_MISSING',
          PHOTO_MISSING,
        );
        return 'rejected';
      }
      // Posted by an earlier attempt: the same request replays the stored answer below.
      alreadyPosted = true;
      continue;
    }
    await deps.upload(doc, blob);
    await markOfflinePurchaseDocumentUploaded(db, record.clientId, doc.id);
  }
  const outcome = await deps.post(request, isRetry);
  if (outcome.kind === 'unknown') throw new Error(outcome.message);
  if (outcome.kind === 'rejected') {
    await rejectOfflinePurchase(db, record.clientId, outcome.code, outcome.message);
    return 'rejected';
  }
  await completeOfflinePurchase(db, record.clientId, {
    billId: outcome.value.billId,
    paymentId: outcome.value.paymentId,
    totalPaise: outcome.value.totalPaise,
  });
  // The bytes are on the server now; the device copy is no longer needed.
  for (const doc of record.documents)
    await deps.removeLocal(record.documentScope, doc.id).catch(() => undefined);
  return 'synced';
}
