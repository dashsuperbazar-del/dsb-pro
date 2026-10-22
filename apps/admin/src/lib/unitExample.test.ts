import { expect, test } from 'vitest';
import { newItemProblem } from './newItem';
import { UNIT_PRESETS, applyPreset, hasPieceValues, unitExample } from './unitExample';

test('example sentence follows the typed units, big → small → piece', () => {
  expect(unitExample({ unit1: 'Kg', unit2: 'Gms', conv1: '1000' })).toEqual({
    sentence: '1 Kg = 1000 Gms',
    hint: '',
  });
  expect(
    unitExample({ unit1: 'case', unit2: 'pack', conv1: '12', unit3: 'pcs', conv2: '10' }),
  ).toEqual({ sentence: '1 case = 12 pack · 1 pack = 10 pcs', hint: '' });
  expect(unitExample({ unit1: ' Kg ', unit2: ' Gms ', conv1: ' 0.5 ' }).sentence).toBe(
    '1 Kg = 0.5 Gms',
  );
});

test('empty or incomplete combinations give a gentle hint, never an error', () => {
  expect(unitExample({}).hint).toContain('big unit');
  expect(unitExample({ unit1: 'Kg' })).toEqual({ sentence: 'Counted in Kg only.', hint: '' });
  expect(unitExample({ unit1: 'Kg', unit2: 'Gms' }).hint).toBe(
    'How many Gms make 1 Kg? Type the number.',
  );
  expect(unitExample({ unit1: 'Kg', unit2: 'Gms', conv1: '0' }).sentence).toBe('');
  expect(unitExample({ unit1: 'Kg', unit2: 'Gms', conv1: 'abc' }).sentence).toBe('');
  expect(unitExample({ unit1: 'Kg', conv1: '5' }).hint).toContain('small unit');
  expect(unitExample({ unit1: 'Kg', unit3: 'pcs' }).hint).toContain('small unit');
  const half = unitExample({ unit1: 'pack', unit2: 'pcs', conv1: '12', unit3: 'x' });
  expect(half.sentence).toBe('1 pack = 12 pcs');
  expect(half.hint).toContain('How many x make 1 pcs?');
});

test('presets only fill big unit, small unit and ratio, and pass the same validation once complete', () => {
  expect(UNIT_PRESETS.map((p) => p.label)).toEqual([
    'Kg / Gms',
    'Litre / ml',
    'Dozen / pcs',
    'Packet / pcs',
  ]);
  for (const p of UNIT_PRESETS) {
    const fill = applyPreset(p);
    expect(Object.keys(fill).sort()).toEqual(['conv1', 'unit1', 'unit2']);
    const problem = newItemProblem({ name: 'X', ...fill });
    // Packet leaves the count for the owner; every other preset is saveable as is.
    if (p.conv1) expect(problem).toBe('');
    else expect(problem).toContain('Enter how many small units');
  }
  expect(applyPreset(UNIT_PRESETS[0]!)).toEqual({ unit1: 'Kg', unit2: 'Gms', conv1: '1000' });
});

test('hasPieceValues sees any piece text', () => {
  expect(hasPieceValues({})).toBe(false);
  expect(hasPieceValues({ unit3: ' ' })).toBe(false);
  expect(hasPieceValues({ unit3: 'pcs' })).toBe(true);
  expect(hasPieceValues({ conv2: '2' })).toBe(true);
});
