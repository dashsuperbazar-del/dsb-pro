import { expect, test } from 'vitest';
import type { Item } from '@dsb-pro/adapters';
import {
  ITEM_FIELD_LABELS,
  describeItemUnits,
  exactItemMatch,
  mappedItemMessage,
  newItemInput,
  newItemProblem,
  sameUnits,
} from './newItem';

test('maps typed fields exactly as the Add item form does: blanks are omitted, conversions are numbers', () => {
  expect(
    newItemInput({
      name: 'Sugar 1kg',
      sku: '',
      unit1: 'bag',
      unit2: '',
      conv1: '',
      unit3: '',
      conv2: '',
    }),
  ).toEqual({
    name: 'Sugar 1kg',
    sku: undefined,
    unit1: 'bag',
    unit2: undefined,
    unit3: undefined,
    conv1: undefined,
    conv2: undefined,
  });
  expect(
    newItemInput({
      name: 'Oil',
      unit1: 'ctn',
      unit2: 'jar',
      conv1: '12',
      unit3: 'pouch',
      conv2: '0.5',
    }),
  ).toEqual({
    name: 'Oil',
    sku: undefined,
    unit1: 'ctn',
    unit2: 'jar',
    unit3: 'pouch',
    conv1: 12,
    conv2: 0.5,
  });
  // Names, SKUs and unit names are sent trimmed; a field of spaces counts as blank.
  expect(
    newItemInput({ name: '  Dal 1kg ', sku: ' ', unit1: ' bag ', unit2: '  ', conv1: ' ' }),
  ).toMatchObject({ name: 'Dal 1kg', sku: undefined, unit1: 'bag', unit2: undefined });
});

test('plain checks before sending mirror the database unit rules', () => {
  const ok = { name: 'Oil', unit1: 'ctn' };
  expect(newItemProblem(ok)).toBe('');
  expect(newItemProblem({ ...ok, name: '  ' })).toBe('Enter the item name.');
  expect(newItemProblem({ ...ok, unit1: ' ' })).toBe('Enter the big unit.');
  expect(newItemProblem({ ...ok, unit2: 'jar' })).toBe(
    'Enter how many small units make one big unit (more than zero).',
  );
  expect(newItemProblem({ ...ok, unit2: 'jar', conv1: '0' })).toContain('more than zero');
  expect(newItemProblem({ ...ok, unit2: 'jar', conv1: '-2' })).toContain('more than zero');
  expect(newItemProblem({ ...ok, unit2: 'jar', conv1: '12' })).toBe('');
  expect(newItemProblem({ ...ok, conv1: '12' })).toBe(
    'Enter the small unit, or clear small units per big.',
  );
  expect(newItemProblem({ ...ok, unit3: 'pc', conv2: '2' })).toBe(
    'Enter the small unit before the piece unit.',
  );
  expect(newItemProblem({ ...ok, unit2: 'jar', conv1: '12', unit3: 'pc' })).toBe(
    'Enter how many pieces make one small unit (more than zero).',
  );
  expect(newItemProblem({ ...ok, unit2: 'jar', conv1: '12', conv2: '2' })).toBe(
    'Enter the piece unit, or clear pieces per small.',
  );
  expect(newItemProblem({ ...ok, unit2: 'jar', conv1: '12', unit3: 'pc', conv2: '2' })).toBe('');
});

test('the card form and the Add item form use the same field labels', () => {
  expect(ITEM_FIELD_LABELS).toEqual({
    name: 'Item name',
    unit1: 'Big unit (e.g. case)',
    unit2: 'Small unit (e.g. pack)',
    conv1: 'Small units per big',
    unit3: 'Piece unit (optional)',
    conv2: 'Pieces per small',
  });
});

test('units are described big to piece, and compared with what was submitted', () => {
  const saved = { unit1: 'ctn', unit2: 'jar', unit3: null, conv1: 12, conv2: null } as Item;
  expect(describeItemUnits(saved)).toBe('ctn; 12 jar per ctn');
  expect(
    describeItemUnits({ unit1: 'ctn', unit2: 'jar', unit3: 'pc', conv1: 12, conv2: 2 } as Item),
  ).toBe('ctn; 12 jar per ctn; 2 pc per jar');
  expect(sameUnits(saved, { name: 'Oil', unit1: 'ctn ', unit2: 'jar', conv1: '12' })).toBe(true);
  expect(sameUnits(saved, { name: 'Oil', unit1: 'ctn', unit2: 'jar', conv1: '6' })).toBe(false);
  expect(sameUnits(saved, { name: 'Oil', unit1: 'box', unit2: 'jar', conv1: '12' })).toBe(false);
  expect(
    sameUnits(saved, { name: 'Oil', unit1: 'ctn', unit2: 'jar', conv1: '12', unit3: 'pc' }),
  ).toBe(false);
});

test('a mapped create says no new item was made and typed GST/SKU were not used', () => {
  expect(mappedItemMessage('Tea')).toBe(
    'Tea already exists with these units — no new item was created (its GST and SKU are unchanged; any GST or SKU typed here was not used).',
  );
});

test('an exact name match ignores case and outer spaces; a partial name is not a match', () => {
  const items = [{ id: 'a', name: 'Sugar 1kg' }] as Item[];
  expect(exactItemMatch(items, '  sugar 1KG ')?.id).toBe('a');
  expect(exactItemMatch(items, 'Sugar')).toBeUndefined();
  expect(exactItemMatch(items, '   ')).toBeUndefined();
});
