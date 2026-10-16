import { useEffect, useRef, useState } from 'preact/hooks';
import { getShopSettings, readCustomerLedgerForStatement } from '@dsb-pro/adapters';
import { rupees } from '../lib/money';
import { validStatementDates } from '../lib/supplierStatement';
import {
  prepareCustomerStatement,
  customerStatementCsv as statementCsv,
  customerEntryKind as statementKind,
  customerStatementPeriod as statementPeriod,
  customerStatementText as statementText,
  CUSTOMER_STATEMENT_NOTE as STATEMENT_NOTE,
  type CustomerStatement as Statement,
} from '../lib/customerStatement';

export function CustomerStatement({
  shopId,
  customerId,
  customerName,
  businessDate,
}: {
  shopId: string;
  customerId: string;
  customerName: string;
  businessDate: string;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(businessDate);
  const [prepared, setPrepared] = useState<Statement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [manualText, setManualText] = useState(false);
  const generation = useRef(0);
  const scopeKey = `${shopId}:${customerId}:${customerName}:${from}:${to}`;
  const current = useRef(scopeKey);
  current.current = scopeKey;
  const statement =
    prepared &&
    prepared.shopId === shopId &&
    prepared.customerId === customerId &&
    prepared.customerName === customerName &&
    prepared.from === (from || null) &&
    prepared.to === to
      ? prepared
      : null;

  async function prepare() {
    const key = current.current;
    const request = ++generation.current;
    setPrepared(null);
    setError('');
    setMessage('');
    setManualText(false);
    if (!validStatementDates(from || null, to)) {
      setError('Choose valid dates with From no later than Through.');
      return;
    }
    setBusy(true);
    try {
      const [ledger, profile] = await Promise.all([
        readCustomerLedgerForStatement(customerId),
        getShopSettings(shopId),
      ]);
      if (request !== generation.current || current.current !== key) return;
      setPrepared(
        prepareCustomerStatement(
          ledger.rows,
          ledger.balancePaise,
          { shopId, customerId, from: from || null, to },
          profile,
          customerName,
          new Date().toISOString(),
        ),
      );
    } catch (e) {
      if (request === generation.current && current.current === key) setError(String(e));
    } finally {
      if (request === generation.current && current.current === key) setBusy(false);
    }
  }
  useEffect(() => {
    void prepare();
    return () => {
      ++generation.current;
    };
  }, [shopId, customerId, customerName]);

  function changeDate(which: 'from' | 'to', value: string) {
    ++generation.current;
    setPrepared(null);
    setBusy(false);
    setError('');
    setMessage('');
    setManualText(false);
    if (which === 'from') setFrom(value);
    else setTo(value);
  }
  function download(kind: 'csv' | 'txt') {
    if (!statement) return;
    const url = URL.createObjectURL(
      new Blob(['\uFEFF', kind === 'csv' ? statementCsv(statement) : statementText(statement)], {
        type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `customer-statement-${statement.customerId}-${statement.from ?? 'all'}-${statement.to}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function share() {
    if (!statement) return;
    const key = current.current;
    setError('');
    setMessage('');
    try {
      if (typeof navigator.share === 'function')
        await navigator.share({
          title: `Customer statement: ${statement.customerName}`,
          text: statementText(statement),
        });
      else {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.');
        await navigator.clipboard.writeText(statementText(statement));
        if (current.current === key) setMessage('Statement text copied.');
      }
    } catch (e) {
      if (current.current !== key || (e as { name?: string }).name === 'AbortError') return;
      setManualText(true);
      setError(
        'Sharing or copying is unavailable. Download text or select the statement text below.',
      );
    }
  }
  function print() {
    if (!statement) return;
    try {
      window.print();
    } catch {
      setError(
        'Printing is unavailable in this browser. Download the statement or use a browser with printing.',
      );
    }
  }
  return (
    <section aria-label="Customer statement" class="customer-statement">
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void prepare();
        }}
      >
        <label>
          Statement from
          <input
            type="date"
            value={from}
            onInput={(e) => changeDate('from', e.currentTarget.value)}
          />
        </label>
        <label>
          Statement through
          <input
            required
            type="date"
            value={to}
            onInput={(e) => changeDate('to', e.currentTarget.value)}
          />
        </label>
        <button disabled={busy} type="submit">
          {busy ? 'Preparing statement…' : 'Prepare statement'}
        </button>
      </form>
      <p class="muted">Leave From empty for all recorded history. {STATEMENT_NOTE}</p>
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
      <div class="row">
        <button disabled={!statement} onClick={() => void share()}>
          {typeof navigator.share === 'function' ? 'Share text' : 'Copy text'}
        </button>
        <button disabled={!statement} onClick={() => download('txt')}>
          Download text
        </button>
        <button disabled={!statement} onClick={() => download('csv')}>
          Download CSV
        </button>
        <button disabled={!statement} onClick={print}>
          Print A4 / PDF
        </button>
      </div>
      {statement && (
        <div aria-label="Prepared customer statement" class="mobile-records">
          <h3>
            {statement.shopName} · {statement.customerName}
          </h3>
          {statement.address && <p>{statement.address}</p>}
          {statement.gstin && <p>GSTIN {statement.gstin}</p>}
          <p>
            {statementPeriod(statement)} · Retrieved UTC {statement.retrievedAt}
          </p>
          <p>
            Opening {rupees(statement.openingBalancePaise)} · Closing{' '}
            {rupees(statement.closingBalancePaise)}
          </p>
          {statement.entries.length === 0 && <p>No posted entries in this period.</p>}
          <StatementTable statement={statement} />
          {manualText && (
            <label>
              Statement text
              <textarea
                readOnly
                rows={10}
                value={statementText(statement)}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
          )}
        </div>
      )}
      {statement && (
        <section
          class="receipt-print receipt-a4 customer-statement-print"
          aria-label="Printable customer statement"
        >
          <h1>{statement.shopName}</h1>
          {statement.address && <p>{statement.address}</p>}
          {statement.gstin && <p>GSTIN {statement.gstin}</p>}
          <h2>Customer statement: {statement.customerName}</h2>
          <p>
            Period: {statementPeriod(statement)}
            <br />
            Retrieved UTC: {statement.retrievedAt}
          </p>
          <p>{STATEMENT_NOTE}</p>
          <p>Opening: {rupees(statement.openingBalancePaise)}</p>
          <StatementTable statement={statement} />
          {statement.entries.length === 0 && <p>No posted entries in this period.</p>}
          <p>
            <strong>Closing: {rupees(statement.closingBalancePaise)}</strong>
          </p>
          <footer>
            Shop ID: {statement.shopId}
            <br />
            Customer ID: {statement.customerId}
          </footer>
        </section>
      )}
    </section>
  );
}

function StatementTable({ statement }: { statement: Statement }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Entry</th>
          <th>Document</th>
          <th>Change</th>
          <th>Balance</th>
        </tr>
      </thead>
      <tbody>
        {statement.entries.map((e) => (
          <tr key={`${e.kind}:${e.id}`}>
            <td data-label="Date">{e.date}</td>
            <td data-label="Entry">{statementKind(e.kind)}</td>
            <td data-label="Document">{e.document}</td>
            <td data-label="Change">{rupees(e.amountPaise)}</td>
            <td data-label="Balance">{rupees(e.runningBalancePaise)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
