import { useEffect, useState } from 'preact/hooks';
import {
  VOID_REASON_MAX,
  getPurchaseVoidInfo,
  purchaseVoidRequestId,
  voidPurchaseOutcome,
} from '@dsb-pro/adapters';

// Void of a credit (or v1) purchase bill through void_purchase. Editing a bill is deliberately NOT here:
// a correction must post the new bill and void the original in one server transaction (future RPC).

/** Plain words for a server refusal of a bill void, saying what to do next. */
export function plainVoidRefusal(message: string): string {
  if (/active allocations|release allocations/i.test(message))
    return 'A supplier payment is assigned to this bill. Release or void that payment first (Suppliers → payments), then void the bill.';
  if (/void posted returns|returns before voiding/i.test(message))
    return 'This bill has supplier returns. Void those returns first (Returns), then void the bill.';
  if (/not permitted|permission/i.test(message))
    return 'Your role cannot void this bill. Ask the owner.';
  if (/insufficient|negative|below zero/i.test(message))
    return `Voiding would take stock below zero (some of it was already sold or used): ${message}`;
  return message;
}

/** What stops a void, from the bill's ledger balance ('' = nothing known; the server re-checks). */
export function voidBlocker(
  balance: { returned_paise: string; allocated_paise: string } | null,
): string {
  if (balance && BigInt(balance.returned_paise) > 0n)
    return 'this bill has supplier returns. Void those returns first.';
  if (balance && BigInt(balance.allocated_paise) > 0n)
    return 'a supplier payment is assigned to this bill. Release or void that payment first.';
  return '';
}

// An unconfirmed void keeps its request (id + reason) on this device, so leaving the bill, reloading or
// coming back later retries the SAME request. Removed only on a definitive answer.
type PendingVoid = { billId: string; clientId: string; reason: string };
// Keyed by user + shop + bill (`scope` = "<user>:<shop>"): another account on this device never sees it.
const pendingKey = (scope: string, billId: string) =>
  `dsb-pending-purchase-void:${scope}:${billId}`;
export function loadPendingVoid(scope: string, billId: string): PendingVoid | null {
  try {
    const raw = localStorage.getItem(pendingKey(scope, billId));
    const v = raw ? (JSON.parse(raw) as PendingVoid) : null;
    return v && v.billId === billId && typeof v.clientId === 'string' ? v : null;
  } catch {
    return null;
  }
}
/** Clears the kept request; called when the bill is seen VOID (returns null so it can sit in JSX). */
export function clearPendingVoid(scope: string, billId: string): null {
  try {
    localStorage.removeItem(pendingKey(scope, billId));
  } catch {
    // a stale entry only means the next void reuses an id the server already answered: harmless
  }
  return null;
}

export function CreditVoidPanel({
  scope,
  disabled = false,
  billId,
  label,
  blocked,
  onVoided,
}: {
  /** "<user>:<shop>" */
  scope: string;
  /** The bill detail is refreshing or could not be refreshed: no void on a possibly stale bill. */
  disabled?: boolean;
  billId: string;
  label: string;
  /** Known reason the server will refuse (payment assigned, returns), shown instead of the button. */
  blocked: string;
  onVoided: (note: string) => void;
}) {
  const [pending, setPending] = useState<PendingVoid | null>(() => loadPendingVoid(scope, billId));
  const [reason, setReason] = useState(pending?.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(
    pending ? 'An earlier void of this bill was not confirmed. Retry sends the same request.' : '',
  );
  useEffect(() => {
    const p = loadPendingVoid(scope, billId);
    setPending(p);
    setReason(p?.reason ?? '');
    setNote(
      p ? 'An earlier void of this bill was not confirmed. Retry sends the same request.' : '',
    );
  }, [scope, billId]);
  async function run() {
    if (busy || disabled) return;
    let req = pending;
    if (!req) {
      let clientId: string;
      try {
        clientId = purchaseVoidRequestId(crypto.randomUUID(), { reason });
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
        return;
      }
      if (
        !confirm(
          `Void ${label}? Its stock comes off and the supplier balance is reduced by this bill. This cannot be undone.`,
        )
      )
        return;
      req = { billId, clientId, reason: reason.trim() };
      try {
        localStorage.setItem(pendingKey(scope, billId), JSON.stringify(req));
      } catch (e) {
        setNote(`Not sent: the void could not be kept on this device (${String(e)}).`);
        return;
      }
      setPending(req);
    }
    setBusy(true);
    setNote('');
    try {
      const outcome = await voidPurchaseOutcome({ purchaseId: req.billId, clientId: req.clientId });
      if (outcome.kind === 'unknown') {
        setNote(
          `Not confirmed: ${outcome.message}. Retry sends the same void request; it never voids twice.`,
        );
        return;
      }
      clearPendingVoid(scope, billId);
      setPending(null);
      if (outcome.kind === 'rejected') {
        setNote(`Not voided: ${plainVoidRefusal(outcome.message)}`);
        return;
      }
      setReason('');
      onVoided('Bill voided. Stock and supplier balance reversed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="void-paid" aria-label="Void bill">
      {blocked && !pending ? (
        <p class="muted" data-testid="void-blocked">
          Cannot void yet: {blocked}
        </p>
      ) : (
        <>
          <label>
            Reason for voiding
            <input
              value={reason}
              maxLength={VOID_REASON_MAX}
              readOnly={Boolean(pending)}
              disabled={busy || disabled}
              placeholder="e.g. entered twice"
              onInput={(e) => setReason(e.currentTarget.value)}
            />
          </label>
          <small class="muted">
            Staff who can see this bill can read the reason. No colons (:).
          </small>
          <button
            type="button"
            class="danger"
            disabled={busy || disabled || !reason.trim()}
            onClick={() => void run()}
          >
            {busy ? 'Voiding…' : pending ? 'Retry void (same request)' : 'Void bill'}
          </button>
          <small class="muted">Reverses this bill's stock and the supplier balance.</small>
        </>
      )}
      {note && <p role="status">{note}</p>}
    </section>
  );
}

/** "Void reason" of a voided bill, when it was recorded by this void and can be read. */
export function VoidReasonNote({ shopId, billId }: { shopId: string; billId: string }) {
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setReason(null);
    void Promise.resolve()
      .then(() => getPurchaseVoidInfo(shopId, billId))
      .then(
        (v) => active && setReason(v?.reason ?? null),
        () => {},
      );
    return () => {
      active = false;
    };
  }, [shopId, billId]);
  return reason ? <p data-testid="void-reason">Void reason: {reason}</p> : null;
}
