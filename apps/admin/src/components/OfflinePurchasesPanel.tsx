import { useEffect, useState } from 'preact/hooks';
import {
  closeRejectedPurchase,
  listOfflinePurchases,
  runSyncNow,
  type OfflinePurchaseRecord,
} from '../lib/offlineSync';
import { savePurchaseDraft, type PurchaseDraft } from '../lib/purchaseDraft';
import type { KnownBill } from '../lib/duplicateBill';
import { rupees } from '../lib/money';

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
  const [note, setNote] = useState('');
  async function load() {
    if (!shopId) return;
    try {
      setRows(await listOfflinePurchases(shopId));
    } catch {
      // The device store is not ready yet: the next sync event reloads.
    }
  }
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener('dsb-offline-purchases', on);
    window.addEventListener('dsb-sync-state', on);
    return () => {
      window.removeEventListener('dsb-offline-purchases', on);
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
  if (!shown.length && !note) return null;
  const queued = shown.filter((r) => r.status === 'QUEUED').length;
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
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    await load();
  }
  return (
    <section aria-label="Purchases saved on this device" class="offline-purchases">
      <h3>Purchases saved on this device</h3>
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
    </section>
  );
}
