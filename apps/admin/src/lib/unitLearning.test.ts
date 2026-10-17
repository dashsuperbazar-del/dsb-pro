import { describe, expect, it } from 'vitest';
import { COMMON_UNITS, learnedUnits } from './unitLearning';

describe('learnedUnits', () => {
  it('ranks the shop units by use, case-insensitively, then adds unused common units', () => {
    const out = learnedUnits([
      { unit1: 'Case', unit2: 'pkt', unit3: null },
      { unit1: 'case ', unit2: 'PKT', unit3: 'pcs' },
      { unit1: 'case', unit2: null, unit3: null },
    ] as never);
    expect(out.slice(0, 3)).toEqual(['Case', 'pkt', 'pcs']);
    expect(out.filter((u) => u.toLowerCase() === 'pkt')).toHaveLength(1);
    expect(out).toContain('kg');
  });
  it('falls back to the common list for an empty catalog', () => {
    expect(learnedUnits([])).toEqual(COMMON_UNITS);
  });
});
