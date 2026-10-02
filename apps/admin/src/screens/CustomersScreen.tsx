import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { withAccountLock } from '../lib/accountLock';
import {
  createCustomer,
  getCurrentMembership,
  getDefaultShopId,
  getShopBusinessDate,
  listCustomerBalances,
  listCustomerLedger,
  listCustomerOutstandingInvoices,
  listCustomers,
  recordCustomerPaymentV2,
  lookupFinancialRequest,
  type FinancialOperation,
  type SupplierWriteOutcome,
  voidPayment,
  type Customer,
  type CustomerLedgerRow,
  type CustomerOutstandingInvoice,
} from '@dsb-pro/adapters';
import { appRoute } from '../lib/paths';
import {
  listOpenFinancialAttempts,
  newFinancialDraft,
  reconcileFinancialAttempt,
  sendFinancialAttempt,
  waitForOfflineRuntime,
  type FinancialAttempt,
} from '../lib/offlineSync';

type ReceiptPayload = {
  shopId: string;
  customerId: string;
  businessDate: string;
  amountPaise: string;
  mode: 'cash' | 'upi' | 'card' | 'bank' | 'other';
  reference: string | null;
  allocations: { saleInvoiceId: string; amountPaise: string }[];
};
// The attempt id is the request id: a lost answer is reconciled, never re-recorded under a new id.
const sendReceipt = (a: FinancialAttempt): Promise<SupplierWriteOutcome> =>
  recordCustomerPaymentV2({ requestId: a.id, ...(a.payload as ReceiptPayload) });
const lookupReceipt = (a: FinancialAttempt) =>
  lookupFinancialRequest(a.shopId, a.operation as FinancialOperation, a.id);
import { parseRupeesToPaise } from '@dsb-pro/core';

const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const toPaise = (rupees: string) => parseRupeesToPaise(rupees || '0');

type AllocationDraft = { saleId: string; docNo: string; checked: boolean; amount: string };

export function CustomersScreen() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState('');
  // The customer the screen shows right now. An action that finishes after the user switched customer
  // must never repaint or act on the old customer (V003 VF-007): every refresh and ledger action is
  // checked against this, not against the `selected` captured when the action started.
  const selectedRef = useRef('');
  const selectCustomer = (id: string) => {
    selectedRef.current = id;
    setSelected(id);
  };
  const [ledger, setLedger] = useState<CustomerLedgerRow[]>([]);
  const [openSales, setOpenSales] = useState<CustomerOutstandingInvoice[]>([]);
  const [allocations, setAllocations] = useState<AllocationDraft[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [shopId, setShopId] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'bank' | 'other'>('cash');
  const [reference, setReference] = useState('');
  const [openAttempts, setOpenAttempts] = useState<FinancialAttempt[]>([]);
  // Account-specific data (ledger, invoices, the unresolved-receipt guard) belongs to one
  // (shop, customer) load. Receiving is disabled until that load finishes, and late answers for a
  // previous selection are discarded (V002 VF-007).
  const [readyFor, setReadyFor] = useState('');
  const loadGeneration = useRef(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function refreshBase() {
    const membership = await getCurrentMembership();
    if (!membership) throw new Error('No tenant membership.');
    const shop = await getDefaultShopId();
    const [c, b, d] = await Promise.all([
      listCustomers(),
      listCustomerBalances(),
      getShopBusinessDate(shop),
    ]);
    setTenantId(membership.tenantId);
    setShopId(shop);
    setCustomers(c);
    setBalances(Object.fromEntries(b.map((x) => [x.customer_id, x.balance_paise])));
    setBusinessDate(d);
  }
  async function refreshCustomer(customerId = selectedRef.current, shop = shopId) {
    if (customerId !== selectedRef.current) return; // a stale action's refresh: the screen moved on
    const generation = ++loadGeneration.current;
    setReadyFor('');
    setLedger([]);
    setOpenSales([]);
    setAllocations([]);
    setOpenAttempts([]);
    if (!customerId || !shop) return;
    const [l, s] = await Promise.all([
      listCustomerLedger(customerId),
      listCustomerOutstandingInvoices(customerId),
    ]);
    await waitForOfflineRuntime();
    const attempts = await listOpenFinancialAttempts(shop, customerId);
    if (generation !== loadGeneration.current || customerId !== selectedRef.current) return;
    setOpenAttempts(attempts);
    setLedger(l);
    setOpenSales(s);
    setAllocations(
      s.map((x) => ({ saleId: x.sale_invoice_id, docNo: x.doc_no, checked: false, amount: '' })),
    );
    setReadyFor(`${shop}:${customerId}`);
  }
  useEffect(() => {
    void refreshBase().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    void refreshCustomer(selectedRef.current, shopId).catch((e) =>
      setError(`Could not load this customer (${String(e)}). Choose the customer again to retry.`),
    );
  }, [selected, shopId]);
  const allocated = useMemo(
    () => allocations.filter((a) => a.checked).reduce((sum, a) => sum + toPaise(a.amount), 0),
    [allocations],
  );

  async function addCustomer(ev: Event) {
    ev.preventDefault();
    setError('');
    if (!tenantId) {
      setError('Shop data is still loading.');
      return;
    }
    const form = ev.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    try {
      const c = await createCustomer({
        tenantId,
        name: String(f.get('name')),
        phone: String(f.get('phone') || '') || undefined,
        address: String(f.get('address') || '') || undefined,
        clientId: crypto.randomUUID(),
      });
      await refreshBase();
      selectCustomer(c.id);
      form.reset();
      setMessage(`Customer ${c.name} created.`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function receive(ev: Event) {
    ev.preventDefault();
    if (busy || !selected) return;
    if (readyFor !== `${shopId}:${selected}`) {
      setError('This customer is still loading. Try again in a moment.');
      return;
    }
    if (openAttempts.length) {
      setError('Resolve the receipt awaiting server confirmation first (Check status below).');
      return;
    }
    if (!shopId || !businessDate) {
      setError('Shop data is still loading.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const paymentPaise = toPaise(amount);
      if (paymentPaise <= 0) throw new Error('Payment must be greater than zero.');
      if (allocated > paymentPaise)
        throw new Error('Selected allocations exceed the payment amount.');
      for (const draft of allocations.filter((a) => a.checked)) {
        const invoice = openSales.find((s) => s.sale_invoice_id === draft.saleId);
        if (invoice && toPaise(draft.amount) > invoice.outstanding_paise)
          throw new Error(`Allocation for ${draft.docNo} exceeds its outstanding amount.`);
      }
      const payload: ReceiptPayload = {
        shopId,
        customerId: selected,
        businessDate,
        amountPaise: String(paymentPaise),
        mode,
        reference: reference || null,
        allocations: allocations
          .filter((a) => a.checked && toPaise(a.amount) > 0)
          .map((a) => ({ saleInvoiceId: a.saleId, amountPaise: String(toPaise(a.amount)) })),
      };
      await waitForOfflineRuntime();
      // Recheck the durable store for THIS account right before creating a new request: an
      // unresolved earlier receipt must be settled first, never bypassed by a fresh id.
      // Held across windows from the check until the send settles.
      const result = await withAccountLock(shopId, selected, async () => {
        const unresolved = await listOpenFinancialAttempts(shopId, selected);
        if (unresolved.length) {
          setOpenAttempts(unresolved);
          throw new Error(
            'Resolve the receipt awaiting server confirmation first (Check status below).',
          );
        }
        const draft = await newFinancialDraft({
          operation: 'record_customer_payment_v2',
          shopId,
          accountId: selected,
          payload,
        });
        return sendFinancialAttempt(draft.id, sendReceipt);
      });
      if (result.state === 'UNKNOWN') {
        setError(
          'The server answer was lost. Do NOT record this payment again — use “Check status”.',
        );
        await refreshCustomer();
        return;
      }
      if (result.state === 'REJECTED')
        throw new Error(`Not recorded: ${result.errorMessage ?? result.errorCode}`);
      setAmount('');
      setReference('');
      setMessage('Payment recorded. Any unallocated remainder is retained as customer advance.');
      await refreshBase();
      await refreshCustomer();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function checkAttempt(a: FinancialAttempt) {
    setBusy(true);
    setError('');
    try {
      let r = await reconcileFinancialAttempt(a.id, lookupReceipt);
      // Not found on the server: the same request id and payload may be sent again.
      if (r.state === 'READY') r = await sendFinancialAttempt(r.id, sendReceipt);
      if (r.state === 'COMMITTED') setMessage('Receipt confirmed by the server.');
      else if (r.state === 'REJECTED') setError(`Not recorded: ${r.errorMessage ?? r.errorCode}`);
      else setError(`Still unknown: ${r.errorMessage ?? 'no answer'}. Try again when online.`);
      await refreshBase();
      await refreshCustomer();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function voidLedgerPayment(row: CustomerLedgerRow) {
    if (row.entry_type !== 'PAYMENT') return;
    // Only a row of the customer on screen, loaded for that customer, can be voided.
    if (
      row.customer_id !== selectedRef.current ||
      readyFor !== `${shopId}:${selectedRef.current}`
    ) {
      setError('This ledger is not loaded for the selected customer. Choose the customer again.');
      return;
    }
    if (
      !confirm(
        'Void this payment? The ledger entry will remain in history as a voided financial record.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await voidPayment(row.ref_id);
      setMessage('Payment voided.');
      await refreshBase();
      await refreshCustomer();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const customer = customers.find((c) => c.id === selected);
  return (
    <main class="page wide">
      <p>
        <a href={appRoute.home}>← Home</a>
      </p>
      <h1>Customers & ledger</h1>
      {error && (
        <p role="alert" class="alert">
          {error}
        </p>
      )}
      {message && (
        <p role="status" class="success">
          {message}
        </p>
      )}
      <section class="card">
        <h2>Customer master</h2>
        <form onSubmit={addCustomer} class="grid-form">
          <label>
            Name
            <input name="name" required />
          </label>
          <label>
            Phone
            <input name="phone" />
          </label>
          <label>
            Address
            <input name="address" />
          </label>
          <button disabled={!tenantId}>Create customer</button>
        </form>
        <label>
          Customer
          <select
            value={selected}
            onChange={(e) => selectCustomer((e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">Choose…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {customer && (
          <p>
            <strong>{customer.name}</strong> · Balance {money(balances[customer.id] ?? 0)}{' '}
            <small>(positive = customer owes; negative = advance)</small>
          </p>
        )}
      </section>

      {selected && (
        <section class="card">
          <h2>Receive payment / allocate invoices</h2>
          {openAttempts.length > 0 && (
            <div class="alert" role="alert" aria-label="Unresolved receipts">
              <p>Receipt awaiting server confirmation. Do not record it again.</p>
              <ul>
                {openAttempts.map((a) => (
                  <li key={a.id}>
                    ₹{(Number((a.payload as ReceiptPayload).amountPaise) / 100).toFixed(2)} ·{' '}
                    {a.state}{' '}
                    <button type="button" disabled={busy} onClick={() => void checkAttempt(a)}>
                      Check status
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form onSubmit={receive}>
            <div class="grid-form">
              <label>
                Business date
                <input
                  type="date"
                  value={businessDate}
                  onInput={(e) => setBusinessDate((e.currentTarget as HTMLInputElement).value)}
                  required
                />
              </label>
              <label>
                Amount ₹
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onInput={(e) => setAmount((e.currentTarget as HTMLInputElement).value)}
                  required
                />
              </label>
              <label>
                Mode
                <select
                  value={mode}
                  onChange={(e) =>
                    setMode((e.currentTarget as HTMLSelectElement).value as typeof mode)
                  }
                >
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                  <option value="bank">Bank</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                Reference
                <input
                  value={reference}
                  onInput={(e) => setReference((e.currentTarget as HTMLInputElement).value)}
                />
              </label>
            </div>
            <h3>Invoice allocation</h3>
            {!openSales.length ? (
              <p class="muted">No outstanding customer invoices.</p>
            ) : (
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Select</th>
                      <th>Invoice</th>
                      <th>Date</th>
                      <th>Total</th>
                      <th>Outstanding</th>
                      <th>Allocate ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openSales.map((s) => {
                      const a = allocations.find((x) => x.saleId === s.sale_invoice_id);
                      return (
                        <tr>
                          <td>
                            <input
                              aria-label={`Allocate ${s.doc_no}`}
                              type="checkbox"
                              checked={a?.checked ?? false}
                              onChange={(e) =>
                                setAllocations((v) =>
                                  v.map((x) =>
                                    x.saleId === s.sale_invoice_id
                                      ? {
                                          ...x,
                                          checked: (e.currentTarget as HTMLInputElement).checked,
                                        }
                                      : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td>{s.doc_no}</td>
                          <td>{s.business_date}</td>
                          <td>{money(s.total_paise)}</td>
                          <td>{money(s.outstanding_paise)}</td>
                          <td>
                            <input
                              aria-label={`Amount for ${s.doc_no}`}
                              type="number"
                              min="0"
                              max={(s.outstanding_paise / 100).toFixed(2)}
                              step="0.01"
                              disabled={!a?.checked}
                              value={a?.amount ?? ''}
                              onInput={(e) =>
                                setAllocations((v) =>
                                  v.map((x) =>
                                    x.saleId === s.sale_invoice_id
                                      ? {
                                          ...x,
                                          amount: (e.currentTarget as HTMLInputElement).value,
                                        }
                                      : x,
                                  ),
                                )
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p>
              Allocated {money(allocated)} · Unallocated advance{' '}
              {money(Math.max(0, toPaise(amount) - allocated))}
            </p>
            <button
              class="primary"
              disabled={
                busy ||
                !shopId ||
                !businessDate ||
                readyFor !== `${shopId}:${selected}` ||
                openAttempts.length > 0
              }
            >
              {busy
                ? 'Saving…'
                : readyFor !== `${shopId}:${selected}`
                  ? 'Loading…'
                  : 'Record payment'}
            </button>
          </form>
        </section>
      )}

      {selected && (
        <section class="card">
          <h2>Customer ledger</h2>
          {!ledger.length ? (
            <p class="muted">No ledger entries.</p>
          ) : (
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Reference</th>
                    <th>Debit</th>
                    <th>Credit</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((r) => (
                    <tr>
                      <td>{r.business_date}</td>
                      <td>{r.entry_type}</td>
                      <td>{r.reference}</td>
                      <td>{r.debit_paise ? money(r.debit_paise) : '—'}</td>
                      <td>{r.credit_paise ? money(r.credit_paise) : '—'}</td>
                      <td>
                        {r.entry_type === 'PAYMENT' && (
                          <button
                            type="button"
                            disabled={
                              busy ||
                              readyFor !== `${shopId}:${selected}` ||
                              r.customer_id !== selected
                            }
                            onClick={() => void voidLedgerPayment(r)}
                          >
                            Void payment
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
