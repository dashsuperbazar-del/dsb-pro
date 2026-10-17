import { useEffect, useState } from 'preact/hooks';
import {
  getDefaultShopId,
  getLowStockReport,
  getShopBusinessDate,
  getSupplierOutstanding,
  getSupplierPaymentsDue,
  type SupplierPaymentDue,
  type LowStockRow,
  type SupplierOutstandingRow,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { rupees } from '../lib/money';
import { summarizeLowStock, summarizeSuppliers } from '../lib/attention';
import { summarizeDue } from '../lib/supplierSchedule';

type Part<T> = { state: 'loading' } | { state: 'error' } | { state: 'ok'; value: T };

// Home tile for owner/manager: what needs a look today. A report that fails is shown as unavailable,
// never as "all clear". "Owed" is the ledger balance; "due" comes only from a saved payment schedule.
export function AttentionTile() {
  const [low, setLow] = useState<Part<LowStockRow[]>>({ state: 'loading' });
  const [sup, setSup] = useState<Part<SupplierOutstandingRow[]>>({ state: 'loading' });
  const [due, setDue] = useState<Part<SupplierPaymentDue[]>>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const shop = await getDefaultShopId();
      getLowStockReport(shop).then(
        (value) => alive && setLow({ state: 'ok', value }),
        () => alive && setLow({ state: 'error' }),
      );
      void (async () => {
        try {
          const value = await getSupplierPaymentsDue(shop, await getShopBusinessDate(shop));
          if (alive) setDue({ state: 'ok', value });
        } catch {
          if (alive) setDue({ state: 'error' });
        }
      })();
      getSupplierOutstanding(shop).then(
        (value) => alive && setSup({ state: 'ok', value }),
        () => alive && setSup({ state: 'error' }),
      );
    })().catch(() => {
      if (alive) {
        setLow({ state: 'error' });
        setSup({ state: 'error' });
        setDue({ state: 'error' });
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  const lowSummary = low.state === 'ok' ? summarizeLowStock(low.value) : null;
  const dueSummary = due.state === 'ok' ? summarizeDue(due.value) : null;
  const supSummary = sup.state === 'ok' ? summarizeSuppliers(sup.value) : null;
  return (
    <section class="card attention-tile" aria-label="Needs attention">
      <h2>Needs attention</h2>
      <ul>
        <li>
          {low.state === 'loading' && <span class="muted">Checking low stock…</span>}
          {low.state === 'error' && <span role="alert">Low stock is unavailable right now.</span>}
          {lowSummary && lowSummary.count === 0 && <span>No items below minimum stock.</span>}
          {lowSummary && lowSummary.count > 0 && (
            <span>
              <strong>{lowSummary.count}</strong> item{lowSummary.count === 1 ? '' : 's'} below
              minimum stock:{' '}
              {lowSummary.worst
                .map((r) => `${r.item_name} (${r.on_hand} ${r.unit_name})`)
                .join(', ')}
              . <a href={appRoute.reports}>Review low stock</a>
            </span>
          )}
        </li>
        <li>
          {sup.state === 'loading' && <span class="muted">Checking suppliers…</span>}
          {sup.state === 'error' && (
            <span role="alert">Supplier balances are unavailable right now.</span>
          )}
          {supSummary && supSummary.owedCount === 0 && <span>No supplier balance is owed.</span>}
          {supSummary && supSummary.owedCount > 0 && (
            <span>
              <strong>{rupees(supSummary.owedPaise)}</strong> owed to {supSummary.owedCount}{' '}
              supplier
              {supSummary.owedCount === 1 ? '' : 's'}.{' '}
              <a href={appRoute.suppliers}>Review supplier balances</a>
            </span>
          )}
        </li>
        <li>
          {due.state === 'loading' && <span class="muted">Checking payment schedule…</span>}
          {due.state === 'error' && (
            <span role="alert">Supplier payment reminders are unavailable right now.</span>
          )}
          {dueSummary && dueSummary.count === 0 && (
            <span>No scheduled supplier payment is due.</span>
          )}
          {dueSummary && dueSummary.count > 0 && (
            <span>
              <strong>{dueSummary.count}</strong> scheduled supplier payment
              {dueSummary.count === 1 ? ' is' : 's are'} due:{' '}
              {dueSummary.worst
                .map(
                  (r) =>
                    `${r.partyName} (${r.remainingPaise === null ? 'no amount set' : rupees(r.remainingPaise)}, ${r.daysOverdue === 0 ? 'due today' : `${r.daysOverdue} day${r.daysOverdue === 1 ? '' : 's'} late`})`,
                )
                .join(', ')}
              . <a href={appRoute.suppliers}>Open suppliers</a>
            </span>
          )}
        </li>
        {supSummary && supSummary.strandedSuppliers > 0 && (
          <li role="alert">
            {supSummary.strandedSuppliers} supplier
            {supSummary.strandedSuppliers === 1 ? ' has' : 's have'} payments still allocated to
            voided bills. Open <a href={appRoute.suppliers}>stranded payments</a> to release them.
          </li>
        )}
      </ul>
    </section>
  );
}
