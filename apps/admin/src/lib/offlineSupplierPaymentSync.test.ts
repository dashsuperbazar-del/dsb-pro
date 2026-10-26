import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  DsbSyncDb,
  markOutboxSending,
  queueOfflineSupplierPayment,
  type OutboxEntry,
} from '@dsb-pro/sync';
import {
  syncQueuedSupplierPayment,
  type SupplierPaymentSyncDeps,
} from './offlineSupplierPaymentSync';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) {
    db.close();
    await db.delete();
  }
});
const REQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTY = '11111111-1111-4111-8111-111111111111';
const BILL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAY = '55555555-5555-4555-8555-555555555555';
const V = '0123456789abcdef0123456789abcdef';

async function setup() {
  const db = new DsbSyncDb(`supplier-pay-sync-${crypto.randomUUID()}`);
  open.push(db);
  await db.open();
  await queueOfflineSupplierPayment(db, {
    clientId: REQ,
    shopId: 'shop',
    partyId: PARTY,
    partyName: 'Traders',
    businessDate: '2026-10-26',
    amountPaise: '6000',
    mode: 'upi',
    reference: 'utr-1',
    allocations: [{ purchaseBillId: BILL, billLabel: 'B-1', amountPaise: '6000' }],
    baseVersions: { supplier: V, bills: { [BILL]: V } },
    form: { amount: '60' },
    limits: { owedPaise: '10000', bills: { [BILL]: '6000' } },
  });
  return db;
}
const row = async (db: DsbSyncDb): Promise<OutboxEntry> =>
  markOutboxSending((await db.outbox.toArray())[0]!);
function deps(over: Partial<SupplierPaymentSyncDeps> = {}): SupplierPaymentSyncDeps {
  return {
    pay: vi.fn(async () => ({
      kind: 'committed' as const,
      value: { paymentId: PAY, allocationIds: [] },
    })),
    plain: (m) => `plain: ${m}`,
    ...over,
  };
}

describe('syncQueuedSupplierPayment', () => {
  it('sends the frozen request under the record id; committed → SYNCED and the outbox row is gone', async () => {
    const db = await setup();
    const d = deps();
    await expect(syncQueuedSupplierPayment(db, await row(db), d)).resolves.toEqual({
      kind: 'synced',
    });
    expect(d.pay).toHaveBeenCalledWith({
      requestId: REQ,
      shopId: 'shop',
      partyId: PARTY,
      businessDate: '2026-10-26',
      amountPaise: '6000',
      mode: 'upi',
      reference: 'utr-1',
      allocations: [{ purchaseBillId: BILL, amountPaise: '6000' }],
      baseVersions: { supplier: V, bills: { [BILL]: V } },
    });
    expect(await db.outbox.count()).toBe(0);
    expect(await db.offlineSupplierPayments.get(REQ)).toMatchObject({
      status: 'SYNCED',
      resultPaymentId: PAY,
    });
  });

  it('a definitive refusal → REJECTED with the form kept, a conflict, and the plain reason', async () => {
    const db = await setup();
    const d = deps({
      pay: vi.fn(async () => ({
        kind: 'rejected' as const,
        code: 'DSB_BILL_CHANGED',
        message: 'DSB_BILL_CHANGED: x',
      })),
    });
    await expect(syncQueuedSupplierPayment(db, await row(db), d)).resolves.toEqual({
      kind: 'rejected',
      reason: 'plain: DSB_BILL_CHANGED: x',
    });
    expect(await db.offlineSupplierPayments.get(REQ)).toMatchObject({
      status: 'REJECTED',
      rejectionCode: 'DSB_BILL_CHANGED',
      form: { amount: '60' },
    });
    expect(await db.outbox.count()).toBe(0);
    expect(await db.conflicts.count()).toBe(1);
  });

  it('an unknown outcome throws, leaving the record QUEUED and the row to be retried', async () => {
    const db = await setup();
    const d = deps({ pay: vi.fn(async () => ({ kind: 'unknown' as const, message: 'offline' })) });
    await expect(syncQueuedSupplierPayment(db, await row(db), d)).rejects.toThrow('offline');
    expect((await db.offlineSupplierPayments.get(REQ))!.status).toBe('QUEUED');
    expect(await db.outbox.count()).toBe(1);
  });

  it('an already-synced record is never sent again (double send after a restart)', async () => {
    const db = await setup();
    const sending = await row(db);
    await syncQueuedSupplierPayment(db, sending, deps());
    const d = deps();
    await expect(syncQueuedSupplierPayment(db, sending, d)).resolves.toEqual({ kind: 'synced' });
    expect(d.pay).not.toHaveBeenCalled();
  });

  it('a payload that does not match its record is never sent', async () => {
    const db = await setup();
    const sending = await row(db);
    const bad = {
      ...sending,
      payload: {
        ...(sending.payload as object),
        request: { shopId: 'shop', partyId: PARTY, amountPaise: '9' },
      },
    } as OutboxEntry;
    const d = deps();
    await expect(syncQueuedSupplierPayment(db, bad, d)).rejects.toThrow(/does not match/);
    expect(d.pay).not.toHaveBeenCalled();
  });
});
