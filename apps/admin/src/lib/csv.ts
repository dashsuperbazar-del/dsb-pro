// RFC 4180 CSV. Text cells that a spreadsheet would run as a formula (=, +, -, @, tab, CR) are
// prefixed with an apostrophe; numeric cells are written as-is so negative amounts stay numbers.
export type Cell = { text: string } | { num: string };

const FORMULA = /^[=+\-@\t\r]/;
function cell(c: Cell): string {
  const raw = 'num' in c ? c.num : FORMULA.test(c.text) ? `'${c.text}` : c.text;
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}
export function toCsv(header: string[], rows: Cell[][]): string {
  return [header.map((h) => cell({ text: h })), ...rows.map((r) => r.map(cell))]
    .map((r) => r.join(','))
    .join('\r\n')
    .concat('\r\n');
}
