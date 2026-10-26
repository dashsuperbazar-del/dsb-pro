import { useEffect, useRef, useState } from 'preact/hooks';
import {
  closeRejectedSupplierPayment,
  getOfflineRuntimeIdentity,
  getQueuedSupplierPaymentTotals,
  getSavedSupplierPayCopy,
  listOfflineSupplierPayments,
  queueSupplierPaymentOffline,
  refreshSupplierPayCopy,
  runSyncNow,
  waitForOfflineRuntime,
  type OfflineSupplierPaymentRecord,
  type SupplierPayCopy,
} from '../lib/offlineSync';
import {
  PAY_MODES,
  checkPayForm,
  fifoPlan,
  paiseToRupeesText,
  rupeesTextToPaise,
  billLabel,
  type ParsedPayment,
  type PayFormErrors,
} from '../lib/supplierPayForm';
import { snapshotAge } from '../lib/routeSnapshot';
import { rupees } from '../lib/money';
import { HomeRow } from './HomeRow';
import { useUserId } from '../lib/useUserId';

// "Pay supplier" that works offline (owner/manager; mig 0074). The payment is saved on this device first
// ("Saved on this device, not yet in the supplier's balance"), sent in order when online, and applied by the
// server only if the supplier and the bills it names are unchanged. A refusal keeps the full form here with a
// specific reason and "Redo this payment"; nothing is ever moved to another bill or supplier. Balances shown
// are the saved copy: they change only after the server confirms.

const DAY_MS = 86_400_000;
type Totals = { bySupplier: Record<string, bigint>; byBill: Record<string, bigint> };
type Prefill = {
  partyId: string;
  amount: string;
  mode: string;
  reference: string;
  date: string;
  allocs: Record<string, string>;
};
type Review = { value: ParsedPayment; clientId: string; redoOf: string | null };

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** The latest date a payment may carry: the shop date from the saved copy, or the device date if later. */
const latestDate = (copy: SupplierPayCopy) => {
  const today = localToday();
  return today > copy.businessDate ? today : copy.businessDate;
};

type SavedForm = {
  partyId: string;
  amount: string;
  mode: string;
  reference: string;
  date: string;
  allocs: Record<string, string>;
};

export function PaySupplierPanel() {
  const userId = useUserId();
  const [shopId, setShopId] = useState('');
  const [copy, setCopy] = useState<SupplierPayCopy | null>(null);
  const [copyChecked, setCopyChecked] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [records, setRecords] = useState<OfflineSupplierPaymentRecord[]>([]);
  const [totals, setTotals] = useState<Totals>({ bySupplier: {}, byBill: {} });
  const [partyId, setPartyId] = useState('');
  const [formKey, setFormKey] = useState(0);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [errors, setErrors] = useState<PayFormErrors | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [fail, setFail] = useState('');
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine !== false,
  );
  const saving = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const redoOf = useRef<string | null>(null);
  const shopRef = useRef('');
  const amountRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<HTMLSelectElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const referenceRef = useRef<HTMLInputElement>(null);
  const allocRefs = useRef<Record<string, HTMLInputElement | null>>({});

  async function loadRecords(shop = shopRef.current) {
    if (!shop) return;
    try {
      setRecords(await listOfflineSupplierPayments(shop));
      setTotals(await getQueuedSupplierPaymentTotals(shop));
    } catch {
      // The device store is not ready yet: the next event reloads.
    }
  }
  async function refreshCopy(shop = shopRef.current) {
    if (!shop) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      const fresh = await refreshSupplierPayCopy(shop);
      if (shopRef.current === shop) {
        setCopy(fresh);
        setRefreshFailed(false);
      }
    } catch {
      if (shopRef.current === shop) setRefreshFailed(true);
    }
  }
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await waitForOfflineRuntime(10_000);
      } catch {
        return;
      }
      const identity = getOfflineRuntimeIdentity();
      if (!live || !identity || !['owner', 'manager'].includes(identity.role)) return;
      shopRef.current = identity.shopId;
      setShopId(identity.shopId);
      try {
        const saved = await getSavedSupplierPayCopy(identity.shopId);
        if (live) setCopy(saved);
      } catch {
        // No saved copy readable: the note below says so.
      }
      if (live) setCopyChecked(true);
      await loadRecords(identity.shopId);
      await refreshCopy(identity.shopId);
    })();
    const onRecords = () => {
      void loadRecords();
      void refreshCopy();
    };
    const onNet = () => {
      setOnline(navigator.onLine !== false);
      if (navigator.onLine !== false) void refreshCopy();
    };
    window.addEventListener('dsb-offline-supplier-payments', onRecords);
    window.addEventListener('online', onNet);
    window.addEventListener('offline', onNet);
    return () => {
      live = false;
      window.removeEventListener('dsb-offline-supplier-payments', onRecords);
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
    };
  }, []);

  if (!shopId) return null;
  const supplier = copy?.suppliers.find((s) => s.partyId === partyId) ?? null;
  const maxDate = copy ? latestDate(copy) : localToday();

  function readForm(): SavedForm {
    const allocs: Record<string, string> = {};
    for (const [id, el] of Object.entries(allocRefs.current))
      if (el && el.value.trim()) allocs[id] = el.value;
    return {
      partyId,
      amount: amountRef.current?.value ?? '',
      mode: modeRef.current?.value ?? 'cash',
      reference: referenceRef.current?.value ?? '',
      date: dateRef.current?.value ?? '',
      allocs,
    };
  }
  function check(form: SavedForm) {
    return checkPayForm({
      supplier,
      amountText: form.amount,
      mode: form.mode,
      reference: form.reference,
      dateText: form.date,
      allocTexts: form.allocs,
      businessDate: maxDate,
      queuedForSupplier: totals.bySupplier[partyId] ?? 0n,
      queuedByBill: totals.byBill,
    });
  }
  function onReview(e: Event) {
    e.preventDefault();
    setNote('');
    setFail('');
    const result = check(readForm());
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors(null);
    setReview({ value: result.value, clientId: requestId.current, redoOf: redoOf.current });
  }
  function autoAssign() {
    if (!supplier) return;
    const cents = rupeesTextToPaise(amountRef.current?.value ?? '');
    if (cents === null || cents <= 0n) {
      setErrors({
        allocations: {},
        amount: 'Enter the amount you paid first, then assign it to bills.',
      });
      return;
    }
    const plan = fifoPlan(supplier, totals.byBill, cents);
    for (const b of supplier.bills) {
      const el = allocRefs.current[b.billId];
      if (el) el.value = plan.allocations[b.billId] ?? '';
    }
    setErrors(null);
    setNote(
      plan.remainderPaise > 0n
        ? `Oldest bills first. ${rupees(plan.remainderPaise.toString())} is not assigned to a bill (it stays against the supplier's balance).`
        : 'Oldest bills first. Check the amounts before saving.',
    );
  }
  function fillBill(billId: string, left: bigint) {
    const el = allocRefs.current[billId];
    if (el) el.value = paiseToRupeesText(left < 0n ? 0n : left);
    setErrors(null);
  }
  async function save() {
    if (!review || saving.current) return;
    saving.current = true;
    setBusy(true);
    setFail('');
    try {
      const v = review.value;
      await queueSupplierPaymentOffline({
        clientId: review.clientId,
        shopId,
        partyId: v.partyId,
        partyName: v.partyName,
        businessDate: v.businessDate,
        amountPaise: v.amountPaise,
        mode: v.mode,
        reference: v.reference,
        allocations: v.allocations,
        baseVersions: v.baseVersions,
        form: { ...readForm(), partyName: v.partyName } satisfies SavedForm & { partyName: string },
        limits: v.limits,
      });
      if (review.redoOf) await closeRejectedSupplierPayment(review.redoOf).catch(() => undefined);
      // A new request id for the next payment; this one is saved.
      requestId.current = crypto.randomUUID();
      redoOf.current = null;
      setReview(null);
      setPrefill(null);
      setPartyId('');
      setFormKey((k) => k + 1);
      setNote(
        'Saved on this device, not yet in the supplier’s balance. It is sent to the server when you are online.',
      );
      await loadRecords();
      void runSyncNow().catch(() => undefined);
    } catch (e) {
      setFail(e instanceof Error ? e.message : String(e));
      setReview(null);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function redo(r: OfflineSupplierPaymentRecord) {
    const f = (r.form ?? {}) as Partial<SavedForm>;
    setPrefill({
      partyId: r.partyId,
      amount: f.amount ?? paiseToRupeesText(r.amountPaise),
      mode: f.mode ?? r.mode,
      reference: f.reference ?? r.reference ?? '',
      date: f.date ?? r.businessDate ?? '',
      allocs:
        f.allocs ??
        Object.fromEntries(
          r.allocations.map((a) => [a.purchaseBillId, paiseToRupeesText(a.amountPaise)]),
        ),
    });
    // A fresh request id: the refused payment's id is spent and its record stays until this one is saved.
    requestId.current = crypto.randomUUID();
    redoOf.current = r.clientId;
    setPartyId(r.partyId);
    setReview(null);
    setErrors(null);
    setFail('');
    setNote('The refused payment is filled in again below. Check it and save it.');
    setFormKey((k) => k + 1);
  }
  async function dismiss(r: OfflineSupplierPaymentRecord) {
    if (!confirm('Dismiss this refused payment? Nothing was recorded.')) return;
    try {
      await closeRejectedSupplierPayment(r.clientId);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    await loadRecords();
  }

  const now = Date.now();
  const shown = records.filter(
    (r) =>
      r.status === 'QUEUED' ||
      (r.status === 'REJECTED' && r.closedAt === null) ||
      (r.status === 'SYNCED' && r.syncedAt !== null && now - r.syncedAt < DAY_MS),
  );
  const queued = shown.filter((r) => r.status === 'QUEUED');
  const refused = shown.filter((r) => r.status === 'REJECTED');
  const queuedPaise = queued.reduce((n, r) => n + BigInt(r.amountPaise), 0n);
  const summary = [
    queued.length ? `${rupees(queuedPaise.toString())} not synced` : '',
    refused.length ? `${refused.length} refused` : '',
    !queued.length && !refused.length ? `${shown.length} synced` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const err = errors ?? { allocations: {} };
  const initial = prefill && prefill.partyId === partyId ? prefill : null;
  const owedLeft = supplier
    ? BigInt(supplier.owedPaise) - (totals.bySupplier[supplier.partyId] ?? 0n)
    : 0n;

  return (
    <section class="pay-supplier" aria-label="Pay supplier" data-testid="pay-supplier">
      <h2>Pay supplier</h2>
      <p class="hint">
        Works without a connection. The payment is saved on this device first and sent to the server
        when you are online. It is not in the supplier’s balance until the server confirms it, and
        it is refused (never moved to another bill) if the supplier or a bill changed in the
        meantime.
      </p>
      {copy && (
        <p
          class={!online || refreshFailed ? 'alert' : 'muted'}
          role="status"
          data-testid="pay-copy-note"
        >
          {!online
            ? `You are offline. The supplier list and amounts owed are the ones saved on this device ${snapshotAge(copy.savedAt)}; they do not include anything that happened since.`
            : refreshFailed
              ? `Could not refresh. The supplier list and amounts owed are from ${snapshotAge(copy.savedAt)} and may be out of date.`
              : `Supplier list saved on this device ${snapshotAge(copy.savedAt)}.`}
        </p>
      )}
      {!copy && copyChecked && (
        <p role="status" data-testid="pay-no-copy">
          {online && !refreshFailed
            ? 'Loading the supplier list…'
            : 'The supplier list is not saved on this device yet. Connect once to load it, then Pay supplier works offline.'}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {fail && (
        <p class="alert" role="alert">
          {fail}
        </p>
      )}
      {copy && (
        <form
          key={formKey}
          hidden={review !== null}
          onSubmit={onReview}
          noValidate
          aria-label="Pay supplier form"
        >
          <label>
            Supplier to pay{' '}
            <select
              value={partyId}
              onChange={(e) => {
                setPartyId((e.target as HTMLSelectElement).value);
                setErrors(null);
              }}
              aria-invalid={err.supplier ? 'true' : undefined}
            >
              <option value="">Select…</option>
              {copy.suppliers.map((s) => (
                <option key={s.partyId} value={s.partyId}>
                  {s.name} — owed {rupees(s.owedPaise)}
                </option>
              ))}
            </select>
          </label>
          {err.supplier && (
            <p class="alert" role="alert">
              {err.supplier}
            </p>
          )}
          {supplier && (
            <p class="muted" data-testid="pay-supplier-owed">
              Owed to {supplier.name}: {rupees(supplier.owedPaise)} as saved
              {(totals.bySupplier[supplier.partyId] ?? 0n) > 0n &&
                ` · waiting to sync from this device: ${rupees((totals.bySupplier[supplier.partyId] ?? 0n).toString())} (left to pay ${rupees((owedLeft < 0n ? 0n : owedLeft).toString())})`}
              .
            </p>
          )}
          <label>
            Amount to pay (₹){' '}
            <input
              ref={amountRef}
              name="payAmount"
              inputMode="decimal"
              autocomplete="off"
              defaultValue={initial?.amount ?? ''}
              aria-invalid={err.amount ? 'true' : undefined}
              aria-describedby={err.amount ? 'pay-amount-error' : undefined}
            />
          </label>
          {err.amount && (
            <p class="alert" role="alert" id="pay-amount-error">
              {err.amount}
            </p>
          )}{' '}
          <label>
            Paid by{' '}
            <select ref={modeRef} name="payMode">
              {PAY_MODES.map((m) => (
                <option key={m} value={m} selected={m === (initial?.mode ?? 'cash')}>
                  {m}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Date paid{' '}
            <input
              ref={dateRef}
              name="payDate"
              type="date"
              max={maxDate}
              defaultValue={initial?.date || maxDate}
              aria-invalid={err.date ? 'true' : undefined}
            />
          </label>
          {err.date && (
            <p class="alert" role="alert">
              {err.date}
            </p>
          )}{' '}
          <label>
            Note / reference{' '}
            <input
              ref={referenceRef}
              name="payReference"
              autocomplete="off"
              defaultValue={initial?.reference ?? ''}
              aria-invalid={err.reference ? 'true' : undefined}
            />
          </label>
          {err.reference && (
            <p class="alert" role="alert">
              {err.reference}
            </p>
          )}
          {supplier && supplier.bills.length > 0 && (
            <fieldset key={`${formKey}:${supplier.partyId}`}>
              <legend>Assign to bills (optional)</legend>
              <p class="hint">
                Leave blank to record the payment against the supplier’s balance. If a bill listed
                here changes before the payment reaches the server, the payment is refused, not
                moved.
              </p>
              <button type="button" onClick={autoAssign} disabled={busy}>
                Auto · oldest first
              </button>
              <ul>
                {supplier.bills.map((b) => {
                  const left = BigInt(b.outstandingPaise) - (totals.byBill[b.billId] ?? 0n);
                  return (
                    <li key={b.billId}>
                      <label>
                        Assign to bill {billLabel(b)} · {b.businessDate} · ₹ left{' '}
                        {rupees((left < 0n ? 0n : left).toString())}{' '}
                        <input
                          ref={(el) => {
                            allocRefs.current[b.billId] = el;
                          }}
                          name={`alloc-${b.billId}`}
                          inputMode="decimal"
                          autocomplete="off"
                          defaultValue={initial?.allocs[b.billId] ?? ''}
                          aria-invalid={err.allocations[b.billId] ? 'true' : undefined}
                        />
                      </label>{' '}
                      <button
                        type="button"
                        onClick={() => fillBill(b.billId, left)}
                        disabled={left <= 0n}
                      >
                        Full
                      </button>
                      {err.allocations[b.billId] && (
                        <p class="alert" role="alert">
                          {err.allocations[b.billId]}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {err.allocationsTotal && (
                <p class="alert" role="alert">
                  {err.allocationsTotal}
                </p>
              )}
            </fieldset>
          )}
          <p>
            <button type="submit" disabled={busy || !partyId}>
              Check and save
            </button>
          </p>
        </form>
      )}
      {review && (
        <div aria-label="Confirm supplier payment" data-testid="pay-review">
          <p>
            Pay <strong>{review.value.partyName}</strong>{' '}
            <strong>{rupees(review.value.amountPaise)}</strong> by {review.value.mode}
            {review.value.businessDate ? `, dated ${review.value.businessDate}` : ''}
            {review.value.reference ? ` (ref ${review.value.reference})` : ''}.
          </p>
          <p>
            {review.value.allocations.length
              ? `Assigned to ${review.value.allocations.length} bill(s): ${review.value.allocations
                  .map((a) => `${a.billLabel} ${rupees(a.amountPaise)}`)
                  .join(', ')}.`
              : 'Not assigned to a bill: it is recorded against the supplier’s balance.'}
          </p>
          <p>
            <strong>Saved on this device, not yet in the supplier’s balance.</strong> The balance
            changes only after the server confirms this payment.
          </p>
          <button class="primary" type="button" disabled={busy} onClick={() => void save()}>
            Save on this device
          </button>{' '}
          <button type="button" disabled={busy} onClick={() => setReview(null)}>
            Back
          </button>
        </div>
      )}
      {shown.length > 0 && (
        <HomeRow
          name="offline-supplier-payments"
          title="Supplier payments saved on this device"
          userId={userId}
          count={shown.length}
          tone={queued.length || refused.length ? 'warning' : 'neutral'}
          summary={summary}
          forceOpen={refused.length > 0}
          class="offline-supplier-payments"
        >
          {queued.length > 0 && (
            <p class="muted" data-testid="offline-supplier-payments-queued">
              {queued.length} not synced yet — they are recorded automatically when you are back
              online. The supplier’s balance changes after they sync. Do not enter them again under
              Record payment.{' '}
              {online && (
                <button type="button" onClick={() => void runSyncNow().catch(() => undefined)}>
                  Sync now
                </button>
              )}
            </p>
          )}
          <ul>
            {shown.map((r) => (
              <li key={r.clientId} data-testid="offline-supplier-payment" data-status={r.status}>
                <strong>
                  {r.status === 'QUEUED'
                    ? 'Saved on this device — will sync'
                    : r.status === 'SYNCED'
                      ? 'Synced'
                      : 'Refused by the server — not recorded'}
                </strong>{' '}
                · {r.partyName} · {rupees(r.amountPaise)} · {r.mode} · {r.businessDate ?? 'today'}
                {r.reference ? ` · ref ${r.reference}` : ''}
                <br />
                <small class="muted">
                  {r.allocations.length
                    ? `Assigned to ${r.allocations.map((a) => `${a.billLabel} ${rupees(a.amountPaise)}`).join(', ')}`
                    : 'Against the supplier’s balance'}
                  {r.status === 'QUEUED' ? ' · not yet in the supplier’s balance' : ''}
                </small>
                {r.status === 'REJECTED' && (
                  <>
                    <p role="alert">{r.rejectionReason}</p>
                    <div class="context-actions">
                      <button type="button" onClick={() => redo(r)}>
                        Redo this payment
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
      )}
    </section>
  );
}
