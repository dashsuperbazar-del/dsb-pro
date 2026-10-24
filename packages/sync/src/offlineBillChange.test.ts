import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { DsbSyncDb } from './db';
import {
  BILL_CHANGE_OUTBOX_TARGET,
  closeRejectedOfflineBillChange,
  completeOfflineBillChange,
  listOfflineBillChangeRecords,
  queueOfflineBillChange,
  rejectOfflineBillChange,
  type QueueOfflineBillChangeInput,
} from './offlineBillChange';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) {
    db.close();
    await db.delete();
  }
});
async function newDb() {
  const db = new DsbSyncDb(`bill-change-${crypto.randomUUID()}`);
  open.push(db);
  await db.open();
  return db;
}
const REQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQ2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BILL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V = '0123456789abcdef0123456789abcdef';
const input = (over: Partial<QueueOfflineBillChangeInput> = {}): QueueOfflineBillChangeInput => ({
  clientId: REQ,
  shopId: 'shop',
  kind: 'edit',
  billId: BILL,
  billLabel: 'B-1',
  baseVersion: V,
  request: { originalId: BILL, clientId: REQ, lines: [] },
  form: { billNo: 'B-1' },
  ...over,
});

describe('offline bill changes', () => {
  it('queues the change with its base version in the ordered outbox; replay returns it', async () => {
    const db = await newDb();
    const rec = await queueOfflineBillChange(db, input(), 5);
    expect(rec.status).toBe('QUEUED');
    const [row] = await db.outbox.toArray();
    expect(row).toMatchObject({ target: BILL_CHANGE_OUTBOX_TARGET, clientId: REQ });
    expect(row!.payload).toEqual({
      kind: 'edit',
      billId: BILL,
      baseVersion: V,
      request: input().request,
    });
    expect(await queueOfflineBillChange(db, input())).toEqual(rec);
    expect(await db.outbox.count()).toBe(1);
    expect(await db.stock.count()).toBe(0);
  });

  it('one queued change per bill: a second edit or void is refused on the device', async () => {
    const db = await newDb();
    await queueOfflineBillChange(db, input());
    await expect(
      queueOfflineBillChange(db, input({ clientId: REQ2, kind: 'void', request: { reason: 'x' } })),
    ).rejects.toThrow(/already has an edit/);
    expect(await db.outbox.count()).toBe(1);
  });

  it('needs a version and lower-case ids', async () => {
    const db = await newDb();
    await expect(queueOfflineBillChange(db, input({ baseVersion: '' }))).rejects.toThrow(/version/);
    await expect(queueOfflineBillChange(db, input({ billId: 'X' }))).rejects.toThrow(/UUID/);
  });

  it('confirmed: SYNCED with the corrected bill id, idempotent; then the bill can change again', async () => {
    const db = await newDb();
    await queueOfflineBillChange(db, input());
    const done = await completeOfflineBillChange(db, REQ, { resultBillId: NEW }, 9);
    expect(done).toMatchObject({ status: 'SYNCED', resultBillId: NEW, syncedAt: 9 });
    expect(await completeOfflineBillChange(db, REQ, { resultBillId: NEW })).toEqual(done);
    expect(await db.outbox.count()).toBe(0);
    await queueOfflineBillChange(db, input({ clientId: REQ2, kind: 'void' }));
  });

  it('refused: stays visible with the form and a conflict; closable; never confirmed later', async () => {
    const db = await newDb();
    await queueOfflineBillChange(db, input());
    await rejectOfflineBillChange(db, REQ, 'DSB_BILL_CHANGED', 'changed');
    const [rec] = await listOfflineBillChangeRecords(db, 'shop');
    expect(rec).toMatchObject({
      status: 'REJECTED',
      rejectionCode: 'DSB_BILL_CHANGED',
      form: { billNo: 'B-1' },
    });
    expect(await db.outbox.count()).toBe(0);
    expect(await db.conflicts.count()).toBe(1);
    await expect(completeOfflineBillChange(db, REQ, { resultBillId: NEW })).rejects.toThrow();
    await closeRejectedOfflineBillChange(db, REQ, 3);
    expect((await db.offlineBillChanges.get(REQ))!.closedAt).toBe(3);
    // A refused change no longer blocks a new one.
    await queueOfflineBillChange(db, input({ clientId: REQ2 }));
  });
});
