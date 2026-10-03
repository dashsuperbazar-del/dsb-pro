import { useEffect, useState } from 'preact/hooks';
import {
  getSettlementOptions,
  settleOpeningOutcome,
  voidSettlementOutcome,
  type SettlementOptions,
} from '@dsb-pro/adapters';
import { parseRupeesToPaise } from '@dsb-pro/core';
import { rupees } from '../lib/money';
import { clearPendingIntent, loadPendingIntent, savePendingIntent } from '../lib/pendingIntent';

// O2: settle the unassigned part of a payment against an opening the account owes. No money moves:
// it only marks which payment paid the opening. Stored before sending; retried with the same id.
type Req = { openingId: string; paymentId: string; amountPaise: number };
type Pending = { req: Req; clientId: string };

// `version` changes when the openings list changes; options reload without resetting the form, so a
// value typed while the list was still loading is kept.
export function OpeningSettlements(props: {
  shop: string;
  names: Map<string, string>;
  version: string;
}) {
  const { shop, names, version } = props;
  const [opts, setOpts] = useState<SettlementOptions | null>(null);
  const [openingId, setOpeningId] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [amount, setAmount] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const key = `dsb-pending-settlement:${shop}`;

  async function load() {
    setOpts(await getSettlementOptions(shop));
  }
  useEffect(() => {
    if (!shop) return;
    const saved = loadPendingIntent<Pending>(key);
    if (saved.ok && saved.value) {
      setPending(saved.value);
      setMsg(
        'An earlier settlement was not confirmed. Press "Retry same settlement" to finish it.',
      );
    } else if (!saved.ok) setMsg(saved.message);
  }, [shop]);
  useEffect(() => {
    if (shop) load().catch((e) => setMsg(String(e)));
  }, [shop, version]);

  const opening = opts?.openings.find((o) => o.id === openingId);
  const payments = (opts?.payments ?? []).filter(
    (p) => opening && p.kind === opening.kind && p.accountId === opening.accountId,
  );
  const label = (kind: string, id: string) =>
    `${names.get(id) ?? '—'} (${kind === 'CUSTOMER' ? 'customer' : 'supplier'})`;

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    let cur = pending;
    if (!cur) {
      let paise: number;
      try {
        paise = parseRupeesToPaise(amount);
      } catch (err) {
        setMsg(String(err));
        return;
      }
      if (!openingId || !paymentId || paise <= 0) {
        setMsg('Choose the opening, the payment and an amount greater than zero.');
        return;
      }
      cur = { req: { openingId, paymentId, amountPaise: paise }, clientId: crypto.randomUUID() };
    }
    try {
      savePendingIntent(key, cur, { retry: pending !== null });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
      return;
    }
    setPending(cur);
    setBusy(true);
    setMsg('');
    const outcome = await settleOpeningOutcome(
      { ...cur.req, clientId: cur.clientId },
      pending !== null,
    );
    if (outcome.kind === 'unknown') {
      setMsg(
        `Not confirmed: ${outcome.message}. Press "Retry same settlement" — it is never applied twice.`,
      );
      setBusy(false);
      return;
    }
    clearPendingIntent(key, cur.clientId);
    const next = loadPendingIntent<Pending>(key);
    const more = next.ok && next.value ? next.value : null;
    setPending(more);
    let text =
      outcome.kind === 'committed'
        ? 'Payment settled against the opening.'
        : `Not settled: ${outcome.message}. An earlier attempt may already be in the list below — check it before trying again.`;
    if (outcome.kind === 'committed') setAmount('');
    if (more)
      text +=
        ' Another settlement from this device is not confirmed yet — press "Retry same settlement".';
    setMsg(text);
    setBusy(false);
    await load().catch(() => undefined);
  }

  async function voidRow(id: string) {
    const why = prompt('Why is this settlement wrong? (It stays in history as voided.)');
    if (!why || !why.trim()) return;
    setBusy(true);
    const outcome = await voidSettlementOutcome(id, why.trim());
    setMsg(
      outcome.kind === 'committed'
        ? 'Settlement voided; the payment is unassigned again.'
        : outcome.kind === 'rejected'
          ? `Not voided: ${outcome.message}`
          : `Not confirmed: ${outcome.message}. Reload to check; voiding again is safe.`,
    );
    setBusy(false);
    await load().catch(() => undefined);
  }

  return (
    <section class="card" aria-label="Settlements">
      <h2>Settle payments against openings</h2>
      <p class="muted">
        When a customer pays an old due (or you pay a supplier's), link that payment to the opening
        so it stops showing as unassigned cash. Balances do not change.
      </p>
      {msg && <p role="status">{msg}</p>}
      <form class="grid-form" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={Boolean(pending) || busy} class="plain grid-form">
          <label>
            Opening
            <select
              value={openingId}
              onChange={(e) => {
                setOpeningId((e.currentTarget as HTMLSelectElement).value);
                setPaymentId('');
              }}
            >
              <option value="">Choose…</option>
              {(opts?.openings ?? [])
                .filter((o) => Number(o.remainingPaise) > 0)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {label(o.kind, o.accountId)} — {rupees(o.remainingPaise)} left
                  </option>
                ))}
            </select>
          </label>
          <label>
            Payment
            <select
              value={paymentId}
              onChange={(e) => setPaymentId((e.currentTarget as HTMLSelectElement).value)}
            >
              <option value="">Choose…</option>
              {payments.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.businessDate} — {rupees(p.unassignedPaise)} unassigned of{' '}
                  {rupees(p.amountPaise)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Settle amount ₹
            <input
              inputMode="decimal"
              value={amount}
              onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </fieldset>
        <button class="primary" disabled={busy || !shop}>
          {busy ? 'Saving…' : pending ? 'Retry same settlement' : 'Settle'}
        </button>
      </form>
      {Boolean(opts?.settlements.length) && (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {opts!.settlements.map((s) => {
                return (
                  <tr key={s.id}>
                    <td>{label(s.kind, s.accountId)}</td>
                    <td>{s.effectiveDate}</td>
                    <td>{rupees(s.amountPaise)}</td>
                    <td>{s.status === 'VOID' ? `Voided: ${s.voidReason ?? ''}` : 'Active'}</td>
                    <td>
                      {s.status === 'POSTED' && (
                        <button type="button" disabled={busy} onClick={() => void voidRow(s.id)}>
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
