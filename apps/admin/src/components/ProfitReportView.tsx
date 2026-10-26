import { formatQuantity } from '@dsb-pro/core';
import type { ProfitReport } from '@dsb-pro/adapters';
import { rupees } from '../lib/money';

// "21.000000" -> "21", "3.500000" -> "3.5": quantities are exact decimals, shown without trailing zeros.
const qty = formatQuantity;
// Basis points -> "44.76%" (null = nothing could be costed). Integer maths only; never a float of money.
function percent(bp: number | null): string {
  if (bp === null) return '—';
  const neg = bp < 0;
  const abs = Math.abs(bp);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}%`;
}

export function ProfitReportView({ report }: { report: ProfitReport }) {
  const s = report.summary;
  const empty = report.items.length === 0;
  // Positive only: after a return the unknown-cost bucket can be zero or negative, which is not a "sales" amount.
  const hasUnknown =
    !s.unknownCostRevenuePaise.startsWith('-') && s.unknownCostRevenuePaise !== '0';
  const hasEstimate = s.estimatedCostPaise !== '0' && !s.estimatedCostPaise.startsWith('-');
  const exact = !hasUnknown && !hasEstimate;
  return (
    <div>
      <p class="muted">
        {report.from} to {report.to} · cost method: FIFO (the oldest purchase cost is used first).
      </p>
      {empty ? (
        <p>There were no sales or returns in this period.</p>
      ) : (
        <>
          <div class="row">
            <p>
              <strong>Net sales</strong>
              <br />
              {rupees(s.netRevenuePaise)}
            </p>
            <p>
              <strong>Cost of goods</strong>
              <br />
              {rupees(s.costOfGoodsPaise)}
            </p>
            <p>
              <strong>{exact ? 'Gross profit' : 'Profit on costed sales'}</strong>
              <br />
              {rupees(s.grossProfitPaise)}
            </p>
            <p>
              <strong>Margin</strong>
              <br />
              {percent(s.marginBp)}
            </p>
          </div>
          {hasEstimate && (
            <p data-testid="estimated-note" class="hint">
              {rupees(s.estimatedCostPaise)} of the cost is estimated from the latest purchase
              price, because {s.estimatedCostItemCount} item(s) were sold before any purchase was
              recorded (opening stock, or a bill entered late). Enter the purchase to make it exact.
            </p>
          )}
          {hasUnknown && (
            <p data-testid="unknown-note" class="alert" role="status">
              {rupees(s.unknownCostRevenuePaise)} of sales on {s.unknownCostItemCount} item(s) have
              no purchase cost on record at all. They are not counted in profit or margin.
            </p>
          )}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Sold</th>
                  <th>Returned</th>
                  <th class="num">Net sales</th>
                  <th>Cost</th>
                  <th>Profit</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((i) => {
                  const unknownQty = qty(i.unknownCostQty);
                  const uncosted = i.marginBp === null; // nothing about this item could be costed
                  return (
                    <tr key={i.itemId}>
                      <td>
                        {i.name}
                        {i.estimatedCostPaise !== '0' && <span class="hint"> · estimated</span>}
                        {unknownQty !== '0' && (
                          <span class="alert">
                            {' '}
                            ·{' '}
                            {uncosted
                              ? 'no cost on record'
                              : `${unknownQty} unit(s) with no cost on record`}
                          </span>
                        )}
                      </td>
                      <td>{qty(i.qtySold)}</td>
                      <td>{qty(i.qtyReturned)}</td>
                      <td class="num">{rupees(i.netRevenuePaise)}</td>
                      <td>{uncosted ? '—' : rupees(i.costOfGoodsPaise)}</td>
                      <td>{uncosted ? '—' : rupees(i.grossProfitPaise)}</td>
                      <td>{uncosted ? '—' : percent(i.marginBp)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.itemsTruncated && (
            <p class="hint">Showing the top 500 items by sales. Totals above include every item.</p>
          )}
        </>
      )}
      <p class="hint">
        Sales are after discounts and include any GST printed on the bill; extra charges and
        round-off are not included. A sale return puts the item back at the cost of the original
        sale. Voided bills and invoices are ignored. Cost is taken from your purchase bills as
        entered; if their GST is not entered the same way as on your sales, the margin is skewed.
        Figures for past periods can change when an earlier-dated purchase is entered later.
      </p>
    </div>
  );
}
