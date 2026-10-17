import { useEffect, useRef, useState } from 'preact/hooks';
import {
  getShopBusinessDate,
  listSupplierBills,
  type PaymentMode,
  type SupplierOutstandingRow,
} from '@dsb-pro/adapters';
import { withAccountLock } from '../lib/accountLock';
import {
  listFinancialDrafts,
  listOpenFinancialAttempts,
  newFinancialDraft,
  sendFinancialAttempt,
} from '../lib/offlineSync';
import { supplierSender } from '../lib/supplierPaymentFlow';
import {
  runBulkPayments,
  validateBulk,
  type BulkDeps,
  type BulkRowResult,
} from '../lib/bulkSupplierPayment';
import { rupees } from '../lib/money';

const realDeps: BulkDeps = {
  lock: withAccountLock,
  listOpen: listOpenFinancialAttempts,
  listDrafts: listFinancialDrafts,
  businessDate: getShopBusinessDate,
  listBills: listSupplierBills,
  newDraft: (input) => newFinancialDraft(input),
  send: (id) => sendFinancialAttempt(id, supplierSender),
};

// Record money already paid to several suppliers in one go. Each one is recorded separately, exactly like a
// single supplier payment; this screen never sends money.
export function BulkSupplierPayments(props: {
  shopId: string;
  businessDate: string;
  suppliers: SupplierOutstandingRow[];
  onDone: (results: BulkRowResult[]) => void;
  deps?: BulkDeps;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [reference, setReference] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BulkRowResult[]>([]);
  const inFlight = useRef(false);
  // A changed supplier list or payment mode needs a fresh review.
  useEffect(() => setReviewing(false), [props.suppliers, mode]);
  const owed = props.suppliers.filter((s) => BigInt(s.netLedgerBalance) > 0n);
  const name = (id: string) => props.suppliers.find((s) => s.partyId === id)?.partyName ?? id;
  const entries = owed.map((s) => ({
    partyId: s.partyId,
    partyName: s.partyName,
    amount: amounts[s.partyId] ?? '',
  }));
  const checked = validateBulk(entries);

  async function record() {
    if (!checked.ok || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setResults([]);
    try {
      const out = await runBulkPayments(
        checked.rows,
        {
          shopId: props.shopId,
          businessDate: props.businessDate,
          mode,
          reference: reference.trim() || null,
        },
        props.deps ?? realDeps,
        (r) => setResults((v) => [...v, r]),
      );
      // Recorded suppliers, and any whose answer was lost, are cleared so a second press can never record
      // them again; the user re-enters an amount only after checking that supplier.
      setAmounts((v) => {
        const next = { ...v };
        for (const r of out)
          if (r.status === 'committed' || r.status === 'unknown') delete next[r.partyId];
        return next;
      });
      setReviewing(false);
      props.onDone(out);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <details class="card" aria-label="Pay several suppliers">
      <summary>Record payments to several suppliers</summary>
      <p class="muted">
        For money you have already paid. Each supplier is recorded on its own, oldest bills first;
        any extra stays as an advance. Date: {props.businessDate}.
      </p>
      {owed.length === 0 && <p>No supplier balance is owed.</p>}
      {owed.map((s) => (
        <label key={s.partyId} class="row">
          {s.partyName} (owed {rupees(s.netLedgerBalance)})
          <input
            aria-label={`Amount paid to ${s.partyName}`}
            inputMode="decimal"
            value={amounts[s.partyId] ?? ''}
            disabled={busy}
            onInput={(e) => {
              setReviewing(false);
              setAmounts((v) => ({ ...v, [s.partyId]: e.currentTarget.value }));
            }}
          />
        </label>
      ))}
      {owed.length > 0 && (
        <>
          <label>
            Paid by{' '}
            <select
              value={mode}
              disabled={busy}
              onChange={(e) => setMode(e.currentTarget.value as PaymentMode)}
            >
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="bank">Bank</option>
              <option value="card">Card</option>
              <option value="other">Other</option>
            </select>
          </label>{' '}
          <label>
            Reference{' '}
            <input
              value={reference}
              disabled={busy}
              onInput={(e) => setReference(e.currentTarget.value)}
            />
          </label>{' '}
          {!reviewing ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setErrors(checked.ok ? [] : checked.errors);
                setReviewing(checked.ok);
              }}
            >
              Review
            </button>
          ) : (
            checked.ok && (
              <div role="group" aria-label="Confirm bulk payments">
                <ul>
                  {checked.rows.map((r) => {
                    const owedPaise = BigInt(
                      props.suppliers.find((s) => s.partyId === r.partyId)?.netLedgerBalance ?? '0',
                    );
                    const advance = r.amountPaise - owedPaise;
                    return (
                      <li key={r.partyId}>
                        {r.partyName}: {rupees(r.amountPaise.toString())}
                        {advance > 0n && (
                          <strong class="alert">
                            {' '}
                            — {rupees(advance.toString())} more than owed, kept as advance
                          </strong>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p>
                  Record {checked.rows.length} payment{checked.rows.length === 1 ? '' : 's'}{' '}
                  totalling <strong>{rupees(checked.totalPaise.toString())}</strong> by {mode}?
                </p>
                <button type="button" class="primary" disabled={busy} onClick={() => void record()}>
                  {busy ? 'Recording…' : 'Record payments'}
                </button>{' '}
                <button type="button" disabled={busy} onClick={() => setReviewing(false)}>
                  Back
                </button>
              </div>
            )
          )}
        </>
      )}
      {errors.map((m) => (
        <p key={m} class="alert" role="alert">
          {m}
        </p>
      ))}
      {results.length > 0 && (
        <ul aria-label="Bulk payment results">
          {results.map((r) => (
            <li key={r.partyId} class={r.status === 'committed' ? '' : 'alert'}>
              {name(r.partyId)}:{' '}
              {r.status === 'committed'
                ? `recorded ${rupees(r.amountPaise)}${BigInt(r.advancePaise) > 0n ? `, ${rupees(r.advancePaise)} kept as advance` : ''}.`
                : r.message}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
