import { describe, expect, it } from 'vitest';
import { matchItems, parseVoiceEntry, unitLevelFor } from './voiceEntry';

const item = (id: string, name: string, unit1 = 'carton', unit2: string | null = 'pkt') =>
  ({ id, name, unit1, unit2, unit3: null }) as never;

describe('parseVoiceEntry', () => {
  it('reads name, quantity, unit and rate', () => {
    expect(parseVoiceEntry('Choco Pie 5 carton 2550')).toEqual({
      name: 'choco pie',
      qty: '5',
      unitWord: 'carton',
      rate: '2550',
    });
    expect(parseVoiceEntry('oil 2')).toEqual({ name: 'oil', qty: '2', unitWord: null, rate: null });
    expect(parseVoiceEntry('sugar')).toEqual({
      name: 'sugar',
      qty: null,
      unitWord: null,
      rate: null,
    });
    expect(parseVoiceEntry('5 10')).toBeNull();
    expect(parseVoiceEntry('   ')).toBeNull();
  });
});

describe('matchItems', () => {
  const items = [item('a', 'Sugar 1kg'), item('b', 'Sugar 5kg'), item('c', 'Oil')];
  it('an exact name wins; otherwise every containing name is returned (never a guess)', () => {
    expect(matchItems(items, 'oil').map((i) => i.id)).toEqual(['c']);
    expect(matchItems(items, 'sugar').map((i) => i.id)).toEqual(['a', 'b']);
    expect(matchItems(items, 'rice')).toEqual([]);
  });
});

describe('unitLevelFor', () => {
  it('matches unit names, allowing a plural', () => {
    expect(unitLevelFor(item('a', 'x'), 'cartons')).toBe(1);
    expect(unitLevelFor(item('a', 'x'), 'PKT')).toBe(2);
    expect(unitLevelFor(item('a', 'x'), 'box')).toBeNull();
    expect(unitLevelFor(item('a', 'x'), null)).toBeNull();
  });
});
