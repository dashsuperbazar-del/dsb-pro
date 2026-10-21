import type { OpenRemark, RemarkDocKind, WriteOutcome } from '@dsb-pro/adapters';
import { appRoute } from './paths';

// Remarks typed while offline (or whose send had no clear answer) wait here and are resent with the SAME
// client id, so the server's idempotent add never makes a second remark. An entry leaves the queue only on a
// committed answer or a definite refusal. Only adds are queued: settle/reopen/edit need the live version.
export type QueuedRemark = {
  clientId: string;
  userId: string;
  shopId: string;
  docKind: RemarkDocKind;
  docId: string;
  body: string;
  queuedAt: number;
  lastError?: string;
};

const KEY = 'dsb.remarkQueue.v1';

function read(): QueuedRemark[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is QueuedRemark =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as QueuedRemark).clientId === 'string' &&
        typeof (e as QueuedRemark).userId === 'string' &&
        typeof (e as QueuedRemark).shopId === 'string' &&
        ((e as QueuedRemark).docKind === 'purchase' || (e as QueuedRemark).docKind === 'sale') &&
        typeof (e as QueuedRemark).docId === 'string' &&
        typeof (e as QueuedRemark).body === 'string',
    );
  } catch {
    return [];
  }
}

function write(entries: QueuedRemark[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

/** Saves the add BEFORE it is sent. False when the device cannot store it (then send it now and say so). */
export function queueRemark(entry: QueuedRemark): boolean {
  const all = read().filter((e) => e.clientId !== entry.clientId);
  return write([...all, entry]);
}

export function queuedRemarks(userId: string, docKind?: RemarkDocKind, docId?: string) {
  return read().filter(
    (e) =>
      e.userId === userId && (!docKind || e.docKind === docKind) && (!docId || e.docId === docId),
  );
}

export function dropQueuedRemark(clientId: string) {
  write(read().filter((e) => e.clientId !== clientId));
}

function markError(clientId: string, message: string) {
  write(read().map((e) => (e.clientId === clientId ? { ...e, lastError: message } : e)));
}

/**
 * Resends this user's queued adds (optionally only for one document). Committed entries and invalid text leave
 * the queue; every other outcome stays (the user can discard it) for the next try. Returns the refused ones so the screen can say why.
 */
export async function flushRemarkQueue(
  userId: string,
  send: (e: QueuedRemark) => Promise<WriteOutcome<string>>,
  only?: { docKind: RemarkDocKind; docId: string },
): Promise<{ sent: number; refused: QueuedRemark[]; waiting: number }> {
  const pending = queuedRemarks(userId, only?.docKind, only?.docId);
  let sent = 0;
  let waiting = 0;
  const refused: QueuedRemark[] = [];
  for (const e of pending) {
    const out = await send(e);
    if (out.kind === 'committed') {
      dropQueuedRemark(e.clientId);
      sent++;
    } else if (out.kind === 'rejected' && out.code === 'DSB_INVALID_REMARK') {
      // The text itself is invalid: it can never be sent.
      dropQueuedRemark(e.clientId);
      refused.push({ ...e, lastError: out.message });
    } else if (out.kind === 'rejected') {
      // Session expired, bill not synced yet, permission change: keep the text, say why, let the user discard.
      markError(e.clientId, out.message);
      waiting++;
    } else {
      markError(e.clientId, out.message);
      waiting++;
    }
  }
  return { sent, refused, waiting };
}

/** Link that opens the document of an open remark (a corrected bill opens itself, not the replaced one). */
export function remarkDocHref(r: Pick<OpenRemark, 'docKind' | 'docId'>): string {
  return r.docKind === 'purchase'
    ? `${appRoute.purchases}?bill=${encodeURIComponent(r.docId)}`
    : `${appRoute.salesHistory}?sale=${encodeURIComponent(r.docId)}`;
}

/** Documents of one kind that have at least one open remark (for "Pending" badges and the filter). */
export function pendingDocIds(remarks: OpenRemark[], kind: RemarkDocKind): Set<string> {
  return new Set(remarks.filter((r) => r.docKind === kind).map((r) => r.docId));
}

/** Days since a remark was written, for the Home list ("3 days"). */
export function remarkAgeDays(createdAt: string, now = Date.now()): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}
