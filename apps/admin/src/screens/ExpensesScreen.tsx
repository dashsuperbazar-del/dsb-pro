import { useEffect, useState } from 'preact/hooks';
import {
  getDayBook,
  getDefaultShopId,
  getShopBusinessDate,
  postExpense,
  voidExpense,
  classifyError,
  type DayBookRow,
} from '@dsb-pro/adapters';
import { parseRupeesToPaise } from '@dsb-pro/core';
import { appRoute } from '../lib/paths';

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
  const [msg, setMsg] = useState('');

  const pendingKey = (s: string) => `dsb-pending-expense:${s}`;
  const savePending = (
    s: string,
    value: { req: NonNullable<typeof pending>; clientId: string } | null,
  ) => {
    try {
      if (value) localStorage.setItem(pendingKey(s), JSON.stringify(value));
      else localStorage.removeItem(pendingKey(s));
    } catch {
      /* ignore */
    }
  };
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
      try {
        const raw = localStorage.getItem(pendingKey(s));
        if (raw) {
          const saved = JSON.parse(raw) as { req: NonNullable<typeof pending>; clientId: string };
          setPending(saved.req);
          setClientId(saved.clientId);
          setMsg('An earlier expense was not confirmed. Press "Retry same expense" to finish it.');
        }
      } catch {
        /* storage unavailable: in-memory lock still applies */
      }
      await load(s, d);
    })().catch((e) => setMsg(String(e)));
  }, []);

  async function submit(e: Event) {
    e.preventDefault();
    if (!shop || busy) return;
    const form = e.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    let req = pending;
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
    setBusy(true);
    setMsg('');
    setPending(req);
    savePending(shop, { req, clientId });
    let id: string;
    try {
      id = await postExpense(
        shop,
        req.date,
        req.category,
        req.description,
        req.amountPaise,
        req.mode,
        null,
        clientId,
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const unknown =
        classifyError(err) !== 'user' ||
        /Something didn't save|You're offline|session expired/i.test(text);
      if (unknown) {
        setMsg(
          `Not confirmed: ${text}. The form is locked: press "Retry same expense" — it never posts twice.`,
        );
      } else {
        // The server definitively refused it: nothing was posted, so the entry can be corrected.
        setPending(null);
        savePending(shop, null);
        setClientId(crypto.randomUUID());
        setMsg(`Not posted: ${text}`);
      }
      setBusy(false);
      return;
    }
    // Confirmed: finish the state transition before anything else can fail.
    setLastId(id);
    setPending(null);
    savePending(shop, null);
    setClientId(crypto.randomUUID());
    setMsg('Expense posted.');
    form.reset();
    setBusy(false);
    try {
      await load();
    } catch (err) {
      setMsg(`Expense posted. (Totals could not refresh: ${String(err)})`);
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
          <button class="primary" disabled={busy || !shop}>
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
