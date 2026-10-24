import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  DsbSyncDb,
  completeOfflineItem,
  markOutboxSending,
  queueOfflineBillChange,
  queueOfflineItem,
  rejectOfflineItem,
  type OutboxEntry,
} from '@dsb-pro/sync';
import { syncQueuedBillChange, type BillChangeSyncDeps } from './offlineBillChangeSync';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) {
    db.close();
    await db.delete();
  }
});
const REQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BILL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V = '0123456789abcdef0123456789abcdef';

async function setup(kind: 'edit' | 'void') {
  const db = new DsbSyncDb(`bill-change-sync-${crypto.randomUUID()}`);
  open.push(db);
  await db.open();
  await queueOfflineBillChange(db, {
    clientId: REQ,
    shopId: 'shop',
    kind,
    billId: BILL,
    billLabel: 'B-1',
    baseVersion: V,
    request:
      kind === 'edit'
        ? { shopId: 'shop', clientId: REQ, originalId: BILL, lines: [] }
        : { purchaseId: BILL, reason: 'twice' },
    form: {},
  });
  return db;
}
const row = async (db: DsbSyncDb): Promise<OutboxEntry> =>
  markOutboxSending((await db.outbox.toArray())[0]!);
function deps(over: Partial<BillChangeSyncDeps> = {}): BillChangeSyncDeps {
  return {
    edit: vi.fn(async () => ({
      kind: 'committed' as const,
      value: {
        billId: NEW,
        originalBillId: BILL,
        paymentId: null,
        totalPaise: 0,
        roundOffPaise: 0,
        businessDate: 'x',
        carriedPaise: 0,
      },
    })),
    void: vi.fn(async () => ({ kind: 'committed' as const, value: { billId: BILL } })),
    plainEdit: (m) => `plain ${m}`,
    plainVoid: (m) => `plain ${m}`,
    ...over,
  };
}

describe('syncQueuedBillChange', () => {
  it('edit: sends the frozen request with the base version; SYNCED with the corrected bill', async () => {
    const db = await setup('edit');
    const d = deps();
    expect(await syncQueuedBillChange(db, await row(db), d)).toEqual({ kind: 'synced' });
    expect(d.edit).toHaveBeenCalledWith(
      { shopId: 'shop', clientId: REQ, originalId: BILL, lines: [] },
      V,
    );
    expect(await db.offlineBillChanges.get(REQ)).toMatchObject({
      status: 'SYNCED',
      resultBillId: NEW,
    });
    expect(await db.outbox.count()).toBe(0);
  });

  it('a stale version is REJECTED with the plain reason and the form kept', async () => {
    const db = await setup('edit');
    const done = await syncQueuedBillChange(
      db,
      await row(db),
      deps({
        edit: async () => ({ kind: 'rejected', code: 'DSB_BILL_CHANGED', message: 'changed' }),
      }),
    );
    expect(done).toEqual({ kind: 'rejected', reason: 'plain changed' });
    expect(await db.offlineBillChanges.get(REQ)).toMatchObject({
      status: 'REJECTED',
      rejectionCode: 'DSB_BILL_CHANGED',
    });
  });

  it('void: sends reason and version; unknown outcome throws and keeps the row for retry', async () => {
    const db = await setup('void');
    const d = deps({ void: vi.fn(async () => ({ kind: 'unknown' as const, message: 'lost' })) });
    await expect(syncQueuedBillChange(db, await row(db), d)).rejects.toThrow('lost');
    expect(d.void).toHaveBeenCalledWith({
      shopId: 'shop',
      purchaseId: BILL,
      clientId: REQ,
      reason: 'twice',
      baseVersion: V,
    });
    expect(await db.outbox.count()).toBe(1);
    expect((await db.offlineBillChanges.get(REQ))!.status).toBe('QUEUED');
    expect(await syncQueuedBillChange(db, await row(db), deps())).toEqual({ kind: 'synced' });
  });

  describe('an edit naming a device-created item', () => {
    const ITEM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const IREQ = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    async function setupWithItem() {
      const db = new DsbSyncDb(`bill-change-item-${crypto.randomUUID()}`);
      open.push(db);
      await db.open();
      await queueOfflineItem(db, {
        clientId: IREQ,
        itemId: ITEM,
        tenantId: 't',
        fields: { name: 'Atta', unit1: 'bag' },
      });
      await queueOfflineBillChange(db, {
        clientId: REQ,
        shopId: 'shop',
        kind: 'edit',
        billId: BILL,
        billLabel: 'B-1',
        baseVersion: V,
        request: { shopId: 'shop', clientId: REQ, originalId: BILL, lines: [{ itemId: ITEM }] },
        form: {},
      });
      return db;
    }
    const editRow = async (db: DsbSyncDb) =>
      markOutboxSending((await db.outbox.where('clientId').equals(REQ).first())!);

    it('waits while the item is queued; never sends the device id', async () => {
      const db = await setupWithItem();
      const d = deps();
      await expect(syncQueuedBillChange(db, await editRow(db), d)).rejects.toThrow(
        /Waiting for the new item/,
      );
      expect(d.edit).not.toHaveBeenCalled();
    });

    it('sends the server id after a match', async () => {
      const db = await setupWithItem();
      await completeOfflineItem(db, IREQ, { itemId: NEW, mapped: true });
      const d = deps();
      expect(await syncQueuedBillChange(db, await editRow(db), d)).toEqual({ kind: 'synced' });
      expect((d.edit as ReturnType<typeof vi.fn>).mock.calls[0]![0].lines[0].itemId).toBe(NEW);
    });

    it('a still-remapped device id (edit already attempted) is refused on the device, not sent', async () => {
      const db = await setupWithItem();
      const row = await db.outbox.where('clientId').equals(REQ).first();
      await db.outbox.put({ ...row!, attempts: 1 });
      await completeOfflineItem(db, IREQ, { itemId: NEW, mapped: true });
      const d = deps();
      const done = await syncQueuedBillChange(db, await editRow(db), d);
      expect(done.kind).toBe('rejected');
      expect(d.edit).not.toHaveBeenCalled();
      expect((await db.offlineBillChanges.get(REQ))!.rejectionCode).toBe('DSB_ITEM_REMAPPED');
    });

    it('a refused item refuses the edit before it is sent', async () => {
      const db = await setupWithItem();
      await rejectOfflineItem(db, IREQ, 'DSB_ITEM_NAME_TAKEN', 'taken');
      expect((await db.offlineBillChanges.get(REQ))!.status).toBe('REJECTED');
      expect(await db.outbox.count()).toBe(0);
    });
  });
});
