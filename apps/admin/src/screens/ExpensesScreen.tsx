import { useEffect, useRef, useState } from 'preact/hooks';
import {
  getDayBook,
  getDefaultShopId,
  getShopBusinessDate,
  postExpenseOutcome,
  voidExpense,
  type DayBookRow,
} from '@dsb-pro/adapters';
import { parseRupeesToPaise } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';
import { clearPendingIntent, loadPendingIntent, savePendingIntent } from '../lib/pendingIntent';

const rupee = (p: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100);
const CATEGORIES = [
  'Rent',
  'Electricity',
  'Salary',
  'Transport',
  'Tea & snacks',
  'Repairs',
  'Other',
];

export function ExpensesScreen() {
  const [shop, setShop] = useState('');
  const [date, setDate] = useState('');
  const [today, setToday] = useState<DayBookRow | null>(null);
  // One request id per expense: a retry after a lost answer reuses it, so it is never posted twice.
  const [clientId, setClientId] = useState<string>(() => crypto.randomUUID());
  const [lastId, setLastId] = useState('');
  // After an unconfirmed attempt the exact request is frozen; Post retries it with the same id.
  const [pending, setPending] = useState<{
    date: string;
    category: string;
    description: string;
    amountPaise: number;
    mode: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // True while the pending expense is the one typed into this form. A restored entry (from another
  // window or a reload) is not, so finishing it must not wipe what the form holds (Codex P2).
  const formHoldsPending = useRef(false);
  const [msg, setMsg] = useState('');
  // Set when this device's saved entries cannot be read: new entries stay blocked.
  const [storageBlocked, setStorageBlocked] = useState(false);

  const pendingKey = (s: string) => `dsb-pending-expense:${s}`;
  async function load(shopId = shop, d = date) {
    if (!shopId || !d) return;
    const rows = await getDayBook(shopId, d, d);
    setToday(rows[0] ?? null);
  }
  useEffect(() => {
    void (async () => {
      const s = await getDefaultShopId();
      const d = await getShopBusinessDate(s);
      setShop(s);
      setDate(d);
      // An expense whose outcome was never confirmed survives a reload with its request id.
      const saved = loadPendingIntent<{ req: NonNullable<typeof pending>; clientId: string }>(
        pendingKey(s),
      );
      if (!saved.ok) {
        setStorageBlocked(true);
        setMsg(saved.message);
      } else if (saved.value) {
        setPending(saved.value.req);
        setClientId(saved.value.clientId);
        setMsg('An earlier expense was not confirmed. Press "Retry same expense" to finish it.');
      }
      await load(s, d);
    })().catch((e) => setMsg(String(e)));
  }, []);

  async function submit(e: Event) {
    e.preventDefault();
    if (!shop || busy || storageBlocked) return;
    const form = e.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    let req = pending;
    const isRetry = pending !== null;
    try {
      req ??= {
        date: String(f.get('date')),
        category: String(f.get('category')),
        description: String(f.get('description') || f.get('category')),
        amountPaise: parseRupeesToPaise(String(f.get('amount'))),
        mode: String(f.get('mode')),
      };
    } catch (err) {
      setMsg(String(err));
      return;
    }
    // Durable before dispatch, or not sent at all.
    try {
      savePendingIntent(pendingKey(shop), { req, clientId }, { retry: isRetry });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    setMsg('');
    if (!isRetry) formHoldsPending.current = true;
    setPending(req);
    const outcome = await postExpenseOutcome({
      isRetry,
      shopId: shop,
      businessDate: req.date,
      category: req.category,
      description: req.description,
      amountPaise: req.amountPaise,
      mode: req.mode,
      reference: null,
      clientId,
    });
    if (outcome.kind === 'unknown') {
      setMsg(
        `Not confirmed: ${outcome.message}. The form is locked: press "Retry same expense" — it never posts twice.`,
      );
      setBusy(false);
      return;
    }
    if (outcome.kind === 'rejected') {
      // The database refused it and rolled back: nothing was posted, so the entry can be corrected.
      setPending(null);
      clearPendingIntent(pendingKey(shop), clientId);
      setClientId(crypto.randomUUID());
      setMsg(`Not posted: ${outcome.message}`);
      restoreNext();
      setBusy(false);
      return;
    }
    const id = outcome.value;
    // Confirmed: finish the state transition before anything else can fail.
    setLastId(id);
    setPending(null);
    clearPendingIntent(pendingKey(shop), clientId);
    setClientId(crypto.randomUUID());
    setMsg('Expense posted.');
    if (formHoldsPending.current) form.reset();
    formHoldsPending.current = false;
    restoreNext();
    setBusy(false);
    try {
      await load();
    } catch (err) {
      setMsg(`Expense posted. (Totals could not refresh: ${String(err)})`);
    }
  }
  // Another window's unconfirmed expense may still be stored: bring it up next, same id (VF-009).
  function restoreNext() {
    const next = loadPendingIntent<{ req: NonNullable<typeof pending>; clientId: string }>(
      pendingKey(shop),
    );
    if (next.ok && next.value) {
      formHoldsPending.current = false;
      setPending(next.value.req);
      setClientId(next.value.clientId);
      setMsg(
        (m) =>
          `${m} Another expense from this device is not confirmed yet — press "Retry same expense".`,
      );
    }
  }
  async function undo() {
    if (!lastId || busy) return;
    setBusy(true);
    try {
      await voidExpense(lastId);
      setLastId('');
      setMsg('Expense voided; the audit record was preserved.');
      await load();
    } catch (err) {
      setMsg(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div class="row">
        <h1>Expenses</h1>
        <a href={appRoute.home}>Home</a>
      </div>
      {msg && <p role="status">{msg}</p>}
      <section class="card">
        <h2>Post expense</h2>
        <form class="grid-form" onSubmit={(e) => void submit(e)}>
          <fieldset disabled={Boolean(pending)} class="plain grid-form">
            <label>
              Date
              <input
                name="date"
                type="date"
                required
                value={date}
                onInput={(e) => setDate((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label>
              Category
              <input name="category" list="expense-categories" required />
              <datalist id="expense-categories">
                {CATEGORIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label>
              Description
              <input name="description" />
            </label>
            <label>
              Amount ₹
              <input name="amount" inputMode="decimal" pattern="[0-9]*[.]?[0-9]{0,2}" required />
            </label>
            <label>
              Mode
              <select name="mode">
                <option>cash</option>
                <option>upi</option>
                <option>card</option>
                <option>bank</option>
                <option>other</option>
              </select>
            </label>
          </fieldset>
          <button class="primary" disabled={busy || !shop || storageBlocked}>
            {busy ? 'Posting…' : pending ? 'Retry same expense' : 'Post expense'}
          </button>
        </form>
        {lastId && (
          <button type="button" disabled={busy} onClick={() => void undo()}>
            Void last posted expense
          </button>
        )}
      </section>
      {today && (
        <section class="card" aria-label="Expenses today">
          <h2>{date}</h2>
          <p>
            Expenses {rupee(today.expenses_paise)} · Net cash flow {rupee(today.net_cashflow_paise)}
          </p>
        </section>
      )}
    </main>
  );
}
