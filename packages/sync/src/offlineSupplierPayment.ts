import { getMeta, setMeta, type DsbSyncDb } from './db';
import type { LocalSyncConflict, OutboxEntry } from './types';

// Offline supplier payment (owner/manager; mig 0074). The device keeps a copy of the suppliers, what is owed,
// their open bills and a version token for each (read while online). A payment saved here carries the tokens it
// was based on; the server applies it only if they still hold (else a specific refusal, DSB_BILL_CHANGED etc.),
// never re-pointing it to another bill or supplier. Same ordered outbox as sales and purchases; idempotent by the
// request id (a resend returns the stored answer). A queued payment never changes the saved balances: they change
// only after the server confirms.
// Decision: payments queued for one supplier are limited on the device to what the saved copy says is owed,
// counting the payments already queued (the server checks again with the live figures and is the authority).

export const SUPPLIER_PAYMENT_OUTBOX_TARGET = 'supplier_payment';

export type SupplierPayMode = 'cash' | 'upi' | 'card' | 'bank' | 'other';
export type SupplierPayCopyBill = Readonly<{
  billId: string;
  billNo: string | null;
  businessDate: string;
  outstandingPaise: string;
  version: string;
}>;
export type SupplierPayCopySupplier = Readonly<{
  partyId: string;
  name: string;
  owedPaise: string;
  version: string;
  bills: readonly SupplierPayCopyBill[];
}>;
/** What the device keeps for offline "Pay supplier" (saved on the last online load; never edited locally). */
export type SupplierPayCopy = Readonly<{
  shopId: string;
  savedAt: number;
  businessDate: string;
  suppliers: readonly SupplierPayCopySupplier[];
}>;
const copyKey = (shopId: string) => `supplierPayCopy:${shopId}`;
export async function saveSupplierPayCopy(db: DsbSyncDb, copy: SupplierPayCopy): Promise<void> {
  await setMeta(db, copyKey(copy.shopId), copy);
}
export async function getSupplierPayCopy(
  db: DsbSyncDb,
  shopId: string,
): Promise<SupplierPayCopy | null> {
  return getMeta<SupplierPayCopy>(db, copyKey(shopId));
}

export type OfflineSupplierPaymentStatus = 'QUEUED' | 'SYNCED' | 'REJECTED';
export type OfflineSupplierAllocation = Readonly<{
  purchaseBillId: string;
  billLabel: string;
  amountPaise: string;
}>;
export type OfflineSupplierPaymentRecord = Readonly<{
  clientId: string;
  shopId: string;
  partyId: string;
  partyName: string;
  businessDate: string | null;
  amountPaise: string;
  mode: SupplierPayMode;
  reference: string | null;
  allocations: readonly OfflineSupplierAllocation[];
  baseVersions: Readonly<{ supplier: string; bills: Readonly<Record<string, string>> }>;
  /** The form as saved (shown in full on a refusal so the payment can be redone). */
  form: unknown;
  status: OfflineSupplierPaymentStatus;
  createdAt: number;
  syncedAt: number | null;
  resultPaymentId: string | null;
  rejectionCode: string | null;
  rejectionReason: string | null;
  closedAt: number | null;
}>;
export type QueueOfflineSupplierPaymentInput = Pick<
  OfflineSupplierPaymentRecord,
  | 'clientId'
  | 'shopId'
  | 'partyId'
  | 'partyName'
  | 'businessDate'
  | 'amountPaise'
  | 'mode'
  | 'reference'
  | 'allocations'
  | 'baseVersions'
  | 'form'
> & {
  /** What the saved copy says is owed (supplier total and each assigned bill), before queued payments. */
  limits: Readonly<{ owedPaise: string; bills: Readonly<Record<string, string>> }>;
};
export type SupplierPaymentOutboxPayload = Readonly<{
  request: Readonly<{
    shopId: string;
    partyId: string;
    businessDate: string | null;
    amountPaise: string;
    mode: SupplierPayMode;
    reference: string | null;
    allocations: readonly { purchaseBillId: string; amountPaise: string }[];
  }>;
  baseVersions: OfflineSupplierPaymentRecord['baseVersions'];
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9a-f]{32}$/;
const DIGITS = /^[0-9]{1,16}$/;
const MODES: readonly string[] = ['cash', 'upi', 'card', 'bank', 'other'];
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const rupees = (paise: bigint) => {
  const n = paise < 0n ? 0n : paise;
  return `₹${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
};

function parsePositive(text: string): bigint {
  if (!DIGITS.test(text) || BigInt(text) <= 0n)
    throw new Error('The amount must be a positive whole number of paise.');
  const value = BigInt(text);
  if (value > MAX_SAFE) throw new Error('The amount is too large.');
  return value;
}

/** Totals of the payments saved on this device and not yet confirmed, per supplier and per bill. */
export async function queuedSupplierPaymentTotals(
  db: DsbSyncDb,
  shopId: string,
): Promise<{ bySupplier: Record<string, bigint>; byBill: Record<string, bigint> }> {
  const bySupplier: Record<string, bigint> = {};
  const byBill: Record<string, bigint> = {};
  for (const r of await db.offlineSupplierPayments.where('shopId').equals(shopId).toArray()) {
    if (r.status !== 'QUEUED') continue;
    bySupplier[r.partyId] = (bySupplier[r.partyId] ?? 0n) + BigInt(r.amountPaise);
    for (const a of r.allocations)
      byBill[a.purchaseBillId] = (byBill[a.purchaseBillId] ?? 0n) + BigInt(a.amountPaise);
  }
  return { bySupplier, byBill };
}

export async function queueOfflineSupplierPayment(
  db: DsbSyncDb,
  input: QueueOfflineSupplierPaymentInput,
  now = Date.now(),
): Promise<OfflineSupplierPaymentRecord> {
  if (!UUID.test(input.clientId) || !UUID.test(input.partyId))
    throw new Error('Payment ids must be lower-case UUIDs.');
  const amount = parsePositive(input.amountPaise);
  if (!MODES.includes(input.mode)) throw new Error('Choose a payment mode.');
  if (input.reference !== null && input.reference.length > 200)
    throw new Error('Reference is too long (200 characters at most).');
  if (!VERSION.test(input.baseVersions.supplier))
    throw new Error('The supplier version is missing. Open Pay supplier again while online.');
  const seen = new Set<string>();
  let assigned = 0n;
  for (const a of input.allocations) {
    if (!UUID.test(a.purchaseBillId)) throw new Error('Bill ids must be lower-case UUIDs.');
    if (seen.has(a.purchaseBillId)) throw new Error('Each bill can be assigned once.');
    seen.add(a.purchaseBillId);
    assigned += parsePositive(a.amountPaise);
    if (!VERSION.test(input.baseVersions.bills[a.purchaseBillId] ?? ''))
      throw new Error(
        `The version of bill ${a.billLabel} is missing. Open Pay supplier again while online.`,
      );
  }
  if (assigned > amount)
    throw new Error('The amounts assigned to bills are more than the payment.');
  const request: SupplierPaymentOutboxPayload['request'] = {
    shopId: input.shopId,
    partyId: input.partyId,
    businessDate: input.businessDate,
    amountPaise: amount.toString(),
    mode: input.mode,
    reference: input.reference,
    allocations: input.allocations.map((a) => ({
      purchaseBillId: a.purchaseBillId,
      amountPaise: a.amountPaise,
    })),
  };
  return db.transaction(
    'rw',
    [db.outbox, db.meta, db.offlineSupplierPayments, db.offlineBillChanges],
    async () => {
      const existing = await db.offlineSupplierPayments.get(input.clientId);
      if (existing) {
        if (
          existing.partyId !== input.partyId ||
          existing.amountPaise !== request.amountPaise ||
          JSON.stringify(existing.allocations.map((a) => [a.purchaseBillId, a.amountPaise])) !==
            JSON.stringify(request.allocations.map((a) => [a.purchaseBillId, a.amountPaise]))
        )
          throw new Error('This request id belongs to a different payment.');
        return existing;
      }
      if (await db.outbox.where('clientId').equals(input.clientId).count())
        throw new Error('This request id is already queued for another operation.');
      // A bill with an edit or void waiting on this device is not paid until that is settled.
      const changes = await db.offlineBillChanges.where('status').equals('QUEUED').toArray();
      for (const a of input.allocations)
        if (changes.some((c) => c.billId === a.purchaseBillId))
          throw new Error(
            `Bill ${a.billLabel} has an edit or void waiting to sync on this device. Wait for it to sync, then pay it.`,
          );
      const totals = await queuedSupplierPaymentTotals(db, input.shopId);
      const owed = BigInt(input.limits.owedPaise);
      const queuedForSupplier = totals.bySupplier[input.partyId] ?? 0n;
      if (queuedForSupplier + amount > (owed < 0n ? 0n : owed))
        throw new Error(
          `This is more than is owed to ${input.partyName}: ${rupees(owed - queuedForSupplier)} is left to pay after the payments already saved on this device.`,
        );
      for (const a of input.allocations) {
        const outstanding = BigInt(input.limits.bills[a.purchaseBillId] ?? '0');
        const left = outstanding - (totals.byBill[a.purchaseBillId] ?? 0n);
        if (BigInt(a.amountPaise) > left)
          throw new Error(
            `Bill ${a.billLabel} has only ${rupees(left)} left to pay after the payments already saved on this device.`,
          );
      }
      const sequence = ((await getMeta<number>(db, 'outboxSeq')) ?? 0) + 1;
      await setMeta(db, 'outboxSeq', sequence);
      const record: OfflineSupplierPaymentRecord = {
        clientId: input.clientId,
        shopId: input.shopId,
        partyId: input.partyId,
        partyName: input.partyName,
        businessDate: input.businessDate,
        amountPaise: request.amountPaise,
        mode: input.mode,
        reference: input.reference,
        allocations: input.allocations,
        baseVersions: input.baseVersions,
        form: input.form,
        status: 'QUEUED',
        createdAt: now,
        syncedAt: null,
        resultPaymentId: null,
        rejectionCode: null,
        rejectionReason: null,
        closedAt: null,
      };
      const payload: SupplierPaymentOutboxPayload = {
        request,
        baseVersions: input.baseVersions,
      };
      const entry: OutboxEntry = {
        sequence,
        clientId: input.clientId,
        kind: 'financial-rpc',
        target: SUPPLIER_PAYMENT_OUTBOX_TARGET,
        payload,
        createdAt: now,
        attempts: 0,
        state: 'pending',
        nextAttemptAt: 0,
        lastError: null,
      };
      await db.offlineSupplierPayments.put(record);
      await db.outbox.put(entry);
      return record;
    },
  );
}

export async function completeOfflineSupplierPayment(
  db: DsbSyncDb,
  clientId: string,
  result: { paymentId: string },
  now = Date.now(),
): Promise<OfflineSupplierPaymentRecord> {
  return db.transaction('rw', [db.outbox, db.offlineSupplierPayments], async () => {
    const record = await db.offlineSupplierPayments.get(clientId);
    if (!record) throw new Error('Offline supplier payment record is missing.');
    if (record.status === 'REJECTED') throw new Error('A refused payment cannot be confirmed.');
    const next: OfflineSupplierPaymentRecord =
      record.status === 'SYNCED'
        ? record
        : { ...record, status: 'SYNCED', syncedAt: now, resultPaymentId: result.paymentId };
    await db.offlineSupplierPayments.put(next);
    await db.outbox.where('clientId').equals(clientId).delete();
    return next;
  });
}

export async function rejectOfflineSupplierPayment(
  db: DsbSyncDb,
  clientId: string,
  code: string,
  reason: string,
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', [db.outbox, db.offlineSupplierPayments, db.conflicts], async () => {
    const record = await db.offlineSupplierPayments.get(clientId);
    if (record?.status === 'SYNCED') throw new Error('A synced payment cannot be rejected.');
    if (record)
      await db.offlineSupplierPayments.put({
        ...record,
        status: 'REJECTED',
        rejectionCode: code,
        rejectionReason: reason,
      });
    const outbox = await db.outbox.where('clientId').equals(clientId).first();
    if (outbox) await db.outbox.delete(outbox.sequence);
    const conflict: LocalSyncConflict = {
      createdAt: now,
      status: 'OPEN',
      kind: 'financial-rejection',
      target: SUPPLIER_PAYMENT_OUTBOX_TARGET,
      clientId,
      reason,
      payload: outbox?.payload ?? null,
      serverRef: null,
    };
    await db.conflicts.add(conflict);
  });
}

/** Only a refused payment can be closed (after the user has redone or dropped it). */
export async function closeRejectedOfflineSupplierPayment(
  db: DsbSyncDb,
  clientId: string,
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', [db.offlineSupplierPayments], async () => {
    const record = await db.offlineSupplierPayments.get(clientId);
    if (!record) throw new Error('Offline supplier payment record is missing.');
    if (record.status !== 'REJECTED') throw new Error('Only a refused payment can be closed.');
    await db.offlineSupplierPayments.put({ ...record, closedAt: record.closedAt ?? now });
  });
}

export async function listOfflineSupplierPaymentRecords(
  db: DsbSyncDb,
  shopId: string,
): Promise<OfflineSupplierPaymentRecord[]> {
  const rows = await db.offlineSupplierPayments.where('shopId').equals(shopId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
