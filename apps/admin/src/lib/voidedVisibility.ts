// Owner decision: voided documents are hidden from the bill/invoice lists by default and never deleted.
// This is display-only; totals, ledgers and statements are not touched. Customer and supplier
// statements deliberately do not use it (a ledger must show reversals).

export type VoidScope = 'purchases' | 'sales';

/** Splits a list into what to show and how many voided items were hidden (0 when shown). */
export function hideVoided<T>(
  rows: T[],
  isVoid: (row: T) => boolean,
  show: boolean,
): { shown: T[]; hidden: number } {
  if (show) return { shown: rows, hidden: 0 };
  const shown = rows.filter((r) => !isVoid(r));
  return { shown, hidden: rows.length - shown.length };
}

const key = (scope: VoidScope, userId: string) => `dsb-show-voided:${scope}:${userId}`;

/** Per-user choice; storage may be missing or blocked, so any failure means the default (hidden). */
export function loadShowVoided(scope: VoidScope, userId: string): boolean {
  try {
    return !!userId && localStorage.getItem(key(scope, userId)) === '1';
  } catch {
    return false;
  }
}

export function saveShowVoided(scope: VoidScope, userId: string, show: boolean): void {
  if (!userId) return;
  try {
    localStorage.setItem(key(scope, userId), show ? '1' : '0');
  } catch {
    // The choice just is not remembered.
  }
}

export function hiddenNote(hidden: number): string {
  return hidden > 0 ? ` ${hidden} voided ${hidden === 1 ? 'item' : 'items'} hidden.` : '';
}
