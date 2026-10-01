import { useEffect, useRef, useState } from 'preact/hooks';
import {
  getAgingReportV2,
  getCurrentMembership,
  getDayBookText,
  getDefaultShopId,
  getShopBusinessDate,
  listItems,
  listStockText,
  type AgingReportV2,
  type DayBookText,
  type Item,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { paiseToDecimal, rupees } from '../lib/money';
import { toCsv, type Cell } from '../lib/csv';

// R1 shadow-run kit: one page to tick against old DSB each day of the 7-day shadow run.
// Balances are as of the chosen date; stock is the current on-hand quantity.

function download(name: string, content: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const balanceCsv = (r: AgingReportV2) =>
  toCsv(
    [
      'Name',
      'Net balance',
      'Open bills',
      'Bill credits',
      'Unassigned paid out',
      'Unassigned received',
    ],
    [
      ...r.accounts.map((a): Cell[] => [
        { text: a.name },
        { num: paiseToDecimal(a.netLedgerBalancePaise) },
        { num: paiseToDecimal(a.grossOpenPaise) },
        { num: paiseToDecimal(a.documentCreditsPaise) },
        { num: paiseToDecimal(a.unassignedOutPaise) },
        { num: paiseToDecimal(a.unassignedInPaise) },
      ]),
      [
        { text: 'TOTAL' },
        { num: paiseToDecimal(r.totals.netLedgerBalancePaise) },
        { num: paiseToDecimal(r.totals.grossOpenPaise) },
        { num: paiseToDecimal(r.totals.documentCreditsPaise) },
        { num: paiseToDecimal(r.totals.unassignedOutPaise) },
        { num: paiseToDecimal(r.totals.unassignedInPaise) },
      ],
    ],
  );

type StockLine = { id: string; name: string; qty: string };
const DAY_FIELDS: [keyof DayBookText, string][] = [
  ['sales_paise', 'Sales'],
  ['purchases_paise', 'Purchases'],
  ['receipts_paise', 'Receipts'],
  ['payments_paise', 'Payments'],
  ['expenses_paise', 'Expenses'],
  ['net_cashflow_paise', 'Net cash flow'],
];

export function CompareScreen() {
  const [shop, setShop] = useState('');
  const [date, setDate] = useState('');
  const [customers, setCustomers] = useState<AgingReportV2 | null>(null);
  const [suppliers, setSuppliers] = useState<AgingReportV2 | null>(null);
  const [stock, setStock] = useState<StockLine[]>([]);
  const [day, setDay] = useState<DayBookText | null>(null);
  const [msg, setMsg] = useState('');
  // Every figure on the page and every file name comes from the date the data was loaded for, never
  // from the date input; a newer load supersedes older answers (R1 review).
  const [loadedDate, setLoadedDate] = useState('');
  const [stockAt, setStockAt] = useState('');
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const generation = useRef(0);

  async function load(s = shop, d = date) {
    if (!s || !d) return;
    const g = ++generation.current;
    setLoadedDate('');
    setCustomers(null);
    setSuppliers(null);
    setStock([]);
    setDay(null);
    setMsg('Loading…');
    try {
      const [c, p, items, st, db] = await Promise.all([
        getAgingReportV2('customer', s, d),
        getAgingReportV2('supplier', s, d),
        listItems(),
        listStockText(s),
        getDayBookText(s, d, d),
      ]);
      if (g !== generation.current) return;
      const qty = new Map(
        st.map((r) => [
          r.item_id,
          r.qty_base.includes('.') ? r.qty_base.replace(/\.?0+$/, '') : r.qty_base,
        ]),
      );
      setCustomers(c);
      setSuppliers(p);
      setStock(
        items
          .map((i: Item) => ({ id: i.id, name: i.name, qty: qty.get(i.id) ?? '0' }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setDay(db[0] ?? null);
      setStockAt(new Date().toISOString().slice(0, 16).replace(':', ''));
      setLoadedDate(d);
      setMsg('');
    } catch (e) {
      if (g === generation.current) setMsg(`Could not load the comparison: ${String(e)}`);
    }
  }
  useEffect(() => {
    void (async () => {
      const m = await getCurrentMembership();
      const ok = m?.role === 'owner' || m?.role === 'manager' || m?.role === 'accountant';
      setAllowed(ok);
      if (!ok) return;
      const s = await getDefaultShopId();
      const d = await getShopBusinessDate(s);
      setShop(s);
      setDate(d);
      await load(s, d);
    })().catch((e) => setMsg(String(e)));
  }, []);

  const stockCsv = () =>
    toCsv(
      ['Item', 'On hand (smallest unit)'],
      stock.map((l): Cell[] => [{ text: l.name }, { num: l.qty }]),
    );
  const dayCsv = () =>
    toCsv(
      ['Date', ...DAY_FIELDS.map(([, label]) => label)],
      [
        [
          { text: loadedDate },
          ...DAY_FIELDS.map(([k]): Cell => ({ num: paiseToDecimal(day?.[k] ?? '0') })),
        ],
      ],
    );

  if (allowed === false)
    return (
      <main>
        <h1>Compare with old DSB</h1>
        <p role="status">
          Only the owner, a manager or the accountant can open the shadow-run comparison.
        </p>
      </main>
    );

  return (
    <main>
      <div class="row">
        <h1>Compare with old DSB</h1>
        <a href={appRoute.reports}>Reports</a>
      </div>
      <p class="muted">
        Shadow run: tick each figure against old DSB for the same date. Any difference you cannot
        explain is a finding — note it with the date before entering anything to "fix" it.
      </p>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          Date
          <input
            type="date"
            value={date}
            onInput={(e) => setDate((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <button class="primary">Compare</button>
      </form>
      {msg && <p role="status">{msg}</p>}

      {loadedDate && loadedDate !== date && (
        <p class="alert" role="alert">
          The figures below are for {loadedDate}. Press Compare to load {date}.
        </p>
      )}
      <section class="card" aria-label="Day totals">
        <div class="row">
          <h2>Day totals {loadedDate || '—'}</h2>
          <button
            type="button"
            disabled={!loadedDate || !day}
            onClick={() => download(`day-${loadedDate}.csv`, dayCsv())}
          >
            CSV
          </button>
        </div>
        {loadedDate && !day && <p class="muted">No day-book row for {loadedDate} (no activity).</p>}
        <table>
          <tbody>
            {DAY_FIELDS.map(([k, label]) => (
              <tr key={k}>
                <td>{label}</td>
                <td>{rupees(day?.[k] ?? '0')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <BalanceSection
        title="Customer balances"
        hint="positive = customer owes the shop"
        report={customers}
        file={`customers-${loadedDate}.csv`}
      />
      <BalanceSection
        title="Supplier balances"
        hint="positive = shop owes the supplier"
        report={suppliers}
        file={`suppliers-${loadedDate}.csv`}
      />

      <section class="card" aria-label="Item stock">
        <div class="row">
          <h2>Item stock (now)</h2>
          <button
            type="button"
            disabled={!loadedDate}
            onClick={() => download(`stock-now-${stockAt}.csv`, stockCsv())}
          >
            CSV
          </button>
        </div>
        <p class="muted">Current on-hand quantity, not as of the chosen date.</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>On hand (smallest unit)</th>
              </tr>
            </thead>
            <tbody>
              {stock.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>{l.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function BalanceSection(props: {
  title: string;
  hint: string;
  report: AgingReportV2 | null;
  file: string;
}) {
  const r = props.report;
  return (
    <section class="card" aria-label={props.title}>
      <div class="row">
        <h2>{props.title}</h2>
        <button
          type="button"
          disabled={!r}
          onClick={() => r && download(props.file, balanceCsv(r))}
        >
          CSV
        </button>
      </div>
      <p class="muted">Net balance as of the loaded date; {props.hint}.</p>
      {!r || !r.accounts.length ? (
        <p class="muted">No balances.</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Net balance</th>
              </tr>
            </thead>
            <tbody>
              {r.accounts.map((a) => (
                <tr key={a.accountId}>
                  <td>{a.name}</td>
                  <td>{rupees(a.netLedgerBalancePaise)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td>{rupees(r.totals.netLedgerBalancePaise)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
