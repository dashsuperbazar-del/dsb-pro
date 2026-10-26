import { formatQuantity, splitGst } from '@dsb-pro/core';
import type { SaleReceipt } from '@dsb-pro/adapters';
import { ReceiptHeader } from './ReceiptHeader';
import type { ProfileLoad } from '../lib/shopProfile';

// The printed sale invoice (thermal or A4). One component for Sales history and the POS "sale done" card,
// so a reprint and the first print are the same document. Hidden on screen, shown by the print stylesheet.
const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

export type SaleReceiptPrintMode = 'thermal' | 'a4';

export function SaleReceiptPrint({
  receipt,
  profile,
  printMode,
}: {
  receipt: SaleReceipt;
  profile: ProfileLoad | null;
  printMode: SaleReceiptPrintMode;
}) {
  return (
    <article
      class={`receipt-print receipt-${printMode}${printMode === 'thermal' && profile?.profile?.printerWidth === '58mm' ? ' receipt-w58' : ''}`}
      aria-label="invoice receipt"
    >
      <ReceiptHeader load={profile}>
        <p>
          Invoice {receipt.invoice.doc_no}
          {receipt.invoice.bill_code && (
            <>
              <br />
              Bill code {receipt.invoice.bill_code}
            </>
          )}
          <br />
          Date {receipt.invoice.business_date}
          <br />
          Status {receipt.invoice.status}
        </p>
      </ReceiptHeader>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Qty</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((l) => (
            <tr>
              <td>
                {l.item_name_snapshot}
                <small>
                  {l.unit_name_snapshot}
                  {l.discount_paise ? ` · discount ${money(l.discount_paise)}` : ''}
                  {receipt.invoice.invoice_type === 'gst_extra'
                    ? ` · GST ${(l.tax_rate_bp_snapshot ?? 0) / 100}% ${money(l.tax_paise ?? 0)}`
                    : ''}
                </small>
              </td>
              <td class="num">{formatQuantity(l.qty)}</td>
              <td>{money(l.unit_price_paise)}</td>
              <td>{money(l.line_total_paise - (l.tax_paise ?? 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl class="receipt-totals">
        <div>
          <dt>
            {receipt.invoice.invoice_type === 'gst_extra' ? 'Subtotal (before GST)' : 'Subtotal'}
          </dt>
          <dd>{money(receipt.invoice.subtotal_paise - (receipt.invoice.tax_paise ?? 0))}</dd>
        </div>
        {receipt.invoice.discount_paise > 0 && (
          <div>
            <dt>Discount</dt>
            <dd>−{money(receipt.invoice.discount_paise)}</dd>
          </div>
        )}
        {receipt.invoice.invoice_type === 'gst_extra' && (
          <>
            <div>
              <dt>CGST</dt>
              <dd>{money(splitGst(receipt.invoice.tax_paise ?? 0).cgstPaise)}</dd>
            </div>
            <div>
              <dt>SGST</dt>
              <dd>{money(splitGst(receipt.invoice.tax_paise ?? 0).sgstPaise)}</dd>
            </div>
          </>
        )}
        {receipt.invoice.extra_charges_paise > 0 && (
          <div>
            <dt>Extra charges</dt>
            <dd>{money(receipt.invoice.extra_charges_paise)}</dd>
          </div>
        )}
        {(receipt.invoice.round_off_paise ?? 0) !== 0 && (
          <div>
            <dt>Round off</dt>
            <dd>
              {(receipt.invoice.round_off_paise ?? 0) > 0 ? '+' : '−'}
              {money(Math.abs(receipt.invoice.round_off_paise ?? 0))}
            </dd>
          </div>
        )}
        <div>
          <dt>Total</dt>
          <dd>
            <strong>{money(receipt.invoice.total_paise)}</strong>
          </dd>
        </div>
      </dl>
      <h2>Payments</h2>
      {receipt.payments.length ? (
        <ul>
          {receipt.payments.map((p) => (
            <li>
              {p.direction === 'out' ? 'REFUND' : 'RECEIPT'} · {p.mode.toUpperCase()}{' '}
              {money(p.amount_paise)}
              {p.reference ? ` · ${p.reference}` : ''}
              {p.status === 'VOID' ? ' · VOID' : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p>Credit / unpaid</p>
      )}
      {receipt.invoice.notes && <p>Notes: {receipt.invoice.notes}</p>}
      <footer>
        <p>Thank you · Powered by DSB Pro</p>
      </footer>
    </article>
  );
}
