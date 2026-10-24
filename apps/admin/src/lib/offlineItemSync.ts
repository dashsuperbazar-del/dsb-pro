import {
  completeOfflineItem,
  rejectOfflineItem,
  type DsbSyncDb,
  type OfflineItemRequest,
  type OutboxEntry,
} from '@dsb-pro/sync';
import type { CreateItemV2Input, CreateItemV2Result, WriteOutcome } from '@dsb-pro/adapters';

// One queued offline item create, sent by the sync engine before any bill queued after it.
// committed → SYNCED (queued bills re-pointed if the server matched an existing item); a definitive
// refusal → REJECTED and every queued bill using it is refused locally (visible); anything else throws so
// the outbox row is retried and the queue stays blocked behind it (the bills that use it never jump ahead).

export type ItemSyncDeps = {
  create: (input: CreateItemV2Input) => Promise<WriteOutcome<CreateItemV2Result>>;
  plain: (message: string) => string;
};

export async function syncQueuedItem(
  db: DsbSyncDb,
  sending: OutboxEntry,
  deps: ItemSyncDeps,
): Promise<{ kind: 'synced' } | { kind: 'rejected'; heldBills: string[]; reason: string }> {
  const record = await db.offlineItems.get(sending.clientId);
  if (!record) throw new Error('Queued item record is missing on this device.');
  if (record.status === 'SYNCED') {
    await db.outbox.where('clientId').equals(sending.clientId).delete();
    return { kind: 'synced' };
  }
  const request = sending.payload as OfflineItemRequest;
  if (request.clientId !== record.clientId || request.itemId !== record.itemId)
    throw new Error('Queued item request does not match its record.');
  const outcome = await deps.create(request);
  if (outcome.kind === 'unknown') throw new Error(outcome.message);
  if (outcome.kind === 'rejected') {
    const reason = deps.plain(outcome.message);
    const heldBills = await rejectOfflineItem(db, record.clientId, outcome.code, reason);
    return { kind: 'rejected', heldBills, reason };
  }
  await completeOfflineItem(db, record.clientId, {
    itemId: outcome.value.itemId,
    mapped: outcome.value.mapped,
  });
  return { kind: 'synced' };
}
