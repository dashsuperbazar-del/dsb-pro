import type { Item } from '@dsb-pro/adapters';

// One mapping from typed item fields to the createItem adapter, shared by the Inventory "Add item" form and
// the "+ Create" form inside a purchase bill card, so both create items under exactly the same rules:
// blank optional fields are omitted, conversions are sent as numbers, and the database checks the rest
// (a second unit needs a conversion above zero, a third unit needs a second unit, SKUs are unique).
export type NewItemFields = {
  name: string;
  sku?: string;
  unit1: string;
  unit2?: string;
  conv1?: string;
  unit3?: string;
  conv2?: string;
};

export function newItemInput(f: NewItemFields) {
  return {
    name: f.name,
    sku: f.sku || undefined,
    unit1: f.unit1,
    unit2: f.unit2 || undefined,
    unit3: f.unit3 || undefined,
    conv1: f.conv1 ? Number(f.conv1) : undefined,
    conv2: f.conv2 ? Number(f.conv2) : undefined,
  };
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
