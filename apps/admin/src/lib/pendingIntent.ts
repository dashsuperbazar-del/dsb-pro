// Durable record of a money/stock write whose outcome is not yet confirmed (V002 VF-005).
// It is written BEFORE the first network call and fails closed: if it cannot be stored, the write is
// not sent, because an in-memory lock would not survive a reload or crash.
export type IntentLoad<T> = { ok: true; value: T | null } | { ok: false; message: string };

export class IntentStorageError extends Error {}

// One slot per shop and kind. Another window's unconfirmed entry in the slot is never overwritten:
// that would lose its request id and allow it to be re-entered (V2 review M1).
export function savePendingIntent<T extends { clientId: string }>(key: string, value: T): void {
  const existing = loadPendingIntent<{ clientId?: string }>(key);
  if (!existing.ok) throw new IntentStorageError(existing.message);
  if (existing.value && existing.value.clientId !== value.clientId)
    throw new IntentStorageError(
      'Another window on this device has an unconfirmed entry here. Nothing was sent; reload this page to finish that entry first.',
    );
  try {
    localStorage.setItem(key, JSON.stringify(value));
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
  if (back !== JSON.stringify(value))
    throw new IntentStorageError('This device did not keep the entry. Nothing was sent.');
}

export function loadPendingIntent<T>(key: string): IntentLoad<T> {
  try {
    const raw = localStorage.getItem(key);
    return { ok: true, value: raw ? (JSON.parse(raw) as T) : null };
  } catch (e) {
    return {
      ok: false,
      message: `Saved entries on this device cannot be read (${String(e)}). New entries are blocked until storage works.`,
    };
  }
}

// Clearing is best effort: a stale record only causes a same-id resend, which the server answers
// idempotently.
export function clearPendingIntent(key: string, clientId: string): void {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    // Only our own entry: another window may have stored its own since.
    if ((JSON.parse(raw) as { clientId?: string }).clientId !== clientId) return;
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
