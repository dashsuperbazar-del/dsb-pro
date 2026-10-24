import { getMeta, setMeta, type DsbSyncDb } from './db';
import { PURCHASE_OUTBOX_TARGET, rejectOfflinePurchase } from './offlinePurchase';
import type { LocalSyncConflict, OutboxEntry } from './types';

// Offline new items (owner/manager). The device generates the item id; the item create goes into the SAME
// ordered outbox as purchases and sales, so it is always sent before any bill queued after it that uses
// the item. A queued item never touches the synced catalog or cached stock: it is shown only to the
// purchase form (as "not synced") until the server confirms it.
//  * SYNCED with another id (the server matched an existing item with the same name and units): every
//    queued, never-sent bill that uses the device id is pointed at the server's item in the same
//    transaction. A bill that was already sent is never rewritten.
//  * REJECTED: the item stays visible with the reason; every queued bill that uses it is refused locally
//    (visible, "Correct this bill") so it can never post against a wrong or missing item.

export const ITEM_OUTBOX_TARGET = 'create_item_v2';
export const ITEM_REJECTED_CODE = 'DSB_ITEM_REJECTED';

export type OfflineItemFields = Readonly<{
  name: string;
  sku?: string;
  unit1: string;
  unit2?: string;
  unit3?: string;
  conv1?: number;
  conv2?: number;
  taxRateBp?: number;
}>;
export type OfflineItemStatus = 'QUEUED' | 'SYNCED' | 'REJECTED';
export type OfflineItemRecord = Readonly<{
  /** Request id of the create (outbox client id). */
  clientId: string;
  /** The device-generated item id that queued bills reference. */
  itemId: string;
  tenantId: string;
  fields: OfflineItemFields;
  status: OfflineItemStatus;
  createdAt: number;
  syncedAt: number | null;
  /** The server's item: the device id, or the existing item it was matched to. */
  serverItemId: string | null;
  mapped: boolean;
  rejectionCode: string | null;
  rejectionReason: string | null;
}>;
export type OfflineItemRequest = Readonly<{
  itemId: string;
  clientId: string;
  item: OfflineItemFields;
}>;

const norm = (s: string) => s.trim().toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sameUnits(a: OfflineItemFields, b: OfflineItemFields) {
  return (
    a.unit1.trim() === b.unit1.trim() &&
    (a.unit2?.trim() || null) === (b.unit2?.trim() || null) &&
    (a.unit3?.trim() || null) === (b.unit3?.trim() || null) &&
    (a.conv1 ?? null) === (b.conv1 ?? null) &&
    (a.conv2 ?? null) === (b.conv2 ?? null)
  );
}

/**
 * Saves the item create and its outbox row atomically. The same client id returns the saved record. A
 * second queued item with the same name returns the first when its units match, and is refused otherwise.
 */
export async function queueOfflineItem(
  db: DsbSyncDb,
  input: { clientId: string; itemId: string; tenantId: string; fields: OfflineItemFields },
  now = Date.now(),
): Promise<OfflineItemRecord> {
  if (!UUID.test(input.clientId) || !UUID.test(input.itemId))
    throw new Error('Offline item ids must be lower-case UUIDs.');
  if (!input.fields.name.trim() || !input.fields.unit1.trim())
    throw new Error('Enter the item name and the big unit.');
  return db.transaction('rw', [db.outbox, db.meta, db.offlineItems], async () => {
    const existing = await db.offlineItems.get(input.clientId);
    // A retry of the same create (same request id) keeps the item id saved first.
    if (existing) return existing;
    const same = (await db.offlineItems.where('tenantId').equals(input.tenantId).toArray()).find(
      (r) => r.status === 'QUEUED' && norm(r.fields.name) === norm(input.fields.name),
    );
    if (same) {
      if (sameUnits(same.fields, input.fields)) return same;
      throw new Error(
        `"${same.fields.name}" is already waiting to sync with other units. Pick it, or use another name.`,
      );
    }
    if (await db.outbox.where('clientId').equals(input.clientId).count())
      throw new Error('This item id is already queued for another operation.');
    const sequence = ((await getMeta<number>(db, 'outboxSeq')) ?? 0) + 1;
    await setMeta(db, 'outboxSeq', sequence);
    const record: OfflineItemRecord = {
      clientId: input.clientId,
      itemId: input.itemId,
      tenantId: input.tenantId,
      fields: { ...input.fields, name: input.fields.name.trim() },
      status: 'QUEUED',
      createdAt: now,
      syncedAt: null,
      serverItemId: null,
      mapped: false,
      rejectionCode: null,
      rejectionReason: null,
    };
    const payload: OfflineItemRequest = {
      itemId: record.itemId,
      clientId: record.clientId,
      item: record.fields,
    };
    const entry: OutboxEntry = {
      sequence,
      clientId: input.clientId,
      kind: 'financial-rpc',
      target: ITEM_OUTBOX_TARGET,
      payload,
      createdAt: now,
      attempts: 0,
      state: 'pending',
      nextAttemptAt: 0,
      lastError: null,
    };
    await db.offlineItems.put(record);
    await db.outbox.put(entry);
    return record;
  });
}

type Line = { itemId?: unknown };
const linesOf = (payload: unknown): Line[] => {
  const lines = (payload as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? (lines as Line[]) : [];
};
async function queuedPurchasesUsing(db: DsbSyncDb, itemId: string) {
  return (await db.outbox.where('target').equals(PURCHASE_OUTBOX_TARGET).toArray()).filter((row) =>
    linesOf(row.payload).some((l) => l.itemId === itemId),
  );
}

/** The server confirmed the item (created, replayed or matched). Idempotent. */
export async function completeOfflineItem(
  db: DsbSyncDb,
  clientId: string,
  result: { itemId: string; mapped: boolean },
  now = Date.now(),
): Promise<OfflineItemRecord> {
  return db.transaction('rw', [db.outbox, db.offlineItems, db.offlinePurchases], async () => {
    const record = await db.offlineItems.get(clientId);
    if (!record) throw new Error('Offline item record is missing.');
    if (record.status === 'SYNCED') {
      await db.outbox.where('clientId').equals(clientId).delete();
      return record;
    }
    if (record.status === 'REJECTED') throw new Error('A refused item cannot be confirmed.');
    if (result.itemId !== record.itemId) {
      // Matched to an existing item: point every never-sent queued bill at it. A bill already sent
      // cannot be changed (the server may hold it under the old payload); it is left to the server.
      for (const row of await queuedPurchasesUsing(db, record.itemId)) {
        if (row.attempts > 0 || row.state !== 'pending') continue;
        const payload = row.payload as Record<string, unknown>;
        const next = {
          ...payload,
          lines: linesOf(payload).map((l) =>
            l.itemId === record.itemId ? { ...l, itemId: result.itemId } : l,
          ),
        };
        await db.outbox.put({ ...row, payload: next });
        const bill = await db.offlinePurchases.get(row.clientId);
        if (bill && bill.status === 'QUEUED')
          await db.offlinePurchases.put({
            ...bill,
            request: next as unknown as typeof bill.request,
            lines: bill.lines.map((l) =>
              l.itemId === record.itemId ? { ...l, itemId: result.itemId } : l,
            ),
          });
      }
    }
    const next: OfflineItemRecord = {
      ...record,
      status: 'SYNCED',
      syncedAt: now,
      serverItemId: result.itemId,
      mapped: result.mapped || result.itemId !== record.itemId,
    };
    await db.offlineItems.put(next);
    await db.outbox.where('clientId').equals(clientId).delete();
    return next;
  });
}

export const ITEM_REMAPPED_CODE = 'DSB_ITEM_REMAPPED';
/** Plain words for a bill that still names a device item the server matched to an existing item. */
export function itemRemappedReason(itemName: string) {
  return `The new item "${itemName}" was matched to an item that already existed, and this bill still names the new one. Nothing was posted. Correct this bill: pick "${itemName}" again.`;
}

/** Plain words for the bills held back by a refused item. */
export function itemRejectedReason(itemName: string, reason: string) {
  return `The new item "${itemName}" on this bill was refused (${reason}). Nothing was posted. Correct this bill: pick an existing item instead.`;
}

/**
 * A definitive refusal of the item: nothing was created. The item stays visible; every queued bill that
 * uses it is refused locally so it never posts. Returns the client ids of those bills.
 */
export async function rejectOfflineItem(
  db: DsbSyncDb,
  clientId: string,
  code: string,
  reason: string,
  now = Date.now(),
): Promise<string[]> {
  const record = await db.transaction(
    'rw',
    [db.outbox, db.offlineItems, db.conflicts],
    async () => {
      const rec = await db.offlineItems.get(clientId);
      if (rec?.status === 'SYNCED') throw new Error('A synced item cannot be rejected.');
      if (rec)
        await db.offlineItems.put({
          ...rec,
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
        target: ITEM_OUTBOX_TARGET,
        clientId,
        reason,
        payload: outbox?.payload ?? null,
        serverRef: null,
      };
      await db.conflicts.add(conflict);
      return rec ?? null;
    },
  );
  if (!record) return [];
  return holdBillsOfRejectedItem(db, record, now);
}

/** Refuses (locally, visibly) every queued bill that uses a refused item. Safe to run again. */
export async function holdBillsOfRejectedItem(
  db: DsbSyncDb,
  record: OfflineItemRecord,
  now = Date.now(),
): Promise<string[]> {
  const held: string[] = [];
  for (const row of await queuedPurchasesUsing(db, record.itemId)) {
    await rejectOfflinePurchase(
      db,
      row.clientId,
      ITEM_REJECTED_CODE,
      itemRejectedReason(record.fields.name, record.rejectionReason ?? 'refused'),
      now,
    );
    held.push(row.clientId);
  }
  return held;
}

/**
 * Before a queued bill is sent: every device-created item it uses must be SYNCED. A refused item refuses
 * the bill ('rejected'); an item still waiting means the order was broken, so the bill waits ('wait').
 */
export async function purchaseItemGate(
  db: DsbSyncDb,
  payload: unknown,
): Promise<
  | { kind: 'ok' }
  | { kind: 'wait'; name: string }
  | { kind: 'rejected'; record: OfflineItemRecord }
  | { kind: 'remapped'; record: OfflineItemRecord }
> {
  const ids = new Set(
    linesOf(payload)
      .map((l) => l.itemId)
      .filter((v): v is string => typeof v === 'string'),
  );
  if (!ids.size) return { kind: 'ok' };
  const records = await db.offlineItems
    .where('itemId')
    .anyOf([...ids])
    .toArray();
  for (const r of records) if (r.status === 'REJECTED') return { kind: 'rejected', record: r };
  for (const r of records) if (r.status === 'QUEUED') return { kind: 'wait', name: r.fields.name };
  // A SYNCED record whose server id differs and is still referenced (not expected: never-sent bills are
  // re-pointed when the match is confirmed): never send the old id, and never block the whole queue.
  for (const r of records)
    if (r.status === 'SYNCED' && r.serverItemId && r.serverItemId !== r.itemId)
      return { kind: 'remapped', record: r };
  return { kind: 'ok' };
}

export async function listOfflineItemRecords(
  db: DsbSyncDb,
  tenantId: string,
): Promise<OfflineItemRecord[]> {
  const rows = await db.offlineItems.where('tenantId').equals(tenantId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
