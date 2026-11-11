import { useEffect, useState } from 'preact/hooks';
import {
  getDayBook,
  getDefaultShopId,
  getProfitReport,
  getShopBusinessDate,
  type DayBookRow,
  type ProfitReport,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { rupees } from '../lib/money';
import { errorText } from '../lib/friendlyError';
import { StatTile } from '../components/Kit';

/** Old-DSB Day Book and Profit Report pages (rebuild R12). Read-only: the same server reports as Reports. */

function Head({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: preact.ComponentChildren;
}) {
  return (
    <div class="db-head">
      <a href={appRoute.home} class="db-back" aria-label="Back to Home">
        ←
      </a>
      <div class="db-title">
        <h1>{title}</h1>
        {sub && <small class="muted">{sub}</small>}
      </div>
      {children}
    </div>
  );
}

const sum = (rows: DayBookRow[], k: keyof DayBookRow) =>
  rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

export function DayBookScreen() {
  const [shop, setShop] = useState('');
  const [date, setDate] = useState('');
  const [rows, setRows] = useState<DayBookRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void (async () => {
      try {
        const s = await getDefaultShopId();
        setShop(s);
        setDate(await getShopBusinessDate(s));
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, []);
  useEffect(() => {
    if (!shop || !date) return;
    setRows(null);
    getDayBook(shop, date, date)
      .then((r) => setRows(r))
      .catch((e) => setError(errorText(e)));
  }, [shop, date]);
  const v = (k: keyof DayBookRow) => (rows ? rupees(String(sum(rows, k))) : '…');
  return (
    <main class="page daybook-page">
      <Head
        title="Day Book"
        sub={
          date
            ? new Date(date + 'T00:00').toLocaleDateString('en-IN', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })
            : ''
        }
      >
        <input
          type="date"
          aria-label="Day"
          value={date}
          onInput={(e) => e.currentTarget.value && setDate(e.currentTarget.value)}
        />
      </Head>
      {error && <p role="alert">{error}</p>}
      <div class="db-grid three">
        <StatTile label="Purchased" value={v('purchases_paise')} tone="danger" />
        <StatTile label="Sold" value={v('sales_paise')} tone="success" />
        <StatTile label="Net Cash" value={v('net_cashflow_paise')} tone="brand" />
      </div>
      <div class="db-grid">
        <StatTile label="Paid Out" value={v('payments_paise')} tone="danger" />
        <StatTile label="Received" value={v('receipts_paise')} tone="success" />
        <StatTile label="Expenses" value={v('expenses_paise')} />
      </div>
      <a class="kit-btn wide" href={appRoute.reports}>
        Full reports
      </a>
    </main>
  );
}

type Period = 'this_month' | 'last_month' | 'this_year' | 'all';
function range(today: string, p: Period): [string, string] {
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (p === 'this_month') return [`${y}-${pad(m)}-01`, today];
  if (p === 'last_month') {
    const ly = m === 1 ? y - 1 : y;
    const lm = m === 1 ? 12 : m - 1;
    const last = new Date(ly, lm, 0).getDate();
    return [`${ly}-${pad(lm)}-01`, `${ly}-${pad(lm)}-${pad(last)}`];
  }
  if (p === 'this_year') return [`${y}-01-01`, today];
  return ['2000-01-01', today];
}

export function ProfitScreen() {
  const [shop, setShop] = useState('');
  const [today, setToday] = useState('');
  const [period, setPeriod] = useState<Period>('this_month');
  const [report, setReport] = useState<ProfitReport | null>(null);
  const [expenses, setExpenses] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void (async () => {
      try {
        const s = await getDefaultShopId();
        setShop(s);
        setToday(await getShopBusinessDate(s));
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, []);
  useEffect(() => {
    if (!shop || !today) return;
    const [from, to] = range(today, period);
    setReport(null);
    setExpenses(null);
    setError('');
    getProfitReport(shop, from, to)
      .then(setReport)
      .catch((e) => setError(errorText(e)));
    getDayBook(shop, from, to)
      .then((r) => setExpenses(sum(r, 'expenses_paise')))
      .catch(() => setExpenses(null));
  }, [shop, today, period]);
  const s = report?.summary;
  const m = (x: string | number | undefined | null) =>
    x === undefined || x === null ? '…' : rupees(String(x));
  const net = s && expenses !== null ? Number(s.grossProfitPaise) - expenses : null;
  return (
    <main class="page daybook-page">
      <Head title="Profit Report">
        <select
          aria-label="Period"
          data-no-search
          value={period}
          onChange={(e) => setPeriod(e.currentTarget.value as Period)}
        >
          <option value="this_month">This Month</option>
          <option value="last_month">Last Month</option>
          <option value="this_year">This Year</option>
          <option value="all">All Time</option>
        </select>
      </Head>
      {error && <p role="alert">{error}</p>}
      <div class="db-grid">
        <StatTile label="Revenue" value={m(s?.netRevenuePaise)} tone="brand" />
        <StatTile label="COGS (FIFO)" value={m(s?.costOfGoodsPaise)} tone="danger" />
        <StatTile label="Gross Profit" value={m(s?.grossProfitPaise)} tone="success" />
        <StatTile label="Expenses" value={m(expenses)} />
      </div>
      <div class="kit-stat db-net">
        <div class="kit-stat-label">Net Profit</div>
        <div class={`db-net-value num${net !== null && net < 0 ? ' danger' : ''}`}>{m(net)}</div>
        {s && s.unknownCostItemCount > 0 && (
          <small class="muted">
            {s.unknownCostItemCount} item(s) sold without a purchase cost are left out of profit.
          </small>
        )}
      </div>
      <a class="kit-btn wide" href={appRoute.reports + '?tab=profit'}>
        Item-wise profit
      </a>
    </main>
  );
}
