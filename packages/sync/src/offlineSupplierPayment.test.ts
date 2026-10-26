import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { DsbSyncDb } from './db';
import { queueOfflineBillChange } from './offlineBillChange';
import {
  SUPPLIER_PAYMENT_OUTBOX_TARGET,
  closeRejectedOfflineSupplierPayment,
  completeOfflineSupplierPayment,
  getSupplierPayCopy,
  listOfflineSupplierPaymentRecords,
  queueOfflineSupplierPayment,
  queuedSupplierPaymentTotals,
  rejectOfflineSupplierPayment,
  saveSupplierPayCopy,
  type QueueOfflineSupplierPaymentInput,
  type SupplierPayCopy,
} from './offlineSupplierPayment';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) {
    db.close();
    await db.delete();
  }
});
async function newDb() {
  const db = new DsbSyncDb(`supplier-pay-${crypto.randomUUID()}`);
  open.push(db);
  await db.open();
  return db;
}
const REQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQ2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQ3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PARTY = '11111111-1111-4111-8111-111111111111';
const BILL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BILL2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const V = '0123456789abcdef0123456789abcdef';
const V2 = 'fedcba9876543210fedcba9876543210';
const limits = { owedPaise: '15000', bills: { [BILL]: '10000', [BILL2]: '5000' } };
const input = (
  over: Partial<QueueOfflineSupplierPaymentInput> = {},
): QueueOfflineSupplierPaymentInput => ({
  clientId: REQ,
  shopId: 'shop',
  partyId: PARTY,
  partyName: 'Traders',
  businessDate: '2026-10-26',
  amountPaise: '6000',
  mode: 'cash',
  reference: null,
  allocations: [{ purchaseBillId: BILL, billLabel: 'B-1', amountPaise: '6000' }],
  baseVersions: { supplier: V, bills: { [BILL]: V2 } },
  form: { amount: '60', mode: 'cash' },
  limits,
  ...over,
});

describe('offline supplier payments (device queue)', () => {
  it('queues the payment with its versions in the ordered outbox; replay returns it; nothing else changes', async () => {
    const db = await newDb();
    const rec = await queueOfflineSupplierPayment(db, input(), 5);
    expect(rec.status).toBe('QUEUED');
    const [row] = await db.outbox.toArray();
    expect(row).toMatchObject({
      target: SUPPLIER_PAYMENT_OUTBOX_TARGET,
      clientId: REQ,
      kind: 'financial-rpc',
      sequence: 1,
    });
    expect(row!.payload).toEqual({
      request: {
        shopId: 'shop',
        partyId: PARTY,
        businessDate: '2026-10-26',
        amountPaise: '6000',
        mode: 'cash',
        reference: null,
        allocations: [{ purchaseBillId: BILL, amountPaise: '6000' }],
      },
      baseVersions: { supplier: V, bills: { [BILL]: V2 } },
    });
    // Double tap / second tab with the same id: the same record, one outbox row.
    expect(await queueOfflineSupplierPayment(db, input())).toEqual(rec);
    expect(await db.outbox.count()).toBe(1);
    expect(await db.stock.count()).toBe(0);
  });

  it('refuses the same id with different content, and an id used by another operation', async () => {
    const db = await newDb();
    await queueOfflineSupplierPayment(db, input());
    await expect(
      queueOfflineSupplierPayment(db, input({ amountPaise: '5000', allocations: [] })),
    ).rejects.toThrow(/different payment/);
    await db.outbox.put({
      sequence: 9,
      clientId: REQ2,
      kind: 'financial-rpc',
      target: 'post_sale',
      payload: {},
      createdAt: 1,
      attempts: 0,
      state: 'pending',
      nextAttemptAt: 0,
      lastError: null,
    });
    await expect(queueOfflineSupplierPayment(db, input({ clientId: REQ2 }))).rejects.toThrow(
      /already queued/,
    );
  });

  it.each([
    ['zero', { amountPaise: '0', allocations: [] }, /positive/],
    ['negative', { amountPaise: '-5', allocations: [] }, /positive/],
    ['decimal', { amountPaise: '10.5', allocations: [] }, /positive/],
    ['unsafe', { amountPaise: '9007199254740993', allocations: [] }, /too large/],
    ['bad mode', { mode: 'barter' as never }, /mode/],
    ['long reference', { reference: 'x'.repeat(201) }, /Reference/],
    [
      'allocation above the payment',
      { allocations: [{ purchaseBillId: BILL, billLabel: 'B', amountPaise: '6001' }] },
      /more than the payment/,
    ],
    [
      'duplicate bill',
      {
        amountPaise: '6000',
        allocations: [
          { purchaseBillId: BILL, billLabel: 'B', amountPaise: '3000' },
          { purchaseBillId: BILL, billLabel: 'B', amountPaise: '3000' },
        ],
      },
      /once/,
    ],
    ['missing bill version', { baseVersions: { supplier: V, bills: {} } }, /version/],
    [
      'missing supplier version',
      { baseVersions: { supplier: 'x', bills: { [BILL]: V2 } } },
      /version/,
    ],
  ] as const)('refuses a %s payment before saving anything', async (_n, over, message) => {
    const db = await newDb();
    await expect(
      queueOfflineSupplierPayment(db, input(over as Partial<QueueOfflineSupplierPaymentInput>)),
    ).rejects.toThrow(message);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.offlineSupplierPayments.count()).toBe(0);
  });

  it('a second queued payment sees the first: refused past what is owed or what the bill still owes', async () => {
    const db = await newDb();
    await queueOfflineSupplierPayment(db, input());
    // Bill B-1 has 4000 left after the first; 5000 on it is refused, 4000 fits.
    await expect(
      queueOfflineSupplierPayment(
        db,
        input({
          clientId: REQ2,
          amountPaise: '5000',
          allocations: [{ purchaseBillId: BILL, billLabel: 'B-1', amountPaise: '5000' }],
        }),
      ),
    ).rejects.toThrow(/B-1.*only/);
    await queueOfflineSupplierPayment(
      db,
      input({
        clientId: REQ2,
        amountPaise: '4000',
        allocations: [{ purchaseBillId: BILL, billLabel: 'B-1', amountPaise: '4000' }],
      }),
    );
    // 15000 owed, 10000 queued: 5001 more is over what is owed, 5000 fits.
    await expect(
      queueOfflineSupplierPayment(
        db,
        input({
          clientId: REQ3,
          amountPaise: '5001',
          allocations: [],
          baseVersions: { supplier: V, bills: {} },
        }),
      ),
    ).rejects.toThrow(/more than is owed/);
    await queueOfflineSupplierPayment(
      db,
      input({
        clientId: REQ3,
        amountPaise: '5000',
        allocations: [],
        baseVersions: { supplier: V, bills: {} },
      }),
    );
    expect(await db.outbox.count()).toBe(3);
    const totals = await queuedSupplierPaymentTotals(db, 'shop');
    expect(totals.bySupplier[PARTY]).toBe(15000n);
    expect(totals.byBill[BILL]).toBe(10000n);
  });

  it('refuses to assign a payment to a bill that has an edit or void waiting on this device', async () => {
    const db = await newDb();
    await queueOfflineBillChange(db, {
      clientId: REQ2,
      shopId: 'shop',
      kind: 'void',
      billId: BILL,
      billLabel: 'B-1',
      baseVersion: V,
      request: { purchaseId: BILL, reason: 'x' },
      form: {},
    });
    await expect(queueOfflineSupplierPayment(db, input())).rejects.toThrow(/waiting/);
    expect(await db.offlineSupplierPayments.count()).toBe(0);
  });

  it('complete is idempotent and removes the outbox row; the record keeps the payment id', async () => {
    const db = await newDb();
    await queueOfflineSupplierPayment(db, input());
    const done = await completeOfflineSupplierPayment(db, REQ, { paymentId: 'pay-1' }, 9);
    expect(done).toMatchObject({ status: 'SYNCED', syncedAt: 9, resultPaymentId: 'pay-1' });
    expect(await db.outbox.count()).toBe(0);
    expect(await completeOfflineSupplierPayment(db, REQ, { paymentId: 'pay-1' }, 99)).toEqual(done);
  });

  it('reject keeps the full form, drops the outbox row, opens a conflict; only a refused one closes', async () => {
    const db = await newDb();
    await queueOfflineSupplierPayment(db, input());
    await expect(closeRejectedOfflineSupplierPayment(db, REQ)).rejects.toThrow(/refused/);
    await rejectOfflineSupplierPayment(db, REQ, 'DSB_BILL_CHANGED', 'The bill changed.');
    const rec = (await listOfflineSupplierPaymentRecords(db, 'shop'))[0]!;
    expect(rec).toMatchObject({
      status: 'REJECTED',
      rejectionCode: 'DSB_BILL_CHANGED',
      rejectionReason: 'The bill changed.',
      form: { amount: '60', mode: 'cash' },
    });
    expect(await db.outbox.count()).toBe(0);
    expect(await db.conflicts.count()).toBe(1);
    await expect(completeOfflineSupplierPayment(db, REQ, { paymentId: 'p' })).rejects.toThrow(
      /refused/,
    );
    // A refused payment no longer counts against what is owed.
    expect((await queuedSupplierPaymentTotals(db, 'shop')).bySupplier[PARTY]).toBeUndefined();
    await closeRejectedOfflineSupplierPayment(db, REQ, 50);
    expect((await listOfflineSupplierPaymentRecords(db, 'shop'))[0]!.closedAt).toBe(50);
    await expect(rejectOfflineSupplierPayment(db, 'nope', 'X', 'y')).resolves.toBeUndefined();
  });

  it('keeps the device copy of suppliers with its saved time, per shop', async () => {
    const db = await newDb();
    const copy: SupplierPayCopy = {
      shopId: 'shop',
      savedAt: 123,
      businessDate: '2026-10-26',
      suppliers: [{ partyId: PARTY, name: 'Traders', owedPaise: '15000', version: V, bills: [] }],
    };
    expect(await getSupplierPayCopy(db, 'shop')).toBeNull();
    await saveSupplierPayCopy(db, copy);
    expect(await getSupplierPayCopy(db, 'shop')).toEqual(copy);
    expect(await getSupplierPayCopy(db, 'other-shop')).toBeNull();
  });
});
