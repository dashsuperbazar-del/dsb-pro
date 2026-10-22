// Bill codes (0069): "K7M2-QX9P", made by the server for every purchase bill and sale invoice. Search is
// case-insensitive and ignores dashes and spaces; a partial match needs at least 4 characters so a short
// query such as "K7" cannot flood the list. The supplier's own bill no. is a different field.
export const BILL_CODE_MIN_QUERY = 4;

export const normalizeBillCode = (s: string | null | undefined): string =>
  (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** 'exact' = the whole code, 'partial' = a part of it (4+ characters), null = no match. */
export function billCodeMatch(
  code: string | null | undefined,
  query: string,
): 'exact' | 'partial' | null {
  const c = normalizeBillCode(code);
  const q = normalizeBillCode(query);
  if (!c || q.length < BILL_CODE_MIN_QUERY) return null;
  if (c === q) return 'exact';
  return c.includes(q) ? 'partial' : null;
}
