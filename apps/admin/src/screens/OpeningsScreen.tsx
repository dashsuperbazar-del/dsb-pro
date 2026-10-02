import { useEffect, useState } from 'preact/hooks';
import {
  getCurrentMembership,
  getDefaultShopId,
  getShopBusinessDate,
  listCustomers,
  listOpenings,
  listParties,
  recordOpeningOutcome,
  voidOpeningOutcome,
  type AccountOpening,
} from '@dsb-pro/adapters';
import { parseRupeesToPaise } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';
import { rupees } from '../lib/money';
import { clearPendingIntent, loadPendingIntent, savePendingIntent } from '../lib/pendingIntent';

// O1: opening balances at cutover. Owner only. Each opening is an immutable ledger row; a wrong one is
// voided and entered again. The request is stored before sending and retried with the same id.
type Kind = 'CUSTOMER' | 'SUPPLIER';
type Req = {
  kind: Kind;
  accountId: string;
  asOfDate: string;
  amountPaise: number;
  reason: string;
};

export function OpeningsScreen() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [shop, setShop] = useState('');
  const [today, setToday] = useState('');
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [parties, setParties] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<AccountOpening[]>([]);
  const [kind, setKind] = useState<Kind>('CUSTOMER');
  const [accountId, setAccountId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [direction, setDirection] = useState<'owes' | 'owed'>('owes');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('Opening balance at cutover');
  const [pending, setPending] = useState<{ req: Req; clientId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const key = (s: string) => `dsb-pending-opening:${s}`;

  async function load(s = shop) {
    const [c, p, o] = await Promise.all([listCustomers(), listParties(), listOpenings(s)]);
    setCustomers(c.map((x) => ({ id: x.id, name: x.name })));
    setParties(p.map((x) => ({ id: x.id, name: x.name })));
    setRows(o);
  }
  useEffect(() => {
    void (async () => {
      const m = await getCurrentMembership();
      setAllowed(m?.role === 'owner');
      if (m?.role !== 'owner') return;
      const s = await getDefaultShopId();
      const d = await getShopBusinessDate(s);
      setShop(s);
      setToday(d);
      setAsOf(d);
      const saved = loadPendingIntent<{ req: Req; clientId: string }>(key(s));
      if (saved.ok && saved.value) {
        setPending(saved.value);
        setMsg('An earlier opening was not confirmed. Press "Retry same opening" to finish it.');
      } else if (!saved.ok) setMsg(saved.message);
      await load(s);
    })().catch((e) => setMsg(String(e)));
  }, []);

  const names = new Map([...customers, ...parties].map((a) => [a.id, a.name]));
  const accounts = kind === 'CUSTOMER' ? customers : parties;
  const owesLabel = kind === 'CUSTOMER' ? 'Customer owes us' : 'We owe the supplier';
  const owedLabel = kind === 'CUSTOMER' ? 'We owe the customer' : 'Supplier owes us';

  async function submit(e: Event) {
    e.preventDefault();
    if (busy || !shop) return;
    let cur = pending;
    if (!cur) {
      let paise: number;
      try {
        paise = parseRupeesToPaise(amount);
      } catch (err) {
        setMsg(String(err));
        return;
      }
      if (!accountId || paise <= 0) {
        setMsg('Choose the account and enter an amount greater than zero.');
        return;
      }
      cur = {
        req: {
          kind,
          accountId,
          asOfDate: asOf,
          amountPaise: direction === 'owes' ? paise : -paise,
          reason: reason.trim(),
        },
        clientId: crypto.randomUUID(),
      };
    }
    try {
      savePendingIntent(key(shop), cur, { retry: pending !== null });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
      return;
    }
    setPending(cur);
    setBusy(true);
    setMsg('');
    const outcome = await recordOpeningOutcome(
      {
        shopId: shop,
        ...cur.req,
        clientId: cur.clientId,
      },
      pending !== null,
    );
    if (outcome.kind === 'unknown') {
      setMsg(
        `Not confirmed: ${outcome.message}. Press "Retry same opening" — it is never recorded twice.`,
      );
      setBusy(false);
      return;
    }
    clearPendingIntent(key(shop), cur.clientId);
    // Another window's unconfirmed opening may still be stored: bring it up next, same id (VF-009).
    const next = loadPendingIntent<{ req: Req; clientId: string }>(key(shop));
    const more = next.ok && next.value ? next.value : null;
    setPending(more);
    let text =
      outcome.kind === 'committed'
        ? `Opening recorded for ${names.get(cur.req.accountId) ?? 'the account'}.`
        : `Not recorded: ${outcome.message}. An earlier attempt may already be in the list below — check it before entering again.`;
    if (outcome.kind === 'committed') setAmount('');
    setBusy(false);
    const fresh = await listOpenings(shop).catch(() => null);
    if (fresh) setRows(fresh);
    // A same-id replay answers with the original row even if another window has voided it since.
    if (
      outcome.kind === 'committed' &&
      fresh?.find((r) => r.id === outcome.value)?.status === 'VOID'
    )
      text =
        'This opening was recorded earlier but has since been voided. Enter it again if needed.';
    if (more)
      text +=
        ' Another opening from this device is not confirmed yet — press "Retry same opening".';
    setMsg(text);
  }

  async function voidRow(r: AccountOpening) {
    const why = prompt('Why is this opening wrong? (It stays in history as voided.)');
    if (!why || !why.trim()) return;
    setBusy(true);
    const outcome = await voidOpeningOutcome(r.id, why.trim());
    setMsg(
      outcome.kind === 'committed'
        ? 'Opening voided. Enter the correct one if needed.'
        : outcome.kind === 'rejected'
          ? `Not voided: ${outcome.message}`
          : `Not confirmed: ${outcome.message}. Reload to check; voiding again is safe.`,
    );
    setBusy(false);
    await load().catch(() => undefined);
  }

  if (allowed === false)
    return (
      <main>
        <h1>Opening balances</h1>
        <p role="status">Only the owner can enter opening balances.</p>
      </main>
    );

  return (
    <main>
      <div class="row">
        <h1>Opening balances</h1>
        <a href={appRoute.home}>Home</a>
      </div>
      <p class="muted">
        What each customer and supplier stood at on your cutover date, before your first entry in
        DSB Pro. One opening per account; a wrong one is voided and entered again. Opening stock is
        entered with a physical count on <a href={appRoute.stockAdjust}>Stock adjust</a>.
      </p>
      {msg && <p role="status">{msg}</p>}
      <section class="card">
        <h2>Enter an opening</h2>
        <form class="grid-form" onSubmit={(e) => void submit(e)}>
          <fieldset disabled={Boolean(pending) || busy} class="plain grid-form">
            <label>
              Account type
              <select
                value={kind}
                onChange={(e) => {
                  setKind((e.currentTarget as HTMLSelectElement).value as Kind);
                  setAccountId('');
                }}
              >
                <option value="CUSTOMER">Customer</option>
                <option value="SUPPLIER">Supplier</option>
              </select>
            </label>
            <label>
              Account
              <select
                value={accountId}
                onChange={(e) => setAccountId((e.currentTarget as HTMLSelectElement).value)}
                required
              >
                <option value="">Choose…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              As of
              <input
                type="date"
                max={today}
                value={asOf}
                onInput={(e) => setAsOf((e.currentTarget as HTMLInputElement).value)}
                required
              />
            </label>
            <label>
              Direction
              <select
                value={direction}
                onChange={(e) =>
                  setDirection((e.currentTarget as HTMLSelectElement).value as 'owes' | 'owed')
                }
              >
                <option value="owes">{owesLabel}</option>
                <option value="owed">{owedLabel}</option>
              </select>
            </label>
            <label>
              Amount ₹
              <input
                inputMode="decimal"
                value={amount}
                onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)}
                required
              />
            </label>
            <label>
              Note
              <input
                value={reason}
                onInput={(e) => setReason((e.currentTarget as HTMLInputElement).value)}
                required
              />
            </label>
          </fieldset>
          <button class="primary" disabled={busy || !shop}>
            {busy ? 'Saving…' : pending ? 'Retry same opening' : 'Record opening'}
          </button>
        </form>
      </section>
      <section class="card" aria-label="Openings">
        <h2>Recorded openings</h2>
        {!rows.length ? (
          <p class="muted">None yet.</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th>As of</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{names.get(r.customer_id ?? r.party_id ?? '') ?? '—'}</td>
                    <td>{r.account_kind === 'CUSTOMER' ? 'Customer' : 'Supplier'}</td>
                    <td>{r.as_of_date}</td>
                    <td>
                      {rupees(r.amount_paise.replace('-', ''))}{' '}
                      {Number(r.amount_paise) > 0
                        ? r.account_kind === 'CUSTOMER'
                          ? '(owes us)'
                          : '(we owe)'
                        : r.account_kind === 'CUSTOMER'
                          ? '(we owe)'
                          : '(owes us)'}
                    </td>
                    <td>{r.status === 'VOID' ? `Voided: ${r.void_reason ?? ''}` : 'Active'}</td>
                    <td>
                      {r.status === 'POSTED' && (
                        <button type="button" disabled={busy} onClick={() => void voidRow(r)}>
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
