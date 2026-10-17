import { useState } from 'preact/hooks';
import type { Party } from '@dsb-pro/adapters';
import { buildQuickBillDraft } from '../lib/quickBill';
import { savePurchaseDraft, scanPurchaseDrafts } from '../lib/purchaseDraft';

// P06 quick bill: note a paper bill's supplier, number, date and total now; add its items later. It saves an
// unposted draft only. Nothing reaches the supplier balance or stock until the itemized bill is posted.
export function QuickBillEntry({
  parties,
  today,
  draftPrefix,
  disabled,
  onSaved,
}: {
  parties: Party[];
  today: string;
  draftPrefix: string;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [supplierId, setSupplierId] = useState('');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(today);
  const [total, setTotal] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [writer] = useState(() => crypto.randomUUID());

  function save() {
    setMessage('');
    let existing: Array<{ supplier: string; billNo: string }>;
    try {
      existing = scanPurchaseDrafts(draftPrefix).drafts.map((d) => ({
        supplier: d.draft.supplier,
        billNo: d.draft.billNo,
      }));
    } catch (e) {
      setErrors([`Saved drafts could not be checked: ${String(e)}. Nothing was saved.`]);
      return;
    }
    const result = buildQuickBillDraft({ supplierId, billNo, date, total }, parties, {
      now: Date.now(),
      newId: () => crypto.randomUUID(),
      today,
      existing,
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    try {
      savePurchaseDraft(draftPrefix, writer, result.draft);
    } catch (e) {
      setErrors([`The quick bill could not be saved: ${String(e)}.`]);
      return;
    }
    setErrors([]);
    setBillNo('');
    setTotal('');
    setMessage(
      'Quick bill saved as a draft. Nothing is posted yet: open it from “Saved purchase drafts”, add its items, then post.',
    );
    onSaved();
  }

  return (
    <details class="card" aria-label="Quick bill">
      <summary>Quick bill (total now, items later)</summary>
      <p class="muted">
        Saves the paper bill as a draft. The supplier balance and stock change only when you add the
        items and post it; posting warns if the items do not match this total.
      </p>
      <label>
        Supplier
        <select
          aria-label="Quick bill supplier"
          value={supplierId}
          onChange={(e) => setSupplierId(e.currentTarget.value)}
        >
          <option value="">Choose…</option>
          {parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        Bill no.
        <input
          aria-label="Quick bill number"
          value={billNo}
          onInput={(e) => setBillNo(e.currentTarget.value)}
        />
      </label>{' '}
      <label>
        Date
        <input
          type="date"
          aria-label="Quick bill date"
          value={date}
          max={today}
          onInput={(e) => setDate(e.currentTarget.value)}
        />
      </label>{' '}
      <label>
        Bill total ₹
        <input
          aria-label="Quick bill total"
          inputMode="decimal"
          value={total}
          onInput={(e) => setTotal(e.currentTarget.value)}
        />
      </label>{' '}
      <button type="button" disabled={disabled} onClick={save}>
        Save quick bill
      </button>
      {errors.map((m) => (
        <p key={m} class="alert" role="alert">
          {m}
        </p>
      ))}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
