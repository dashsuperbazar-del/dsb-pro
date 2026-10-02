// Durable record of a money/stock write whose outcome is not yet confirmed (V002 VF-005).
// It is written BEFORE the first network call and fails closed: if it cannot be stored, the write is
// not sent, because an in-memory lock would not survive a reload or crash.
//
// Each request is stored under its own key (`<prefix>:<clientId>`), so two windows can never
// overwrite each other's entry, even if both submit at the same instant: every sent request stays
// recoverable and is restored, oldest first, until confirmed. (The legacy single key `<prefix>` is
// still read.)
export type IntentLoad<T> = { ok: true; value: T | null } | { ok: false; message: string };

export class IntentStorageError extends Error {}

type Stored = { clientId: string; savedAt?: number };

function entries(prefix: string): { key: string; value: Stored }[] {
  const out: { key: string; value: Stored }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || (key !== prefix && !key.startsWith(`${prefix}:`))) continue;
    const raw = localStorage.getItem(key);
    if (raw) out.push({ key, value: JSON.parse(raw) as Stored });
  }
  return out.sort((a, b) => (a.value.savedAt ?? 0) - (b.value.savedAt ?? 0));
}

// Stable JSON for comparing a stored request with a retry (key order independent, savedAt ignored).
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .filter((k) => k !== 'savedAt')
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

// `retry: true` re-sends an entry that is already stored under its own id (V003 VF-009): it is never
// blocked by other windows' entries and never rewritten; a stored entry with a different payload is
// refused. A new entry is still refused while another unconfirmed entry exists.
export function savePendingIntent<T extends { clientId: string }>(
  prefix: string,
  value: T,
  opts: { retry?: boolean } = {},
): void {
  let all: { key: string; value: Stored }[];
  try {
    all = entries(prefix);
  } catch (e) {
    throw new IntentStorageError(
      `Saved entries on this device cannot be read (${String(e)}). Nothing was sent.`,
    );
  }
  const own = all.find((e) => e.value.clientId === value.clientId);
  if (own) {
    // Compare what would be stored (JSON drops undefined fields) with what is stored.
    if (canonical(own.value) !== canonical(JSON.parse(JSON.stringify(value))))
      throw new IntentStorageError(
        'The saved entry for this request differs from what would be sent. Nothing was sent.',
      );
    return; // already durable, exactly as stored
  }
  const others = all.filter((e) => e.value.clientId !== value.clientId);
  // A retry whose stored copy is gone is re-stored before sending; a new entry waits for the others.
  if (others.length && !opts.retry)
    throw new IntentStorageError(
      'Another window on this device has an unconfirmed entry here. Nothing was sent; reload this page to finish that entry first.',
    );
  const key = `${prefix}:${value.clientId}`;
  const text = JSON.stringify({ ...value, savedAt: Date.now() });
  try {
    localStorage.setItem(key, text);
  } catch (e) {
    throw new IntentStorageError(
      `This device could not save the entry before sending (${String(e)}). Nothing was sent; free storage or leave private mode, then try again.`,
    );
  }
  // Read back: some browsers accept a write and drop it.
  let back: string | null;
  try {
    back = localStorage.getItem(key);
  } catch {
    back = null;
  }
  if (back !== text)
    throw new IntentStorageError('This device did not keep the entry. Nothing was sent.');
}

// The oldest unconfirmed entry, if any.
export function loadPendingIntent<T>(prefix: string): IntentLoad<T> {
  try {
    const first = entries(prefix)[0];
    return { ok: true, value: first ? (first.value as unknown as T) : null };
  } catch (e) {
    return {
      ok: false,
      message: `Saved entries on this device cannot be read (${String(e)}). New entries are blocked until storage works.`,
    };
  }
}

// Removes only this request's entry. Best effort: a stale entry only causes a same-id resend, which
// the server answers idempotently.
export function clearPendingIntent(prefix: string, clientId: string): void {
  try {
    for (const e of entries(prefix))
      if (e.value.clientId === clientId) localStorage.removeItem(e.key);
  } catch {
    /* ignore */
  }
}
