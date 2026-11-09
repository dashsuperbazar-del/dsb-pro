import { describe, expect, it } from 'vitest';
import { findSimilarParty, oldestUnpaidDays } from './partyNames';

const parties = [{ name: 'M.b lal Hindustan' }, { name: 'Tinku H.pada' }, { name: 'Shyam' }];

describe('findSimilarParty', () => {
  it('catches spacing, dots, case and small typos', () => {
    expect(findSimilarParty('M. B lal Hindustan', parties)?.name).toBe('M.b lal Hindustan');
    expect(findSimilarParty('tinku hpada', parties)?.name).toBe('Tinku H.pada');
    expect(findSimilarParty('Tinku H.padaa', parties)?.name).toBe('Tinku H.pada');
    expect(findSimilarParty('shyam', parties)?.name).toBe('Shyam');
  });
  it('does not flag different short names or blanks', () => {
    expect(findSimilarParty('Ram', parties)).toBeNull();
    expect(findSimilarParty('Goenka', parties)).toBeNull();
    expect(findSimilarParty('  ', parties)).toBeNull();
  });
});

describe('oldestUnpaidDays', () => {
  it('takes the oldest bill with money still due', () => {
    expect(
      oldestUnpaidDays([
        { ageDays: 150, clampedDuePaise: '0' },
        { ageDays: 96, clampedDuePaise: '500' },
        { ageDays: 10, clampedDuePaise: '100' },
      ]),
    ).toBe(96);
    expect(oldestUnpaidDays([])).toBeNull();
  });
});
