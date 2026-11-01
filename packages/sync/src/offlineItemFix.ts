import { getMeta, setMeta, type DsbSyncDb } from './db';
import {
  ITEM_REJECTED_CODE,
  queueOfflineItem,
  type OfflineItemFields,
  type OfflineItemRecord,
} from './offlineItem';
import { PURCHASE_OUTBOX_TARGET } from './offlinePurchase';

// Fix a refused item in place (D9). Both fixes only act on a bill that the item gate held (code
// DSB_ITEM_REJECTED): such a bill was refused on the device BEFORE it was ever sent, so the server has never
// seen its request id. It is pointed at the item and queued again under the SAME request id (the server
// still sees one request), behind the item. A bill the server refused for another reason, or one that was
// already sent, is never touched. No ledger, stock or money rule changes: only which item a never-sent
// request names.

const norm = (s: string) => s.trim().toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Line = { itemId?: unknown };
const linesOf = (payload: unknown): Line[] => {
  const lines = (payload as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? (lines as Line[]) : [];
};

function swapIds(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((v) => swapIds(v, from, to));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, swapIds(v, from, to)]),
    );
  return value;
}

const tablesOf = (db: DsbSyncDb) => [
  db.outbox,
  db.meta,
  db.offlineItems,
  db.offlinePurchases,
  db.offlineBillChanges,
  db.conflicts,
];

async function closeAlertsFor(db: DsbSyncDb, clientIds: string[], now: number) {
  const set = new Set(clientIds);
  for (const c of await db.conflicts.toArray())
    if (c.status === 'OPEN' && c.clientId && set.has(c.clientId))
      await db.conflicts.put({ ...c, status: 'RESOLVED', resolvedAt: now, resolvedBy: 'system' });
}

/** Held bills (and edits) of a refused item are pointed at `toId`; held bills are queued again. */
async function moveHeldBills(db: DsbSyncDb, fromId: string, toId: string, now: number) {
  const requeued: string[] = [];
  for (const bill of await db.offlinePurchases.toArray()) {
    if (bill.status !== 'REJECTED' || bill.rejectionCode !== ITEM_REJECTED_CODE) continue;
    if (bill.closedAt !== null) continue;
    if (!linesOf(bill.request).some((l) => l.itemId === fromId)) continue;
    // Anything still in the outbox under this id is not "held": leave it.
    if (await db.outbox.where('clientId').equals(bill.clientId).count()) continue;
    const request = swapIds(bill.request, fromId, toId) as typeof bill.request;
    const sequence = ((await getMeta<number>(db, 'outboxSeq')) ?? 0) + 1;
    await setMeta(db, 'outboxSeq', sequence);
    await db.offlinePurchases.put({
      ...bill,
      request,
      draft: swapIds(bill.draft, fromId, toId),
      lines: bill.lines.map((l) => (l.itemId === fromId ? { ...l, itemId: toId } : l)),
      status: 'QUEUED',
      syncedAt: null,
      billId: null,
      paymentId: null,
      rejectionCode: null,
      rejectionReason: null,
    });
    await db.outbox.put({
      sequence,
      clientId: bill.clientId,
      kind: 'financial-rpc',
      target: PURCHASE_OUTBOX_TARGET,
      payload: request,
      createdAt: now,
      attempts: 0,
      state: 'pending',
      nextAttemptAt: 0,
      lastError: null,
    });
    requeued.push(bill.clientId);
  }
  // A held bill EDIT keeps its own "Redo this edit" step (an edit also depends on the bill's version), but
  // its saved form now names the right item.
  for (const change of await db.offlineBillChanges.toArray()) {
    if (change.status !== 'REJECTED' || change.rejectionCode !== ITEM_REJECTED_CODE) continue;
    if (change.closedAt !== null) continue;
    if (!linesOf(change.request).some((l) => l.itemId === fromId)) continue;
    await db.offlineBillChanges.put({
      ...change,
      request: swapIds(change.request, fromId, toId) as typeof change.request,
      form: swapIds(change.form, fromId, toId),
    });
  }
  return requeued;
}

/**
 * "Use the existing item": the refused create is closed as matched to `existing`, and the held bills are
 * pointed at it and queued again. Needs the user's explicit confirm that these are the same product.
 * Idempotent: a second call changes nothing.
 */
export async function useExistingItemForRefused(
  db: DsbSyncDb,
  clientId: string,
  existing: Readonly<{ itemId: string; fields: Pick<OfflineItemFields, 'name'> }>,
  confirmedSameProduct: boolean,
  now = Date.now(),
): Promise<{ requeued: string[] }> {
  if (!UUID.test(existing.itemId)) throw new Error('The existing item id is not valid.');
  return db.transaction('rw', tablesOf(db), async () => {
    const rec = await db.offlineItems.get(clientId);
    if (!rec) throw new Error('Offline item record is missing.');
    if (rec.status === 'SYNCED') {
      if (rec.serverItemId === existing.itemId) return { requeued: [] };
      throw new Error('This item was already created or matched to another item.');
    }
    if (rec.status !== 'REJECTED') throw new Error('Only a refused item can be matched.');
    if (norm(existing.fields.name) !== norm(rec.fields.name))
      throw new Error('The existing item must have the same name as the refused one.');
    if (!confirmedSameProduct)
      throw new Error('Confirm that these are the same product before using the existing item.');
    const requeued = await moveHeldBills(db, rec.itemId, existing.itemId, now);
    await db.offlineItems.put({
      ...rec,
      status: 'SYNCED',
      syncedAt: now,
      serverItemId: existing.itemId,
      mapped: true,
    });
    await closeAlertsFor(db, [clientId, ...requeued], now);
    return { requeued };
  });
}

/**
 * "Rename and create": a NEW create (new request id, new item id) under another name with the same units.
 * The held bills follow the new item and wait behind it. Idempotent: a second call returns the first.
 */
export async function renameRefusedItem(
  db: DsbSyncDb,
  clientId: string,
  next: Readonly<{ clientId: string; itemId: string; name: string }>,
  now = Date.now(),
): Promise<{ record: OfflineItemRecord; requeued: string[] }> {
  return db.transaction('rw', tablesOf(db), async () => {
    const rec = await db.offlineItems.get(clientId);
    if (!rec) throw new Error('Offline item record is missing.');
    if (rec.replacedBy) {
      const done = await db.offlineItems.get(rec.replacedBy);
      if (done) return { record: done, requeued: [] };
    }
    if (rec.status !== 'REJECTED') throw new Error('Only a refused item can be created again.');
    const name = next.name.trim();
    if (!name) throw new Error('Enter the new item name.');
    if (norm(name) === norm(rec.fields.name))
      throw new Error('Use a different name: the shop already has an item with this one.');
    const record = await queueOfflineItem(
      db,
      {
        clientId: next.clientId,
        itemId: next.itemId,
        tenantId: rec.tenantId,
        fields: { ...rec.fields, name },
      },
      now,
    );
    await db.offlineItems.put({ ...rec, replacedBy: record.clientId });
    const requeued = await moveHeldBills(db, rec.itemId, record.itemId, now);
    await closeAlertsFor(db, [clientId, ...requeued], now);
    return { record, requeued };
  });
}
