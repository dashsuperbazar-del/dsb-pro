import {
  purchaseVoidRequestId,
  voidPaidPurchaseOutcome,
  voidPurchaseOutcome,
  type WriteOutcome,
} from '@dsb-pro/adapters';

// "Edit bill" (old DSB parity): the bill is re-entered as a NEW draft; when that draft posts, the original
// is voided automatically. Nothing is edited in place, so every financial event stays in the ledger.
// The link draft -> original is a durable record keyed by the draft's client id (the same id the draft and
// the pending purchase intent carry), written before the draft exists, so it survives a reload at any point.
// A posted correction whose original is not yet voided stays recorded (state 'posted') and is shown as a
// persistent alert with Retry until the void is confirmed: both bills are never left live silently.
export type CorrectionRecord = {
  v: 1;
  shopId: string;
  newClientId: string;
  originalId: string;
  originalLabel: string;
  originalPaymentType: 'credit' | 'cash' | 'upi';
  /** One void request per correction: every retry sends the same id. */
  voidRequestId: string;
  state: 'draft' | 'posted';
  newBillId?: string;
  newBillLabel?: string;
  lastError?: string;
  savedAt: number;
};

export const CORRECTION_EVENT = 'dsb-corrections-changed';
const PREFIX = 'dsb-purchase-correction:';
const key = (shopId: string, clientId: string) => `${PREFIX}${shopId}:${clientId}`;
const DRAFT_TTL_MS = 30 * 24 * 3600 * 1000;

function notify() {
  try {
    window.dispatchEvent(new Event(CORRECTION_EVENT));
  } catch {
    // no window (tests without DOM)
  }
}

/** Throws when it cannot be stored: a correction is then not started. */
export function saveCorrection(rec: CorrectionRecord): void {
  localStorage.setItem(key(rec.shopId, rec.newClientId), JSON.stringify(rec));
  notify();
}

export function loadCorrection(shopId: string, clientId: string): CorrectionRecord | null {
  if (!shopId || !clientId) return null;
  try {
    const raw = localStorage.getItem(key(shopId, clientId));
    return raw ? (JSON.parse(raw) as CorrectionRecord) : null;
  } catch {
    return null;
  }
}

export function removeCorrection(shopId: string, clientId: string): void {
  try {
    localStorage.removeItem(key(shopId, clientId));
  } catch {
    // keeps the record; the alert stays, which is the safe side
  }
  notify();
}

export function listCorrections(shopId: string): CorrectionRecord[] {
  const out: CorrectionRecord[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(`${PREFIX}${shopId}:`)) continue;
      try {
        const r = JSON.parse(localStorage.getItem(k) ?? '') as CorrectionRecord;
        if (r?.v !== 1) continue;
        // A draft-stage record whose draft was abandoned long ago is dropped (nothing was posted).
        if (r.state === 'draft' && Date.now() - r.savedAt > DRAFT_TTL_MS) {
          localStorage.removeItem(k);
          i--;
          continue;
        }
        out.push(r);
      } catch {
        // unreadable entry: ignored
      }
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => a.savedAt - b.savedAt);
}

/** Posted corrections whose original void is not confirmed yet. */
export const pendingVoids = (shopId: string) =>
  listCorrections(shopId).filter((r) => r.state === 'posted');

export const correctionReason = (rec: CorrectionRecord) =>
  `Corrected by ${rec.newBillLabel || rec.newBillId?.slice(0, 8) || 'a new bill'}`;

/** Plain words for a server refusal of a bill void, saying what to do next. */
export function plainVoidRefusal(message: string): string {
  if (/active allocations|release allocations/i.test(message))
    return 'A supplier payment is assigned to this bill. Release or void that payment first (Suppliers → payments), then void the bill.';
  if (/void posted returns|returns before voiding/i.test(message))
    return 'This bill has supplier returns. Void those returns first (Returns), then void the bill.';
  if (/DSB_PAYMENT_REASSIGNED/.test(message))
    return "The bill's payment is also assigned to other bills. Release that payment from them first, then void the bill.";
  if (/not permitted|permission/i.test(message))
    return 'Your role cannot void this bill. Ask the owner.';
  if (/insufficient|negative|below zero/i.test(message))
    return `Voiding would take stock below zero (some of it was already sold or used): ${message}`;
  return message;
}

/** Voids the original of a posted correction. Same request id on every call; idempotent server side. */
export async function voidOriginal(rec: CorrectionRecord): Promise<WriteOutcome<unknown>> {
  if (rec.state !== 'posted' || !rec.newBillId)
    return { kind: 'rejected', code: 'NOT_POSTED', message: 'The correction is not posted yet.' };
  if (rec.originalPaymentType === 'credit')
    return voidPurchaseOutcome({
      purchaseId: rec.originalId,
      clientId: purchaseVoidRequestId(rec.voidRequestId, { correctedBy: rec.newBillId }),
    });
  return voidPaidPurchaseOutcome({
    purchaseId: rec.originalId,
    reason: correctionReason(rec),
    clientId: rec.voidRequestId,
  });
}

/**
 * Runs the void of a posted correction and settles its record: confirmed -> record removed;
 * refused or unconfirmed -> record kept with the message (the alert offers Retry). Returns a status line.
 */
export async function completeCorrection(rec: CorrectionRecord): Promise<{
  done: boolean;
  message: string;
}> {
  const outcome = await voidOriginal(rec);
  if (outcome.kind === 'committed') {
    removeCorrection(rec.shopId, rec.newClientId);
    return { done: true, message: `${rec.originalLabel} voided (${correctionReason(rec)}).` };
  }
  const message =
    outcome.kind === 'rejected'
      ? `${rec.originalLabel} was NOT voided: ${plainVoidRefusal(outcome.message)}`
      : `Void of ${rec.originalLabel} not confirmed: ${outcome.message}. Retry sends the same request; it never voids twice.`;
  try {
    saveCorrection({ ...rec, lastError: message });
  } catch {
    // the earlier 'posted' record is still stored
  }
  return { done: false, message };
}

/** What stops voiding a bill, from its ledger balance ('' = nothing known). paymentType null = returns only. */
export function correctionBlocker(
  d: { balance: { returned_paise: string; allocated_paise: string } | null },
  paymentType: 'credit' | 'cash' | 'upi' | null,
): string {
  if (d.balance && BigInt(d.balance.returned_paise) > 0n)
    return 'this bill has supplier returns. Void those returns first.';
  if (paymentType === 'credit' && d.balance && BigInt(d.balance.allocated_paise) > 0n)
    return 'a supplier payment is assigned to this bill. Release or void that payment first.';
  return '';
}
