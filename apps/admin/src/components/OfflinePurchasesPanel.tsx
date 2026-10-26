import { useEffect, useState } from 'preact/hooks';
import {
  closeRejectedPurchase,
  closeRejectedBillChange,
  listOfflineBillChanges,
  listOfflineItems,
  listOfflinePurchases,
  runSyncNow,
  type OfflineBillChangeRecord,
  type OfflineItemRecord,
  type OfflinePurchaseRecord,
} from '../lib/offlineSync';
import { appRoute } from '../lib/paths';
import { savePurchaseDraft, type PurchaseDraft } from '../lib/purchaseDraft';
import type { KnownBill } from '../lib/duplicateBill';
import { rupees } from '../lib/money';
import { removeLocalDocument } from '../lib/billDocumentStore';
import { HomeRow } from './HomeRow';
import { useUserId } from '../lib/useUserId';

// Purchases saved on this device while offline (docs/OFFLINE_PURCHASES_PLAN.md). Queued bills are shown as
// "not synced" with what they will add; a refused bill stays here with its reason until the user turns it
// into a draft ("Correct this bill") or dismisses it. Synced bills are listed for a day.

const DAY_MS = 86_400_000;
const PAY: Record<OfflinePurchaseRecord['paymentType'], string> = {
  credit: 'Credit',
  cash: 'Cash',
  upi: 'UPI',
};

/** Queued bills of this device, for the duplicate-bill check. Never throws. */
export async function queuedKnownBills(shopId: string): Promise<KnownBill[]> {
  try {
    return (await listOfflinePurchases(shopId))
      .filter((r) => r.status === 'QUEUED')
      .map((r) => ({
        id: r.clientId,
        partyId: (r.request.partyId as string | null | undefined) ?? null,
        billNo: r.billNo,
        businessDate: r.businessDate,
        totalPaise: r.totalPaise,
        status: 'POSTED',
      }));
  } catch {
    return [];
  }
}

/** The draft a refused bill becomes. A payload mismatch means its id belongs to another bill: new id, no
 * photos (their paths carry the old id). Otherwise nothing was posted under the id, so it is kept. */
export function correctionDraft(record: OfflinePurchaseRecord, now: number): PurchaseDraft {
  const draft = record.draft as PurchaseDraft;
  if (record.rejectionCode === 'DSB_PAYLOAD_MISMATCH')
    return {
      ...draft,
      clientId: crypto.randomUUID(),
      savedAt: now,
      document: null,
      documents: [],
    };
  return { ...draft, savedAt: now };
}

export function OfflinePurchasesPanel({
  shopId,
  draftPrefix,
  onDraftSaved,
}: {
  shopId: string;
  draftPrefix: string;
  onDraftSaved: () => void;
}) {
  const [rows, setRows] = useState<OfflinePurchaseRecord[]>([]);
  const [itemRows, setItemRows] = useState<OfflineItemRecord[]>([]);
  const [changeRows, setChangeRows] = useState<OfflineBillChangeRecord[]>([]);
  const [note, setNote] = useState('');
  const userId = useUserId();
  async function load() {
    if (!shopId) return;
    try {
      setRows(await listOfflinePurchases(shopId));
      setItemRows(await listOfflineItems());
      setChangeRows(await listOfflineBillChanges(shopId));
    } catch {
      // The device store is not ready yet: the next sync event reloads.
    }
  }
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener('dsb-offline-purchases', on);
    window.addEventListener('dsb-offline-items', on);
    window.addEventListener('dsb-sync-state', on);
    return () => {
      window.removeEventListener('dsb-offline-purchases', on);
      window.removeEventListener('dsb-offline-items', on);
      window.removeEventListener('dsb-sync-state', on);
    };
  }, [shopId]);
  const now = Date.now();
  const shown = rows.filter(
    (r) =>
      r.status === 'QUEUED' ||
      (r.status === 'REJECTED' && r.closedAt === null) ||
      (r.status === 'SYNCED' && r.syncedAt !== null && now - r.syncedAt < DAY_MS),
  );
  // New items made on this device: waiting, refused (kept a week with the reason), or matched/synced today.
  const items = itemRows.filter(
    (r) =>
      r.status === 'QUEUED' ||
      (r.status === 'REJECTED' && now - r.createdAt < 7 * DAY_MS) ||
      (r.status === 'SYNCED' && r.syncedAt !== null && now - r.syncedAt < DAY_MS),
  );
  // Offline bill edits/voids: waiting, refused (kept until dismissed, with the full form), synced today.
  const changes = changeRows.filter(
    (r) =>
      r.status === 'QUEUED' ||
      (r.status === 'REJECTED' && r.closedAt === null) ||
      (r.status === 'SYNCED' && r.syncedAt !== null && now - r.syncedAt < DAY_MS),
  );
  if (!shown.length && !items.length && !changes.length && !note) return null;
  const queued = shown.filter((r) => r.status === 'QUEUED').length;
  const queuedAll =
    queued +
    items.filter((r) => r.status === 'QUEUED').length +
    changes.filter((r) => r.status === 'QUEUED').length;
  const refused =
    shown.filter((r) => r.status === 'REJECTED').length +
    items.filter((r) => r.status === 'REJECTED').length +
    changes.filter((r) => r.status === 'REJECTED').length;
  const count = shown.length + items.length + changes.length;
  const queuedPaise = shown
    .filter((r) => r.status === 'QUEUED')
    .reduce((n, r) => n + BigInt(r.totalPaise), 0n);
  const summary = [
    queuedAll
      ? queuedPaise > 0n
        ? `${rupees(queuedPaise.toString())} not synced`
        : `${queuedAll} not synced`
      : '',
    refused ? `${refused} refused` : '',
    !queuedAll && !refused ? `${count} synced` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  async function correct(r: OfflinePurchaseRecord) {
    setNote('');
    try {
      if (!draftPrefix) throw new Error('Drafts are kept for the owner or a manager only.');
      savePurchaseDraft(draftPrefix, 'offline-correction', correctionDraft(r, Date.now()));
      await closeRejectedPurchase(r.clientId);
      onDraftSaved();
      setNote('The refused bill is now a draft below: open it, correct it and post again.');
    } catch (e) {
      setNote(`Could not make a draft: ${e instanceof Error ? e.message : String(e)}`);
    }
    await load();
  }
  async function dismiss(r: OfflinePurchaseRecord) {
    if (
      !confirm(
        'Dismiss this refused bill? Nothing was posted. Its items are not kept anywhere else.',
      )
    )
      return;
    try {
      await closeRejectedPurchase(r.clientId);
      // Nothing was posted and the bill is dismissed: free its photo bytes.
      for (const d of r.documents)
        await removeLocalDocument(r.documentScope, d.id).catch(() => undefined);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    await load();
  }
  return (
    <HomeRow
      name="offline-saved"
      title="Saved on this device"
      label="Purchases saved on this device"
      userId={userId}
      count={count}
      tone={queuedAll || refused ? 'warning' : 'neutral'}
      summary={summary}
      forceOpen={refused > 0}
      class="offline-purchases"
    >
      {queued > 0 && (
        <p class="muted" data-testid="offline-purchases-queued">
          {queued} not synced yet — they post automatically when you're back online. Stock and
          supplier balances update after they sync.{' '}
          {typeof navigator !== 'undefined' && navigator.onLine !== false && (
            <button type="button" onClick={() => void runSyncNow().catch(() => undefined)}>
              Sync now
            </button>
          )}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {changes.length > 0 && (
        <ul aria-label="Bill changes saved on this device">
          {changes.map((r) => (
            <li key={r.clientId} data-testid="offline-bill-change" data-status={r.status}>
              <strong>
                {r.status === 'QUEUED'
                  ? `${r.kind === 'edit' ? 'Edit' : 'Void'} saved on this device — will sync`
                  : r.status === 'SYNCED'
                    ? `${r.kind === 'edit' ? 'Edit' : 'Void'} synced`
                    : `${r.kind === 'edit' ? 'Edit' : 'Void'} refused by the server — bill unchanged`}
              </strong>{' '}
              · bill {r.billLabel}
              <BillChangeForm record={r} />
              {r.status === 'REJECTED' && (
                <>
                  <p role="alert">{r.rejectionReason}</p>
                  <div class="context-actions">
                    {r.kind === 'edit' && (
                      <a href={appRoute.purchases + '?new=1&edit=' + encodeURIComponent(r.billId)}>
                        Redo this edit
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void closeRejectedBillChange(r.clientId)
                          .then(load)
                          .catch((e: unknown) =>
                            setNote(e instanceof Error ? e.message : String(e)),
                          )
                      }
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <ul aria-label="New items saved on this device">
          {items.map((r) => (
            <li key={r.clientId} data-testid="offline-item" data-status={r.status}>
              <strong>
                {r.status === 'QUEUED'
                  ? 'New item saved on this device — will sync'
                  : r.status === 'SYNCED'
                    ? r.mapped
                      ? 'New item matched an existing item'
                      : 'New item synced'
                    : 'New item refused by the server — not created'}
              </strong>{' '}
              · {r.fields.name} · {r.fields.unit1}
              {r.fields.unit2 ? ` / ${r.fields.conv1} ${r.fields.unit2}` : ''}
              {r.fields.unit3 ? ` / ${r.fields.conv2} ${r.fields.unit3}` : ''}
              {r.status === 'REJECTED' && (
                <p role="alert">
                  {r.rejectionReason} Bills that use it were not posted: use "Correct this bill" on
                  each and pick the existing item.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <ul>
        {shown.map((r) => (
          <li key={r.clientId} data-testid="offline-purchase" data-status={r.status}>
            <strong>
              {r.status === 'QUEUED'
                ? 'Saved on this device — not synced'
                : r.status === 'SYNCED'
                  ? 'Synced'
                  : 'Refused by the server — not posted'}
            </strong>{' '}
            · {r.supplierName ?? 'No supplier'}
            {r.billNo ? ` · bill ${r.billNo}` : ''} · {r.businessDate} · {PAY[r.paymentType]}{' '}
            {rupees(r.totalPaise)}
            {r.documents.length ? ` · ${r.documents.length} photo(s)` : ''}
            <br />
            <small class="muted">
              {r.lines
                .map(
                  (l) => `${r.status === 'QUEUED' ? '+' : ''}${l.qty} ${l.unitName} ${l.itemName}`,
                )
                .join(', ')}
            </small>
            {r.reconciliationWarning && <p role="alert">{r.reconciliationWarning}</p>}
            {r.status === 'REJECTED' && (
              <>
                <p role="alert">{r.rejectionReason}</p>
                <div class="context-actions">
                  <button type="button" onClick={() => void correct(r)}>
                    Correct this bill
                  </button>
                  <button type="button" onClick={() => void dismiss(r)}>
                    Dismiss
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </HomeRow>
  );
}

type ChangeForm = {
  reason?: string;
  supplierName?: string | null;
  billNo?: string | null;
  businessDate?: string;
  paymentType?: string;
  notes?: string | null;
  discountPaise?: number;
  charges?: { label: string; amountPaise: number }[];
  lines?: {
    itemName: string;
    qty: string;
    unitName: string;
    unitPricePaise: number;
    discountBp?: number;
    gstBp?: number | null;
  }[];
};
/** The full form of a queued/refused bill change, so a refused edit can be redone exactly. */
function BillChangeForm({ record }: { record: OfflineBillChangeRecord }) {
  const f = (record.form ?? {}) as ChangeForm;
  if (record.kind === 'void')
    return (
      <>
        <br />
        <small class="muted">Reason: {f.reason ?? ''}</small>
      </>
    );
  return (
    <div class="muted" data-testid="offline-bill-change-form">
      <small>
        {f.supplierName ?? 'No supplier'}
        {f.billNo ? ` · bill ${f.billNo}` : ''} · {f.businessDate ?? ''} · {f.paymentType ?? ''}
        {f.discountPaise ? ` · discount ${rupees(f.discountPaise)}` : ''}
        {(f.charges ?? []).map((c) => ` · ${c.label} ${rupees(c.amountPaise)}`).join('')}
      </small>
      <ul>
        {(f.lines ?? []).map((l, i) => (
          <li key={i}>
            <small>
              {l.qty} {l.unitName} {l.itemName} @ {rupees(l.unitPricePaise)}
              {l.discountBp ? ` · ${l.discountBp / 100}% off` : ''}
              {l.gstBp !== null && l.gstBp !== undefined ? ` · GST ${l.gstBp / 100}%` : ''}
            </small>
          </li>
        ))}
      </ul>
      {f.notes && <small>Notes: {f.notes}</small>}
    </div>
  );
}
