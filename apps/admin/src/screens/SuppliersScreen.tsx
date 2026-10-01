import { useEffect, useRef, useState } from 'preact/hooks';
import {
  allocateSupplierPayment,
  getCurrentMembership,
  getDefaultShopId,
  getShopBusinessDate,
  listParties,
  getSupplierLedger,
  getSupplierOutstanding,
  listSupplierAllocations,
  listSupplierBills,
  listSupplierPayments,
  lookupSupplierRequest,
  recordSupplierPayment,
  releaseSupplierAllocation,
  voidSupplierPayment,
  type PaymentMode,
  type SupplierBill,
  type SupplierLedger,
  type SupplierOperation,
  type SupplierOutstandingRow,
  type SupplierPayment,
  type SupplierWriteOutcome,
} from '@dsb-pro/adapters';
import { parseRupeesToPaise, type Role } from '@dsb-pro/core';
import {
  copyRejectedFinancialAttempt,
  discardFinancialDraft,
  editFinancialDraft,
  listFinancialDrafts,
  listOpenFinancialAttempts,
  newFinancialDraft,
  reconcileFinancialAttempt,
  sendFinancialAttempt,
  waitForOfflineRuntime,
  type FinancialAttempt,
} from '../lib/offlineSync';
import { appRoute } from '../lib/paths';
import { rupees } from '../lib/money';
import { t } from '../lib/i18n';

export { rupees };
const toPaiseText = (r: string) => String(parseRupeesToPaise(r || '0'));

type RecordPayload = {
  shopId: string;
  partyId: string;
  businessDate: string | null;
  amountPaise: string;
  mode: PaymentMode;
  reference: string | null;
  allocations: { purchaseBillId: string; amountPaise: string }[];
};

// Each operation is sent with the attempt's own id as the request id -- never a fresh one.
function sender(attempt: FinancialAttempt): Promise<SupplierWriteOutcome> {
  const p = attempt.payload as Record<string, unknown>;
  switch (attempt.operation) {
    case 'supplier.record.v1':
      return recordSupplierPayment({ requestId: attempt.id, ...(p as RecordPayload) });
    case 'supplier.allocate.v1':
      return allocateSupplierPayment({
        requestId: attempt.id,
        paymentId: String(p.paymentId),
        allocations: p.allocations as RecordPayload['allocations'],
      });
    case 'supplier.void.v1':
      return voidSupplierPayment({
        requestId: attempt.id,
        paymentId: String(p.paymentId),
        reason: String(p.reason),
      });
    case 'supplier.release.v1':
      return releaseSupplierAllocation({
        requestId: attempt.id,
        allocationId: String(p.allocationId),
        reason: String(p.reason),
      });
    default:
      // Customer attempts belong to the Customers screen; never send them from here.
      return Promise.resolve({ kind: 'unknown', message: 'Not a supplier request.' });
  }
}
const lookup = (a: FinancialAttempt) =>
  lookupSupplierRequest(a.shopId, a.operation as SupplierOperation, a.id);

export function SuppliersScreen() {
  const [role, setRole] = useState<Role | null>(null);
  const [shopId, setShopId] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [summary, setSummary] = useState<SupplierOutstandingRow[]>([]);
  const [partyId, setPartyId] = useState('');
  const [bills, setBills] = useState<SupplierBill[]>([]);
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [ledger, setLedger] = useState<SupplierLedger | null>(null);
  const [open, setOpen] = useState<FinancialAttempt[]>([]);
  const [draft, setDraft] = useState<FinancialAttempt | null>(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [reference, setReference] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loadedParty, setLoadedParty] = useState('');
  const restoredFor = useRef('');
  // The shop:party the screen currently shows; late results for any other selection are dropped.
  const current = useRef('');
  const [allParties, setAllParties] = useState<{ id: string; name: string }[]>([]);

  const canPost = role === 'owner' || role === 'manager';
  const isOwner = role === 'owner';

  async function refreshBase() {
    const m = await getCurrentMembership();
    if (!m) throw new Error('No tenant membership.');
    setRole(m.role);
    if (m.role === 'cashier') return;
    const shop = m.shopIds[0] ?? (await getDefaultShopId());
    setShopId(shop);
    const [s, d, parties] = await Promise.all([
      getSupplierOutstanding(shop),
      getShopBusinessDate(shop),
      listParties(),
    ]);
    setSummary(s);
    setAllParties(parties);
    setBusinessDate(d);
  }
  async function refreshParty(shop = shopId, party = partyId) {
    const key = `${shop}:${party}`;
    current.current = key;
    if (!shop || !party) {
      setBills([]);
      setPayments([]);
      setLedger(null);
      setOpen([]);
      setDraft(null);
      return;
    }
    await waitForOfflineRuntime();
    const [b, p, l, o, drafts] = await Promise.all([
      listSupplierBills(shop, party),
      listSupplierPayments(shop, party),
      getSupplierLedger(shop, party),
      listOpenFinancialAttempts(shop, party),
      listFinancialDrafts(shop, party),
    ]);
    if (current.current !== key) return; // a newer selection owns the screen
    setBills(b);
    setPayments(p);
    setLedger(l);
    setOpen(o);
    const d = drafts.find((x) => x.operation === 'supplier.record.v1') ?? null;
    setDraft(d);
    // Restore a saved draft only once per supplier switch, never over what the user is typing.
    if (d && restoredFor.current !== party) {
      const pl = d.payload as RecordPayload;
      setAmount(pl.amountPaise === '0' ? '' : String(Number(pl.amountPaise) / 100));
      setMode(pl.mode);
      setReference(pl.reference ?? '');
      setAlloc(
        Object.fromEntries(
          pl.allocations.map((a) => [a.purchaseBillId, String(Number(a.amountPaise) / 100)]),
        ),
      );
    }
    restoredFor.current = party;
    setLoadedParty(party);
  }
  useEffect(() => {
    void refreshBase().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    void refreshParty().catch((e) => setError(String(e)));
  }, [shopId, partyId]);

  function payload(): RecordPayload {
    return {
      shopId,
      partyId,
      businessDate: businessDate || null,
      amountPaise: toPaiseText(amount),
      mode,
      reference: reference.trim() || null,
      allocations: Object.entries(alloc)
        .filter(([, v]) => v && parseRupeesToPaise(v) > 0)
        .map(([purchaseBillId, v]) => ({ purchaseBillId, amountPaise: toPaiseText(v) })),
    };
  }
  async function saveDraft(): Promise<FinancialAttempt> {
    const pl = payload();
    if (draft) return editFinancialDraft(draft.id, pl);
    const d = await newFinancialDraft({
      operation: 'supplier.record.v1',
      shopId,
      accountId: partyId,
      payload: pl,
    });
    setDraft(d);
    return d;
  }
  async function changeParty(next: string) {
    if (
      draft &&
      !confirm(
        'Keep the unsaved payment draft for this supplier? OK = keep it, Cancel = discard it.',
      )
    ) {
      await discardFinancialDraft(draft.id);
    } else if (draft) {
      await editFinancialDraft(draft.id, payload()); // keep the latest edits, not the older save
    } else if (!draft && (amount || Object.keys(alloc).length)) {
      if (confirm('Save this payment as a draft for this supplier?')) await saveDraft();
    }
    setAmount('');
    setMode('cash');
    setReference('');
    setAlloc({});
    setLoadedParty('');
    setBills([]);
    setPayments([]);
    setLedger(null);
    setOpen([]);
    setDraft(null);
    current.current = '';
    restoredFor.current = '';
    setPartyId(next);
    setConfirming(false);
    setMessage('');
    setError('');
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function report(a: FinancialAttempt) {
    if (a.state === 'COMMITTED') setMessage('Recorded and confirmed by the server.');
    else if (a.state === 'REJECTED') setError(`Not recorded: ${a.errorMessage ?? a.errorCode}`);
    else if (a.state === 'UNKNOWN')
      setError(
        'The server answer was lost. Do NOT record this payment again — use “Check status” below.',
      );
  }
  const submitRecord = () =>
    run(async () => {
      const pl = payload();
      if (!pl.businessDate) throw new Error('Business date not loaded yet. Try again in a moment.');
      if (Number(pl.amountPaise) <= 0) throw new Error('Enter the amount already paid.');
      const total = pl.allocations.reduce((s, a) => s + Number(a.amountPaise), 0);
      if (total > Number(pl.amountPaise))
        throw new Error('Bill allocations exceed the payment amount.');
      // Recheck the durable store for this supplier right before sending (V002 VF-007).
      const unresolvedNow = (await listOpenFinancialAttempts(shopId, partyId)).filter(
        (a) => a.state !== 'READY' || a.id !== draft?.id,
      );
      if (unresolvedNow.length) {
        setOpen(unresolvedNow);
        throw new Error('Resolve the payment awaiting server confirmation first.');
      }
      const d = await saveDraft();
      const result = await sendFinancialAttempt(d.id, sender);
      report(result);
      setConfirming(false);
      // A final attempt is never edited again. After a rejection the fields stay, so the next
      // review saves them as a new draft with a new request id (the spec's "copy to new draft").
      if (result.state === 'REJECTED') setDraft(null);
      if (result.state === 'COMMITTED') {
        setDraft(null);
        setAmount('');
        setReference('');
        setAlloc({});
      }
      await Promise.all([refreshParty(), refreshBase()]);
    });
  const oneOff = (operation: SupplierOperation, pl: Record<string, unknown>) =>
    run(async () => {
      const d = await newFinancialDraft({ operation, shopId, accountId: partyId, payload: pl });
      report(await sendFinancialAttempt(d.id, sender));
      await Promise.all([refreshParty(), refreshBase()]);
    });
  const reconcile = (a: FinancialAttempt) =>
    run(async () => {
      const r = await reconcileFinancialAttempt(a.id, lookup);
      if (r.state === 'READY') {
        // The server never saw it: the same request id and payload may be sent again.
        report(await sendFinancialAttempt(r.id, sender));
      } else if (r.state === 'UNKNOWN')
        setError(`Still unknown: ${r.errorMessage}. Ask an owner or manager to check again.`);
      else report(r);
      await Promise.all([refreshParty(), refreshBase()]);
    });

  if (role === 'cashier') {
    return (
      <main>
        <p role="alert">Supplier payments are not available to cashiers.</p>
        <a href={appRoute.home}>{t('home')}</a>
      </main>
    );
  }
  const party = summary.find((s) => s.partyId === partyId);
  const unresolved = open.filter((a) => a.state !== 'READY' || a.id !== draft?.id);
  const pl = payload();
  const allocTotal = pl.allocations.reduce((s, a) => s + Number(a.amountPaise), 0);

  return (
    <main>
      <div class="row">
        <h1>{t('suppliers')}</h1>
        <a href={appRoute.home}>{t('home')}</a>
      </div>
      <p class="hint">
        This app records money you have already paid a supplier. It does not send money.
      </p>
      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}

      <section>
        <h2>Summary</h2>
        <table>
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Open bills</th>
              <th>Unallocated advances</th>
              <th>Return credits</th>
              <th>Net balance</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={s.partyId}>
                <td>
                  <button class="link" onClick={() => void changeParty(s.partyId)}>
                    {s.partyName}
                  </button>
                  {s.strandedAllocationsOnVoidBills > 0 && (
                    <span class="alert">
                      {' '}
                      ⚠ {s.strandedAllocationsOnVoidBills} payment(s) on void bills — owner must
                      release
                    </span>
                  )}
                </td>
                <td>{rupees(s.grossOpenBills)}</td>
                <td>{rupees(s.unallocatedCashAdvances)}</td>
                <td>{rupees(s.returnCredits)}</td>
                <td>{rupees(s.netLedgerBalance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <label>
          Supplier{' '}
          <select
            value={partyId}
            onChange={(e) => void changeParty((e.target as HTMLSelectElement).value)}
            aria-label="Supplier"
          >
            <option value="">Select…</option>
            {[
              ...summary.map((s) => ({ partyId: s.partyId, partyName: s.partyName })),
              // Suppliers with no bills or payments yet can still receive an advance.
              ...allParties
                .filter((p) => !summary.some((s) => s.partyId === p.id))
                .map((p) => ({ partyId: p.id, partyName: p.name })),
            ].map((s) => (
              <option key={s.partyId} value={s.partyId}>
                {s.partyName}
              </option>
            ))}
          </select>
        </label>
      </section>

      {partyId && (
        <>
          {unresolved.length > 0 && (
            <section class="alert" role="alert" aria-label="Unresolved payments">
              <h2>Payments awaiting server confirmation</h2>
              <p>Resolve these before recording another payment to this supplier.</p>
              <ul>
                {unresolved.map((a) => (
                  <li key={a.id}>
                    {a.operation} · {a.state} · request {a.id.slice(0, 8)}
                    {(a.payload as { amountPaise?: string }).amountPaise && (
                      <> · {rupees(String((a.payload as { amountPaise: string }).amountPaise))}</>
                    )}{' '}
                    {a.state === 'UNKNOWN' && (
                      <button disabled={busy} onClick={() => void reconcile(a)}>
                        Check status
                      </button>
                    )}
                    {a.state === 'READY' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            report(await sendFinancialAttempt(a.id, sender));
                            await refreshParty();
                          })
                        }
                      >
                        Send
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2>Open bills</h2>
            <table>
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Date</th>
                  <th>Total</th>
                  <th>Returned</th>
                  <th>Paid</th>
                  <th>Outstanding</th>
                  {canPost && <th>Allocate ₹</th>}
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.purchase_bill_id}>
                    <td>{b.bill_no ?? b.purchase_bill_id.slice(0, 8)}</td>
                    <td>{b.business_date}</td>
                    <td>{rupees(b.total_paise)}</td>
                    <td>{rupees(b.returned_paise)}</td>
                    <td>{rupees(b.allocated_paise)}</td>
                    <td>{rupees(b.outstanding_paise)}</td>
                    {canPost && (
                      <td>
                        {b.outstanding_paise > 0 && (
                          <input
                            inputMode="decimal"
                            aria-label={`Allocate to ${b.bill_no ?? b.purchase_bill_id}`}
                            value={alloc[b.purchase_bill_id] ?? ''}
                            disabled={confirming || unresolved.length > 0}
                            onInput={(e) =>
                              setAlloc({
                                ...alloc,
                                [b.purchase_bill_id]: (e.target as HTMLInputElement).value,
                              })
                            }
                          />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {canPost && loadedParty === partyId && (
            <section>
              <h2>{t('recordPaymentMade')}</h2>
              {unresolved.length > 0 ? (
                <p>Blocked until the payments above are resolved.</p>
              ) : !confirming ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setError('');
                    setConfirming(true);
                  }}
                >
                  <label>
                    Amount paid ₹{' '}
                    <input
                      inputMode="decimal"
                      required
                      value={amount}
                      onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
                    />
                  </label>{' '}
                  <label>
                    Mode{' '}
                    <select
                      value={mode}
                      onChange={(e) =>
                        setMode((e.target as HTMLSelectElement).value as PaymentMode)
                      }
                    >
                      {(['cash', 'upi', 'bank', 'card', 'other'] as const).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>{' '}
                  <label>
                    Reference{' '}
                    <input
                      value={reference}
                      onInput={(e) => setReference((e.target as HTMLInputElement).value)}
                    />
                  </label>{' '}
                  <button type="submit">Review</button>{' '}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await saveDraft();
                        setMessage('Draft saved on this device.');
                      })
                    }
                  >
                    Save draft
                  </button>
                  {draft && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            await discardFinancialDraft(draft.id);
                            await refreshParty();
                          })
                        }
                      >
                        Discard draft
                      </button>
                    </>
                  )}
                </form>
              ) : (
                <div aria-label="Confirm payment">
                  <p>
                    Record a payment <strong>already made</strong> to{' '}
                    <strong>{party?.partyName}</strong> on {businessDate} by {mode}
                    {reference && ` (ref ${reference})`}.
                  </p>
                  <p>
                    Total {rupees(pl.amountPaise)} · allocated to bills {rupees(allocTotal)} ·
                    remaining advance {rupees(Number(pl.amountPaise) - allocTotal)}
                  </p>
                  <button disabled={busy} onClick={() => void submitRecord()}>
                    Confirm and record
                  </button>{' '}
                  <button disabled={busy} onClick={() => setConfirming(false)}>
                    Back
                  </button>
                </div>
              )}
            </section>
          )}

          <section>
            <h2>Payment history</h2>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Allocated</th>
                  <th>Advance left</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <PaymentRow
                    key={p.id}
                    p={p}
                    bills={bills}
                    canPost={canPost && unresolved.length === 0}
                    isOwner={isOwner}
                    busy={busy}
                    onAllocate={(billId, amt) =>
                      void oneOff('supplier.allocate.v1', {
                        paymentId: p.id,
                        allocations: [{ purchaseBillId: billId, amountPaise: toPaiseText(amt) }],
                      })
                    }
                    onVoid={(reason) =>
                      void oneOff('supplier.void.v1', { paymentId: p.id, reason })
                    }
                    onRelease={(allocationId, reason) =>
                      void oneOff('supplier.release.v1', { allocationId, reason })
                    }
                  />
                ))}
              </tbody>
            </table>
          </section>

          {ledger && (
            <section>
              <h2>Ledger (this shop)</h2>
              <p>
                Opening {rupees(ledger.openingBalancePaise)} · Closing{' '}
                {rupees(ledger.closingBalancePaise)} (positive = owed to supplier)
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry</th>
                    <th>Document</th>
                    <th>Amount</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.entries.map((e) => (
                    <tr key={`${e.kind}-${e.id}`}>
                      <td>{e.date}</td>
                      <td>{e.kind}</td>
                      <td>{e.document}</td>
                      <td>{rupees(e.amountPaise)}</td>
                      <td>{rupees(e.runningBalancePaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <RejectedCopy shopId={shopId} partyId={partyId} onCopied={() => void refreshParty()} />
        </>
      )}
    </main>
  );
}

function PaymentRow(props: {
  p: SupplierPayment;
  bills: SupplierBill[];
  canPost: boolean;
  isOwner: boolean;
  busy: boolean;
  onAllocate: (billId: string, rupeesText: string) => void;
  onVoid: (reason: string) => void;
  onRelease: (allocationId: string, reason: string) => void;
}) {
  const { p } = props;
  const [allocs, setAllocs] = useState<Awaited<ReturnType<typeof listSupplierAllocations>> | null>(
    null,
  );
  const left = p.amount_paise - p.allocated_paise;
  const ask = (label: string) => {
    const r = prompt(`${label} — reason (required)`);
    return r && r.trim() ? r.trim() : null;
  };
  return (
    <>
      <tr>
        <td>{p.business_date}</td>
        <td>{rupees(p.amount_paise)}</td>
        <td>{rupees(p.allocated_paise)}</td>
        <td>{rupees(left)}</td>
        <td>
          {p.mode}
          {p.reference && ` · ${p.reference}`}
        </td>
        <td>{p.status}</td>
        <td>
          <button onClick={() => void listSupplierAllocations(p.id).then(setAllocs)}>Bills</button>
          {p.status === 'POSTED' && props.canPost && left > 0 && (
            <>
              {' '}
              <button
                disabled={props.busy}
                onClick={() => {
                  const open = props.bills.filter((b) => b.outstanding_paise > 0);
                  const bill = prompt(
                    `Allocate advance to which bill?\n${open.map((b) => b.bill_no ?? b.purchase_bill_id).join(', ')}`,
                  );
                  const target = open.find(
                    (b) => (b.bill_no ?? b.purchase_bill_id) === bill?.trim(),
                  );
                  const amt = target && prompt('Amount ₹ to allocate');
                  if (target && amt) props.onAllocate(target.purchase_bill_id, amt);
                }}
              >
                Allocate advance
              </button>
            </>
          )}
          {p.status === 'POSTED' && props.isOwner && (
            <>
              {' '}
              <button
                disabled={props.busy}
                onClick={() => {
                  const r = ask('Void this payment record');
                  if (r) props.onVoid(r);
                }}
              >
                Void
              </button>
            </>
          )}
        </td>
      </tr>
      {allocs &&
        allocs.map((a) => (
          <tr key={a.id} class="sub">
            <td colSpan={2}>
              → bill{' '}
              {props.bills.find((b) => b.purchase_bill_id === a.purchase_bill_id)?.bill_no ??
                a.purchase_bill_id.slice(0, 8)}
            </td>
            <td>{rupees(a.amount_paise)}</td>
            <td>{a.effective_date}</td>
            <td />
            <td>{a.status}</td>
            <td>
              {a.status === 'POSTED' && props.isOwner && (
                <button
                  disabled={props.busy}
                  onClick={() => {
                    const r = ask('Release this bill match (cash stays recorded)');
                    if (r) props.onRelease(a.id, r);
                  }}
                >
                  Release
                </button>
              )}
            </td>
          </tr>
        ))}
    </>
  );
}

function RejectedCopy(props: { shopId: string; partyId: string; onCopied: () => void }) {
  const [hint, setHint] = useState('');
  return (
    <p class="hint">
      A rejected payment is never re-sent. To fix and resubmit one, enter its request id:{' '}
      <input
        aria-label="Rejected request id"
        value={hint}
        onInput={(e) => setHint((e.target as HTMLInputElement).value)}
      />{' '}
      <button
        onClick={() =>
          void copyRejectedFinancialAttempt(hint.trim())
            .then(props.onCopied)
            .catch((e) => alert(String(e)))
        }
      >
        Copy to new draft
      </button>
    </p>
  );
}
