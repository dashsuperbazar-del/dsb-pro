import {
  completeOfflineSupplierPayment,
  rejectOfflineSupplierPayment,
  type DsbSyncDb,
  type OutboxEntry,
  type SupplierPaymentOutboxPayload,
} from '@dsb-pro/sync';
import type {
  PaySupplierIfUnchangedInput,
  PaySupplierResult,
  WriteOutcome,
} from '@dsb-pro/adapters';

// One queued offline supplier payment (mig 0074). committed → SYNCED; a definitive refusal (a bill or the
// supplier changed, already paid, over what is owed...) → REJECTED with the full form kept and NOTHING applied
// anywhere else; anything else throws so the outbox row is retried (the queue stays blocked behind it).

export type SupplierPaymentSyncDeps = {
  pay: (input: PaySupplierIfUnchangedInput) => Promise<WriteOutcome<PaySupplierResult>>;
  plain: (message: string) => string;
};

export async function syncQueuedSupplierPayment(
  db: DsbSyncDb,
  sending: OutboxEntry,
  deps: SupplierPaymentSyncDeps,
): Promise<{ kind: 'synced' } | { kind: 'rejected'; reason: string }> {
  const record = await db.offlineSupplierPayments.get(sending.clientId);
  if (!record) throw new Error('Queued supplier payment record is missing on this device.');
  if (record.status === 'SYNCED') {
    await db.outbox.where('clientId').equals(sending.clientId).delete();
    return { kind: 'synced' };
  }
  const p = sending.payload as SupplierPaymentOutboxPayload;
  if (
    p.request.partyId !== record.partyId ||
    p.request.shopId !== record.shopId ||
    p.request.amountPaise !== record.amountPaise
  )
    throw new Error('Queued supplier payment does not match its record.');
  // The frozen request is sent exactly as saved, under the record's own request id.
  const outcome = await deps.pay({
    requestId: record.clientId,
    shopId: p.request.shopId,
    partyId: p.request.partyId,
    businessDate: p.request.businessDate,
    amountPaise: p.request.amountPaise,
    mode: p.request.mode,
    reference: p.request.reference,
    allocations: p.request.allocations.map((a) => ({ ...a })),
    baseVersions: { supplier: p.baseVersions.supplier, bills: { ...p.baseVersions.bills } },
  });
  if (outcome.kind === 'unknown') throw new Error(outcome.message);
  if (outcome.kind === 'rejected') {
    const reason = deps.plain(outcome.message);
    await rejectOfflineSupplierPayment(db, record.clientId, outcome.code, reason);
    return { kind: 'rejected', reason };
  }
  await completeOfflineSupplierPayment(db, record.clientId, {
    paymentId: outcome.value.paymentId,
  });
  return { kind: 'synced' };
}
