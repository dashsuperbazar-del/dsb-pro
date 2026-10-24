import { getMeta, setMeta, type DsbSyncDb } from './db';
import type { LocalSyncConflict, OutboxEntry } from './types';

// Offline purchases (plan: docs/OFFLINE_PURCHASES_PLAN.md). A purchase bill saved while offline is kept
// as one record plus one outbox row in the same transaction, in the same ordered queue as offline sales.
// The outbox payload is the exact frozen post_purchase_v2 request; the server replays a same-id request
// with its stored answer, so resending is safe. A queued bill never changes cached stock: an unsynced
// bill may still be refused, and offline sales must not count stock from it.

export const PURCHASE_OUTBOX_TARGET = 'post_purchase_v2';

export type OfflinePurchaseDocument = Readonly<{
  id: string;
  path: string;
  name: string;
  mime: 'image/webp' | 'application/pdf';
  size: number;
  sha256: string;
  uploaded: boolean;
}>;
export type OfflinePurchaseLineSummary = Readonly<{
  itemId: string;
  itemName: string;
  qty: string;
  unitName: string;
}>;
export type OfflinePurchaseStatus = 'QUEUED' | 'SYNCED' | 'REJECTED';
export type OfflinePurchaseRecord = Readonly<{
  clientId: string;
  shopId: string;
  /** The exact request sent to post_purchase_v2 (shopId, clientId, lines, charges, images …). */
  request: Readonly<Record<string, unknown> & { shopId: string; clientId: string }>;
  /** The form as it was when saved, so a refused bill can be corrected as a normal draft. */
  draft: unknown;
  /** Device store scope of the photo bytes (bytes are removed only after the bill is SYNCED). */
  documentScope: string;
  documents: ReadonlyArray<OfflinePurchaseDocument>;
  supplierName: string | null;
  billNo: string | null;
  businessDate: string;
  paymentType: 'credit' | 'cash' | 'upi';
  totalPaise: number;
  lines: ReadonlyArray<OfflinePurchaseLineSummary>;
  status: OfflinePurchaseStatus;
  createdAt: number;
  syncedAt: number | null;
  billId: string | null;
  paymentId: string | null;
  rejectionCode: string | null;
  rejectionReason: string | null;
  /** Set when the server's total differs from the one saved on this device (the server figure is kept). */
  reconciliationWarning?: string | null;
  /** Set when the user turned a refused bill into a draft or dismissed it. */
  closedAt: number | null;
}>;
export type QueueOfflinePurchaseInput = Omit<
  OfflinePurchaseRecord,
  | 'status'
  | 'createdAt'
  | 'syncedAt'
  | 'billId'
  | 'paymentId'
  | 'rejectionCode'
  | 'rejectionReason'
  | 'closedAt'
>;

function assertIdentity(input: QueueOfflinePurchaseInput) {
  if (!input.clientId || input.request.clientId !== input.clientId)
    throw new Error('Offline purchase identity mismatch.');
  if (!input.shopId || input.request.shopId !== input.shopId)
    throw new Error('Offline purchase shop mismatch.');
  if (!Number.isSafeInteger(input.totalPaise) || input.totalPaise < 0)
    throw new Error('Offline purchase total must be whole non-negative paise.');
  if (!input.lines.length) throw new Error('Add at least one item.');
  for (const d of input.documents)
    if (!d.path.includes(`/${input.clientId}/`))
      throw new Error('A bill photo belongs to another bill. Remove it and attach it again.');
}

async function resolveOfflineItems(
  db: DsbSyncDb,
  input: QueueOfflinePurchaseInput,
): Promise<QueueOfflinePurchaseInput> {
  const lines = Array.isArray(input.request.lines)
    ? (input.request.lines as Array<{ itemId?: unknown }>)
    : [];
  const ids = [
    ...new Set(lines.map((l) => l.itemId).filter((v): v is string => typeof v === 'string')),
  ];
  if (!ids.length) return input;
  const map = new Map<string, string>();
  for (const r of await db.offlineItems.where('itemId').anyOf(ids).toArray()) {
    if (r.status === 'REJECTED')
      throw new Error(
        `The new item "${r.fields.name}" was refused (${r.rejectionReason ?? 'refused'}). Pick an existing item instead.`,
      );
    if (r.status === 'SYNCED' && r.serverItemId && r.serverItemId !== r.itemId)
      map.set(r.itemId, r.serverItemId);
  }
  if (!map.size) return input;
  const swap = <T extends { itemId?: unknown }>(l: T): T =>
    typeof l.itemId === 'string' && map.has(l.itemId) ? { ...l, itemId: map.get(l.itemId) } : l;
  return {
    ...input,
    request: { ...input.request, lines: lines.map(swap) },
    lines: input.lines.map(swap),
  };
}

/** Saves the bill and its outbox row atomically. The same client id returns the record already saved. */
export async function queueOfflinePurchase(
  db: DsbSyncDb,
  input: QueueOfflinePurchaseInput,
  now = Date.now(),
): Promise<OfflinePurchaseRecord> {
  assertIdentity(input);
  return db.transaction(
    'rw',
    [db.outbox, db.meta, db.offlinePurchases, db.offlineItems],
    async () => {
      const existing = await db.offlinePurchases.get(input.clientId);
      // A refused bill that the user turned into a draft (closed) keeps its id — nothing was posted under
      // it — and may be saved again; any other existing record is returned unchanged (never a second bill).
      if (existing && !(existing.status === 'REJECTED' && existing.closedAt !== null)) {
        if (existing.status === 'REJECTED')
          throw new Error(
            'This bill was refused. Use "Correct this bill" in the pending list first.',
          );
        return existing;
      }
      if (await db.outbox.where('clientId').equals(input.clientId).count())
        throw new Error('This bill id is already queued for another operation.');
      // Items created on this device (docs/OFFLINE_PURCHASES_PLAN.md, offline new items): a refused item
      // cannot be used; an item the server matched to an existing one is referenced by the server's id.
      const resolved = await resolveOfflineItems(db, input);
      const sequence = ((await getMeta<number>(db, 'outboxSeq')) ?? 0) + 1;
      await setMeta(db, 'outboxSeq', sequence);
      const record: OfflinePurchaseRecord = {
        ...resolved,
        status: 'QUEUED',
        createdAt: now,
        syncedAt: null,
        billId: null,
        paymentId: null,
        rejectionCode: null,
        rejectionReason: null,
        closedAt: null,
      };
      const entry: OutboxEntry = {
        sequence,
        clientId: input.clientId,
        kind: 'financial-rpc',
        target: PURCHASE_OUTBOX_TARGET,
        payload: resolved.request,
        createdAt: now,
        attempts: 0,
        state: 'pending',
        nextAttemptAt: 0,
        lastError: null,
      };
      await db.offlinePurchases.put(record);
      await db.outbox.put(entry);
      return record;
    },
  );
}

/** The server confirmed the bill (first answer or replay). Idempotent. */
export async function completeOfflinePurchase(
  db: DsbSyncDb,
  clientId: string,
  result: { billId: string; paymentId: string | null; totalPaise: number },
  now = Date.now(),
): Promise<OfflinePurchaseRecord> {
  return db.transaction('rw', [db.outbox, db.offlinePurchases], async () => {
    const record = await db.offlinePurchases.get(clientId);
    if (!record) throw new Error('Offline purchase record is missing.');
    // The server already committed this bill: never block the queue or leave it "not synced" over a total
    // difference. The server figure replaces the local one and the difference is shown for review.
    const mismatch = result.totalPaise !== record.totalPaise;
    const next: OfflinePurchaseRecord =
      record.status === 'SYNCED'
        ? record
        : {
            ...record,
            status: 'SYNCED',
            syncedAt: now,
            billId: result.billId,
            paymentId: result.paymentId,
            totalPaise: result.totalPaise,
            reconciliationWarning: mismatch
              ? `The server recorded ₹${(result.totalPaise / 100).toFixed(2)} for this bill; this device had saved ₹${(record.totalPaise / 100).toFixed(2)}. Check the bill.`
              : null,
            rejectionCode: null,
            rejectionReason: null,
            documents: record.documents.map((d) => ({ ...d, uploaded: true })),
          };
    await db.offlinePurchases.put(next);
    await db.outbox.where('clientId').equals(clientId).delete();
    return next;
  });
}

/** A definitive refusal: nothing was posted. The record stays (visible) with its form for correction. */
export async function rejectOfflinePurchase(
  db: DsbSyncDb,
  clientId: string,
  code: string,
  reason: string,
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', [db.outbox, db.offlinePurchases, db.conflicts], async () => {
    const record = await db.offlinePurchases.get(clientId);
    if (record?.status === 'SYNCED') throw new Error('A synced purchase cannot be rejected.');
    if (record)
      await db.offlinePurchases.put({
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
      target: PURCHASE_OUTBOX_TARGET,
      clientId,
      reason,
      payload: record?.request ?? outbox?.payload ?? null,
      serverRef: null,
    };
    await db.conflicts.add(conflict);
  });
}

export async function markOfflinePurchaseDocumentUploaded(
  db: DsbSyncDb,
  clientId: string,
  documentId: string,
): Promise<void> {
  await db.transaction('rw', [db.offlinePurchases], async () => {
    const record = await db.offlinePurchases.get(clientId);
    if (!record) return;
    await db.offlinePurchases.put({
      ...record,
      documents: record.documents.map((d) => (d.id === documentId ? { ...d, uploaded: true } : d)),
    });
  });
}

/** Only a refused bill can be closed (turned into a draft or dismissed); queued/synced bills cannot. */
export async function closeRejectedOfflinePurchase(
  db: DsbSyncDb,
  clientId: string,
  now = Date.now(),
): Promise<OfflinePurchaseRecord> {
  return db.transaction('rw', [db.offlinePurchases], async () => {
    const record = await db.offlinePurchases.get(clientId);
    if (!record) throw new Error('Offline purchase record is missing.');
    if (record.status !== 'REJECTED') throw new Error('Only a refused bill can be corrected.');
    const next = { ...record, closedAt: record.closedAt ?? now };
    await db.offlinePurchases.put(next);
    return next;
  });
}

export async function listOfflinePurchaseRecords(
  db: DsbSyncDb,
  shopId: string,
): Promise<OfflinePurchaseRecord[]> {
  const rows = await db.offlinePurchases.where('shopId').equals(shopId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
