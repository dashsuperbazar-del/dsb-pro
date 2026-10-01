import { useEffect, useState } from 'preact/hooks';
import {
  getDayBook,
  getDefaultShopId,
  getShopBusinessDate,
  type DayBookRow,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';

const rupee = (p: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100);

// Home tile: today's day book at a glance (server figures; nothing computed locally).
export function DayBookTile() {
  const [date, setDate] = useState('');
  const [row, setRow] = useState<DayBookRow | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void (async () => {
      const shop = await getDefaultShopId();
      const d = await getShopBusinessDate(shop);
      setDate(d);
      setRow((await getDayBook(shop, d, d))[0] ?? null);
    })().catch((e) => setError(String(e)));
  }, []);
  if (error) return null;
  const v = (k: keyof Omit<DayBookRow, 'business_date'>) => rupee(row ? row[k] : 0);
  return (
    <section class="card daybook-tile" aria-label="Day book today">
      <h2>Today {date && `· ${date}`}</h2>
      <dl class="tiles">
        <div>
          <dt>Sales</dt>
          <dd>{v('sales_paise')}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>{v('receipts_paise')}</dd>
        </div>
        <div>
          <dt>Paid out</dt>
          <dd>{v('payments_paise')}</dd>
        </div>
        <div>
          <dt>Expenses</dt>
          <dd>{v('expenses_paise')}</dd>
        </div>
        <div>
          <dt>Net cash</dt>
          <dd>{v('net_cashflow_paise')}</dd>
        </div>
      </dl>
      <a href={appRoute.reports}>Full day book</a>
    </section>
  );
}
