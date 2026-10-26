import { formatQuantity } from '@dsb-pro/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { hiddenNote, hideVoided, loadShowVoided, saveShowVoided } from '../lib/voidedVisibility';
import { compareLegacyDsbDayToPro, type LegacyDsbDayComparison } from '@dsb-pro/core';
import {
  getDefaultShopId,
  getSaleReceipt,
  getShopBusinessDate,
  getShopDayReconciliation,
  listCustomers,
  listRecentSales,
  listOpenRemarks,
  voidSale,
  type Customer,
  type SaleInvoice,
  type SaleReceipt,
  type ShopDayReconciliation,
} from '@dsb-pro/adapters';
import { LanguageToggle } from '../components/LanguageToggle';
import { appRoute } from '../lib/paths';
import { getLocale, t } from '../lib/i18n';
import { SaleReceiptPrint } from '../components/SaleReceiptPrint';
import { loadShopProfile, type ProfileLoad } from '../lib/shopProfile';
import { ShareImageButton } from '../components/ShareImageButton';
import { saleInvoiceDoc } from '../lib/shareImage';
import { RemarkBox } from '../components/RemarkBox';
import { BillCodeChip } from '../components/BillCodeChip';
import { billCodeMatch } from '../lib/billCode';
import { pendingDocIds } from '../lib/remarkQueue';
import { shopContext } from '../lib/shopContext';

const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

type PrintMode = 'thermal' | 'a4';

export function SalesHistoryScreen() {
  const [sales, setSales] = useState<SaleInvoice[]>([]);
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);
  const [printMode, setPrintMode] = useState<PrintMode>('a4');
  const [profile, setProfile] = useState<ProfileLoad | null>(null);
  const [shopId, setShopId] = useState('');
  const [reportDate, setReportDate] = useState('');
  const [report, setReport] = useState<ShopDayReconciliation | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [legacyComparison, setLegacyComparison] = useState<LegacyDsbDayComparison | null>(null);
  const [legacyCompareFile, setLegacyCompareFile] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [, forceLocale] = useState(0);
  const [viewing, setViewing] = useState<SaleReceipt | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  // 0067: invoices with an open remark ("Pending" badge and filter); null = not known.
  const [pending, setPending] = useState<Set<string> | null>(null);
  const [onlyPending, setOnlyPending] = useState(false);
  const [findText, setFindText] = useState('');
  const [showVoided, setShowVoided] = useState(false);
  const voidedTouched = useRef(false);
  const pendingGen = useRef(0);
  const [me, setMe] = useState<{ userId: string; role: string } | null>(null);

  async function loadReport(shop: string, date: string) {
    setReportBusy(true);
    try {
      setReport(await getShopDayReconciliation(shop, date));
    } finally {
      setReportBusy(false);
    }
  }
  async function refresh() {
    const shop = await getDefaultShopId();
    setShopId(shop);
    const date = reportDate || (await getShopBusinessDate(shop));
    if (!reportDate) setReportDate(date);
    const [recent, day] = await Promise.all([
      listRecentSales(shop, 100),
      getShopDayReconciliation(shop, date),
    ]);
    setSales(recent);
    setReport(day);
    const token = ++pendingGen.current;
    void listOpenRemarks(shop).then(
      (r) => token === pendingGen.current && setPending(pendingDocIds(r, 'sale')),
      () => token === pendingGen.current && setPending(null),
    );
  }
  useEffect(() => {
    // Global search opens an invoice directly: /sales-history?sale=<id>.
    const saleParam = new URLSearchParams(window.location.search).get('sale');
    void refresh()
      .then(() => (saleParam ? viewSale(saleParam) : undefined))
      .catch((e) => setError(String(e)));
    void listCustomers()
      .then(setCustomers)
      .catch(() => undefined);
    void shopContext
      .get()
      .then((c) => {
        setMe({ userId: c.session.user.id, role: c.membership.role });
        // A tick made before this answered stays (it could not be saved without the user id).
        if (!voidedTouched.current) setShowVoided(loadShowVoided('sales', c.session.user.id));
      })
      .catch(() => undefined);
    const h = () => forceLocale((v) => v + 1);
    window.addEventListener('dsb-locale-change', h);
    return () => window.removeEventListener('dsb-locale-change', h);
  }, []);

  async function viewSale(id: string) {
    setBusy(true);
    setError('');
    try {
      setViewing(await getSaleReceipt(id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const customerOf = (id: string | null) => (id ? customers.find((c) => c.id === id) : undefined);
  async function openReceipt(sale: SaleInvoice, mode: PrintMode) {
    setBusy(true);
    setError('');
    try {
      setPrintMode(mode);
      const [r, prof] = await Promise.all([getSaleReceipt(sale.id), loadShopProfile(shopId)]);
      setProfile(prof);
      setReceipt(r);
      setTimeout(() => window.print(), 50);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function doVoid(sale: SaleInvoice) {
    if (
      !confirm(
        `Void invoice ${sale.doc_no}? This creates reversing stock movements; history is retained.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await voidSale(sale.id, crypto.randomUUID());
      setMessage(`Invoice ${sale.doc_no} voided.`);
      await refresh();
      if (receipt?.invoice.id === sale.id) setReceipt(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function refreshReport() {
    if (!shopId || !reportDate) return;
    setError('');
    setLegacyComparison(null);
    setLegacyCompareFile('');
    try {
      await loadReport(shopId, reportDate);
    } catch (e) {
      setError(String(e));
    }
  }
  async function compareLegacyBackup(ev: Event) {
    setError('');
    setLegacyComparison(null);
    setLegacyCompareFile('');
    if (!report) {
      setError('Refresh the DSB Pro day totals before comparing a legacy backup.');
      return;
    }
    const file = (ev.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('Legacy DSB backup is too large for this comparison screen.');
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const comparison = compareLegacyDsbDayToPro(parsed, reportDate, report);
      setLegacyComparison(comparison);
      setLegacyCompareFile(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const locale = getLocale();
  // Display only: voided invoices are hidden by default, never deleted.
  const { shown: listed, hidden: hiddenVoided } = hideVoided(
    sales
      .filter((s) => !onlyPending || !!pending?.has(s.id))
      .filter(
        (s) =>
          !findText.trim() ||
          s.doc_no.toLowerCase().includes(findText.trim().toLowerCase()) ||
          billCodeMatch(s.bill_code, findText) !== null,
      ),
    (s) => s.status === 'VOID',
    showVoided,
  );
  return (
    <main class="page wide">
      <div class="row no-print">
        <a href={appRoute.home}>← {t('home', locale)}</a>
        <LanguageToggle />
      </div>
      <h1 class="no-print">{t('salesHistory', locale)}</h1>
      {error && (
        <p role="alert" class="alert no-print">
          {error}
        </p>
      )}
      {message && (
        <p role="status" class="success no-print">
          {message}
        </p>
      )}
      <section class="card no-print" aria-label="Day reconciliation">
        <div class="row">
          <div>
            <h2>Day reconciliation</h2>
            <p class="muted">
              Use this at shop close to compare DSB Pro with legacy DSB for the same business date.
            </p>
          </div>
        </div>
        <div class="row">
          <label>
            Business date{' '}
            <input
              aria-label="Reconciliation business date"
              type="date"
              value={reportDate}
              onInput={(e) => setReportDate((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <button
            type="button"
            disabled={reportBusy || !shopId || !reportDate}
            onClick={() => void refreshReport()}
          >
            {reportBusy ? 'Refreshing…' : 'Refresh totals'}
          </button>
        </div>
        {report && (
          <div data-testid="day-reconciliation-summary">
            <div class="table-wrap">
              <table>
                <tbody>
                  <tr>
                    <th>Finalized invoices</th>
                    <td>{report.invoiceCount}</td>
                  </tr>
                  <tr>
                    <th>Sales total</th>
                    <td>{money(report.salesTotalPaise)}</td>
                  </tr>
                  <tr>
                    <th>Sale returns</th>
                    <td>
                      {report.saleReturnCount} · −{money(report.saleReturnTotalPaise)}
                    </td>
                  </tr>
                  <tr>
                    <th>Net sales</th>
                    <td>{money(report.netSalesTotalPaise)}</td>
                  </tr>
                  <tr>
                    <th>Cash refunded</th>
                    <td>−{money(report.cashRefundPaise)}</td>
                  </tr>
                  <tr>
                    <th>Discounts</th>
                    <td>{money(report.discountPaise)}</td>
                  </tr>
                  <tr>
                    <th>Extra charges</th>
                    <td>{money(report.extraChargesPaise)}</td>
                  </tr>
                  <tr>
                    <th>Direct sale receipts</th>
                    <td>{money(report.directSaleReceiptsPaise)}</td>
                  </tr>
                  <tr>
                    <th>Credit created on sales</th>
                    <td>{money(report.creditCreatedPaise)}</td>
                  </tr>
                  <tr>
                    <th>Standalone customer receipts</th>
                    <td>{money(report.standaloneCustomerReceiptsPaise)}</td>
                  </tr>
                  <tr>
                    <th>Customer advance created today</th>
                    <td>{money(report.standaloneAdvancePaise)}</td>
                  </tr>
                  <tr>
                    <th>All customer receipts</th>
                    <td>{money(report.allCustomerReceiptsPaise)}</td>
                  </tr>
                  <tr>
                    <th>Voided invoices</th>
                    <td>
                      {report.voidCount} · {money(report.voidedTotalPaise)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h3>Payment modes</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Cash</th>
                    <th>UPI</th>
                    <th>Card</th>
                    <th>Bank</th>
                    <th>Other</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{money(report.paymentModes.cash)}</td>
                    <td>{money(report.paymentModes.upi)}</td>
                    <td>{money(report.paymentModes.card)}</td>
                    <td>{money(report.paymentModes.bank)}</td>
                    <td>{money(report.paymentModes.other)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              <strong>Current customer outstanding:</strong>{' '}
              {money(report.currentCustomerOutstandingPaise)} ·{' '}
              <strong>Current customer advance:</strong> {money(report.currentCustomerAdvancePaise)}
            </p>
            <h3>Items sold on {report.businessDate}</h3>
            {report.soldItems.length ? (
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Sold</th>
                      <th>Current stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.soldItems.map((i) => (
                      <tr>
                        <td>{i.name}</td>
                        <td>
                          {i.soldQtySmallest} {i.smallestUnit}
                        </td>
                        <td>
                          {i.currentStockSmallest} {i.smallestUnit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No finalized sale items for this date.</p>
            )}
            <hr />
            <h3>Compare with old DSB backup</h3>
            <p class="muted">
              At shop closing, export a fresh JSON backup from old DSB and choose it here. The file
              is read in this browser; it is not uploaded to GitHub.
            </p>
            <input
              aria-label="Choose closing DSB backup JSON"
              type="file"
              accept=".json,application/json"
              onChange={compareLegacyBackup}
            />
            {legacyComparison && (
              <div class="card" aria-label="Legacy DSB comparison result">
                <p>
                  <strong>{legacyCompareFile}</strong>
                  <br />
                  Old DSB exported at{' '}
                  {new Date(legacyComparison.legacy.exportedAt).toLocaleString()}.
                </p>
                <p role="status" class={legacyComparison.exactMatch ? 'success' : 'alert'}>
                  <strong>
                    {legacyComparison.exactMatch
                      ? 'MATCH — Phase 4 day totals reconcile'
                      : 'MISMATCH — review the rows below'}
                  </strong>
                </p>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th>Old DSB</th>
                        <th>DSB Pro</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {legacyComparison.rows.map((row) => (
                        <tr>
                          <td>{row.label}</td>
                          <td>
                            {row.legacy === null
                              ? 'Unknown — verify payout'
                              : row.kind === 'paise'
                                ? money(row.legacy)
                                : row.legacy}
                          </td>
                          <td>{row.kind === 'paise' ? money(row.dsbPro) : row.dsbPro}</td>
                          <td>
                            <strong>
                              {row.legacy === null
                                ? 'REVIEW REQUIRED'
                                : row.match
                                  ? 'MATCH'
                                  : 'MISMATCH'}
                            </strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {legacyComparison.legacy.returnCreditPaise > 0 && (
                  <p>
                    Old DSB sale-return credit: {money(legacyComparison.legacy.returnCreditPaise)}.
                    It is compared with DSB Pro returns and netted from cash.
                  </p>
                )}
                {legacyComparison.legacy.warnings.length > 0 && (
                  <details>
                    <summary>
                      Comparison warnings ({legacyComparison.legacy.warnings.length})
                    </summary>
                    <ul>
                      {legacyComparison.legacy.warnings.map((w) => (
                        <li>{w}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {viewing && (
        <section class="card no-print" aria-label="Invoice detail">
          <div class="row">
            <h2>Invoice {viewing.invoice.doc_no}</h2>
            <ShareImageButton
              build={async () => {
                const c = customerOf(viewing.invoice.customer_id);
                const prof = await loadShopProfile(shopId);
                return saleInvoiceDoc(
                  viewing,
                  prof.profile,
                  c ? { name: c.name, phone: c.phone } : null,
                );
              }}
            />
            <button type="button" onClick={() => setViewing(null)}>
              Close detail
            </button>
          </div>
          <p>
            {viewing.invoice.business_date} · {viewing.invoice.status} ·{' '}
            {customerOf(viewing.invoice.customer_id)?.name ?? 'Walk-in customer'}
          </p>
          <BillCodeChip code={viewing.invoice.bill_code} />
          <div class="record-list">
            {viewing.lines.map((l, i) => (
              <div class="purchase-line" key={i}>
                <span>
                  <strong>{l.item_name_snapshot}</strong>
                  <small>
                    {formatQuantity(l.qty)} {l.unit_name_snapshot} × {money(l.unit_price_paise)}
                  </small>
                </span>
                <strong>{money(l.line_total_paise - (l.tax_paise ?? 0))}</strong>
              </div>
            ))}
          </div>
          <p>
            <strong>Total {money(viewing.invoice.total_paise)}</strong>
          </p>
          {me && shopId && (
            <RemarkBox
              shopId={shopId}
              docKind="sale"
              docId={viewing.invoice.id}
              userId={me.userId}
              role={me.role}
              onLoaded={(list) => {
                const id = viewing.invoice.id;
                const has = list.some((r) => r.status === 'OPEN');
                setPending((old) => {
                  if (!old || old.has(id) === has) return old;
                  const next = new Set(old);
                  if (has) next.add(id);
                  else next.delete(id);
                  return next;
                });
              }}
            />
          )}
        </section>
      )}

      <section class="card no-print">
        <label class="inline-check">
          <input
            type="checkbox"
            checked={onlyPending}
            onChange={(e) => setOnlyPending(e.currentTarget.checked)}
          />{' '}
          Only invoices with pending items
        </label>{' '}
        <label class="inline-check">
          <input
            type="checkbox"
            checked={showVoided}
            onChange={(e) => {
              voidedTouched.current = true;
              setShowVoided(e.currentTarget.checked);
              saveShowVoided('sales', me?.userId ?? '', e.currentTarget.checked);
            }}
          />{' '}
          Show voided
        </label>
        <label class="search-field">
          Find an invoice
          <input
            value={findText}
            placeholder="Invoice no. or bill code"
            onInput={(e) => setFindText(e.currentTarget.value)}
          />
        </label>
        <p class="muted" data-testid="sales-list-count">
          Showing {listed.length} of {sales.length} loaded items.{hiddenNote(hiddenVoided)}
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>Status</th>
                <th>Total</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((s) => (
                <tr>
                  <td>
                    {s.doc_no}
                    {s.bill_code && <small class="muted"> · {s.bill_code}</small>}
                  </td>
                  <td>{s.business_date}</td>
                  <td>
                    {s.status}
                    {pending?.has(s.id) && (
                      <>
                        {' '}
                        <span class="badge remark-open" data-testid="sale-pending">
                          Pending
                        </span>
                      </>
                    )}
                  </td>
                  <td>{money(s.total_paise)}</td>
                  <td>
                    <div class="row">
                      <button disabled={busy} onClick={() => void viewSale(s.id)}>
                        View
                      </button>
                      <button disabled={busy} onClick={() => void openReceipt(s, 'thermal')}>
                        {t('printThermal', locale)}
                      </button>
                      <button disabled={busy} onClick={() => void openReceipt(s, 'a4')}>
                        {t('printA4', locale)}
                      </button>
                      {s.status === 'FINALIZED' && (
                        <button disabled={busy} onClick={() => void doVoid(s)}>
                          {t('voidSale', locale)}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {receipt && <SaleReceiptPrint receipt={receipt} profile={profile} printMode={printMode} />}
    </main>
  );
}
