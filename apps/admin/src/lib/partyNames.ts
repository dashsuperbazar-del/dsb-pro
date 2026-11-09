/** Letters and digits only, lower case: "M. B lal Hindustan" and "M.b lal Hindustan" compare equal. */
export function normalizePartyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, '');
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** An existing party whose name is the same or a near-typo of `name` (a warning only, never a block). */
export function findSimilarParty<T extends { name: string }>(
  name: string,
  parties: readonly T[],
): T | null {
  const n = normalizePartyName(name);
  if (!n) return null;
  const limit = n.length >= 8 ? 2 : n.length >= 5 ? 1 : 0;
  for (const p of parties) {
    const m = normalizePartyName(p.name);
    if (
      m === n ||
      (limit > 0 && Math.abs(m.length - n.length) <= limit && editDistance(m, n) <= limit)
    )
      return p;
  }
  return null;
}

/** Ask before creating a party that looks like an existing one. True = go ahead. */
export function confirmNewPartyName(name: string, parties: readonly { name: string }[]): boolean {
  const twin = findSimilarParty(name, parties);
  if (!twin) return true;
  return window.confirm(
    `"${name.trim()}" looks like the existing party "${twin.name}". A second party splits the balance. Create it anyway?`,
  );
}

/** Age in days of the oldest bill a supplier still owes, from the supplier aging report details. */
export function oldestUnpaidDays(
  details: readonly { ageDays: number; clampedDuePaise: string }[],
): number | null {
  let max: number | null = null;
  for (const d of details)
    if (BigInt(d.clampedDuePaise) > 0n && (max === null || d.ageDays > max)) max = d.ageDays;
  return max;
}
