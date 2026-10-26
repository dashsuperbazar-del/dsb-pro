import type { ComponentChildren, RefObject } from 'preact';
import type { SaleDoneFigures } from '../lib/saleDone';
import { rupees } from '../lib/money';
import { BillCodeChip } from './BillCodeChip';

// What the counter sees after a sale is finalized (D4): the money first, the invoice number and bill code,
// and the next step. It only shows what the posting path already returned; nothing is recomputed here.
export type SaleDoneInfo = {
  kind: 'synced' | 'queued';
  clientId: string;
  /** The official invoice number (synced) or the device's provisional number (queued). */
  docNo: string;
  billCode: string | null;
  figures: SaleDoneFigures | null;
  customerName: string | null;
  /** Extra sentence after a synced sale (e.g. "Saved as sale price: …"), or after a queued one. */
  note: string;
};

const money = (paise: number) => (Number.isSafeInteger(paise) ? rupees(paise) : '—');
const shortProvisional = (docNo: string) => (docNo.length > 12 ? `${docNo.slice(0, 10)}…` : docNo);

export function SaleDoneCard({
  info,
  cardRef,
  onNewSale,
  onClose,
  onPrint,
  share,
}: {
  info: SaleDoneInfo;
  cardRef?: RefObject<HTMLElement>;
  onNewSale: () => void;
  onClose: () => void;
  /** Absent when this sale cannot be printed from here. */
  onPrint?: () => void;
  /** The share button (a synced sale only: the image is built from the server invoice). */
  share?: ComponentChildren;
}) {
  const queued = info.kind === 'queued';
  const f = info.figures;
  return (
    <section
      class={`card sale-done${queued ? ' sale-done-queued' : ''}`}
      aria-label="Sale done"
      tabIndex={-1}
      ref={cardRef as RefObject<HTMLElement>}
    >
      <p role="status" class="sale-done-head">
        {queued ? (
          <>
            <strong>Saved on this device — will sync</strong>
            <small>
              Saved locally as {info.docNo}. It will sync automatically when the backend is
              reachable.{info.note ? ` ${info.note}` : ''}
            </small>
          </>
        ) : (
          <>
            Sale finalized: {info.docNo}.{info.note ? ` ${info.note}` : ''}
          </>
        )}
      </p>
      {f && (
        <div class="sale-done-total">
          <small>
            {!queued && f.confirmed === false ? 'Total as entered on this device' : 'Total'}
          </small>
          <strong>{money(f.totalPaise)}</strong>
        </div>
      )}
      <dl class="sale-done-facts">
        {f && (
          <>
            <div>
              <dt>Paid</dt>
              <dd>{money(f.paidPaise)}</dd>
            </div>
            <div>
              <dt>{f.balancePaise > 0 && !f.paymentsUnclear ? 'Balance on credit' : 'Balance'}</dt>
              <dd class={f.balancePaise > 0 && !f.paymentsUnclear ? 'sale-done-credit' : undefined}>
                {f.paymentsUnclear
                  ? 'Check Sales history'
                  : f.balancePaise > 0
                    ? money(f.balancePaise)
                    : 'Nil, fully paid'}
              </dd>
            </div>
          </>
        )}
        {info.customerName && (
          <div>
            <dt>Customer</dt>
            <dd>{info.customerName}</dd>
          </div>
        )}
        <div>
          <dt>{queued ? 'Provisional number' : 'Invoice'}</dt>
          <dd title={info.docNo}>{queued ? shortProvisional(info.docNo) : info.docNo}</dd>
        </div>
      </dl>
      {!queued && <BillCodeChip code={info.billCode} />}
      <div class="sale-done-actions no-print">
        <button type="button" class="primary" onClick={onNewSale}>
          New sale
        </button>
        {onPrint && (
          <button type="button" onClick={onPrint}>
            Print receipt
          </button>
        )}
        {share}
        <button type="button" class="quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
