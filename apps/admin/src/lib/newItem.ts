import type { Item } from '@dsb-pro/adapters';

// One mapping from typed item fields to the createItem adapter, shared by the Inventory "Add item" form and
// the "+ Create" form inside a purchase bill card, so both create items under exactly the same rules:
// text is trimmed, blank optional fields are omitted, conversions are sent as numbers, and the unit rules
// of the database (items check constraints) are checked first in plain words. Level 1 is the BIG unit;
// stock is stored in the smallest configured unit.
export type NewItemFields = {
  name: string;
  sku?: string;
  unit1: string;
  unit2?: string;
  conv1?: string;
  unit3?: string;
  conv2?: string;
};

/** Field labels of both forms (the Add item form's original wording). */
export const ITEM_FIELD_LABELS = {
  name: 'Item name',
  unit1: 'Big unit (e.g. case)',
  unit2: 'Small unit (e.g. pack)',
  conv1: 'Small units per big',
  unit3: 'Piece unit (optional)',
  conv2: 'Pieces per small',
} as const;
export const ITEM_UNITS_HINT =
  'Unit order follows DSB: big → small → piece. Stock is stored in the smallest configured unit.';

const text = (v: string | undefined) => (v ?? '').trim();

export function newItemInput(f: NewItemFields) {
  return {
    name: text(f.name),
    sku: text(f.sku) || undefined,
    unit1: text(f.unit1),
    unit2: text(f.unit2) || undefined,
    unit3: text(f.unit3) || undefined,
    conv1: text(f.conv1) ? Number(text(f.conv1)) : undefined,
    conv2: text(f.conv2) ? Number(text(f.conv2)) : undefined,
  };
}

/** The first problem the database would refuse, in plain words; '' when the fields can be sent. */
export function newItemProblem(f: NewItemFields): string {
  const v = newItemInput(f);
  const positive = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n > 0;
  if (!v.name) return 'Enter the item name.';
  if (!v.unit1) return 'Enter the big unit.';
  if (!v.unit2 && v.conv1 !== undefined)
    return 'Enter the small unit, or clear small units per big.';
  if (v.unit2 && !positive(v.conv1))
    return 'Enter how many small units make one big unit (more than zero).';
  if (v.unit3 && !v.unit2) return 'Enter the small unit before the piece unit.';
  if (!v.unit3 && v.conv2 !== undefined) return 'Enter the piece unit, or clear pieces per small.';
  if (v.unit3 && !positive(v.conv2))
    return 'Enter how many pieces make one small unit (more than zero).';
  return '';
}

type Units = Pick<Item, 'unit1' | 'unit2' | 'unit3' | 'conv1' | 'conv2'>;
/** "ctn; 12 jar per ctn; 2 pc per jar" */
export function describeItemUnits(i: Units): string {
  const parts = [i.unit1];
  if (i.unit2) parts.push(`${Number(i.conv1)} ${i.unit2} per ${i.unit1}`);
  if (i.unit2 && i.unit3) parts.push(`${Number(i.conv2)} ${i.unit3} per ${i.unit2}`);
  return parts.join('; ');
}

/** Whether a saved item has exactly the units and conversions these fields would create. */
export function sameUnits(saved: Units, f: NewItemFields): boolean {
  const v = newItemInput(f);
  const num = (n: number | string | null | undefined) =>
    n === null || n === undefined ? null : Number(n);
  return (
    saved.unit1 === v.unit1 &&
    (saved.unit2 ?? undefined) === v.unit2 &&
    (saved.unit3 ?? undefined) === v.unit3 &&
    num(saved.conv1) === num(v.conv1) &&
    num(saved.conv2) === num(v.conv2)
  );
}

/** An online create that found the same name with the same units: nothing new was written and the existing
 * item was returned (create_item_v2 mapped=true). Typed GST/SKU are not applied to it. */
export function mappedItemMessage(name: string): string {
  return `${name} already exists with these units — no new item was created (its GST and SKU are unchanged; any GST or SKU typed here was not used).`;
}

/** The item already called this (ignoring case and outer spaces); a bill card chooses it, never re-creates it. */
export function exactItemMatch<T extends Pick<Item, 'name'>>(
  items: T[],
  name: string,
): T | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return items.find((i) => i.name.trim().toLowerCase() === key);
}
