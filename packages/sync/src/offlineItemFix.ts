import type { DsbSyncDb } from './db';
import {
  ITEM_REJECTED_CODE,
  queueOfflineItem,
  requeueHeldPurchase,
  swapIds,
  type OfflineItemFields,
  type OfflineItemRecord,
} from './offlineItem';

// Fix a refused item in place (D9). The money rule: a bill line is quantity x unit level, and the SERVER turns
// that into stock, cost and total with the units and conversions of the item the line names. So a held bill
// may be pointed at another item ONLY if that item has exactly the same units and conversions; otherwise
// nothing is changed and the bill stays held. Only a bill that the item gate held BEFORE any send
// (heldBeforeSend) is ever touched: the server has never seen its request id. A bill without that marker may
// already have reached the server and is left alone, with a message.

const norm = (s: string) => s.trim().toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Line = { itemId?: unknown };
const linesOf = (payload: unknown): Line[] => {
  const lines = (payload as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? (lines as Line[]) : [];
};

export type ItemUnits = Readonly<{
  name: string;
  unit1: string;
  unit2?: string | null;
  unit3?: string | null;
  conv1?: number | null;
  conv2?: number | null;
}>;

/** What differs between two items' units and conversions, in plain words. Empty = same. */
export function unitDifferences(refused: ItemUnits, existing: ItemUnits): string[] {
  const t = (v: string | null | undefined) => (v ?? '').trim() || null;
  const n = (v: number | null | undefined) => (v === undefined ? null : v);
  const out: string[] = [];
  const pair = (label: string, a: unknown, b: unknown) => {
    if (a !== b) out.push(`${label}: ${a ?? 'none'} (new) vs ${b ?? 'none'} (existing)`);
  };
  pair('Big unit', t(refused.unit1), t(existing.unit1));
  pair('Middle unit', t(refused.unit2), t(existing.unit2));
  pair('Small unit', t(refused.unit3), t(existing.unit3));
  pair('Big to middle conversion', n(refused.conv1), n(existing.conv1));
  pair('Middle to small conversion', n(refused.conv2), n(existing.conv2));
  return out;
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

const uses = (request: unknown, itemId: string) =>
  linesOf(request).some((l) => l.itemId === itemId);

/** Held bills/edits of a refused item. `unsure` = refused for the item but not proven never-sent. */
async function heldOf(db: DsbSyncDb, itemId: string) {
  const bills = [];
  const edits = [];
  const unsure: string[] = [];
  for (const bill of await db.offlinePurchases.toArray()) {
    if (bill.status !== 'REJECTED' || bill.rejectionCode !== ITEM_REJECTED_CODE) continue;
    if (bill.closedAt !== null || !uses(bill.request, itemId)) continue;
    if (bill.heldBeforeSend && !(await db.outbox.where('clientId').equals(bill.clientId).count()))
      bills.push(bill);
    else unsure.push(bill.clientId);
  }
  for (const change of await db.offlineBillChanges.toArray()) {
    if (change.status !== 'REJECTED' || change.rejectionCode !== ITEM_REJECTED_CODE) continue;
    if (change.closedAt !== null || !uses(change.request, itemId)) continue;
    if (
      change.heldBeforeSend &&
      !(await db.outbox.where('clientId').equals(change.clientId).count())
    )
      edits.push(change);
    else unsure.push(change.clientId);
  }
  return { bills, edits, unsure };
}

export type UseExistingResult =
  | { kind: 'done'; requeued: string[]; notMoved: string[] }
  | {
      kind: 'refused';
      reason: 'not-confirmed' | 'units-differ' | 'name-differs';
      differences: string[];
    };

/**
 * "Use the existing item": allowed only when the existing item has the SAME name, units and conversions and
 * the user confirmed it is the same product. Otherwise nothing at all changes. Idempotent.
 */
export async function useExistingItemForRefused(
  db: DsbSyncDb,
  clientId: string,
  existing: Readonly<{ itemId: string; fields: ItemUnits }>,
  confirmedSameProduct: boolean,
  now = Date.now(),
): Promise<UseExistingResult> {
  if (!UUID.test(existing.itemId)) throw new Error('The existing item id is not valid.');
  return db.transaction('rw', tablesOf(db), async (): Promise<UseExistingResult> => {
    const rec = await db.offlineItems.get(clientId);
    if (!rec) throw new Error('Offline item record is missing.');
    if (rec.status === 'SYNCED') {
      if (rec.serverItemId === existing.itemId) return { kind: 'done', requeued: [], notMoved: [] };
      throw new Error('This item was already created or matched to another item.');
    }
    if (rec.status !== 'REJECTED') throw new Error('Only a refused item can be matched.');
    if (norm(existing.fields.name) !== norm(rec.fields.name))
      return { kind: 'refused', reason: 'name-differs', differences: [] };
    const differences = unitDifferences({ ...rec.fields, name: rec.fields.name }, existing.fields);
    if (differences.length) return { kind: 'refused', reason: 'units-differ', differences };
    if (!confirmedSameProduct) return { kind: 'refused', reason: 'not-confirmed', differences: [] };
    const held = await heldOf(db, rec.itemId);
    for (const bill of held.bills)
      await requeueHeldPurchase(db, bill, now, rec.itemId, existing.itemId);
    for (const change of held.edits)
      await db.offlineBillChanges.put({
        ...change,
        request: swapIds(change.request, rec.itemId, existing.itemId) as typeof change.request,
        form: swapIds(change.form, rec.itemId, existing.itemId),
      });
    await db.offlineItems.put({
      ...rec,
      status: 'SYNCED',
      syncedAt: now,
      serverItemId: existing.itemId,
      mapped: true,
    });
    const requeued = held.bills.map((b) => b.clientId);
    await closeAlertsFor(db, [clientId, ...requeued, ...held.edits.map((e) => e.clientId)], now);
    return { kind: 'done', requeued, notMoved: held.unsure };
  });
}

/**
 * "Rename and create": a NEW create (new request id, new item id) under another name with the same units.
 * Held bills are pointed at the new item but stay HELD; they are queued again only when the new item is
 * confirmed (completeOfflineItem). Idempotent: a second call returns the first.
 */
export async function renameRefusedItem(
  db: DsbSyncDb,
  clientId: string,
  next: Readonly<{ clientId: string; itemId: string; name: string }>,
  now = Date.now(),
): Promise<{ record: OfflineItemRecord; held: string[]; notMoved: string[] }> {
  return db.transaction('rw', tablesOf(db), async () => {
    const rec = await db.offlineItems.get(clientId);
    if (!rec) throw new Error('Offline item record is missing.');
    if (rec.replacedBy) {
      const done = await db.offlineItems.get(rec.replacedBy);
      if (done) return { record: done, held: [], notMoved: [] };
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
    const held = await heldOf(db, rec.itemId);
    const waiting = `Waiting for the new item "${name}" to be created. Nothing was posted.`;
    for (const bill of held.bills)
      await db.offlinePurchases.put({
        ...bill,
        request: swapIds(bill.request, rec.itemId, record.itemId) as typeof bill.request,
        draft: swapIds(bill.draft, rec.itemId, record.itemId),
        lines: bill.lines.map((l) =>
          l.itemId === rec.itemId ? { ...l, itemId: record.itemId } : l,
        ),
        releaseWithItem: record.itemId,
        rejectionReason: waiting,
      });
    for (const change of held.edits)
      await db.offlineBillChanges.put({
        ...change,
        request: swapIds(change.request, rec.itemId, record.itemId) as typeof change.request,
        form: swapIds(change.form, rec.itemId, record.itemId),
      });
    const ids = [...held.bills, ...held.edits].map((b) => b.clientId);
    await closeAlertsFor(db, [clientId, ...ids], now);
    return { record, held: ids, notMoved: held.unsure };
  });
}
