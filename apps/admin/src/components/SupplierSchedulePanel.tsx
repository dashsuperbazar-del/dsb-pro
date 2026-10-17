import { useEffect, useState } from 'preact/hooks';
import {
  listSupplierSchedules,
  removeSupplierSchedule,
  saveSupplierSchedule,
  type SupplierSchedule,
} from '@dsb-pro/adapters';
import { parseScheduleForm } from '../lib/supplierSchedule';
import { paiseToDecimal, rupees } from '../lib/money';

// Reminder only: saving or removing a schedule never moves money. Payments still go through the audited
// supplier payment flow; what is due is derived on the server from posted payments.
export function SupplierSchedulePanel(props: {
  shopId: string;
  partyId: string;
  partyName: string;
}) {
  const { shopId, partyId } = props;
  const [current, setCurrent] = useState<SupplierSchedule | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dueDay, setDueDay] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function fill(s: SupplierSchedule | null) {
    setCurrent(s);
    setDueDay(s ? String(s.dueDay) : '');
    setAmount(s?.expectedAmountPaise ? paiseToDecimal(s.expectedAmountPaise) : '');
    setNote(s?.note ?? '');
    setActive(s ? s.active : true);
  }
  async function load() {
    setLoaded(false);
    setError('');
    try {
      const all = await listSupplierSchedules(shopId);
      fill(all.find((s) => s.partyId === partyId) ?? null);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the payment schedule.');
    }
  }
  useEffect(() => {
    setMessage('');
    void load();
  }, [shopId, partyId]);

  async function save() {
    const parsed = parseScheduleForm({ dueDay, amount, note });
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await saveSupplierSchedule({
        shopId,
        partyId,
        dueDay: parsed.dueDay,
        expectedAmountPaise: parsed.expectedAmountPaise,
        note: parsed.note,
        active,
        clientId: crypto.randomUUID(),
      });
      setMessage('Payment schedule saved. No money was recorded.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the payment schedule.');
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!current) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await removeSupplierSchedule(current.id);
      setMessage('Payment schedule removed.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the payment schedule.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="card" aria-label="Payment schedule">
      <h2>Payment schedule — {props.partyName}</h2>
      <p class="hint">
        A monthly reminder only. It does not pay or record anything; it shows on Home until a
        payment to this supplier is recorded this month.
      </p>
      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!loaded && !error && <p class="muted">Loading schedule…</p>}
      {loaded && (
        <>
          {current && (
            <p>
              Current: day {current.dueDay} of each month
              {current.expectedAmountPaise ? `, about ${rupees(current.expectedAmountPaise)}` : ''}
              {current.active ? '' : ' (paused)'}.
            </p>
          )}
          <label>
            Due day of month (1–28)
            <input
              inputMode="numeric"
              value={dueDay}
              onInput={(e) => setDueDay((e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Expected amount ₹ (optional)
            <input
              inputMode="decimal"
              value={amount}
              onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Note (optional)
            <input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive((e.target as HTMLInputElement).checked)}
            />{' '}
            Active
          </label>
          <button type="button" disabled={busy} onClick={() => void save()}>
            Save schedule
          </button>
          {current && (
            <button type="button" class="secondary" disabled={busy} onClick={() => void remove()}>
              Remove schedule
            </button>
          )}
        </>
      )}
    </section>
  );
}
