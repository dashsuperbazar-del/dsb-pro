import { expect, test } from 'vitest';
import type { Item } from '@dsb-pro/adapters';
import { exactItemMatch, isItemClientIdConflict, newItemInput } from './newItem';

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
});

test('only the items client_id unique violation counts as an already-saved create', () => {
  expect(
    isItemClientIdConflict(
      new Error('duplicate key value violates unique constraint "items_tenant_id_client_id_key"'),
    ),
  ).toBe(true);
  expect(
    isItemClientIdConflict(
      new Error('duplicate key value violates unique constraint "items_tenant_id_sku_key"'),
    ),
  ).toBe(false);
  expect(isItemClientIdConflict(new Error('network down'))).toBe(false);
  expect(isItemClientIdConflict('x')).toBe(false);
});

test('an exact name match ignores case and outer spaces; a partial name is not a match', () => {
  const items = [{ id: 'a', name: 'Sugar 1kg' }] as Item[];
  expect(exactItemMatch(items, '  sugar 1KG ')?.id).toBe('a');
  expect(exactItemMatch(items, 'Sugar')).toBeUndefined();
  expect(exactItemMatch(items, '   ')).toBeUndefined();
});
