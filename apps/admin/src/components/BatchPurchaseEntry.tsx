import { useState } from 'preact/hooks';
import type { Item, Party } from '@dsb-pro/adapters';
import { buildBatchDrafts, type BatchError, type BatchRow } from '../lib/batchPurchase';
import { savePurchaseDraft, scanPurchaseDrafts } from '../lib/purchaseDraft';
import { boundedItemOptions } from '../lib/itemOptions';
import { BATCH_CSV_HEADER, batchRowsFromCsv, parseCsv } from '../lib/csvImport';

const blankRow = (date: string, previous?: BatchRow): BatchRow => ({
  billNo: '',
  supplierId: previous?.supplierId ?? '',
  date: previous?.date ?? date,
  itemId: '',
  unitLevel: 1,
  qty: '',
  costMode: 'unit',
  cost: '',
});

// Batch entry: type several single-line supplier bills in a grid and save them as unposted drafts. Nothing is
// posted here; each draft is reviewed and posted from "Saved purchase drafts" through the normal purchase path.
export function BatchPurchaseEntry({
  items,
  parties,
  today,
  draftPrefix,
  disabled,
  onSaved,
}: {
  items: Item[];
  parties: Party[];
  today: string;
  draftPrefix: string;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<BatchRow[]>(() => [blankRow(today)]);
  const [searches, setSearches] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<BatchError[]>([]);
  const [message, setMessage] = useState('');
  const [writer] = useState(() => crypto.randomUUID());
  const patch = (i: number, p: Partial<BatchRow>) =>
    setRows((v) => v.map((r, n) => (n === i ? { ...r, ...p } : r)));

  function save() {
    setMessage('');
    let existing: Array<{ supplier: string; billNo: string }>;
    try {
      existing = scanPurchaseDrafts(draftPrefix).drafts.map((d) => ({
        supplier: d.draft.supplier,
        billNo: d.draft.billNo,
      }));
    } catch (e) {
      setMessage(`Saved drafts could not be checked: ${String(e)}. Nothing was saved.`);
      return;
    }
    const result = buildBatchDrafts(rows, items, parties, {
      now: Date.now(),
      newId: () => crypto.randomUUID(),
      today,
      existing,
    });
    setErrors(result.errors);
    if (result.errors.length) return;
    let saved = 0;
    try {
      for (const draft of result.drafts) {
        savePurchaseDraft(draftPrefix, writer, draft);
        saved++;
      }
    } catch (e) {
      // Rows already saved are removed from the grid so a retry cannot save them twice.
      setRows((v) => v.slice(saved));
      setSearches({});
      setMessage(
        `Saved ${saved} of ${result.drafts.length} drafts, then storage failed: ${String(e)}. The remaining bills are still here.`,
      );
      if (saved) onSaved();
      return;
    }
    setRows([blankRow(today, rows[rows.length - 1])]);
    setSearches({});
    setMessage(
      `Saved ${saved} draft${saved === 1 ? '' : 's'}. Nothing is posted yet: open “Saved purchase drafts” to review and post each bill.`,
    );
    onSaved();
  }

  return (
    <details class="card" aria-label="Batch bill entry">
      <summary>Batch entry (save several bills as drafts)</summary>
      <p class="muted">
        One line per bill. Bills are saved as drafts and nothing posts until you review and post
        each one. For bills with several lines, use the normal purchase form.
      </p>
      {rows.map((r, i) => {
        const item = items.find((x) => x.id === r.itemId);
        const picker = boundedItemOptions(items, searches[i] ?? '', r.itemId);
        const rowErrors = errors.filter((e) => e.row === i + 1 || e.row === 0);
        return (
          <fieldset key={i} aria-label={`Batch bill ${i + 1}`}>
            <legend>Bill {i + 1}</legend>
            <label>
              Supplier
              <select
                aria-label={`Batch supplier ${i + 1}`}
                value={r.supplierId}
                onChange={(e) => patch(i, { supplierId: e.currentTarget.value })}
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
                aria-label={`Batch bill number ${i + 1}`}
                value={r.billNo}
                onInput={(e) => patch(i, { billNo: e.currentTarget.value })}
              />
            </label>{' '}
            <label>
              Date
              <input
                type="date"
                aria-label={`Batch date ${i + 1}`}
                value={r.date}
                max={today}
                onInput={(e) => patch(i, { date: e.currentTarget.value })}
              />
            </label>{' '}
            <label>
              Find item
              <input
                aria-label={`Batch item search ${i + 1}`}
                placeholder="Name or SKU"
                value={searches[i] ?? ''}
                onInput={(e) => {
                  const value = e.currentTarget.value;
                  setSearches((v) => ({ ...v, [i]: value }));
                }}
              />
            </label>{' '}
            <label>
              Item
              <select
                aria-label={`Batch item ${i + 1}`}
                value={r.itemId}
                onChange={(e) => patch(i, { itemId: e.currentTarget.value, unitLevel: 1 })}
              >
                <option value="">Choose…</option>
                {picker.options.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
              </select>
            </label>{' '}
            <label>
              Unit
              <select
                aria-label={`Batch unit ${i + 1}`}
                value={r.unitLevel}
                disabled={!item}
                onChange={(e) =>
                  patch(i, { unitLevel: Number(e.currentTarget.value) as 1 | 2 | 3 })
                }
              >
                <option value="1">{item?.unit1 || 'Big unit'}</option>
                {item?.unit2 && <option value="2">{item.unit2}</option>}
                {item?.unit3 && <option value="3">{item.unit3}</option>}
              </select>
            </label>{' '}
            <label>
              Qty
              <input
                type="number"
                min="0.000001"
                step="any"
                aria-label={`Batch quantity ${i + 1}`}
                value={r.qty}
                onInput={(e) => patch(i, { qty: e.currentTarget.value })}
              />
            </label>{' '}
            <label>
              Cost as
              <select
                aria-label={`Batch cost mode ${i + 1}`}
                value={r.costMode}
                onChange={(e) =>
                  patch(i, {
                    costMode: e.currentTarget.value === 'total' ? 'total' : 'unit',
                    cost: '',
                  })
                }
              >
                <option value="unit">Per unit</option>
                <option value="total">Line total</option>
              </select>
            </label>{' '}
            <label>
              {r.costMode === 'total' ? 'Total ₹' : 'Unit cost ₹'}
              <input
                type="number"
                min="0"
                step="0.01"
                aria-label={`Batch cost ${i + 1}`}
                value={r.cost}
                onInput={(e) => patch(i, { cost: e.currentTarget.value })}
              />
            </label>{' '}
            <button
              type="button"
              aria-label={`Remove batch bill ${i + 1}`}
              disabled={rows.length === 1}
              onClick={() => {
                setRows((v) => v.filter((_, n) => n !== i));
                setSearches({});
              }}
            >
              Remove
            </button>
            {rowErrors.map((e, k) => (
              <p key={k} role="alert" class="alert">
                {e.row ? `Bill ${e.row}: ` : ''}
                {e.message}
              </p>
            ))}
          </fieldset>
        );
      })}
      <div class="row">
        <button
          type="button"
          onClick={() => setRows((v) => [...v, blankRow(today, v[v.length - 1])])}
        >
          Add another bill
        </button>
        <label>
          Fill from CSV{' '}
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Fill batch from CSV"
            disabled={disabled}
            onChange={(e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              input.value = '';
              if (!file) return;
              if (file.size > 512_000) {
                setErrors([{ row: 0, message: 'That file is too large (over 500 KB).' }]);
                return;
              }
              void file.text().then((text) => {
                const result = batchRowsFromCsv(parseCsv(text), items, parties);
                if (result.errors.length) {
                  setErrors(result.errors.map((message) => ({ row: 0, message })));
                  setMessage('Nothing was filled in. Fix the file and choose it again.');
                  return;
                }
                setErrors([]);
                setSearches({});
                setRows(result.rows);
                setMessage(
                  `Filled ${result.rows.length} bill${result.rows.length === 1 ? '' : 's'} from ${file.name}. Check them, then press Save. Nothing is saved or posted yet.`,
                );
              });
            }}
          />
        </label>
        <a
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(BATCH_CSV_HEADER.join(',') + '\n')}`}
          download="dsb-batch-bills-template.csv"
        >
          CSV template
        </a>
        <button type="button" disabled={disabled || !draftPrefix} onClick={save}>
          Save {rows.length} draft{rows.length === 1 ? '' : 's'}
        </button>
      </div>
      {message && <p class="muted">{message}</p>}
    </details>
  );
}
