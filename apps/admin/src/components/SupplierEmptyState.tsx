import { useState } from 'preact/hooks';
import { errorText } from '../lib/friendlyError';

// Suppliers with nothing yet: say so, and offer the one thing to do. The form creates the supplier through
// the same createParty path as "Add a supplier" in purchase entry; it records no money.
export function SupplierEmptyState(props: {
  canAdd: boolean;
  title: string;
  onCreate: (v: { name: string; phone: string; gstin: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(ev: Event) {
    ev.preventDefault();
    if (busy) return;
    const form = ev.currentTarget as HTMLFormElement;
    const f = new FormData(form);
    const name = String(f.get('name') ?? '').trim();
    if (!name) {
      setError('Enter the supplier name.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await props.onCreate({
        name,
        phone: String(f.get('phone') ?? '').trim(),
        gstin: String(f.get('gstin') ?? '').trim(),
      });
      form.reset();
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="empty-state" data-testid="suppliers-empty">
      <h3>{props.title}</h3>
      <p class="muted">
        Add the people you buy from. Then each purchase bill shows what you owe them.
      </p>
      {props.canAdd ? (
        !open ? (
          <button type="button" class="primary" onClick={() => setOpen(true)}>
            Add a supplier
          </button>
        ) : (
          <form onSubmit={submit} aria-label="Add a supplier">
            <label>
              Supplier name
              <input name="name" autoComplete="off" required />
            </label>
            <label>
              Phone (optional)
              <input name="phone" type="tel" />
            </label>
            <label>
              GSTIN (optional)
              <input name="gstin" />
            </label>
            {error && (
              <p role="alert" class="alert">
                {error}
              </p>
            )}
            <div class="row">
              <button class="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save supplier'}
              </button>
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )
      ) : (
        <p class="muted">Ask the owner or a manager to add a supplier.</p>
      )}
    </div>
  );
}
