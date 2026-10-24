import { getMeta, setMeta, type DsbSyncDb } from './db';
import type { LocalSyncConflict, OutboxEntry } from './types';

// Offline edit / void of a POSTED purchase bill (owner/manager; mig 0072). The request carries the bill's
// version token read with the bill; the server applies it only if the bill is unchanged since (else
// DSB_BILL_CHANGED) and its normal rules hold. Same ordered outbox as sales and purchases; idempotent by
// the request id (a resend returns the stored answer). Never last-write-wins. A queued change never
// touches cached stock or balances: they change only after the server confirms.
// Decision: ONE queued change per bill. A second edit/void of a bill that already has a queued change is
// refused on the device (the user waits for the first to sync, or it is refused and redone). Bills that
// are themselves still queued offline have no server id and are never offered for edit/void.

export const BILL_CHANGE_OUTBOX_TARGET = 'purchase_bill_change';

export type OfflineBillChangeStatus = 'QUEUED' | 'SYNCED' | 'REJECTED';
export type OfflineBillChangeRecord = Readonly<{
  clientId: string;
  shopId: string;
  kind: 'edit' | 'void';
  billId: string;
  billLabel: string;
  baseVersion: string;
  /** edit: the exact edit request (bill payload + originalId); void: { purchaseId, reason }. */
  request: Readonly<Record<string, unknown>>;
  /** The form as saved (shown in full on a refusal so the edit can be redone). */
  form: unknown;
  status: OfflineBillChangeStatus;
  createdAt: number;
  syncedAt: number | null;
  /** edit: the corrected bill's id. */
  resultBillId: string | null;
  rejectionCode: string | null;
  rejectionReason: string | null;
  closedAt: number | null;
}>;
export type QueueOfflineBillChangeInput = Pick<
  OfflineBillChangeRecord,
  'clientId' | 'shopId' | 'kind' | 'billId' | 'billLabel' | 'baseVersion' | 'request' | 'form'
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9a-f]{32}$/;

export async function queueOfflineBillChange(
  db: DsbSyncDb,
  input: QueueOfflineBillChangeInput,
  now = Date.now(),
): Promise<OfflineBillChangeRecord> {
  if (!UUID.test(input.clientId) || !UUID.test(input.billId))
    throw new Error('Bill change ids must be lower-case UUIDs.');
  if (!VERSION.test(input.baseVersion))
    throw new Error('The bill version is missing. Open the bill again while online.');
  return db.transaction('rw', [db.outbox, db.meta, db.offlineBillChanges], async () => {
    const existing = await db.offlineBillChanges.get(input.clientId);
    if (existing) {
      if (existing.billId !== input.billId || existing.kind !== input.kind)
        throw new Error('Bill change identity mismatch.');
      return existing;
    }
    const open = (await db.offlineBillChanges.where('billId').equals(input.billId).toArray()).find(
      (r) => r.status === 'QUEUED',
    );
    if (open)
      throw new Error(
        `This bill already has ${open.kind === 'edit' ? 'an edit' : 'a void'} saved on this device that has not synced. Wait for it to sync, then change the bill again.`,
      );
    if (await db.outbox.where('clientId').equals(input.clientId).count())
      throw new Error('This request id is already queued for another operation.');
    const sequence = ((await getMeta<number>(db, 'outboxSeq')) ?? 0) + 1;
    await setMeta(db, 'outboxSeq', sequence);
    const record: OfflineBillChangeRecord = {
      ...input,
      status: 'QUEUED',
      createdAt: now,
      syncedAt: null,
      resultBillId: null,
      rejectionCode: null,
      rejectionReason: null,
      closedAt: null,
    };
    const entry: OutboxEntry = {
      sequence,
      clientId: input.clientId,
      kind: 'financial-rpc',
      target: BILL_CHANGE_OUTBOX_TARGET,
      payload: {
        kind: input.kind,
        billId: input.billId,
        baseVersion: input.baseVersion,
        request: input.request,
      },
      createdAt: now,
      attempts: 0,
      state: 'pending',
      nextAttemptAt: 0,
      lastError: null,
    };
    await db.offlineBillChanges.put(record);
    await db.outbox.put(entry);
    return record;
  });
}

export async function completeOfflineBillChange(
  db: DsbSyncDb,
  clientId: string,
  result: { resultBillId: string | null },
  now = Date.now(),
): Promise<OfflineBillChangeRecord> {
  return db.transaction('rw', [db.outbox, db.offlineBillChanges], async () => {
    const record = await db.offlineBillChanges.get(clientId);
    if (!record) throw new Error('Offline bill change record is missing.');
    if (record.status === 'REJECTED') throw new Error('A refused change cannot be confirmed.');
    const next: OfflineBillChangeRecord =
      record.status === 'SYNCED'
        ? record
        : { ...record, status: 'SYNCED', syncedAt: now, resultBillId: result.resultBillId };
    await db.offlineBillChanges.put(next);
    await db.outbox.where('clientId').equals(clientId).delete();
    return next;
  });
}

export async function rejectOfflineBillChange(
  db: DsbSyncDb,
  clientId: string,
  code: string,
  reason: string,
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', [db.outbox, db.offlineBillChanges, db.conflicts], async () => {
    const record = await db.offlineBillChanges.get(clientId);
    if (record?.status === 'SYNCED') throw new Error('A synced change cannot be rejected.');
    if (record)
      await db.offlineBillChanges.put({
        ...record,
        status: 'REJECTED',
        rejectionCode: code,
        rejectionReason: reason,
      });
    const outbox = await db.outbox.where('clientId').equals(clientId).first();
    if (outbox) await db.outbox.delete(outbox.sequence);
    const conflict: LocalSyncConflict = {
      createdAt: now,
      status: 'OPEN',
      kind: 'financial-rejection',
      target: BILL_CHANGE_OUTBOX_TARGET,
      clientId,
      reason,
      payload: outbox?.payload ?? record?.request ?? null,
      serverRef: null,
    };
    await db.conflicts.add(conflict);
  });
}

/** Only a refused change can be closed (after the user has redone or dropped it). */
export async function closeRejectedOfflineBillChange(
  db: DsbSyncDb,
  clientId: string,
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', [db.offlineBillChanges], async () => {
    const record = await db.offlineBillChanges.get(clientId);
    if (!record) throw new Error('Offline bill change record is missing.');
    if (record.status !== 'REJECTED') throw new Error('Only a refused change can be closed.');
    await db.offlineBillChanges.put({ ...record, closedAt: record.closedAt ?? now });
  });
}

export async function listOfflineBillChangeRecords(
  db: DsbSyncDb,
  shopId: string,
): Promise<OfflineBillChangeRecord[]> {
  const rows = await db.offlineBillChanges.where('shopId').equals(shopId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
