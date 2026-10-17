import type { Item, Party } from '@dsb-pro/adapters';
import type { BatchRow } from './batchPurchase';

// P10 (old DSB entry sheet): read a CSV of single-line bills into the batch-entry grid. It only fills the
// grid; nothing is saved or posted until the user presses Save and then posts each draft normally.
export const BATCH_CSV_HEADER = [
  'bill no',
  'supplier',
  'date',
  'item',
  'unit',
  'qty',
  'cost',
  'cost type',
];
export const MAX_IMPORT_ROWS = 200;

/** RFC 4180 style: commas, double-quoted fields with "" escapes, CRLF or LF line ends. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function batchRowsFromCsv(
  table: string[][],
  items: Item[],
  parties: Party[],
): { rows: BatchRow[]; errors: string[] } {
  const errors: string[] = [];
  if (!table.length) return { rows: [], errors: ['The file is empty.'] };
  const header = table[0]!.map(norm);
  const col = (name: string) => header.indexOf(name);
  const missing = BATCH_CSV_HEADER.slice(0, 7).filter((h) => col(h) < 0);
  if (missing.length) return { rows: [], errors: [`Missing column(s): ${missing.join(', ')}.`] };
  const body = table.slice(1);
  if (!body.length) return { rows: [], errors: ['The file has no bills under the header.'] };
  if (body.length > MAX_IMPORT_ROWS)
    return {
      rows: [],
      errors: [`At most ${MAX_IMPORT_ROWS} bills per file; this one has ${body.length}.`],
    };
  const unique = <T extends { name: string }>(list: T[], name: string) => {
    const hits = list.filter((x) => norm(x.name) === norm(name));
    return hits.length === 1 ? hits[0]! : hits.length ? 'ambiguous' : null;
  };
  const rows: BatchRow[] = [];
  body.forEach((r, i) => {
    const line = i + 2;
    const get = (h: string) => (col(h) >= 0 ? (r[col(h)] ?? '').trim() : '');
    const supplier = unique(parties, get('supplier'));
    const item = unique(items, get('item'));
    if (supplier === null) errors.push(`Line ${line}: no supplier named “${get('supplier')}”.`);
    if (supplier === 'ambiguous')
      errors.push(`Line ${line}: more than one supplier is named “${get('supplier')}”.`);
    if (item === null) errors.push(`Line ${line}: no item named “${get('item')}”.`);
    if (item === 'ambiguous')
      errors.push(`Line ${line}: more than one item is named “${get('item')}”.`);
    let unitLevel: 1 | 2 | 3 = 1;
    const unit = norm(get('unit'));
    if (item && item !== 'ambiguous' && unit) {
      const levels = [item.unit1, item.unit2, item.unit3].map((u) => norm(u ?? ''));
      const at = ['1', '2', '3'].includes(unit) ? Number(unit) - 1 : levels.indexOf(unit);
      if (at < 0 || !levels[at])
        errors.push(`Line ${line}: ${item.name} has no unit “${get('unit')}”.`);
      else unitLevel = (at + 1) as 1 | 2 | 3;
    }
    const costType = norm(get('cost type') || 'unit');
    if (costType !== 'unit' && costType !== 'total')
      errors.push(`Line ${line}: cost type must be “unit” or “total”.`);
    rows.push({
      billNo: get('bill no'),
      supplierId: supplier && supplier !== 'ambiguous' ? supplier.id : '',
      date: get('date'),
      itemId: item && item !== 'ambiguous' ? item.id : '',
      unitLevel,
      qty: get('qty'),
      costMode: costType === 'total' ? 'total' : 'unit',
      cost: get('cost'),
    });
  });
  return errors.length ? { rows: [], errors } : { rows, errors: [] };
}
