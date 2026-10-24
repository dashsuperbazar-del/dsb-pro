import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  DsbSyncDb,
  markOutboxSending,
  queueOfflineItem,
  queueOfflinePurchase,
  type OutboxEntry,
} from '@dsb-pro/sync';
import { syncQueuedItem, type ItemSyncDeps } from './offlineItemSync';
import { syncQueuedPurchase, type PurchaseSyncDeps } from './offlinePurchaseSync';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) {
    db.close();
    await db.delete();
  }
});
const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BILL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SERVER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

async function setup() {
  const db = new DsbSyncDb(`item-sync-${crypto.randomUUID()}`);
  open.push(db);
  await db.open();
  await queueOfflineItem(db, {
    clientId: REQ,
    itemId: ITEM,
    tenantId: 't',
    fields: { name: 'Atta', unit1: 'bag' },
  });
  await queueOfflinePurchase(db, {
    clientId: BILL,
    shopId: 'shop',
    request: {
      shopId: 'shop',
      clientId: BILL,
      lines: [{ itemId: ITEM, unitLevel: 1, qty: '1', unitPricePaise: 500 }],
    },
    draft: null,
    documentScope: 's:',
    documents: [],
    supplierName: null,
    billNo: null,
    businessDate: '2026-10-24',
    paymentType: 'credit',
    totalPaise: 500,
    lines: [{ itemId: ITEM, itemName: 'Atta', qty: '1', unitName: 'bag' }],
  });
  return db;
}
async function row(db: DsbSyncDb, clientId: string): Promise<OutboxEntry> {
  return markOutboxSending((await db.outbox.where('clientId').equals(clientId).first())!);
}
const itemDeps = (create: ItemSyncDeps['create']): ItemSyncDeps => ({ create, plain: (m) => m });
function purchaseDeps(): PurchaseSyncDeps {
  return {
    post: vi.fn(async () => ({
      kind: 'committed' as const,
      value: {
        billId: SERVER,
        paymentId: null,
        totalPaise: 500,
        roundOffPaise: 0,
        businessDate: 'x',
      },
    })),
    lookup: vi.fn(async () => ({ kind: 'not_found' as const })),
    upload: vi.fn(async () => undefined),
    readLocal: vi.fn(async () => null),
    removeLocal: vi.fn(async () => undefined),
  };
}

describe('syncQueuedItem', () => {
  it('creates the item, then the bill posts under it', async () => {
    const db = await setup();
    const create = vi.fn(async () => ({
      kind: 'committed' as const,
      value: { itemId: ITEM, mapped: false, name: null },
    }));
    expect(await syncQueuedItem(db, await row(db, REQ), itemDeps(create))).toEqual({
      kind: 'synced',
    });
    expect(create).toHaveBeenCalledWith({
      itemId: ITEM,
      clientId: REQ,
      item: { name: 'Atta', unit1: 'bag' },
    });
    const d = purchaseDeps();
    expect(await syncQueuedPurchase(db, await row(db, BILL), d)).toBe('synced');
    expect((d.post as ReturnType<typeof vi.fn>).mock.calls[0]![0].lines[0].itemId).toBe(ITEM);
  });

  it('a match points the queued bill at the existing item before it is sent', async () => {
    const db = await setup();
    await syncQueuedItem(
      db,
      await row(db, REQ),
      itemDeps(async () => ({
        kind: 'committed',
        value: { itemId: SERVER, mapped: true, name: 'ATTA' },
      })),
    );
    const d = purchaseDeps();
    expect(await syncQueuedPurchase(db, await row(db, BILL), d)).toBe('synced');
    expect((d.post as ReturnType<typeof vi.fn>).mock.calls[0]![0].lines[0].itemId).toBe(SERVER);
  });

  it('a refusal keeps the item visible and the bill never posts', async () => {
    const db = await setup();
    const done = await syncQueuedItem(
      db,
      await row(db, REQ),
      itemDeps(async () => ({
        kind: 'rejected',
        code: 'DSB_ITEM_NAME_TAKEN',
        message: 'name taken',
      })),
    );
    expect(done).toEqual({ kind: 'rejected', heldBills: [BILL], reason: 'name taken' });
    expect(await db.outbox.count()).toBe(0);
    expect((await db.offlinePurchases.get(BILL))?.status).toBe('REJECTED');
    expect((await db.offlineItems.get(REQ))?.status).toBe('REJECTED');
  });

  it('an unknown outcome throws (retry; the bill stays queued behind it)', async () => {
    const db = await setup();
    await expect(
      syncQueuedItem(
        db,
        await row(db, REQ),
        itemDeps(async () => ({ kind: 'unknown', message: 'lost' })),
      ),
    ).rejects.toThrow('lost');
    expect(await db.outbox.count()).toBe(2);
    // The bill cannot be sent while its item waits.
    const d = purchaseDeps();
    await expect(syncQueuedPurchase(db, await row(db, BILL), d)).rejects.toThrow(
      /Waiting for the new item/,
    );
    expect(d.post).not.toHaveBeenCalled();
  });
});
