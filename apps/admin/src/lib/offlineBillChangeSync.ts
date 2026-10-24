import {
  completeOfflineBillChange,
  rejectOfflineBillChange,
  type DsbSyncDb,
  type OutboxEntry,
} from '@dsb-pro/sync';
import type { PurchaseEditRequest, PurchaseEditResult, WriteOutcome } from '@dsb-pro/adapters';

// One queued offline bill edit or void (mig 0072). committed → SYNCED; a definitive refusal (stale version,
// payment assigned, edit rules) → REJECTED with the full form kept; anything else throws so the outbox row
// is retried (the queue stays blocked behind it).

export type BillChangeSyncDeps = {
  edit: (
    request: PurchaseEditRequest,
    baseVersion: string,
  ) => Promise<WriteOutcome<PurchaseEditResult>>;
  void: (input: {
    shopId: string;
    purchaseId: string;
    clientId: string;
    reason: string;
    baseVersion: string;
  }) => Promise<WriteOutcome<{ billId: string }>>;
  plainEdit: (message: string) => string;
  plainVoid: (message: string) => string;
};

type Payload = {
  kind: 'edit' | 'void';
  billId: string;
  baseVersion: string;
  request: Record<string, unknown>;
};

export async function syncQueuedBillChange(
  db: DsbSyncDb,
  sending: OutboxEntry,
  deps: BillChangeSyncDeps,
): Promise<{ kind: 'synced' } | { kind: 'rejected'; reason: string }> {
  const record = await db.offlineBillChanges.get(sending.clientId);
  if (!record) throw new Error('Queued bill change record is missing on this device.');
  if (record.status === 'SYNCED') {
    await db.outbox.where('clientId').equals(sending.clientId).delete();
    return { kind: 'synced' };
  }
  const p = sending.payload as Payload;
  if (p.billId !== record.billId || p.kind !== record.kind || p.baseVersion !== record.baseVersion)
    throw new Error('Queued bill change does not match its record.');
  if (p.kind === 'edit') {
    const request = p.request as unknown as PurchaseEditRequest;
    if (request.clientId !== record.clientId || request.originalId !== record.billId)
      throw new Error('Queued bill edit does not match its record.');
    const outcome = await deps.edit(request, p.baseVersion);
    if (outcome.kind === 'unknown') throw new Error(outcome.message);
    if (outcome.kind === 'rejected') {
      const reason = deps.plainEdit(outcome.message);
      await rejectOfflineBillChange(db, record.clientId, outcome.code, reason);
      return { kind: 'rejected', reason };
    }
    await completeOfflineBillChange(db, record.clientId, { resultBillId: outcome.value.billId });
    return { kind: 'synced' };
  }
  const outcome = await deps.void({
    shopId: record.shopId,
    purchaseId: record.billId,
    clientId: record.clientId,
    reason: String(p.request.reason ?? ''),
    baseVersion: p.baseVersion,
  });
  if (outcome.kind === 'unknown') throw new Error(outcome.message);
  if (outcome.kind === 'rejected') {
    const reason = deps.plainVoid(outcome.message);
    await rejectOfflineBillChange(db, record.clientId, outcome.code, reason);
    return { kind: 'rejected', reason };
  }
  await completeOfflineBillChange(db, record.clientId, { resultBillId: null });
  return { kind: 'synced' };
}
