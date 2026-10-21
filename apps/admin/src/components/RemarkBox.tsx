import { useEffect, useRef, useState } from 'preact/hooks';
import {
  addRemarkOutcome,
  editRemarkOutcome,
  listDocumentRemarks,
  listRemarkHistory,
  plainRemarkRefusal,
  reopenRemarkOutcome,
  settleRemarkOutcome,
  REMARK_MAX_LENGTH,
  type DocumentRemark,
  type RemarkDocKind,
  type RemarkEvent,
  type WriteOutcome,
} from '@dsb-pro/adapters';
import {
  dropQueuedRemark,
  flushRemarkQueue,
  queueRemark,
  queuedRemarks,
  type QueuedRemark,
} from '../lib/remarkQueue';

const ACTION_WORD: Record<RemarkEvent['action'], string> = {
  ADD: 'Added',
  EDIT: 'Changed',
  SETTLE: 'Settled',
  REOPEN: 'Reopened',
};

const sendQueued = (e: QueuedRemark) =>
  addRemarkOutcome({
    shopId: e.shopId,
    docKind: e.docKind,
    docId: e.docId,
    body: e.body,
    clientId: e.clientId,
  });

function refusal(out: WriteOutcome<unknown>): string {
  if (out.kind === 'committed') return '';
  return plainRemarkRefusal(out.message) || out.message;
}

// Pending remarks on one purchase bill or sale invoice: items still to come from the supplier, items the
// customer collects later, follow-ups. A remark is only a note; it never changes money or stock.
export function RemarkBox(props: {
  shopId: string;
  docKind: RemarkDocKind;
  docId: string;
  userId: string;
  role: string;
  /** Called with the remarks after every successful read (lists update their "Pending" badge). */
  onLoaded?: (remarks: DocumentRemark[]) => void;
}) {
  const { shopId, docKind, docId, userId, role } = props;
  const [remarks, setRemarks] = useState<DocumentRemark[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [queued, setQueued] = useState<QueuedRemark[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string; version: number } | null>(
    null,
  );
  const [history, setHistory] = useState<{ id: string; events: RemarkEvent[] | null } | null>(null);
  const generation = useRef(0);
  const canReopen = role === 'owner' || role === 'manager';

  async function load() {
    const token = ++generation.current;
    setQueued(queuedRemarks(userId, docKind, docId));
    try {
      const list = await listDocumentRemarks(docKind, docId);
      if (token !== generation.current) return;
      setRemarks(list);
      setLoadError('');
      props.onLoaded?.(list);
    } catch (e) {
      if (token !== generation.current) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  async function flush() {
    if (!userId) return;
    const result = await flushRemarkQueue(userId, sendQueued, { docKind, docId });
    if (result.refused.length)
      setNote(
        `A waiting remark was not saved: ${plainRemarkRefusal(result.refused[0]!.lastError ?? '') || result.refused[0]!.lastError}`,
      );
    if (result.sent || result.refused.length) await load();
    else setQueued(queuedRemarks(userId, docKind, docId));
  }

  useEffect(() => {
    setRemarks(null);
    setEditing(null);
    setHistory(null);
    setNote('');
    void load().then(flush);
    const online = () => void flush();
    window.addEventListener('online', online);
    return () => {
      generation.current++;
      window.removeEventListener('online', online);
    };
  }, [shopId, docKind, docId, userId]);

  async function add() {
    const body = text.trim();
    if (!body || body.length > REMARK_MAX_LENGTH || busy) return;
    setBusy(true);
    setNote('');
    const entry: QueuedRemark = {
      clientId: crypto.randomUUID(),
      userId,
      shopId,
      docKind,
      docId,
      body,
      queuedAt: Date.now(),
    };
    // Saved on this device first: an offline add is kept and resent with the same id.
    const stored = queueRemark(entry);
    const out = await sendQueued(entry);
    if (out.kind === 'committed') {
      if (stored) flushDrop(entry.clientId);
      setText('');
      await load();
    } else if (out.kind === 'rejected') {
      if (stored) flushDrop(entry.clientId);
      setNote(refusal(out));
    } else {
      setText('');
      setNote(
        stored
          ? 'No answer from the server. The remark is saved on this device and will be sent again.'
          : 'No answer from the server, and this device could not keep the remark. Check the remarks before writing it again.',
      );
      setQueued(queuedRemarks(userId, docKind, docId));
    }
    setBusy(false);
  }

  function flushDrop(clientId: string) {
    dropQueuedRemark(clientId);
    setQueued(queuedRemarks(userId, docKind, docId));
  }

  async function act(run: () => Promise<WriteOutcome<number>>) {
    if (busy) return;
    setBusy(true);
    setNote('');
    const out = await run();
    if (out.kind === 'unknown')
      setNote('No answer from the server. Reload the remarks to see whether it was saved.');
    else if (out.kind === 'rejected') setNote(refusal(out));
    else setEditing(null);
    await load();
    if (history) await showHistory(history.id);
    setBusy(false);
  }

  async function showHistory(id: string) {
    setHistory({ id, events: null });
    try {
      const events = await listRemarkHistory(id);
      setHistory({ id, events });
    } catch (e) {
      setHistory(null);
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  const open = remarks?.filter((r) => r.status === 'OPEN') ?? [];
  const settled = remarks?.filter((r) => r.status === 'SETTLED') ?? [];
  const row = (r: DocumentRemark) => (
    <li key={r.id} data-testid="remark" data-status={r.status}>
      {editing?.id === r.id ? (
        <span class="remark-edit">
          <textarea
            aria-label="Change remark"
            maxLength={REMARK_MAX_LENGTH}
            value={editing.text}
            onInput={(e) => setEditing({ ...editing, text: e.currentTarget.value })}
          />
          <button
            type="button"
            disabled={busy || !editing.text.trim()}
            onClick={() =>
              void act(() =>
                editRemarkOutcome({
                  remarkId: r.id,
                  body: editing.text,
                  expectedVersion: editing.version,
                }),
              )
            }
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </span>
      ) : (
        <span>
          <span class={`badge ${r.status === 'OPEN' ? 'remark-open' : 'remark-settled'}`}>
            {r.status === 'OPEN' ? 'Pending' : 'Settled'}
          </span>{' '}
          {r.body}
          <small class="muted">
            {' '}
            · {r.createdAt.slice(0, 10)}
            {r.fromEarlierBill ? ' · written on the bill before it was corrected' : ''}
            {r.settledAt ? ` · settled ${r.settledAt.slice(0, 10)}` : ''}
          </small>
        </span>
      )}
      {editing?.id !== r.id && (
        <span class="row remark-actions">
          {r.status === 'OPEN' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => settleRemarkOutcome(r.id))}
            >
              Mark settled
            </button>
          )}
          {r.status === 'OPEN' && (r.createdBy === userId || canReopen) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing({ id: r.id, text: r.body, version: r.version })}
            >
              Change
            </button>
          )}
          {r.status === 'SETTLED' && canReopen && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => reopenRemarkOutcome(r.id))}
            >
              Reopen
            </button>
          )}
          <button
            type="button"
            class="link"
            onClick={() => (history?.id === r.id ? setHistory(null) : void showHistory(r.id))}
          >
            {history?.id === r.id ? 'Hide history' : 'History'}
          </button>
        </span>
      )}
      {history?.id === r.id && (
        <ol class="remark-history" aria-label="Remark history">
          {history.events === null && <li class="muted">Loading history…</li>}
          {history.events?.map((ev) => (
            <li key={ev.version}>
              {ACTION_WORD[ev.action]} {ev.createdAt.slice(0, 16).replace('T', ' ')}
              {ev.actor === userId ? ' by you' : ''}: {ev.body}
            </li>
          ))}
        </ol>
      )}
    </li>
  );

  return (
    <section class="remark-box" aria-label="Pending remarks">
      <h3>Pending remarks</h3>
      {loadError && <p role="alert">Remarks are unavailable right now: {loadError}</p>}
      {remarks === null && !loadError && <p class="muted">Loading remarks…</p>}
      {remarks && !remarks.length && !queued.length && (
        <p class="muted">
          No pending items noted on this {docKind === 'sale' ? 'invoice' : 'bill'}.
        </p>
      )}
      {(open.length > 0 || queued.length > 0) && (
        <ul class="remark-list">
          {open.map(row)}
          {queued.map((q) => (
            <li key={q.clientId} data-testid="remark-queued">
              <span class="badge remark-waiting">Waiting to send</span> {q.body}
            </li>
          ))}
        </ul>
      )}
      {settled.length > 0 && (
        <details>
          <summary>Settled ({settled.length})</summary>
          <ul class="remark-list">{settled.map(row)}</ul>
        </details>
      )}
      {note && <p role="status">{note}</p>}
      <label>
        Add a remark
        <textarea
          aria-label="New remark"
          maxLength={REMARK_MAX_LENGTH}
          placeholder={
            docKind === 'purchase'
              ? 'e.g. 5 kg sugar short, supplier to send next trip'
              : 'e.g. Customer will collect 2 items tomorrow'
          }
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </label>
      <div class="row">
        <small class="muted">
          {text.trim().length}/{REMARK_MAX_LENGTH}
        </small>
        <button type="button" disabled={busy || !text.trim()} onClick={() => void add()}>
          Add remark
        </button>
      </div>
    </section>
  );
}
