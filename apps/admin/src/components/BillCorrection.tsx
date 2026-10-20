import { useEffect, useRef, useState } from 'preact/hooks';
import {
  VOID_REASON_MAX,
  findCorrectedBill,
  getPurchaseVoidInfo,
  purchaseVoidRequestId,
  voidPurchaseOutcome,
  type PurchaseVoidInfo,
} from '@dsb-pro/adapters';
import {
  CORRECTION_EVENT,
  completeCorrection,
  listCorrections,
  plainVoidRefusal,
  type CorrectionRecord,
} from '../lib/billCorrection';
import { appRoute } from '../lib/paths';

/** Void of a credit (or v1) bill: reason required, confirm, one request id per bill until confirmed. */
export function CreditVoidPanel({
  billId,
  label,
  blocked,
  onVoided,
}: {
  billId: string;
  label: string;
  /** Known reason the server will refuse (payment assigned, returns), shown instead of the button. */
  blocked: string;
  onVoided: (note: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const request = useRef<{ billId: string; clientId: string } | null>(null);
  useEffect(() => {
    if (request.current?.billId === billId) return;
    request.current = null;
    setReason('');
    setNote('');
    setUnconfirmed(false);
  }, [billId]);
  async function run() {
    if (busy) return;
    if (!request.current) {
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
      request.current = { billId, clientId };
    }
    const req = request.current;
    setBusy(true);
    setNote('');
    try {
      const outcome = await voidPurchaseOutcome({ purchaseId: req.billId, clientId: req.clientId });
      if (outcome.kind === 'unknown') {
        setUnconfirmed(true);
        setNote(
          `Not confirmed: ${outcome.message}. Retry sends the same void request; it never voids twice.`,
        );
        return;
      }
      request.current = null;
      setUnconfirmed(false);
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
      {blocked ? (
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
              readOnly={unconfirmed}
              disabled={busy}
              placeholder="e.g. entered twice"
              onInput={(e) => setReason(e.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            class="danger"
            disabled={busy || !reason.trim()}
            onClick={() => void run()}
          >
            {busy ? 'Voiding…' : unconfirmed ? 'Retry void (same request)' : 'Void bill'}
          </button>
          <small class="muted">Reverses this bill's stock and the supplier balance.</small>
        </>
      )}
      {note && <p role="status">{note}</p>}
    </section>
  );
}

function useCorrections(shopId: string): CorrectionRecord[] {
  const [list, setList] = useState<CorrectionRecord[]>([]);
  useEffect(() => {
    if (!shopId) return;
    const load = () => setList(listCorrections(shopId));
    load();
    window.addEventListener(CORRECTION_EVENT, load);
    window.addEventListener('storage', load);
    return () => {
      window.removeEventListener(CORRECTION_EVENT, load);
      window.removeEventListener('storage', load);
    };
  }, [shopId]);
  return list;
}

/** Persistent alert for every posted correction whose original bill is not voided yet. */
export function CorrectionAlerts({ shopId, onDone }: { shopId: string; onDone?: () => void }) {
  const list = useCorrections(shopId).filter((r) => r.state === 'posted');
  const [busy, setBusy] = useState('');
  if (!list.length) return null;
  return (
    <>
      {list.map((r) => (
        <div role="alert" class="card" key={r.newClientId} data-testid="correction-alert">
          <p>
            <strong>
              {r.newBillLabel || 'The correcting bill'} is posted, but {r.originalLabel} is still
              live.
            </strong>{' '}
            Both bills count until the original is voided.
          </p>
          {r.lastError && <p>{r.lastError}</p>}
          <button
            type="button"
            disabled={busy === r.newClientId}
            onClick={() => {
              setBusy(r.newClientId);
              void completeCorrection(r)
                .then(() => onDone?.())
                .finally(() => setBusy(''));
            }}
          >
            {busy === r.newClientId ? 'Voiding…' : 'Retry void'}
          </button>{' '}
          <a href={appRoute.purchases}>Bill list</a>
        </div>
      ))}
    </>
  );
}

/** "Void reason" and the correction link in both directions, when they can be read. */
export function BillCorrectionLinks({
  shopId,
  billId,
  status,
  onOpen,
}: {
  shopId: string;
  billId: string;
  status: 'POSTED' | 'VOID';
  onOpen: (id: string) => void;
}) {
  const [info, setInfo] = useState<PurchaseVoidInfo | null>(null);
  const [correctionOf, setCorrectionOf] = useState<string | null>(null);
  const local = useCorrections(shopId);
  useEffect(() => {
    let active = true;
    setInfo(null);
    setCorrectionOf(null);
    if (status === 'VOID')
      void Promise.resolve()
        .then(() => getPurchaseVoidInfo(shopId, billId))
        .then(
          (v) => active && setInfo(v),
          () => {},
        );
    else
      void Promise.resolve()
        .then(() => findCorrectedBill(shopId, billId))
        .then(
          (v) => active && setCorrectionOf(v),
          () => {},
        );
    return () => {
      active = false;
    };
  }, [shopId, billId, status]);
  const localOf = local.find((r) => r.newBillId === billId);
  const localBy = local.find((r) => r.originalId === billId && r.newBillId);
  const correctedBy = info?.correctedBy ?? localBy?.newBillId ?? null;
  const original = correctionOf ?? localOf?.originalId ?? null;
  return (
    <>
      {info?.reason && <p data-testid="void-reason">Void reason: {info.reason}</p>}
      {correctedBy && (
        <p data-testid="corrected-by">
          Corrected by{' '}
          <button type="button" class="link" onClick={() => onOpen(correctedBy)}>
            {localBy?.newBillLabel || 'the new bill'}
          </button>
        </p>
      )}
      {original && (
        <p data-testid="correction-of">
          Correction of{' '}
          <button type="button" class="link" onClick={() => onOpen(original)}>
            {localOf?.originalLabel || 'the original bill'}
          </button>
        </p>
      )}
    </>
  );
}
