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

export function savePendingIntent<T extends { clientId: string }>(prefix: string, value: T): void {
  let others: { key: string; value: Stored }[];
  try {
    others = entries(prefix).filter((e) => e.value.clientId !== value.clientId);
  } catch (e) {
    throw new IntentStorageError(
      `Saved entries on this device cannot be read (${String(e)}). Nothing was sent.`,
    );
  }
  // Courtesy check only; safety comes from the per-request key below.
  if (others.length)
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
