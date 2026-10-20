import { useState } from 'preact/hooks';
import { parseRupeesToPaise } from '@dsb-pro/core';
import { paiseToDecimal } from '../lib/money';

export type PartyEditorValues = {
  name: string;
  phone: string;
  gstin: string;
  address: string;
  /** Customers only: integer paise; null = no credit limit. */
  creditLimitPaise?: number | null;
  /** Customers only. */
  notes?: string;
};

// Edit details of a supplier or customer. Master data only: it never touches a ledger or posts money.
// The caller owns what a save means (and re-reads its list); this form owns typing, busy and errors.
export function PartyEditor({
  kind,
  initial,
  onSave,
  onArchive,
}: {
  kind: 'supplier' | 'customer';
  initial: {
    name: string;
    phone: string | null;
    gstin: string | null;
    address: string | null;
    creditLimitPaise?: number | null;
    notes?: string | null;
  };
  onSave: (values: PartyEditorValues) => Promise<void>;
  /** Offered only to people allowed to archive. The server refuses a party that has any history. */
  onArchive?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [gstin, setGstin] = useState(initial.gstin ?? '');
  const [address, setAddress] = useState(initial.address ?? '');
  const [creditLimit, setCreditLimit] = useState(
    initial.creditLimitPaise === null || initial.creditLimitPaise === undefined
      ? ''
      : paiseToDecimal(initial.creditLimitPaise),
  );
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  // The fields exist only while the section is open, so a closed editor never competes with the add form.
  const [open, setOpen] = useState(false);

  async function archive() {
    if (busy) return;
    const label = kind === 'supplier' ? 'supplier' : 'customer';
    if (
      !window.confirm(
        `Archive ${initial.name}? The ${label} disappears from every list. This only works while there are no bills, sales, payments, returns or opening balances for them.`,
      )
    )
      return;
    setError('');
    setSaved('');
    setBusy(true);
    try {
      await onArchive!();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setSaved('');
    const values: PartyEditorValues = { name, phone, gstin, address };
    if (kind === 'customer') {
      try {
        // Exactly what is shown is what is stored: more than two decimals would be silently rounded.
        const typed = creditLimit.trim();
        if (typed && !/^\d+(\.\d{1,2})?$/.test(typed)) throw new Error('format');
        // Blank = no credit limit. 0 = no credit allowed.
        values.creditLimitPaise = typed ? parseRupeesToPaise(typed) : null;
      } catch {
        setError('Enter the credit limit in rupees, for example 1500 or 1500.50.');
        return;
      }
      values.notes = notes;
    }
    setBusy(true);
    try {
      await onSave(values);
      setSaved('Details saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      class="recovery-tools"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Edit details</summary>
      {open && (
        <form onSubmit={submit} class="grid-form party-editor">
          <label>
            Name
            <input value={name} onInput={(e) => setName(e.currentTarget.value)} required />
          </label>
          <label>
            Phone
            <input value={phone} inputMode="tel" onInput={(e) => setPhone(e.currentTarget.value)} />
          </label>
          <label>
            GSTIN
            <input value={gstin} onInput={(e) => setGstin(e.currentTarget.value)} />
          </label>
          <label>
            Address
            <input value={address} onInput={(e) => setAddress(e.currentTarget.value)} />
          </label>
          {kind === 'customer' && (
            <>
              <label>
                Credit limit ₹ (blank = no limit)
                <input
                  value={creditLimit}
                  inputMode="decimal"
                  onInput={(e) => setCreditLimit(e.currentTarget.value)}
                />
              </label>
              <label>
                Notes
                <textarea value={notes} onInput={(e) => setNotes(e.currentTarget.value)} />
              </label>
            </>
          )}
          <button disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button>
        </form>
      )}
      {open && onArchive && (
        <p>
          <button type="button" class="link" disabled={busy} onClick={() => void archive()}>
            Archive this {kind}
          </button>
        </p>
      )}
      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">{saved}</p>}
    </details>
  );
}
