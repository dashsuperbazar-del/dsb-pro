import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  DsbSyncDb,
  markOutboxSending,
  queueOfflineBillChange,
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
});
