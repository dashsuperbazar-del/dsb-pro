import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { DsbSyncDb } from './db';
import { nextOutboxEntry } from './outbox';
import {
  ITEM_OUTBOX_TARGET,
  ITEM_REJECTED_CODE,
  closeOfflineItemRecord,
  completeOfflineItem,
  listOfflineItemRecords,
  purchaseItemGate,
  queueOfflineItem,
  rejectOfflineItem,
} from './offlineItem';
import { PURCHASE_OUTBOX_TARGET, queueOfflinePurchase } from './offlinePurchase';
import { resolveLocalConflicts } from './offlineSale';
import { renameRefusedItem, useExistingItemForRefused } from './offlineItemFix';
import { queueOfflineBillChange } from './offlineBillChange';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) {
    db.close();
    await db.delete();
  }
});
async function newDb() {
  const db = new DsbSyncDb(`offline-item-${crypto.randomUUID()}`);
  open.push(db);
  await db.open();
  return db;
}
const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BILL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SERVER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const fields = { name: 'Atta', unit1: 'bag', unit2: 'kg', conv1: 10 };
const item = (over = {}) => ({ clientId: REQ, itemId: ITEM, tenantId: 't', fields, ...over });
function bill(itemId = ITEM) {
  return {
    clientId: BILL,
    shopId: 'shop',
    request: {
      shopId: 'shop',
      clientId: BILL,
      lines: [{ itemId, unitLevel: 1, qty: '2', unitPricePaise: 1000 }],
    },
    draft: null,
    documentScope: 's:',
    documents: [],
    supplierName: null,
    billNo: null,
    businessDate: '2026-10-24',
    paymentType: 'credit' as const,
    totalPaise: 2000,
    lines: [{ itemId, itemName: 'Atta', qty: '2', unitName: 'bag' }],
  };
}

describe('offline new items', () => {
  it('queues the item before the bill that uses it, in one ordered outbox', async () => {
    const db = await newDb();
    await queueOfflineItem(db, item(), 1);
    await queueOfflinePurchase(db, bill(), 2);
    const rows = await db.outbox.orderBy('sequence').toArray();
    expect(rows.map((r) => r.target)).toEqual([ITEM_OUTBOX_TARGET, PURCHASE_OUTBOX_TARGET]);
    expect(rows[0]!.payload).toEqual({ itemId: ITEM, clientId: REQ, item: fields });
    expect(nextOutboxEntry(rows, 3)?.target).toBe(ITEM_OUTBOX_TARGET);
    // Nothing reaches the synced catalog or cached stock.
    expect(await db.items.count()).toBe(0);
    expect(await db.stock.count()).toBe(0);
  });

  it('the same request returns the saved item; a queued same name reuses it or is refused', async () => {
    const db = await newDb();
    const a = await queueOfflineItem(db, item());
    expect(await queueOfflineItem(db, item())).toEqual(a);
    const other = { clientId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', itemId: SERVER };
    expect(
      (await queueOfflineItem(db, item({ ...other, fields: { ...fields, name: ' atta ' } })))
        .itemId,
    ).toBe(ITEM);
    await expect(
      queueOfflineItem(db, item({ ...other, fields: { ...fields, conv1: 25 } })),
    ).rejects.toThrow(/other units/);
    expect(await db.outbox.count()).toBe(1);
    expect((await queueOfflineItem(db, item({ itemId: SERVER }))).itemId).toBe(ITEM);
  });

  it('confirmed: SYNCED, outbox row removed, idempotent', async () => {
    const db = await newDb();
    await queueOfflineItem(db, item());
    const done = await completeOfflineItem(db, REQ, { itemId: ITEM, mapped: false }, 5);
    expect(done).toMatchObject({
      status: 'SYNCED',
      serverItemId: ITEM,
      mapped: false,
      syncedAt: 5,
    });
    expect(await completeOfflineItem(db, REQ, { itemId: ITEM, mapped: false })).toEqual(done);
    expect(await db.outbox.count()).toBe(0);
  });

  it('matched to an existing item: never-sent queued bills are pointed at the server item', async () => {
    const db = await newDb();
    await queueOfflineItem(db, item());
    await queueOfflinePurchase(db, bill());
    await completeOfflineItem(db, REQ, { itemId: SERVER, mapped: true });
    const row = await db.outbox.where('clientId').equals(BILL).first();
    expect((row!.payload as { lines: { itemId: string }[] }).lines[0]!.itemId).toBe(SERVER);
    const rec = await db.offlinePurchases.get(BILL);
    expect((rec!.request.lines as { itemId: string }[])[0]!.itemId).toBe(SERVER);
    expect(rec!.lines[0]!.itemId).toBe(SERVER);
    expect(await purchaseItemGate(db, row!.payload)).toEqual({ kind: 'ok' });
  });

  it('a bill queued after the match uses the server item id', async () => {
    const db = await newDb();
    await queueOfflineItem(db, item());
    await completeOfflineItem(db, REQ, { itemId: SERVER, mapped: true });
    const rec = await queueOfflinePurchase(db, bill());
    expect((rec.request.lines as { itemId: string }[])[0]!.itemId).toBe(SERVER);
  });

  it('refused: item stays visible, dependent bills are refused locally and never sent', async () => {
    const db = await newDb();
    await queueOfflineItem(db, item());
    await queueOfflinePurchase(db, bill());
    const held = await rejectOfflineItem(db, REQ, 'DSB_ITEM_NAME_TAKEN', 'name taken');
    expect(held).toEqual([BILL]);
    expect(await db.outbox.count()).toBe(0);
    expect((await listOfflineItemRecords(db, 't'))[0]).toMatchObject({
      status: 'REJECTED',
      rejectionCode: 'DSB_ITEM_NAME_TAKEN',
    });
    const rec = await db.offlinePurchases.get(BILL);
    expect(rec).toMatchObject({ status: 'REJECTED', rejectionCode: ITEM_REJECTED_CODE });
    expect(rec!.rejectionReason).toMatch(/Atta.*refused/);
    expect(await db.conflicts.count()).toBe(2);
    await expect(
      queueOfflinePurchase(db, {
        ...bill(),
        clientId: SERVER,
        request: { ...bill().request, clientId: SERVER },
      }),
    ).rejects.toThrow(/refused/);
    await expect(completeOfflineItem(db, REQ, { itemId: ITEM, mapped: false })).rejects.toThrow();
  });

  it('gate: a bill waits while its item is queued and is refused once the item is refused', async () => {
    const db = await newDb();
    await queueOfflineItem(db, item());
    const payload = bill().request;
    expect(await purchaseItemGate(db, payload)).toEqual({ kind: 'wait', name: 'Atta' });
    expect(await purchaseItemGate(db, { lines: [{ itemId: 'other' }] })).toEqual({ kind: 'ok' });
    await rejectOfflineItem(db, REQ, 'X', 'no');
    expect((await purchaseItemGate(db, payload)).kind).toBe('rejected');
  });

  it('gate: a bill still naming a matched device item is never sent under the old id', async () => {
    const db = await newDb();
    await queueOfflineItem(db, item());
    await completeOfflineItem(db, REQ, { itemId: SERVER, mapped: true });
    expect((await purchaseItemGate(db, bill().request)).kind).toBe('remapped');
    expect(await purchaseItemGate(db, bill(SERVER).request)).toEqual({ kind: 'ok' });
  });

  describe('queued bill edits that use a device item', () => {
    const EDIT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const ORIG = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const queueEdit = (db: DsbSyncDb) =>
      queueOfflineBillChange(db, {
        clientId: EDIT,
        shopId: 'shop',
        kind: 'edit',
        billId: ORIG,
        billLabel: 'B-1',
        baseVersion: '0123456789abcdef0123456789abcdef',
        request: {
          shopId: 'shop',
          clientId: EDIT,
          originalId: ORIG,
          lines: [{ itemId: ITEM, qty: '1' }],
        },
        form: {},
      });
    const editLines = async (db: DsbSyncDb) => {
      const row = await db.outbox.where('clientId').equals(EDIT).first();
      return (row!.payload as { request: { lines: { itemId: string }[] } }).request.lines;
    };

    it('a match re-points the never-sent edit (outbox and record)', async () => {
      const db = await newDb();
      await queueOfflineItem(db, item());
      await queueEdit(db);
      await completeOfflineItem(db, REQ, { itemId: SERVER, mapped: true });
      expect((await editLines(db))[0]!.itemId).toBe(SERVER);
      const rec = await db.offlineBillChanges.get(EDIT);
      expect((rec!.request.lines as { itemId: string }[])[0]!.itemId).toBe(SERVER);
    });

    it('a refused item refuses the queued edit (visible, never sent)', async () => {
      const db = await newDb();
      await queueOfflineItem(db, item());
      await queueEdit(db);
      const held = await rejectOfflineItem(db, REQ, 'DSB_ITEM_NAME_TAKEN', 'name taken');
      expect(held).toEqual([EDIT]);
      expect(await db.outbox.count()).toBe(0);
      expect(await db.offlineBillChanges.get(EDIT)).toMatchObject({
        status: 'REJECTED',
        rejectionCode: ITEM_REJECTED_CODE,
      });
    });
  });
});

describe('fix a refused item in place (D9)', () => {
  const EXISTING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const NEW_REQ = 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1';
  const NEW_ITEM = 'f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2';
  // Same name and units as `fields` (bag of 10 kg).
  const same = { itemId: EXISTING, fields: { ...fields, name: 'ATTA' } };
  async function refused() {
    const db = await newDb();
    await queueOfflineItem(db, item(), 1);
    await queueOfflinePurchase(db, bill(), 2);
    await rejectOfflineItem(db, REQ, 'DSB_ITEM_NAME_TAKEN', 'name taken', 3);
    return db;
  }
  async function snapshot(db: DsbSyncDb) {
    return JSON.stringify([
      await db.offlineItems.toArray(),
      await db.offlinePurchases.toArray(),
      await db.outbox.toArray(),
      await db.conflicts.toArray(),
    ]);
  }
  it('use existing: units must be confirmed AND identical; refusal changes nothing', async () => {
    const db = await refused();
    const before = await snapshot(db);
    expect(await useExistingItemForRefused(db, REQ, same, false)).toMatchObject({
      kind: 'refused',
      reason: 'not-confirmed',
    });
    // Different big unit (dozen vs bag): 12 of "bag" must never become 12 of "dozen".
    const other = { itemId: EXISTING, fields: { name: 'Atta', unit1: 'dozen' } };
    const r = await useExistingItemForRefused(db, REQ, other, true);
    expect(r).toMatchObject({ kind: 'refused', reason: 'units-differ' });
    expect((r as { differences: string[] }).differences.join(' ')).toMatch(/Big unit.*bag.*dozen/);
    // Same units but another conversion (1 bag = 25 kg).
    const conv = { itemId: EXISTING, fields: { ...fields, conv1: 25 } };
    expect(await useExistingItemForRefused(db, REQ, conv, true)).toMatchObject({
      kind: 'refused',
      reason: 'units-differ',
    });
    expect(await snapshot(db)).toBe(before);
  });
  it('use existing: identical units re-point the held bill and queue it once; double tap safe', async () => {
    const db = await refused();
    const done = await useExistingItemForRefused(db, REQ, same, true, 10);
    expect(done).toMatchObject({ kind: 'done', requeued: [BILL], notMoved: [] });
    const bill1 = await db.offlinePurchases.get(BILL);
    expect(bill1!.status).toBe('QUEUED');
    expect(JSON.stringify(bill1!.request)).toContain(EXISTING);
    expect(JSON.stringify(bill1!.request)).not.toContain(ITEM);
    const rows = await db.outbox.toArray();
    expect(rows.map((r) => r.clientId)).toEqual([BILL]);
    expect(rows[0]!.attempts).toBe(0);
    expect(await db.offlineItems.get(REQ)).toMatchObject({
      status: 'SYNCED',
      serverItemId: EXISTING,
      mapped: true,
    });
    expect(await useExistingItemForRefused(db, REQ, same, true, 11)).toMatchObject({
      kind: 'done',
      requeued: [],
    });
    expect(await db.outbox.count()).toBe(1);
    expect((await db.conflicts.toArray()).filter((c) => c.status === 'OPEN')).toEqual([]);
  });
  it('use existing: a bill not proven never-sent stays held with a message; other refusals are untouched', async () => {
    const db = await refused();
    const held = await db.offlinePurchases.get(BILL);
    // Held before this marker existed (or by another path): it may already have reached the server.
    await db.offlinePurchases.put({ ...held!, heldBeforeSend: false });
    const done = await useExistingItemForRefused(db, REQ, same, true, 10);
    expect(done).toMatchObject({ kind: 'done', requeued: [], notMoved: [BILL] });
    expect((await db.offlinePurchases.get(BILL))!.status).toBe('REJECTED');
    expect(JSON.stringify((await db.offlinePurchases.get(BILL))!.request)).toContain(ITEM);
    expect(await db.outbox.count()).toBe(0);
  });
  it('a held bill EDIT is re-pointed in its saved form but never queued', async () => {
    const db = await newDb();
    await queueOfflineItem(db, item(), 1);
    await queueOfflineBillChange(
      db,
      {
        clientId: SERVER,
        shopId: 'shop',
        kind: 'edit',
        billId: BILL,
        billLabel: 'B1',
        baseVersion: 'a'.repeat(32),
        request: { lines: [{ itemId: ITEM }] },
        form: { cards: [{ itemId: ITEM }] },
      },
      2,
    );
    await rejectOfflineItem(db, REQ, 'DSB_ITEM_NAME_TAKEN', 'name taken', 3);
    expect(await useExistingItemForRefused(db, REQ, same, true, 4)).toMatchObject({ kind: 'done' });
    const change = await db.offlineBillChanges.get(SERVER);
    expect(change!.status).toBe('REJECTED');
    expect(JSON.stringify(change!.form)).toContain(EXISTING);
    expect(await db.outbox.count()).toBe(0);
  });
  it('rename: one new item; the bill stays HELD until the new item is confirmed, then follows it', async () => {
    const db = await refused();
    const input = { clientId: NEW_REQ, itemId: NEW_ITEM, name: 'Atta 12 pcs' };
    const first = await renameRefusedItem(db, REQ, input, 10);
    expect(first.record.fields).toMatchObject({ name: 'Atta 12 pcs', unit1: 'bag' });
    const again = await renameRefusedItem(
      db,
      REQ,
      { ...input, clientId: crypto.randomUUID(), itemId: crypto.randomUUID() },
      11,
    );
    expect(again.record.clientId).toBe(NEW_REQ);
    expect(await db.offlineItems.count()).toBe(2);
    // Only the item is queued; the bill is held and already names the new device item.
    expect((await db.outbox.toArray()).map((r) => r.target)).toEqual([ITEM_OUTBOX_TARGET]);
    const held = await db.offlinePurchases.get(BILL);
    expect(held).toMatchObject({ status: 'REJECTED', releaseWithItem: NEW_ITEM });
    expect(JSON.stringify(held!.request)).toContain(NEW_ITEM);
    await completeOfflineItem(db, NEW_REQ, { itemId: SERVER, mapped: true }, 20);
    const released = await db.offlinePurchases.get(BILL);
    expect(released!.status).toBe('QUEUED');
    expect(JSON.stringify(released!.request)).toContain(SERVER);
    expect((await db.outbox.toArray()).map((r) => r.clientId)).toEqual([BILL]);
    expect((await db.conflicts.toArray()).filter((c) => c.status === 'OPEN')).toEqual([]);
  });
  it('rename refused again: the bill stays held and can be fixed from the new item', async () => {
    const db = await refused();
    await renameRefusedItem(db, REQ, { clientId: NEW_REQ, itemId: NEW_ITEM, name: 'Atta 2' }, 10);
    await rejectOfflineItem(db, NEW_REQ, 'DSB_ITEM_NAME_TAKEN', 'taken again', 12);
    expect((await db.offlinePurchases.get(BILL))!.status).toBe('REJECTED');
    const done = await useExistingItemForRefused(db, NEW_REQ, same, true, 13);
    expect(done).toMatchObject({ kind: 'refused' }); // other name than "Atta 2"
    const ok = await useExistingItemForRefused(
      db,
      NEW_REQ,
      { itemId: EXISTING, fields: { ...fields, name: 'Atta 2' } },
      true,
      14,
    );
    expect(ok).toMatchObject({ kind: 'done', requeued: [BILL] });
  });
  it('resolveLocalConflicts records who and when and is safe twice', async () => {
    const db = await refused();
    const ids = (await db.conflicts.toArray()).map((c) => c.id!);
    await resolveLocalConflicts(db, ids, 'user-1', 50);
    await resolveLocalConflicts(db, ids, 'user-2', 60);
    const rows = await db.conflicts.toArray();
    expect(
      rows.every(
        (c) => c.status === 'RESOLVED' && c.resolvedBy === 'user-1' && c.resolvedAt === 50,
      ),
    ).toBe(true);
  });
});

describe('hiding a finished item entry', () => {
  it('hides a refused entry from display only; a waiting one cannot be hidden', async () => {
    const db = await newDb();
    await queueOfflineItem(db, item());
    await expect(closeOfflineItemRecord(db, REQ)).rejects.toThrow('waiting');
    await rejectOfflineItem(db, REQ, ITEM_REJECTED_CODE, 'refused');
    await closeOfflineItemRecord(db, REQ, 5);
    const [r] = await listOfflineItemRecords(db, 't');
    expect(r?.status).toBe('REJECTED');
    expect(r?.closedAt).toBe(5);
  });
});
