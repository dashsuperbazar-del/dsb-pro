import { useEffect, useRef, useState } from 'preact/hooks';
import { getPurchaseReturnRoundOffs, getShopSettings, getSupplierLedger } from '@dsb-pro/adapters';
import { roundOffLabel, rupees } from '../lib/money';
import {
  prepareSupplierStatement,
  statementCsv,
  statementKind,
  statementPeriod,
  statementText,
  validStatementDates,
  STATEMENT_NOTE,
  type SupplierStatement as Statement,
} from '../lib/supplierStatement';

export function SupplierStatement({
  shopId,
  partyId,
  supplierName,
  businessDate,
}: {
  shopId: string;
  partyId: string;
  supplierName: string;
  businessDate: string;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(businessDate);
  const [prepared, setPrepared] = useState<Statement | null>(null);
  // Round off of each purchase return in the prepared statement (display only; the server amount already
  // includes it). Keyed to that statement, so a newer one never shows an older one's notes.
  const [roundOffs, setRoundOffs] = useState<{
    of: Statement;
    byId: Record<string, string>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [manualText, setManualText] = useState(false);
  const generation = useRef(0);
  const scopeKey = `${shopId}:${partyId}:${supplierName}:${from}:${to}`;
  const current = useRef(scopeKey);
  current.current = scopeKey;
  const statement =
    prepared &&
    prepared.shopId === shopId &&
    prepared.partyId === partyId &&
    prepared.supplierName === supplierName &&
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
        getSupplierLedger(shopId, partyId, from || null, to),
        getShopSettings(shopId),
      ]);
      if (request !== generation.current || current.current !== key) return;
      const next = prepareSupplierStatement(
        ledger,
        { shopId, partyId, from: from || null, to },
        profile,
        supplierName,
        new Date().toISOString(),
      );
      setPrepared(next);
      const returnIds = next.entries.filter((e) => e.kind === 'PURCHASE_RETURN').map((e) => e.id);
      if (returnIds.length)
        void getPurchaseReturnRoundOffs(shopId, returnIds)
          .then((byId) => setRoundOffs({ of: next, byId }))
          .catch(() => {
            /* only a note: the statement amounts are exact without it */
          });
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
  }, [shopId, partyId, supplierName]);

  const notesFor = (s: Statement) => (roundOffs?.of === s ? roundOffs.byId : {});
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
    a.download = `supplier-statement-${statement.partyId}-${statement.from ?? 'all'}-${statement.to}.${kind}`;
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
          title: `Supplier statement: ${statement.supplierName}`,
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
    <section aria-label="Supplier statement" class="supplier-statement">
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
        <div aria-label="Prepared supplier statement" class="mobile-records">
          <h3>
            {statement.shopName} · {statement.supplierName}
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
          <StatementTable statement={statement} roundOffs={notesFor(statement)} />
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
          class="receipt-print receipt-a4 supplier-statement-print"
          aria-label="Printable supplier statement"
        >
          <h1>{statement.shopName}</h1>
          {statement.address && <p>{statement.address}</p>}
          {statement.gstin && <p>GSTIN {statement.gstin}</p>}
          <h2>Supplier statement: {statement.supplierName}</h2>
          <p>
            Period: {statementPeriod(statement)}
            <br />
            Retrieved UTC: {statement.retrievedAt}
          </p>
          <p>{STATEMENT_NOTE}</p>
          <p>Opening: {rupees(statement.openingBalancePaise)}</p>
          <StatementTable statement={statement} roundOffs={notesFor(statement)} />
          {statement.entries.length === 0 && <p>No posted entries in this period.</p>}
          <p>
            <strong>Closing: {rupees(statement.closingBalancePaise)}</strong>
          </p>
          <footer>
            Shop ID: {statement.shopId}
            <br />
            Supplier ID: {statement.partyId}
          </footer>
        </section>
      )}
    </section>
  );
}

function StatementTable({
  statement,
  roundOffs,
}: {
  statement: Statement;
  roundOffs: Record<string, string>;
}) {
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
            <td data-label="Document">
              {e.document}
              {e.kind === 'PURCHASE_RETURN' && roundOffLabel(roundOffs[e.id]) && (
                <small class="muted"> · {roundOffLabel(roundOffs[e.id])} (included)</small>
              )}
            </td>
            <td data-label="Change">{rupees(e.amountPaise)}</td>
            <td data-label="Balance">{rupees(e.runningBalancePaise)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
