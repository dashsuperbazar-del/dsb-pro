import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { DsbSyncDb } from './db';
import { nextOutboxEntry } from './outbox';
import {
  ITEM_OUTBOX_TARGET,
  ITEM_REJECTED_CODE,
  completeOfflineItem,
  listOfflineItemRecords,
  purchaseItemGate,
  queueOfflineItem,
  rejectOfflineItem,
} from './offlineItem';
import { PURCHASE_OUTBOX_TARGET, queueOfflinePurchase } from './offlinePurchase';

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
});
