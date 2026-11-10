import { useEffect, useState } from 'preact/hooks';
import { getAgingReportV2, getDayBook, getShopBusinessDate } from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { rupees } from '../lib/money';
import { StatGrid, StatTile } from './Kit';

/** Old-DSB sales header (L5): tiles + Customer / Walk-in / Counter. Display only; a tile the role cannot read
 * stays "…" and never blocks the invoice list. */
export function SalesOverview({ shopId }: { shopId: string }) {
  const [t, setT] = useState<{ today?: number; month?: number; due?: string }>({});
  useEffect(() => {
    if (!shopId) return;
    let live = true;
    void getShopBusinessDate(shopId)
      .then((today) =>
        Promise.allSettled([
          getDayBook(shopId, today.slice(0, 8) + '01', today).then((rows) => {
            const d = rows.find((r) => r.business_date === today);
            if (live)
              setT((v) => ({
                ...v,
                today: Number(d?.sales_paise ?? 0),
                month: rows.reduce((a, r) => a + Number(r.sales_paise), 0),
              }));
          }),
          getAgingReportV2('customer', shopId, today).then((r) => {
            if (live) setT((v) => ({ ...v, due: r.totals.netLedgerBalancePaise }));
          }),
        ]),
      )
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [shopId]);
  const m = (v: number | string | undefined) => (v === undefined ? '…' : rupees(String(v)));
  return (
    <section class="sales-overview no-print" aria-label="Sales overview">
      <div class="sales-actions">
        <a class="kit-btn" href={appRoute.customers}>
          + Customer
        </a>
        <a class="kit-btn" href={appRoute.pos}>
          ⚡ Walk-in
        </a>
        <a class="kit-btn primary" href={appRoute.pos}>
          🏪 Counter
        </a>
      </div>
      <StatGrid>
        <StatTile label="Sales today" value={m(t.today)} tone="brand" />
        <StatTile label="This month sales" value={m(t.month)} tone="brand" />
        <StatTile label="Receivable" value={m(t.due)} tone="danger" />
      </StatGrid>
    </section>
  );
}
