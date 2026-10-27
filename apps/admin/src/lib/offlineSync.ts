import {
  ackSync,
  classifyError,
  ensureFreshSession,
  errorMessage,
  getDefaultShopId,
  getOrCreateDeviceId,
  listServerSyncConflicts,
  pullSyncTable,
  pushSyncedSale,
  recordServerSyncConflict,
  resolveServerSyncConflict,
  setOfflineCashierFinalization,
  subscribeSyncWakeup,
  SYNC_PULL_LIMITS,
  pullReturnSources,
  pushSyncedReturn,
  pushSyncedReturnVoid,
  type Membership,
  type SaleLineExtras,
  type SaleLineInput,
  type SalePaymentInput,
  type SyncPullTable,
  lookupPurchaseRequest,
  postPurchaseV2Outcome,
  uploadBillDocument,
  createItemV2Outcome,
  plainItemRefusal,
  editPurchaseBillOutcome,
  plainEditRefusal,
  voidPurchaseIfUnchangedOutcome,
  plainOfflineVoidRefusal,
  getSupplierPayContext,
  paySupplierIfUnchangedOutcome,
  plainOfflineSupplierPaymentRefusal,
} from '@dsb-pro/adapters';
import { readLocalDocument, removeLocalDocument } from './billDocumentStore';
import { syncQueuedSupplierPayment } from './offlineSupplierPaymentSync';
import { syncQueuedPurchase } from './offlinePurchaseSync';
import { syncQueuedItem } from './offlineItemSync';
import { syncQueuedBillChange } from './offlineBillChangeSync';
import {
  applySyncPull,
  setMeta,
  completeOfflineSale,
  getCachedBusinessDate,
  getCachedCustomers,
  getCachedItems,
  getCachedPolicy,
  getCachedPrices,
  getSyncCursors,
  getSyncHealth,
  isDefinitiveFinancialRejectionMessage,
  markOutboxRetry,
  markOutboxSending,
  nextOutboxEntry,
  openSyncDb,
  queueOfflineSale,
  recoverInterruptedOutbox,
  recoverInterruptedAttempts,
  createAttemptDraft,
  updateAttemptDraft,
  cancelAttemptDraft,
  freezeAttempt,
  submitAttempt,
  reconcileAttempt,
  copyRejectedToDraft,
  listOpenAttempts,
  type FinancialAttempt,
  type FinancialAttemptOperation,
  type AttemptSendOutcome,
  type AttemptLookup,
  rejectOfflineSale,
  retryDelayMs,
  resolveLocalConflict,
  restrictCachedCostPrices,
  reviewOfflineSaleReconciliation,
  type DsbSyncDb,
  type LocalSyncConflict,
  type OfflineSalePayload,
  type OfflineSaleRecord,
  type OutboxEntry,
  cacheReturnSources,
  returnableCachedLines,
  queueOfflineReturn,
  completeOfflineReturn,
  rejectOfflineReturn,
  queueReturnVoid,
  completeReturnVoid,
  getMeta,
  canUnblockRejectedReturnVoid,
  type ReturnVoidIntent,
  type OfflineReturnPayload,
  type OfflineReturnRecord,
  type OfflineReturnType,
  holdCart,
  listHeldCarts,
  discardHeldCart,
  claimHeldCart,
  releaseHeldCartClaim,
  completeHeldCartResume,
  type HeldCartLine,
  type HeldCartRecord,
  type SyncedBarcode,
  type SyncedCustomer,
  type SyncedItem,
  type SyncedPrice,
  type SyncIdentity,
  type SyncPullPayload,
  type SyncedSaleResult,
  type FreeTextLine,
  PURCHASE_OUTBOX_TARGET,
  queueOfflinePurchase,
  listOfflinePurchaseRecords,
  closeRejectedOfflinePurchase,
  type OfflinePurchaseRecord,
  type QueueOfflinePurchaseInput,
  ITEM_OUTBOX_TARGET,
  queueOfflineItem,
  listOfflineItemRecords,
  type OfflineItemFields,
  type OfflineItemRecord,
  BILL_CHANGE_OUTBOX_TARGET,
  queueOfflineBillChange,
  listOfflineBillChangeRecords,
  closeRejectedOfflineBillChange,
  type OfflineBillChangeRecord,
  type QueueOfflineBillChangeInput,
  SUPPLIER_PAYMENT_OUTBOX_TARGET,
  queueOfflineSupplierPayment,
  listOfflineSupplierPaymentRecords,
  closeRejectedOfflineSupplierPayment,
  saveSupplierPayCopy,
  getSupplierPayCopy,
  type OfflineSupplierPaymentRecord,
  type QueueOfflineSupplierPaymentInput,
  type SupplierPayCopy,
} from '@dsb-pro/sync';

type Runtime = {
  identity: SyncIdentity;
  db: DsbSyncDb;
  timer: number;
  unsubscribeRealtime: (() => void) | null;
  running: Promise<void> | null;
  /** True once a full cycle (outbox, every pull page, ack) has completed for this identity. */
  syncedOnce: boolean;
  /** When the most recent fully successful cycle STARTED (what it pulled is at least this fresh). */
  lastGoodCycleStartedAt: number;
  /** The shop the stored pull cursors belong to (null until the first cycle). */
  cursorShopId: string | null;
};
type PublicState = {
  online: boolean;
  running: boolean;
  lastError: string | null;
  lastCycleAt: number | null;
};
let runtime: Runtime | null = null;
let state: PublicState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  running: false,
  lastError: null,
  lastCycleAt: null,
};
const waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: number }> = [];

function emit() {
  state = { ...state, online: typeof navigator === 'undefined' ? true : navigator.onLine };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dsb-sync-state'));
}
function asPull(value: Awaited<ReturnType<typeof pullSyncTable>>): SyncPullPayload {
  return value as unknown as SyncPullPayload;
}
function asSale(value: Awaited<ReturnType<typeof pushSyncedSale>>): SyncedSaleResult {
  return value as unknown as SyncedSaleResult;
}
function reason(error: unknown) {
  return errorMessage(classifyError(error), error) || String(error);
}
function requireRuntime(): Runtime {
  if (!runtime) throw new Error('Offline cache is still starting. Wait a moment and try again.');
  return runtime;
}
function resolveWaiters() {
  while (waiters.length) {
    const w = waiters.shift()!;
    window.clearTimeout(w.timer);
    w.resolve();
  }
}

// 30 s, not 5 s: on a loaded device (or CI runner) opening the local database can take longer, and a
// timeout here leaves the Suppliers/Customers screens without their payment form.
export async function waitForOfflineRuntime(timeoutMs = 30000): Promise<void> {
  if (runtime) return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const i = waiters.findIndex((w) => w.timer === timer);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('Offline cache did not start in time.'));
    }, timeoutMs);
    waiters.push({ resolve, reject, timer });
  });
}

// Start token: every start/stop bumps it, and a start that was superseded while it awaited (database open,
// recovery) installs nothing, so only ONE loop (interval + realtime + listeners) can ever exist.
let startGeneration = 0;
// The old runtime's cycle may still be sending when it is stopped; a new start waits for it before
// recovering "interrupted" outbox entries, so an entry still in flight is never mistaken for a crashed one.
let draining: Promise<void> | null = null;

export async function startOfflineSync(input: {
  userId: string;
  membership: Membership;
}): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  const generation = ++startGeneration;
  const shopId = input.membership.shopIds[0] ?? (await getDefaultShopId());
  if (generation !== startGeneration) return;
  const identity: SyncIdentity = {
    userId: input.userId,
    tenantId: input.membership.tenantId,
    shopId,
    deviceId,
    role: input.membership.role,
  };
  if (
    runtime &&
    runtime.identity.userId === identity.userId &&
    runtime.identity.tenantId === identity.tenantId &&
    runtime.identity.deviceId === identity.deviceId
  ) {
    // Same user/shop group/device: the running loop stays; only the role and shop are updated in place
    // (the server may confirm a different role than the cached one this session opened with). A demotion
    // to cashier removes a formerly authorized cost cache right away.
    const rt = runtime;
    rt.identity = { ...rt.identity, role: identity.role, shopId: identity.shopId };
    if (identity.role === 'cashier') await restrictCachedCostPrices(rt.db);
    emit();
    return;
  }
  stopOfflineSync();
  startGeneration = generation; // stopOfflineSync bumps it; this start is still the current one
  const superseded = () => generation !== startGeneration;
  const db = await openSyncDb(identity);
  if (superseded()) {
    return;
  }
  // A role downgrade must remove a formerly authorized cost cache even when
  // this device starts offline and cannot yet receive the server capability.
  if (identity.role === 'cashier') await restrictCachedCostPrices(db);
  // Wait for the old runtime's in-flight cycle, but never forever: after ~20 s skip recovering "sending"
  // rows (the idempotent client_id protects a re-send; the next start recovers them).
  let drained = true;
  if (draining) {
    drained = await Promise.race([
      draining.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20000)),
    ]);
  }
  if (superseded()) {
    return;
  }
  if (drained) await recoverInterruptedOutbox(db);
  await recoverInterruptedAttempts(db);
  if (superseded()) {
    return;
  }
  runtime = {
    identity,
    db,
    timer: 0,
    unsubscribeRealtime: null,
    running: null,
    syncedOnce: false,
    lastGoodCycleStartedAt: 0,
    cursorShopId: null,
  };
  runtime.timer = window.setInterval(() => {
    void runSyncNow();
  }, 30000);
  runtime.unsubscribeRealtime = subscribeSyncWakeup(() => {
    void runSyncNow();
  });
  window.addEventListener('online', onlineHandler);
  window.addEventListener('offline', offlineHandler);
  resolveWaiters();
  emit();
  await runSyncNow();
}
function onlineHandler() {
  emit();
  void forceRetryNow();
}
function offlineHandler() {
  emit();
}
export function stopOfflineSync() {
  startGeneration++; // supersedes any start still awaiting
  if (!runtime) return;
  draining = runtime.running;
  window.clearInterval(runtime.timer);
  runtime.unsubscribeRealtime?.();
  window.removeEventListener('online', onlineHandler);
  window.removeEventListener('offline', offlineHandler);
  runtime = null;
  emit();
}

async function processOutbox(rt: Runtime) {
  for (let guard = 0; guard < 100; guard++) {
    if (runtime !== rt) return false; // stopped: never send another entry for a runtime that is gone
    const rows = await rt.db.outbox.orderBy('sequence').toArray();
    const next = nextOutboxEntry(rows, Date.now());
    // An unknown-outcome operation may already have committed at the server.
    // Do not pull that movement beneath its still-pending local overlay.
    if (!next) return rows.length === 0;
    const sending = markOutboxSending(next);
    await rt.db.outbox.put(sending);
    if (sending.kind === 'financial-rpc' && sending.target === 'void_return') {
      const intent = sending.payload as ReturnVoidIntent;
      try {
        await completeReturnVoid(
          rt.db,
          intent,
          await pushSyncedReturnVoid({ ...intent, deviceId: rt.identity.deviceId }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Unknown outcomes and read snapshots retain the durable billing block.
        // A later permission/device rejection cannot prove an earlier unknown
        // attempt did not commit. Only a first-attempt DB rejection can unblock.
        if (canUnblockRejectedReturnVoid(sending.attempts, message, intent.readOnly)) {
          await rt.db.transaction('rw', [rt.db.meta, rt.db.outbox, rt.db.conflicts], async () => {
            await rt.db.conflicts.add({
              createdAt: Date.now(),
              status: 'OPEN',
              kind: 'financial-rejection',
              target: 'void_return',
              clientId: intent.clientId,
              reason: message,
              payload: intent,
              serverRef: null,
            });
            await rt.db.outbox.where('clientId').equals(intent.clientId).delete();
            await rt.db.meta.delete('pendingReturnVoid');
          });
        } else {
          await rt.db.outbox.put(
            markOutboxRetry(sending, message, Date.now() + retryDelayMs(sending.attempts + 1)),
          );
          throw error;
        }
      }
      continue;
    }
    if (sending.kind === 'financial-rpc' && sending.target === 'post_return') {
      try {
        const result = await pushSyncedReturn({
          ...(sending.payload as OfflineReturnPayload),
          deviceId: rt.identity.deviceId,
        });
        await completeOfflineReturn(rt.db, sending.clientId, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isDefinitiveFinancialRejectionMessage(message))
          await rejectOfflineReturn(rt.db, sending.clientId, message);
        else {
          await rt.db.outbox.put(
            markOutboxRetry(sending, message, Date.now() + retryDelayMs(sending.attempts + 1)),
          );
          throw error;
        }
      }
      continue;
    }
    if (sending.kind === 'financial-rpc' && sending.target === BILL_CHANGE_OUTBOX_TARGET) {
      // Offline bill edit/void: applied only if the bill is unchanged since the device read it.
      try {
        const done = await syncQueuedBillChange(rt.db, sending, {
          edit: (request, baseVersion) => editPurchaseBillOutcome(request, true, baseVersion),
          void: voidPurchaseIfUnchangedOutcome,
          plainEdit: plainEditRefusal,
          plainVoid: plainOfflineVoidRefusal,
        });
        if (done.kind === 'rejected')
          void recordServerSyncConflict({
            deviceId: rt.identity.deviceId,
            opClientId: sending.clientId,
            kind: 'financial-rejection',
            target: sending.target,
            reason: done.reason,
            payload: sending.payload,
            serverRef: null,
            clientId: crypto.randomUUID(),
          }).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await rt.db.outbox.put(
          markOutboxRetry(sending, message, Date.now() + retryDelayMs(sending.attempts + 1)),
        );
        throw error;
      }
      if (typeof window !== 'undefined')
        window.dispatchEvent(new CustomEvent('dsb-offline-purchases'));
      continue;
    }
    if (sending.kind === 'financial-rpc' && sending.target === SUPPLIER_PAYMENT_OUTBOX_TARGET) {
      // Offline supplier payment: applied only if the supplier and its bills are unchanged since the device
      // read them; otherwise visibly refused with the form kept, never moved to another bill or supplier.
      try {
        const done = await syncQueuedSupplierPayment(rt.db, sending, {
          pay: paySupplierIfUnchangedOutcome,
          plain: plainOfflineSupplierPaymentRefusal,
        });
        if (done.kind === 'rejected')
          void recordServerSyncConflict({
            deviceId: rt.identity.deviceId,
            opClientId: sending.clientId,
            kind: 'financial-rejection',
            target: sending.target,
            reason: done.reason,
            payload: sending.payload,
            serverRef: null,
            clientId: crypto.randomUUID(),
          }).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await rt.db.outbox.put(
          markOutboxRetry(sending, message, Date.now() + retryDelayMs(sending.attempts + 1)),
        );
        throw error;
      }
      if (typeof window !== 'undefined')
        window.dispatchEvent(new CustomEvent('dsb-offline-supplier-payments'));
      continue;
    }
    if (sending.kind === 'financial-rpc' && sending.target === ITEM_OUTBOX_TARGET) {
      // Offline new item: created (or matched) before any bill queued after it; refused → visible, and
      // the bills that use it are refused locally.
      try {
        const done = await syncQueuedItem(rt.db, sending, {
          create: createItemV2Outcome,
          plain: plainItemRefusal,
        });
        if (done.kind === 'rejected')
          for (const opClientId of [sending.clientId, ...done.heldBills])
            void recordServerSyncConflict({
              deviceId: rt.identity.deviceId,
              opClientId,
              kind: 'financial-rejection',
              target:
                opClientId === sending.clientId
                  ? sending.target
                  : (await rt.db.offlineBillChanges.get(opClientId))
                    ? BILL_CHANGE_OUTBOX_TARGET
                    : PURCHASE_OUTBOX_TARGET,
              reason: done.reason,
              payload: opClientId === sending.clientId ? sending.payload : null,
              serverRef: null,
              clientId: crypto.randomUUID(),
            }).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await rt.db.outbox.put(
          markOutboxRetry(sending, message, Date.now() + retryDelayMs(sending.attempts + 1)),
        );
        throw error;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dsb-offline-items'));
        window.dispatchEvent(new CustomEvent('dsb-offline-purchases'));
      }
      continue;
    }
    if (sending.kind === 'financial-rpc' && sending.target === PURCHASE_OUTBOX_TARGET) {
      // Offline purchase (docs/OFFLINE_PURCHASES_PLAN.md): synced or visibly rejected, else retried.
      try {
        const done = await syncQueuedPurchase(rt.db, sending, {
          post: postPurchaseV2Outcome,
          lookup: (shopId, clientId) => lookupPurchaseRequest(shopId, 'purchase.post.v2', clientId),
          upload: uploadBillDocument,
          readLocal: readLocalDocument,
          removeLocal: removeLocalDocument,
        });
        if (done === 'rejected') {
          const rec = await rt.db.offlinePurchases.get(sending.clientId);
          void recordServerSyncConflict({
            deviceId: rt.identity.deviceId,
            opClientId: sending.clientId,
            kind: 'financial-rejection',
            target: sending.target,
            reason: rec?.rejectionReason ?? 'Purchase refused.',
            payload: sending.payload,
            serverRef: null,
            clientId: crypto.randomUUID(),
          }).catch(() => undefined);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await rt.db.outbox.put(
          markOutboxRetry(sending, message, Date.now() + retryDelayMs(sending.attempts + 1)),
        );
        throw error;
      }
      if (typeof window !== 'undefined')
        window.dispatchEvent(new CustomEvent('dsb-offline-purchases'));
      continue;
    }
    if (sending.kind !== 'financial-rpc' || sending.target !== 'post_sale') {
      const message = `Unsupported outbox target ${sending.target}`;
      await rejectOfflineSale(rt.db, sending.clientId, message);
      continue;
    }
    const payload = sending.payload as OfflineSalePayload;
    let result: Awaited<ReturnType<typeof pushSyncedSale>>;
    try {
      result = await pushSyncedSale({
        deviceId: rt.identity.deviceId,
        shopId: payload.shopId,
        customerId: payload.customerId,
        businessDate: payload.businessDate,
        discountPaise: payload.discountPaise,
        extraChargesPaise: payload.extraChargesPaise,
        clientId: payload.clientId,
        intentFingerprint: payload.intentFingerprint ?? '',
        roundTotal: payload.roundTotal === true,
        saleV2:
          payload.saleV2 === true
            ? {
                invoiceType: payload.invoiceType ?? 'gst_included',
                creditOverride: payload.creditOverride === true,
                expectedTotalPaise: payload.expectedTotalPaise ?? -1,
              }
            : undefined,
        lines: payload.lines as Array<SaleLineInput & SaleLineExtras>,
        payments: payload.payments as SalePaymentInput[],
        notes: payload.notes,
      });
    } catch (error) {
      const message = reason(error);
      if (
        !isDefinitiveFinancialRejectionMessage(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        const retry = markOutboxRetry(
          sending,
          message,
          Date.now() + retryDelayMs(sending.attempts + 1),
        );
        await rt.db.outbox.put(retry);
        throw error;
      }
      await rejectOfflineSale(rt.db, sending.clientId, message);
      void recordServerSyncConflict({
        deviceId: rt.identity.deviceId,
        opClientId: sending.clientId,
        kind: 'financial-rejection',
        target: sending.target,
        reason: message,
        payload: sending.payload,
        serverRef: null,
        clientId: crypto.randomUUID(),
      }).catch(() => undefined);
      continue;
    }

    try {
      await completeOfflineSale(rt.db, sending.clientId, asSale(result));
    } catch (error) {
      const retry = markOutboxRetry(
        sending,
        `Server confirmed sale but local acknowledgement failed: ${reason(error)}`,
        Date.now() + retryDelayMs(sending.attempts + 1),
      );
      await rt.db.outbox.put(retry);
      throw error;
    }
  }
  throw new Error('Sync outbox safety limit reached.');
}

async function pullTablePages(rt: Runtime, table: SyncPullTable, shopId: string) {
  for (let page = 0; page < 100; page++) {
    if (runtime !== rt) return; // replaced: stop pulling for a runtime that is gone
    const cursors = await getSyncCursors(rt.db);
    const pulled = await pullSyncTable({
      table,
      deviceId: rt.identity.deviceId,
      shopId,
      cursors,
    });
    if (runtime !== rt) return;
    await applySyncPull(rt.db, asPull(pulled));
    if (pulled[table].length < SYNC_PULL_LIMITS[table]) return;
  }
  throw new Error(`Sync pull safety limit reached before ${table} pages were drained.`);
}

async function pullAllPages(rt: Runtime) {
  // Items are the billing catalog and must become searchable first on a weak
  // link. Sharing the initial bandwidth with four other large tables left a
  // 10k catalog only partially usable at the performance deadline. Once items
  // are complete, drain the dependent/reference caches concurrently.
  // One shop for the whole cycle. When the shop changed since the last cycle, start every table from the
  // beginning so rows scoped to the new shop (prices, stock) are not skipped by the old shop's cursors.
  const shopId = rt.identity.shopId;
  if (rt.cursorShopId !== shopId) {
    if (rt.cursorShopId !== null)
      for (const table of Object.keys(SYNC_PULL_LIMITS))
        await setMeta(rt.db, `cursor:${table}`, { updatedAt: 0, id: '' });
    rt.cursorShopId = shopId;
  }
  await pullTablePages(rt, 'items', shopId);
  const remaining = (Object.keys(SYNC_PULL_LIMITS) as SyncPullTable[]).filter(
    (table) => table !== 'items',
  );
  await Promise.all(remaining.map((table) => pullTablePages(rt, table, shopId)));
  await refreshOfflineReturnSources();
  return getSyncCursors(rt.db);
}

export async function runSyncNow(): Promise<void> {
  const rt = requireRuntime();
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    emit();
    return;
  }
  if (rt.running) return rt.running;
  rt.running = (async () => {
    const startedAt = Date.now();
    state = { ...state, running: true, lastError: null };
    emit();
    try {
      const session = await ensureFreshSession();
      if (!session)
        throw new Error(
          'Authentication session is unavailable. Sign in again before syncing queued work.',
        );
      if (!(await processOutbox(rt))) return;
      if (runtime !== rt) return;
      const nextCursors = await pullAllPages(rt);
      if (runtime !== rt) return;
      await ackSync({ deviceId: rt.identity.deviceId, cursors: nextCursors });
      rt.syncedOnce = true;
      rt.lastGoodCycleStartedAt = startedAt;
      state = { ...state, lastCycleAt: Date.now(), lastError: null };
    } catch (error) {
      state = { ...state, lastError: reason(error) };
    } finally {
      state = { ...state, running: false };
      emit();
      rt.running = null;
    }
  })();
  return rt.running;
}

export type ResilientSaleResult =
  { kind: 'synced'; saleId: string; docNo: string } | { kind: 'queued'; provisionalDocNo: string };

export async function finalizeSaleResilient(input: {
  shopId: string;
  customerId?: string;
  businessDate: string;
  discountPaise: number;
  extraChargesPaise: number;
  clientId: string;
  lines: Array<SaleLineInput & { manualUnitPricePaise?: number; freeText?: FreeTextLine }>;
  payments: SalePaymentInput[];
  notes?: string;
  /** salepricing (0065): typed prices / invoice type / credit limit go through sp_sync_post_sale. */
  saleV2?: {
    invoiceType: 'gst_included' | 'gst_extra';
    creditOverride: boolean;
    expectedTotalPaise: number;
  };
}): Promise<ResilientSaleResult> {
  const rt = requireRuntime();
  const policy = (await getCachedPolicy(rt.db)) ?? {
    allowCashierOfflineFinalization: false,
    allowNegativeStock: false,
    canViewCostPrices: false,
  };
  if (rt.identity.role === 'cashier' && !policy.allowCashierOfflineFinalization) {
    if (typeof navigator === 'undefined' || !navigator.onLine) {
      throw new Error(
        'Offline finalization is disabled for cashiers. Keep this sale as a draft until online.',
      );
    }
    await runSyncNow();
    if (state.lastError) {
      throw new Error(
        'Cashier finalization needs a live server connection. Your cart is preserved; retry when sync is healthy.',
      );
    }
  }
  const onlineInitiated = typeof navigator !== 'undefined' && navigator.onLine && !state.lastError;
  const { saleV2, ...rest } = input;
  const payload = {
    ...rest,
    // R0 (user decision B1): every new sale rounds its bill total to the nearest rupee.
    roundTotal: true,
    lines: input.lines.map((l) => ({ ...l, discountPaise: l.discountPaise ?? 0 })),
    payments: input.payments,
    ...(saleV2
      ? {
          saleV2: true,
          invoiceType: saleV2.invoiceType,
          creditOverride: saleV2.creditOverride,
          expectedTotalPaise: saleV2.expectedTotalPaise,
        }
      : {}),
  };
  let record: OfflineSaleRecord;
  try {
    record = await queueOfflineSale(rt.db, payload, {
      deviceId: rt.identity.deviceId,
      role: rt.identity.role,
      policy,
      onlineInitiated,
    });
  } catch (error) {
    if (typeof navigator === 'undefined' || !navigator.onLine) throw error;
    await new Promise((resolve) => window.setTimeout(resolve, 1100));
    await runSyncNow();
    const retryOnlineInitiated =
      typeof navigator !== 'undefined' && navigator.onLine && !state.lastError;
    record = await queueOfflineSale(rt.db, payload, {
      deviceId: rt.identity.deviceId,
      role: rt.identity.role,
      policy,
      onlineInitiated: retryOnlineInitiated,
    });
  }
  emit();
  if (navigator.onLine) {
    await runSyncNow();
    // runSyncNow joins a cycle already in flight, which may have read the outbox before this sale
    // was queued. Run one fresh cycle so an online sale is posted now instead of "saved locally".
    const afterJoin = await rt.db.offlineSales.get(record.clientId);
    if (afterJoin?.status === 'QUEUED' && navigator.onLine && !state.lastError) await runSyncNow();
  }
  const final = await rt.db.offlineSales.get(record.clientId);
  if (final?.status === 'SYNCED' && final.officialSaleId && final.officialDocNo)
    return { kind: 'synced', saleId: final.officialSaleId, docNo: final.officialDocNo };
  if (final?.status === 'REJECTED')
    throw new Error(final.rejectionReason ?? 'Queued sale was rejected by the server.');
  return { kind: 'queued', provisionalDocNo: record.provisionalDocNo };
}

export function getOfflineRuntimeState(): PublicState {
  return { ...state };
}
export type LocalSyncSummary = {
  online: boolean;
  running: boolean;
  pending: number;
  conflicts: number;
};
/** Header indicator (D1): local reads only — never starts a sync or calls the server. */
export async function getLocalSyncSummary(): Promise<LocalSyncSummary> {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  if (!runtime) return { online, running: false, pending: 0, conflicts: 0 };
  const health = await getSyncHealth(runtime.db);
  return {
    online,
    running: state.running,
    pending: health.outboxCount,
    conflicts: health.conflictCount,
  };
}
export async function refreshOfflineReturnSources(): Promise<void> {
  const rt = requireRuntime();
  await cacheReturnSources(
    rt.db,
    rt.identity.shopId,
    await pullReturnSources({ deviceId: rt.identity.deviceId, shopId: rt.identity.shopId }),
  );
}
export async function getOfflineReturnSources(type: OfflineReturnType) {
  const rt = requireRuntime();
  return (await rt.db.returnSources.where('shop_id').equals(rt.identity.shopId).toArray()).filter(
    (row) => row.return_type === type,
  );
}
export async function getOfflineReturnLines(type: OfflineReturnType, sourceId: string) {
  return returnableCachedLines(requireRuntime().db, type, sourceId);
}
export async function listOfflineReturns(): Promise<OfflineReturnRecord[]> {
  return (await requireRuntime().db.offlineReturns.orderBy('createdAt').reverse().toArray()).slice(
    0,
    100,
  );
}
export async function reviewOfflineSaleMismatch(clientId: string): Promise<void> {
  await reviewOfflineSaleReconciliation(requireRuntime().db, clientId);
  emit();
}
export async function holdCurrentCart(input: {
  label: string;
  customerId: string;
  globalDiscount: string;
  extra: string;
  lines: HeldCartLine[];
}): Promise<HeldCartRecord> {
  const rt = requireRuntime();
  return holdCart(rt.db, { shopId: rt.identity.shopId, ...input });
}
export async function listHeldCartsForShop(): Promise<HeldCartRecord[]> {
  const rt = requireRuntime();
  return listHeldCarts(rt.db, rt.identity.shopId);
}
export async function claimHeldCartForResume(
  id: string,
  token: string,
): Promise<HeldCartRecord | undefined> {
  return claimHeldCart(requireRuntime().db, id, token);
}
export async function releaseHeldCartForResume(id: string, token: string): Promise<boolean> {
  return releaseHeldCartClaim(requireRuntime().db, id, token);
}
export async function completeHeldCartForResume(id: string, token: string): Promise<boolean> {
  return completeHeldCartResume(requireRuntime().db, id, token);
}
export async function discardHeldCartById(id: string): Promise<void> {
  return discardHeldCart(requireRuntime().db, id);
}
export async function recordLocalReturnVoid(returnId: string): Promise<void> {
  const rt = requireRuntime(),
    row = await rt.db.offlineReturns
      .filter((row) => row.officialReturnId === returnId && row.status !== 'VOID')
      .first();
  if (!row || (await getMeta(rt.db, 'pendingReturnVoid'))) return;
  await queueReturnVoid(rt.db, {
    type: row.payload.type,
    returnId,
    shopId: rt.identity.shopId,
    clientId: crypto.randomUUID(),
    readOnly: true,
  });
  emit();
  await runSyncNow();
  if (navigator.onLine && (await getMeta(rt.db, 'pendingReturnVoid'))) await runSyncNow();
}
export async function voidReturnResilient(
  type: OfflineReturnType,
  returnId: string,
): Promise<void> {
  if (!navigator.onLine) throw new Error('Reconnect before voiding a confirmed return.');
  const rt = requireRuntime(),
    intent = await queueReturnVoid(rt.db, {
      type,
      returnId,
      shopId: rt.identity.shopId,
      clientId: crypto.randomUUID(),
    });
  emit();
  await runSyncNow();
  // The intent can be appended after an already-running cycle drained its
  // outbox. Joining that cycle alone does not send this newly queued void.
  if (navigator.onLine && (await getMeta(rt.db, 'pendingReturnVoid'))) await runSyncNow();
  if (await getMeta(rt.db, 'pendingReturnVoid'))
    throw new Error(
      'Void confirmation pending — billing is blocked until reconnect confirms authoritative stock.',
    );
  const rejected = await rt.db.conflicts
    .filter(
      (row) =>
        row.target === 'void_return' && row.status === 'OPEN' && row.clientId === intent.clientId,
    )
    .first();
  if (rejected) throw new Error(rejected.reason);
}
export async function hasPendingReturnVoid(): Promise<boolean> {
  return !!(await getMeta(requireRuntime().db, 'pendingReturnVoid'));
}
export async function postReturnResilient(
  input: OfflineReturnPayload,
): Promise<OfflineReturnRecord> {
  const rt = requireRuntime();
  if (input.shopId !== rt.identity.shopId) throw new Error('Return shop does not match this till.');
  const queue = () =>
    queueOfflineReturn(rt.db, input, {
      role: rt.identity.role,
      deviceId: rt.identity.deviceId,
    });
  let record: OfflineReturnRecord;
  try {
    record = await queue();
  } catch (error) {
    // Same as sales: right after a purchase the device stock copy may not have it yet (the sync pull
    // skips rows changed in the last second). The refusal happens before anything is stored or sent,
    // so online we wait past that second, pull fresh stock and check again; a joined in-flight cycle
    // may have started too early, so one more fresh cycle if it is still refused.
    if (
      !navigator.onLine ||
      !(error instanceof Error) ||
      !error.message.startsWith('Insufficient cached stock')
    )
      throw error;
    await new Promise((resolve) => window.setTimeout(resolve, 1100));
    await runSyncNow();
    try {
      record = await queue();
    } catch (again) {
      if (!(again instanceof Error) || !again.message.startsWith('Insufficient cached stock'))
        throw again;
      await runSyncNow();
      record = await queue();
    }
  }
  emit();
  if (navigator.onLine) {
    await runSyncNow();
    // Same as sales: a joined in-flight cycle may have missed this return; run one fresh cycle.
    const afterJoin = await rt.db.offlineReturns.get(record.clientId);
    if (afterJoin?.status === 'QUEUED' && navigator.onLine && !state.lastError) await runSyncNow();
  }
  const final = (await rt.db.offlineReturns.get(record.clientId)) ?? record;
  return final;
}
export function getOfflineRuntimeIdentity(): SyncIdentity | null {
  return runtime?.identity ?? null;
}
export async function getOfflineItems(): Promise<SyncedItem[]> {
  return getCachedItems(requireRuntime().db);
}
/**
 * The device catalog for display, or null while it could still be partial or older than `notBefore`: no
 * completed sync cycle for this identity yet, or none that STARTED after `notBefore` (used after our own
 * writes, which reach the device only through a later cycle). Also null if the identity changed during
 * the read. The identity fields let the caller refuse rows that belong to anyone but the current user.
 */
export async function getSyncedOfflineCatalog(input: { notBefore?: number } = {}): Promise<{
  key: string;
  tenantId: string;
  userId: string;
  items: SyncedItem[];
} | null> {
  const rt = runtime;
  if (!rt || !rt.syncedOnce) return null;
  if (input.notBefore && rt.lastGoodCycleStartedAt < input.notBefore) return null;
  const items = await getCachedItems(rt.db);
  if (rt !== runtime) return null;
  const { tenantId, userId, shopId, deviceId } = rt.identity;
  return { key: `${tenantId}:${userId}:${shopId}:${deviceId}`, tenantId, userId, items };
}
export async function getOfflineItemCount(): Promise<number> {
  return requireRuntime().db.items.count();
}
export async function getOfflineCustomers(): Promise<SyncedCustomer[]> {
  return getCachedCustomers(requireRuntime().db);
}
export async function getOfflinePrices(itemId: string): Promise<SyncedPrice[]> {
  return getCachedPrices(requireRuntime().db, itemId);
}
export async function getOfflineBusinessDate(): Promise<string | null> {
  return getCachedBusinessDate(requireRuntime().db);
}
export async function findOfflineBarcode(barcode: string): Promise<SyncedBarcode | null> {
  const db = requireRuntime().db;
  const row = await db.barcodes.where('barcode').equals(barcode.trim()).first();
  return row && row.deleted_at === null ? row : null;
}
/** salepricing: the device's view of one sale (QUEUED / SYNCED / REJECTED), or undefined when unknown. */
export async function getOfflineSaleStatus(
  clientId: string,
): Promise<OfflineSaleRecord['status'] | undefined> {
  return (await requireRuntime().db.offlineSales.get(clientId))?.status;
}
export async function listOfflineSales(): Promise<OfflineSaleRecord[]> {
  return (await requireRuntime().db.offlineSales.orderBy('createdAt').reverse().toArray()).slice(
    0,
    50,
  );
}
export async function exportOfflineBillingSnapshot() {
  const rt = requireRuntime();
  const [
    items,
    barcodes,
    prices,
    customers,
    stock,
    outbox,
    metadata,
    conflicts,
    reservations,
    offlineSales,
    returnSources,
    offlineReturns,
    heldCarts,
    financialAttempts,
  ] = await Promise.all([
    rt.db.items.toArray(),
    rt.db.barcodes.toArray(),
    rt.db.prices.toArray(),
    rt.db.customers.toArray(),
    rt.db.stock.toArray(),
    rt.db.outbox.toArray(),
    rt.db.meta.toArray(),
    rt.db.conflicts.toArray(),
    rt.db.reservations.toArray(),
    rt.db.offlineSales.toArray(),
    rt.db.returnSources.toArray(),
    rt.db.offlineReturns.toArray(),
    rt.db.heldCarts.toArray(),
    rt.db.financialAttempts.toArray(),
  ]);
  return {
    schemaVersion: 4,
    exportKind: 'offline-billing-continuity',
    exportedAt: new Date().toISOString(),
    identity: rt.identity,
    items,
    barcodes,
    prices,
    customers,
    stock,
    outbox,
    metadata,
    conflicts,
    reservations,
    offlineSales,
    returnSources,
    offlineReturns,
    heldCarts,
    // Online money requests whose server outcome is not yet confirmed (C2).
    onlineRequestsAwaitingConfirmation: financialAttempts.filter((a) =>
      ['READY', 'SENDING', 'UNKNOWN'].includes(a.state),
    ),
    financialAttempts,
  };
}
export async function getSyncDashboard() {
  const rt = requireRuntime();
  const serverConflictPromise =
    typeof navigator !== 'undefined' && !navigator.onLine
      ? Promise.resolve([])
      : listServerSyncConflicts().catch(() => []);
  const [health, conflicts, sales, serverConflicts] = await Promise.all([
    getSyncHealth(rt.db),
    rt.db.conflicts.orderBy('createdAt').reverse().toArray(),
    listOfflineSales(),
    serverConflictPromise,
  ]);
  return {
    health,
    conflicts,
    sales,
    serverConflicts,
    state: getOfflineRuntimeState(),
    identity: rt.identity,
    policy: (await getCachedPolicy(rt.db)) ?? {
      allowCashierOfflineFinalization: false,
      allowNegativeStock: false,
      canViewCostPrices: false,
    },
  };
}
export async function forceRetryNow(): Promise<void> {
  const rt = requireRuntime();
  if (rt.running) await rt.running;

  const retryWaits = [0, 500, 1000, 2000, 4000];
  for (let attempt = 0; attempt < retryWaits.length; attempt++) {
    if (retryWaits[attempt] > 0)
      await new Promise((resolve) => window.setTimeout(resolve, retryWaits[attempt]));
    await recoverInterruptedOutbox(rt.db);
    const retries = await rt.db.outbox.where('state').equals('retry').toArray();
    if (retries.length)
      await rt.db.outbox.bulkPut(retries.map((r) => ({ ...r, nextAttemptAt: 0 }) as OutboxEntry));

    await runSyncNow();
    if ((await rt.db.outbox.count()) === 0) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  }
}
export async function resolveConflictLocally(conflict: LocalSyncConflict): Promise<void> {
  if (conflict.id === undefined) return;
  await resolveLocalConflict(requireRuntime().db, conflict.id);
  emit();
}
export async function updateCashierOfflinePolicy(allow: boolean): Promise<void> {
  await setOfflineCashierFinalization(allow);
  await runSyncNow();
}

export async function resolveConflictOnServer(id: string): Promise<void> {
  const rt = requireRuntime();
  await resolveServerSyncConflict({ deviceId: rt.identity.deviceId, id });
  emit();
}

// C2 durable online money attempts, scoped to the runtime identity (tenant/user/device DB).
export type { FinancialAttempt, FinancialAttemptOperation, AttemptSendOutcome, AttemptLookup };
export async function newFinancialDraft(input: {
  operation: FinancialAttemptOperation;
  shopId: string;
  accountId: string;
  payload: Record<string, unknown>;
}): Promise<FinancialAttempt> {
  return createAttemptDraft(requireRuntime().db, input);
}
export async function editFinancialDraft(id: string, payload: Record<string, unknown>) {
  return updateAttemptDraft(requireRuntime().db, id, payload);
}
export async function discardFinancialDraft(id: string) {
  return cancelAttemptDraft(requireRuntime().db, id);
}
export async function sendFinancialAttempt(
  id: string,
  send: (attempt: FinancialAttempt) => Promise<AttemptSendOutcome>,
): Promise<FinancialAttempt> {
  const db = requireRuntime().db;
  await freezeAttempt(db, id); // durable READY before any network call
  return submitAttempt(db, id, send);
}
export async function reconcileFinancialAttempt(
  id: string,
  lookup: (attempt: FinancialAttempt) => Promise<AttemptLookup>,
): Promise<FinancialAttempt> {
  return reconcileAttempt(requireRuntime().db, id, lookup);
}
export async function copyRejectedFinancialAttempt(id: string) {
  return copyRejectedToDraft(requireRuntime().db, id);
}
export async function listOpenFinancialAttempts(shopId: string, accountId?: string) {
  return listOpenAttempts(requireRuntime().db, shopId, accountId);
}
export async function listFinancialDrafts(shopId: string, accountId: string) {
  return (
    await requireRuntime().db.financialAttempts.where('state').equals('DRAFT').toArray()
  ).filter((a) => a.shopId === shopId && a.accountId === accountId);
}

// Offline purchases (docs/OFFLINE_PURCHASES_PLAN.md).
export type { OfflinePurchaseRecord, QueueOfflinePurchaseInput };
export async function queuePurchaseOffline(
  input: QueueOfflinePurchaseInput,
): Promise<OfflinePurchaseRecord> {
  const record = await queueOfflinePurchase(requireRuntime().db, input);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dsb-offline-purchases'));
  void runSyncNow().catch(() => undefined);
  return record;
}
export async function listOfflinePurchases(shopId: string): Promise<OfflinePurchaseRecord[]> {
  return listOfflinePurchaseRecords(requireRuntime().db, shopId);
}
export async function closeRejectedPurchase(clientId: string): Promise<OfflinePurchaseRecord> {
  const record = await closeRejectedOfflinePurchase(requireRuntime().db, clientId);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dsb-offline-purchases'));
  return record;
}
/**
 * Saves the supplier list the offline bill form uses. Waits for the device cache to start (it used to
 * skip silently when the page loaded faster than the cache, leaving offline bills with no suppliers).
 * Resolves true once saved, false when the cache never started.
 */
export async function cacheOfflineSuppliers(
  rows: ReadonlyArray<{ id: string; name: string }>,
): Promise<boolean> {
  if (!runtime) await waitForOfflineRuntime(30000).catch(() => undefined);
  const db = runtime?.db;
  if (!db) return false;
  await db.transaction('rw', db.meta, async () => {
    await db.meta.put({ key: 'purchaseSuppliers', value: rows.map((r) => ({ ...r })) });
    await db.meta.put({ key: 'purchaseSuppliersSavedAt', value: new Date().toISOString() });
  });
  return true;
}
/** When the saved supplier list was written (ISO), or null (none, or saved by an older app version). */
export async function getOfflineSuppliersSavedAt(): Promise<string | null> {
  return getMeta<string>(requireRuntime().db, 'purchaseSuppliersSavedAt');
}
export async function getOfflineSuppliers<T>(): Promise<T[] | null> {
  return getMeta<T[]>(requireRuntime().db, 'purchaseSuppliers');
}
export async function getOfflineStock(shopId: string) {
  return requireRuntime().db.stock.where('shop_id').equals(shopId).toArray();
}

// Offline new items (device-generated id, queued before the bills that use it).
export type { OfflineItemFields, OfflineItemRecord };
export async function queueItemOffline(input: {
  clientId: string;
  itemId: string;
  fields: OfflineItemFields;
}): Promise<OfflineItemRecord> {
  const rt = requireRuntime();
  const record = await queueOfflineItem(rt.db, { ...input, tenantId: rt.identity.tenantId });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dsb-offline-items'));
  void runSyncNow().catch(() => undefined);
  return record;
}
export async function listOfflineItems(): Promise<OfflineItemRecord[]> {
  const rt = runtime;
  if (!rt) return [];
  return listOfflineItemRecords(rt.db, rt.identity.tenantId);
}

// Offline bill edit/void (mig 0072): one queued change per bill, applied only if the bill is unchanged.
export type { OfflineBillChangeRecord, QueueOfflineBillChangeInput };
export async function queueBillChangeOffline(
  input: QueueOfflineBillChangeInput,
): Promise<OfflineBillChangeRecord> {
  const record = await queueOfflineBillChange(requireRuntime().db, input);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dsb-offline-purchases'));
  void runSyncNow().catch(() => undefined);
  return record;
}
export async function listOfflineBillChanges(shopId: string): Promise<OfflineBillChangeRecord[]> {
  const rt = runtime;
  if (!rt) return [];
  return listOfflineBillChangeRecords(rt.db, shopId);
}
export async function closeRejectedBillChange(clientId: string): Promise<void> {
  await closeRejectedOfflineBillChange(requireRuntime().db, clientId);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dsb-offline-purchases'));
}

// Offline supplier payments (mig 0074): saved on this device, sent in order, applied only if unchanged.
export type { OfflineSupplierPaymentRecord, QueueOfflineSupplierPaymentInput, SupplierPayCopy };
const supplierPaymentsChanged = () => {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent('dsb-offline-supplier-payments'));
};
export async function queueSupplierPaymentOffline(
  input: QueueOfflineSupplierPaymentInput,
): Promise<OfflineSupplierPaymentRecord> {
  const record = await queueOfflineSupplierPayment(requireRuntime().db, input);
  supplierPaymentsChanged();
  void runSyncNow().catch(() => undefined);
  return record;
}
export async function listOfflineSupplierPayments(
  shopId: string,
): Promise<OfflineSupplierPaymentRecord[]> {
  const rt = runtime;
  if (!rt) return [];
  return listOfflineSupplierPaymentRecords(rt.db, shopId);
}
export async function closeRejectedSupplierPayment(clientId: string): Promise<void> {
  await closeRejectedOfflineSupplierPayment(requireRuntime().db, clientId);
  supplierPaymentsChanged();
}
/** The device copy of suppliers, owed amounts, open bills and their versions (saved on the last online load). */
export async function getSavedSupplierPayCopy(shopId: string): Promise<SupplierPayCopy | null> {
  await waitForOfflineRuntime();
  return getSupplierPayCopy(requireRuntime().db, shopId);
}
/** Reads the live context and saves it on the device; returns it. Throws when offline (the saved copy stays). */
export async function refreshSupplierPayCopy(shopId: string): Promise<SupplierPayCopy> {
  await waitForOfflineRuntime();
  // Stamped BEFORE the server read: a payment that synced while it ran is counted as not yet in the copy.
  const savedAt = Date.now();
  const ctx = await getSupplierPayContext(shopId);
  const copy: SupplierPayCopy = {
    shopId,
    savedAt,
    businessDate: ctx.businessDate,
    suppliers: ctx.suppliers,
  };
  await saveSupplierPayCopy(requireRuntime().db, copy);
  return copy;
}
