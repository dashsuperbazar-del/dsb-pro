import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { DsbSyncDb, setMeta } from './db';
import { nextOutboxEntry } from './outbox';
import {
  closeRejectedOfflinePurchase,
  completeOfflinePurchase,
  listOfflinePurchaseRecords,
  queueOfflinePurchase,
  rejectOfflinePurchase,
  type QueueOfflinePurchaseInput,
} from './offlinePurchase';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) {
    db.close();
    await db.delete();
  }
});
async function newDb() {
  const db = new DsbSyncDb(`offline-purchase-${crypto.randomUUID()}`);
  open.push(db);
  await db.open();
  return db;
}
const CLIENT = '11111111-1111-4111-8111-111111111111';
function input(over: Partial<QueueOfflinePurchaseInput> = {}): QueueOfflinePurchaseInput {
  return {
    clientId: CLIENT,
    shopId: 'shop',
    request: { api: 'v2', shopId: 'shop', clientId: CLIENT, paymentType: 'cash', lines: [] },
    draft: { version: 2, clientId: CLIENT },
    documentScope: 'scope:',
    documents: [
      {
        id: 'doc',
        path: `t/shop/${CLIENT}/doc.webp`,
        name: 'bill.webp',
        mime: 'image/webp',
        size: 3,
        sha256: 'abc',
        uploaded: false,
      },
    ],
    supplierName: 'Supplier',
    billNo: 'B-1',
    businessDate: '2026-10-22',
    paymentType: 'cash',
    totalPaise: 1500,
    lines: [{ itemId: 'item', itemName: 'Rice', qty: '3', unitName: 'bag' }],
    ...over,
  };
}

describe('offline purchases', () => {
  it('queues the bill and its exact request in the same ordered outbox as sales', async () => {
    const db = await newDb();
    await setMeta(db, 'outboxSeq', 4); // an offline sale was queued before
    const rec = await queueOfflinePurchase(db, input(), 10);
    expect(rec.status).toBe('QUEUED');
    const rows = await db.outbox.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sequence: 5,
      clientId: CLIENT,
      kind: 'financial-rpc',
      target: 'post_purchase_v2',
      state: 'pending',
    });
    expect(rows[0]!.payload).toEqual(input().request);
    expect(nextOutboxEntry(rows, 11)?.clientId).toBe(CLIENT);
    // Cached stock is never changed by an unsynced bill.
    expect(await db.stock.count()).toBe(0);
    expect(await db.reservations.count()).toBe(0);
  });

  it('saving the same bill twice (double tap, two tabs) keeps one record and one outbox row', async () => {
    const db = await newDb();
    await queueOfflinePurchase(db, input());
    const again = await queueOfflinePurchase(db, input({ totalPaise: 9999 }));
    expect(again.totalPaise).toBe(1500);
    expect(await db.outbox.count()).toBe(1);
    expect(await db.offlinePurchases.count()).toBe(1);
  });

  it('refuses a photo whose path belongs to another bill, and a mismatched identity', async () => {
    const db = await newDb();
    await expect(
      queueOfflinePurchase(
        db,
        input({ documents: [{ ...input().documents[0]!, path: 't/shop/other/doc.webp' }] }),
      ),
    ).rejects.toThrow(/another bill/);
    await expect(
      queueOfflinePurchase(db, input({ request: { shopId: 'shop', clientId: 'x' } })),
    ).rejects.toThrow(/identity/);
    expect(await db.outbox.count()).toBe(0);
  });

  it('completes once (idempotent) and refuses an acknowledgement with another total', async () => {
    const db = await newDb();
    await queueOfflinePurchase(db, input());
    await expect(
      completeOfflinePurchase(db, CLIENT, { billId: 'b', paymentId: 'p', totalPaise: 1 }),
    ).rejects.toThrow(/total/);
    expect(await db.outbox.count()).toBe(1);
    const done = await completeOfflinePurchase(db, CLIENT, {
      billId: 'b',
      paymentId: 'p',
      totalPaise: 1500,
    });
    expect(done).toMatchObject({ status: 'SYNCED', billId: 'b', paymentId: 'p' });
    expect(done.documents[0]!.uploaded).toBe(true);
    const again = await completeOfflinePurchase(db, CLIENT, {
      billId: 'b',
      paymentId: 'p',
      totalPaise: 1500,
    });
    expect(again.syncedAt).toBe(done.syncedAt);
    expect(await db.outbox.count()).toBe(0);
  });

  it('a refusal keeps the bill visible with its form, records a conflict and frees the queue', async () => {
    const db = await newDb();
    await queueOfflinePurchase(db, input());
    await rejectOfflinePurchase(db, CLIENT, 'party archived', 'party archived');
    const [rec] = await listOfflinePurchaseRecords(db, 'shop');
    expect(rec).toMatchObject({ status: 'REJECTED', rejectionReason: 'party archived' });
    expect(rec!.draft).toEqual(input().draft);
    expect(await db.outbox.count()).toBe(0);
    const conflicts = await db.conflicts.toArray();
    expect(conflicts[0]).toMatchObject({ target: 'post_purchase_v2', clientId: CLIENT });
    await expect(queueOfflinePurchase(db, input())).rejects.toThrow(/refused/);
    const closed = await closeRejectedOfflinePurchase(db, CLIENT, 7);
    expect(closed.closedAt).toBe(7);
    // Corrected under the same id (nothing was posted under it): queued again, one outbox row.
    const again = await queueOfflinePurchase(db, input({ totalPaise: 1600 }), 8);
    expect(again).toMatchObject({ status: 'QUEUED', totalPaise: 1600, closedAt: null });
    expect(await db.outbox.count()).toBe(1);
  });

  it('a synced bill can never be turned into a rejection or a draft', async () => {
    const db = await newDb();
    await queueOfflinePurchase(db, input());
    await completeOfflinePurchase(db, CLIENT, { billId: 'b', paymentId: 'p', totalPaise: 1500 });
    await expect(rejectOfflinePurchase(db, CLIENT, 'X', 'late')).rejects.toThrow(/synced/);
    await expect(closeRejectedOfflinePurchase(db, CLIENT)).rejects.toThrow(/refused/);
  });
});
