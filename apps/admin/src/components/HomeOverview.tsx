import { useEffect, useState } from 'preact/hooks';
import {
  getAgingReportV2,
  getDayBook,
  getDefaultShopId,
  getShopBusinessDate,
  getSupplierOutstanding,
  listParties,
  listPurchaseHistory,
  type PurchaseRecord,
  type SupplierOutstandingRow,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { rupees } from '../lib/money';
import { oldestUnpaidDays } from '../lib/partyNames';
import { DocCard, SectionTitle, StatGrid, StatTile } from './Kit';

/** Old-DSB home (L2): six tiles, recent bills, top outstanding. Display only; every figure comes from the
 * same server reports the other screens use. Each block fails on its own and simply stays hidden. */
type Data = {
  outstanding: bigint | null;
  parties: number | null;
  monthBills: number | null;
  todayBills: number | null;
  todaySales: number | null;
  monthSales: number | null;
  recent: PurchaseRecord[];
  names: Map<string, string>;
  top: SupplierOutstandingRow[];
  age: Map<string, number>;
  today: string;
};
const EMPTY: Data = {
  outstanding: null,
  parties: null,
  monthBills: null,
  todayBills: null,
  todaySales: null,
  monthSales: null,
  recent: [],
  names: new Map(),
  top: [],
  age: new Map(),
  today: '',
};

function shortDate(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function HomeOverview({ rev }: { rev: number }) {
  const [d, setD] = useState<Data>(EMPTY);
  useEffect(() => {
    let live = true;
    const put = (p: Partial<Data>) => live && setD((v) => ({ ...v, ...p }));
    void (async () => {
      const shop = await getDefaultShopId();
      const today = await getShopBusinessDate(shop);
      put({ today });
      const monthStart = today.slice(0, 8) + '01';
      await Promise.allSettled([
        getSupplierOutstanding(shop).then((rows) => {
          const owed = rows.filter((r) => BigInt(r.netLedgerBalance) > 0n);
          put({
            outstanding: owed.reduce((a, r) => a + BigInt(r.netLedgerBalance), 0n),
            top: owed
              .sort((a, b) => (BigInt(b.netLedgerBalance) > BigInt(a.netLedgerBalance) ? 1 : -1))
              .slice(0, 8),
          });
        }),
        listParties().then((p) =>
          put({ parties: p.length, names: new Map(p.map((x) => [x.id, x.name])) }),
        ),
        getDayBook(shop, monthStart, today).then((rows) => {
          const t = rows.find((r) => r.business_date === today);
          put({
            monthBills: rows.reduce((a, r) => a + Number(r.purchases_paise), 0),
            monthSales: rows.reduce((a, r) => a + Number(r.sales_paise), 0),
            todayBills: Number(t?.purchases_paise ?? 0),
            todaySales: Number(t?.sales_paise ?? 0),
          });
        }),
        listPurchaseHistory(shop, 0).then((b) => put({ recent: b.slice(0, 5) })),
        getAgingReportV2('supplier', shop, today).then((r) => {
          const age = new Map<string, number>();
          for (const a of r.accounts) {
            const x = oldestUnpaidDays(a.details ?? []);
            if (x !== null) age.set(a.accountId, x);
          }
          put({ age });
        }),
      ]);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [rev]);

  const money = (v: number | bigint | null) => (v === null ? '…' : rupees(v.toString()));
  return (
    <section class="home-overview" aria-label="Shop overview">
      <form
        class="home-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get('q');
          window.location.href = appRoute.search + (q ? `?q=${encodeURIComponent(String(q))}` : '');
        }}
      >
        <input
          name="q"
          type="search"
          aria-label="Search everything"
          placeholder="Search everything — bills, parties, items…"
        />
      </form>
      <StatGrid>
        <StatTile
          label="Total outstanding"
          value={money(d.outstanding)}
          tone="danger"
          testId="tile-outstanding"
        />
        <StatTile label="This month bills" value={money(d.monthBills)} tone="brand" />
        <StatTile label="Total parties" value={d.parties ?? '…'} />
        <StatTile label="Bills today" value={money(d.todayBills)} />
        <StatTile label="Sales today" value={money(d.todaySales)} tone="success" />
        <StatTile label="This month sales" value={money(d.monthSales)} tone="success" />
      </StatGrid>
      <div class="home-actions">
        <a class="kit-btn primary" href={appRoute.purchases + '?new=1'}>
          📦 New Bill
        </a>
        <a class="kit-btn" href={appRoute.pos}>
          ⚡ Walk-in Sale
        </a>
        <a class="kit-btn" href={appRoute.more}>
          🛠 Tools
        </a>
      </div>
      <a class="kit-btn wide" href={appRoute.daybook}>
        📒 Day Book — Today's Summary
      </a>
      <a class="kit-btn wide" href={appRoute.profit}>
        📈 Profit Report
      </a>
      {d.recent.length > 0 && (
        <>
          <SectionTitle>Recent bills</SectionTitle>
          {d.recent.map((b) => (
            <DocCard
              key={b.id}
              party={(b.party_id && d.names.get(b.party_id)) || 'No supplier'}
              docNo={b.bill_code || b.bill_no || 'Bill'}
              date={shortDate(b.business_date)}
              amount={rupees(b.total_paise)}
              status={b.status === 'VOID' ? 'void' : undefined}
              onOpen={() => (window.location.href = `${appRoute.purchases}?bill=${b.id}`)}
            />
          ))}
        </>
      )}
      {d.top.length > 0 && (
        <>
          <SectionTitle>Top outstanding</SectionTitle>
          <ul class="home-owed">
            {d.top.map((r) => {
              const age = d.age.get(r.partyId);
              return (
                <li key={r.partyId}>
                  <span class="home-owed-avatar" aria-hidden="true">
                    {r.partyName.slice(0, 1).toUpperCase()}
                  </span>
                  <span class="home-owed-name">
                    <strong>{r.partyName}</strong>
                    {age !== undefined && age > 0 && (
                      <span
                        class={`kit-badge ${age > 120 ? 'credit' : age > 60 ? 'partial' : 'void'}`}
                      >
                        {age}d unpaid
                      </span>
                    )}
                  </span>
                  <span class="home-owed-side">
                    <strong class="num money-negative">{rupees(r.netLedgerBalance)}</strong>
                    <a
                      class="kit-btn small primary"
                      href={`${appRoute.suppliers}?supplier=${r.partyId}&view=payment`}
                    >
                      Pay
                    </a>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
