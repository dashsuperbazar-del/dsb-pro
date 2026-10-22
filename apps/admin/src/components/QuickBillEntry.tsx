import { useEffect, useState } from 'preact/hooks';
import type { BillDocument, Party } from '@dsb-pro/adapters';
import { buildQuickBillDraft } from '../lib/quickBill';
import { savePurchaseDraft, scanPurchaseDrafts } from '../lib/purchaseDraft';
import { BillAttachmentEditor } from './BillAttachmentEditor';
import { removeLocalDocument } from '../lib/billDocumentStore';
import { DISCARD_PROMPT, useDirtyGuard } from '../lib/dirtyGuard';

// P06 quick bill: note a paper bill's supplier, number, date and total now; add its items later. It saves an
// unposted draft only. Nothing reaches the supplier balance or stock until the itemized bill is posted.
export function QuickBillEntry({
  parties,
  today,
  draftPrefix,
  tenantId,
  shopId,
  disabled,
  onSaved,
}: {
  parties: Party[];
  today: string;
  draftPrefix: string;
  tenantId: string;
  shopId: string;
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
  // The bill's request id is fixed now so each photo's private path is bound to the bill the draft becomes.
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [documents, setDocuments] = useState<BillDocument[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  // The shop date can roll over while this page is open; a date still on the old default follows it.
  const [defaultDate, setDefaultDate] = useState(today);
  useEffect(() => {
    if (date === defaultDate) setDate(today);
    setDefaultDate(today);
  }, [today]);

  // N08: a typed bill number or total that is not yet saved as a draft.
  const dirty = Boolean(billNo.trim() || total.trim() || documents.length);
  useDirtyGuard(dirty);
  function onToggle(e: Event) {
    const el = e.currentTarget as HTMLDetailsElement;
    if (el.open || !dirty) return;
    if (!window.confirm(DISCARD_PROMPT)) {
      el.open = true;
      return;
    }
    // Unsaved photos are dropped from this device with the typed fields (nothing was uploaded or recorded).
    for (const d of documents) void removeLocalDocument(draftPrefix, d.id).catch(() => {});
    setDocuments([]);
    setClientId(crypto.randomUUID());
    setBillNo('');
    setTotal('');
    setErrors([]);
    setMessage('');
  }

  function save() {
    setMessage('');
    if (photoBusy) {
      setErrors(['A photo is still being kept on this device. Wait a moment, then save.']);
      return;
    }
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
      newId: () => clientId,
      today,
      existing,
      documents,
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
    setDocuments([]);
    setClientId(crypto.randomUUID());
    setMessage(
      'Quick bill saved as a draft. Nothing is posted yet: open it from “Saved purchase drafts”, add its items, then post.',
    );
    onSaved();
  }

  return (
    <details class="card" aria-label="Quick bill" onToggle={onToggle}>
      <summary>Quick bill (total now, items later)</summary>
      <p class="muted">
        Saves the paper bill, and any photo of it, as a draft. The supplier balance and stock change
        only when you add the items and post it; posting warns if the items do not match this total.
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
      </label>
      <BillAttachmentEditor
        key={clientId}
        scope={draftPrefix}
        tenantId={tenantId}
        shopId={shopId}
        clientId={clientId}
        documents={documents}
        disabled={disabled}
        deferUpload
        labelSuffix=" (quick bill)"
        beforePicker={() => true}
        onChange={setDocuments}
        onBusy={setPhotoBusy}
        onProblem={(m) => setErrors(m ? [m] : [])}
      />{' '}
      <button type="button" disabled={disabled || photoBusy} onClick={save}>
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
