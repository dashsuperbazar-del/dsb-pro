import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  DsbSyncDb,
  markOutboxSending,
  queueOfflinePurchase,
  type OutboxEntry,
  type QueueOfflinePurchaseInput,
} from '@dsb-pro/sync';
import { PHOTO_MISSING, syncQueuedPurchase, type PurchaseSyncDeps } from './offlinePurchaseSync';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) {
    db.close();
    await db.delete();
  }
});
const CLIENT = '22222222-2222-4222-8222-222222222222';
const BILL = '33333333-3333-4333-8333-333333333333';
function input(photos = 1): QueueOfflinePurchaseInput {
  return {
    clientId: CLIENT,
    shopId: 'shop',
    request: { shopId: 'shop', clientId: CLIENT, paymentType: 'credit', lines: [] },
    draft: { version: 2 },
    documentScope: 'scope:',
    documents: Array.from({ length: photos }, (_, i) => ({
      id: `doc${i}`,
      path: `t/shop/${CLIENT}/doc${i}.webp`,
      name: 'b.webp',
      mime: 'image/webp' as const,
      size: 1,
      sha256: 'h',
      uploaded: false,
    })),
    supplierName: null,
    billNo: null,
    businessDate: '2026-10-22',
    paymentType: 'credit',
    totalPaise: 500,
    lines: [{ itemId: 'i', itemName: 'Rice', qty: '1', unitName: 'bag' }],
  };
}
async function setup(photos = 1) {
  const db = new DsbSyncDb(`purchase-sync-${crypto.randomUUID()}`);
  open.push(db);
  await db.open();
  await queueOfflinePurchase(db, input(photos));
  return db;
}
async function sendingRow(db: DsbSyncDb, attempts = 0): Promise<OutboxEntry> {
  const row = (await db.outbox.toArray())[0]!;
  return markOutboxSending({ ...row, attempts });
}
function deps(over: Partial<PurchaseSyncDeps> = {}): PurchaseSyncDeps {
  return {
    post: vi.fn(async () => ({
      kind: 'committed' as const,
      value: {
        billId: BILL,
        paymentId: null,
        totalPaise: 500,
        roundOffPaise: 0,
        businessDate: '2026-10-22',
      },
    })),
    lookup: vi.fn(async () => ({ kind: 'not_found' as const })),
    upload: vi.fn(async () => undefined),
    readLocal: vi.fn(async () => new Blob(['x'])),
    removeLocal: vi.fn(async () => undefined),
    ...over,
  };
}

describe('syncQueuedPurchase', () => {
  it('uploads the photo once, posts the frozen request, marks SYNCED and frees the device copy', async () => {
    const db = await setup();
    const d = deps();
    expect(await syncQueuedPurchase(db, await sendingRow(db), d)).toBe('synced');
    expect(d.upload).toHaveBeenCalledTimes(1);
    expect(d.post).toHaveBeenCalledWith(input().request, true);
    expect((await db.offlinePurchases.get(CLIENT))?.status).toBe('SYNCED');
    expect(await db.outbox.count()).toBe(0);
    expect(d.removeLocal).toHaveBeenCalledWith('scope:', 'doc0');
  });

  it('after an unknown outcome the retry re-sends the SAME request as a retry (every send is a possible retry) and does not re-upload', async () => {
    const db = await setup();
    const unknown = deps({
      post: vi.fn(async () => ({ kind: 'unknown' as const, message: 'net' })),
    });
    await expect(syncQueuedPurchase(db, await sendingRow(db), unknown)).rejects.toThrow('net');
    expect((await db.offlinePurchases.get(CLIENT))?.status).toBe('QUEUED');
    expect(await db.outbox.count()).toBe(1);
    const d = deps();
    expect(await syncQueuedPurchase(db, await sendingRow(db, 1), d)).toBe('synced');
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.post).toHaveBeenCalledWith(input().request, true);
  });

  it('a definitive refusal becomes a visible REJECTED bill with its form; nothing is retried', async () => {
    const db = await setup(0);
    const d = deps({
      post: vi.fn(async () => ({
        kind: 'rejected' as const,
        code: 'REJECTED',
        message: 'unit tier unavailable',
      })),
    });
    expect(await syncQueuedPurchase(db, await sendingRow(db), d)).toBe('rejected');
    const rec = await db.offlinePurchases.get(CLIENT);
    expect(rec).toMatchObject({ status: 'REJECTED', rejectionReason: 'unit tier unavailable' });
    expect(rec?.draft).toEqual({ version: 2 });
    expect(await db.outbox.count()).toBe(0);
    expect(await db.conflicts.count()).toBe(1);
  });

  it('a failed photo upload leaves the bill queued and never posts it', async () => {
    const db = await setup();
    const d = deps({ upload: vi.fn(async () => Promise.reject(new Error('offline'))) });
    await expect(syncQueuedPurchase(db, await sendingRow(db), d)).rejects.toThrow('offline');
    expect(d.post).not.toHaveBeenCalled();
    expect((await db.offlinePurchases.get(CLIENT))?.status).toBe('QUEUED');
  });

  it('missing photo bytes: posted earlier → replay as retry; never posted → REJECTED; unknown → retry', async () => {
    let db = await setup();
    let d = deps({
      readLocal: vi.fn(async () => null),
      lookup: vi.fn(async () => ({
        kind: 'committed' as const,
        result: {},
        currentStatus: 'POSTED',
      })),
    });
    expect(await syncQueuedPurchase(db, await sendingRow(db), d)).toBe('synced');
    expect(d.post).toHaveBeenCalledWith(input().request, true);

    db = await setup();
    d = deps({ readLocal: vi.fn(async () => null) });
    expect(await syncQueuedPurchase(db, await sendingRow(db), d)).toBe('rejected');
    expect(d.post).not.toHaveBeenCalled();
    expect((await db.offlinePurchases.get(CLIENT))?.rejectionReason).toBe(PHOTO_MISSING);

    db = await setup();
    d = deps({
      readLocal: vi.fn(async () => null),
      lookup: vi.fn(async () => ({ kind: 'unavailable' as const, message: 'down' })),
    });
    await expect(syncQueuedPurchase(db, await sendingRow(db), d)).rejects.toThrow(/down/);
    expect((await db.offlinePurchases.get(CLIENT))?.status).toBe('QUEUED');
  });

  it('an acknowledgement for another total still ends SYNCED (the server committed) with a warning', async () => {
    const db = await setup(0);
    const d = deps({
      post: vi.fn(async () => ({
        kind: 'committed' as const,
        value: {
          billId: BILL,
          paymentId: null,
          totalPaise: 1,
          roundOffPaise: 0,
          businessDate: 'x',
        },
      })),
    });
    expect(await syncQueuedPurchase(db, await sendingRow(db), d)).toBe('synced');
    const rec = await db.offlinePurchases.get(CLIENT);
    expect(rec?.status).toBe('SYNCED');
    expect(rec?.reconciliationWarning).toBeTruthy();
    expect(await db.outbox.count()).toBe(0);
  });
});
