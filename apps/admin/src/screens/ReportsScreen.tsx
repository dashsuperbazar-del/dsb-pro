import { useEffect, useState } from 'preact/hooks';
import {
  checkInvariants,
  exportTenant,
  getDayBook,
  getDefaultShopId,
  getGstSummary,
  getShopBusinessDate,
  getPartyLedger,
  getStockValuation,
  listParties,
  getLowStockReport,
  getItemSalesReport,
  getPurchaseRegister,
  getCustomerAgingReport,
  type DayBookRow,
  type GstRow,
  type Party,
  type PartyLedgerRow,
  type StockValueRow,
  type LowStockRow,
  type ItemSalesRow,
  type PurchaseRegisterRow,
  type CustomerAgingRow,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import { exportOfflineBillingSnapshot } from '../lib/offlineSync';
import { buildBusinessExportArchive } from '@dsb-pro/core';

const rupee = (p: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100);
function download(name: string, content: string | Uint8Array, type: string) {
  const part: BlobPart =
    typeof content === 'string' ? content : (content.slice().buffer as ArrayBuffer);
  const blob = new Blob([part], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function ReportsScreen() {
  const [shop, setShop] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [day, setDay] = useState<DayBookRow[]>([]);
  const [stock, setStock] = useState<StockValueRow[]>([]);
  const [gst, setGst] = useState<GstRow[]>([]);
  const [lowStock, setLowStock] = useState<LowStockRow[]>([]);
  const [itemSales, setItemSales] = useState<ItemSalesRow[]>([]);
  const [purchaseRegister, setPurchaseRegister] = useState<PurchaseRegisterRow[]>([]);
  const [aging, setAging] = useState<CustomerAgingRow[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [partyId, setPartyId] = useState('');
  const [partyLedger, setPartyLedger] = useState<PartyLedgerRow[]>([]);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    void (async () => {
      try {
        const s = await getDefaultShopId();
        setShop(s);
        const [ps, d] = await Promise.all([listParties(), getShopBusinessDate(s)]);
        setParties(ps);
        setBusinessDate(d);
        setFrom(d.slice(0, 8) + '01');
        setTo(d);
      } catch (e) {
        setMsg(String(e));
      }
    })();
  }, []);
  async function load() {
    if (!shop) return;
    setMsg('Loading…');
    try {
      const [d, s, g, i, ls, is, pr, ag] = await Promise.all([
        getDayBook(shop, from, to),
        getStockValuation(shop),
        getGstSummary(shop, from, to),
        checkInvariants(),
        getLowStockReport(shop),
        getItemSalesReport(shop, from, to),
        getPurchaseRegister(shop, from, to),
        getCustomerAgingReport(shop, to),
      ]);
      setDay(d);
      setStock(s);
      setGst(g);
      setLowStock(ls);
      setItemSales(is);
      setPurchaseRegister(pr);
      setAging(ag);
      if (partyId) setPartyLedger(await getPartyLedger(partyId, from, to));
      setMsg(i.ok ? 'Invariant check: PASS' : 'Invariant check: FAIL — stop and investigate');
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function saveBackup() {
    if (!shop || !businessDate) return;
    try {
      const data = await exportTenant(shop);
      const archive = buildBusinessExportArchive(data);
      download('dsb-pro-full-device-backup-' + businessDate + '.zip', archive, 'application/zip');
      setMsg(
        'Full device backup saved as one ZIP: portable JSON, every exported table as CSV, and one PDF per invoice. Keep an encrypted copy off-device too.',
      );
    } catch (e) {
      setMsg(String(e));
    }
  }
  async function saveOfflineSnapshot() {
    try {
      const data = await exportOfflineBillingSnapshot();
      download(
        'dsb-pro-offline-billing-' + (businessDate || 'snapshot') + '.json',
        JSON.stringify(data, null, 2),
        'application/json',
      );
      setMsg(
        'Offline billing-continuity snapshot saved. It includes the local catalog, stock, queued sales and conflicts—not full accounting history.',
      );
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <main class="wide">
      <h1>Reports & recovery</h1>
      <p>
        <a href={appRoute.home}>← Home</a>
      </p>
      <div class="row">
        <label>
          From
          <input
            type="date"
            value={from}
            onInput={(e) => setFrom((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            onInput={(e) => setTo((e.target as HTMLInputElement).value)}
          />
        </label>
        <button class="primary" disabled={!shop || !from || !to} onClick={() => void load()}>
          Refresh
        </button>
        <button onClick={() => void saveBackup()}>Save full device backup ZIP</button>
        <button onClick={() => void saveOfflineSnapshot()}>Save offline billing snapshot</button>
      </div>
      {msg && (
        <p role="status" class={msg.includes('FAIL') ? 'alert' : ''}>
          {msg}
        </p>
      )}
      <section class="card">
        <h2>Daily entry</h2>
        <p>
          Expenses and stock adjustments have their own screens:{' '}
          <a href={appRoute.expenses}>Expenses</a> · <a href={appRoute.stockAdjust}>Stock adjust</a>
        </p>
      </section>
      <section class="card">
        <h2>Party ledger</h2>
        <div class="row">
          <select
            value={partyId}
            onInput={(e) => setPartyId((e.target as HTMLSelectElement).value)}
          >
            <option value="">Choose supplier…</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button onClick={() => void load()}>Load ledger</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Document</th>
                <th>Debit</th>
                <th>Credit</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {partyLedger.map((r) => (
                <tr>
                  <td>{r.business_date}</td>
                  <td>{r.entry_type}</td>
                  <td>{r.document}</td>
                  <td>{rupee(r.debit_paise)}</td>
                  <td>{rupee(r.credit_paise)}</td>
                  <td>{rupee(r.running_balance_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>Day book</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Sales</th>
                <th>Purchases</th>
                <th>Receipts</th>
                <th>Payments</th>
                <th>Expenses</th>
                <th>Net cash flow</th>
              </tr>
            </thead>
            <tbody>
              {day.map((r) => (
                <tr>
                  <td>{r.business_date}</td>
                  <td>{rupee(r.sales_paise)}</td>
                  <td>{rupee(r.purchases_paise)}</td>
                  <td>{rupee(r.receipts_paise)}</td>
                  <td>{rupee(r.payments_paise)}</td>
                  <td>{rupee(r.expenses_paise)}</td>
                  <td>{rupee(r.net_cashflow_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>Stock valuation</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty base</th>
                <th>Last cost</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {stock.map((r) => (
                <tr>
                  <td>{r.item_name}</td>
                  <td>{r.qty_base}</td>
                  <td>{rupee(r.cost_paise)}</td>
                  <td>{rupee(r.value_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>GST summary</h2>
        <p class="muted">
          Derived from immutable tax-rate snapshots. This is a bookkeeping summary, not filing
          advice.
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rate</th>
                <th>Taxable sales</th>
                <th>Gross sales</th>
                <th>Taxable purchases</th>
                <th>Gross purchases</th>
              </tr>
            </thead>
            <tbody>
              {gst.map((r) => (
                <tr>
                  <td>{(r.tax_rate_bp / 100).toFixed(2)}%</td>
                  <td>{rupee(r.taxable_sales_paise)}</td>
                  <td>{rupee(r.gross_sales_paise)}</td>
                  <td>{rupee(r.taxable_purchases_paise)}</td>
                  <td>{rupee(r.gross_purchases_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>Low stock / reorder</h2>
        <p class="muted">
          Items at or below their configured minimum stock, right now — not limited to the date
          range above.
        </p>
        {!lowStock.length ? (
          <p class="muted">Nothing is at or below its minimum stock.</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>On hand</th>
                  <th>Min stock</th>
                  <th>Shortfall</th>
                </tr>
              </thead>
              <tbody>
                {lowStock.map((r) => (
                  <tr>
                    <td>{r.item_name}</td>
                    <td>
                      {r.on_hand} {r.unit_name}
                    </td>
                    <td>
                      {r.min_stock} {r.unit_name}
                    </td>
                    <td>
                      {r.shortfall} {r.unit_name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section class="card">
        <h2>Item-wise sales</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Sold</th>
                <th>Returned</th>
                <th>Net qty</th>
                <th>Gross sales</th>
                <th>Net sales</th>
              </tr>
            </thead>
            <tbody>
              {itemSales.map((r) => (
                <tr>
                  <td>{r.item_name}</td>
                  <td>{r.qty_sold}</td>
                  <td>{r.qty_returned}</td>
                  <td>{r.net_qty}</td>
                  <td>{rupee(r.gross_sales_paise)}</td>
                  <td>{rupee(r.net_sales_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>Purchase register</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Bill</th>
                <th>Date</th>
                <th>Supplier</th>
                <th>Subtotal</th>
                <th>Discount</th>
                <th>Extra</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {purchaseRegister.map((r) => (
                <tr>
                  <td>{r.doc_no}</td>
                  <td>{r.business_date}</td>
                  <td>{r.party_name ?? '—'}</td>
                  <td>{rupee(r.subtotal_paise)}</td>
                  <td>{rupee(r.discount_paise)}</td>
                  <td>{rupee(r.extra_charges_paise)}</td>
                  <td>{rupee(r.total_paise)}</td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>Customer aging</h2>
        <p class="muted">
          As of the "To" date above. Fully settled invoices carry no balance and do not appear.
        </p>
        {!aging.length ? (
          <p class="muted">No outstanding customer balances.</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Not due</th>
                  <th>1–30 days</th>
                  <th>31–60 days</th>
                  <th>61–90 days</th>
                  <th>90+ days</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {aging.map((r) => (
                  <tr>
                    <td>{r.customer_name}</td>
                    <td>{rupee(r.not_due_paise)}</td>
                    <td>{rupee(r.days_1_30_paise)}</td>
                    <td>{rupee(r.days_31_60_paise)}</td>
                    <td>{rupee(r.days_61_90_paise)}</td>
                    <td>{rupee(r.days_90_plus_paise)}</td>
                    <td>{rupee(r.total_outstanding_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
