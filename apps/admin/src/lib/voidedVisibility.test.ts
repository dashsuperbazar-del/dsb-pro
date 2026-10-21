// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hiddenNote, hideVoided, loadShowVoided, saveShowVoided } from './voidedVisibility';

const rows = [
  { id: 'a', status: 'POSTED' },
  { id: 'b', status: 'VOID' },
  { id: 'c', status: 'VOID' },
];
const isVoid = (r: { status: string }) => r.status === 'VOID';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('hideVoided', () => {
  it('hides voided rows by default and counts them', () => {
    const r = hideVoided(rows, isVoid, false);
    expect(r.shown.map((x) => x.id)).toEqual(['a']);
    expect(r.hidden).toBe(2);
  });
  it('shows everything, hidden 0, when asked', () => {
    const r = hideVoided(rows, isVoid, true);
    expect(r.shown).toHaveLength(3);
    expect(r.hidden).toBe(0);
  });
  it('handles an empty list and does not mutate the input', () => {
    expect(hideVoided([], isVoid, false)).toEqual({ shown: [], hidden: 0 });
    expect(rows).toHaveLength(3);
  });
});

describe('hiddenNote', () => {
  it('uses items wording', () => {
    expect(hiddenNote(0)).toBe('');
    expect(hiddenNote(1)).toBe(' 1 voided item hidden.');
    expect(hiddenNote(3)).toBe(' 3 voided items hidden.');
  });
});

describe('remembered choice', () => {
  it('is per user and scope, default off', () => {
    expect(loadShowVoided('purchases', 'u1')).toBe(false);
    saveShowVoided('purchases', 'u1', true);
    expect(loadShowVoided('purchases', 'u1')).toBe(true);
    expect(loadShowVoided('purchases', 'u2')).toBe(false);
    expect(loadShowVoided('sales', 'u1')).toBe(false);
    saveShowVoided('purchases', 'u1', false);
    expect(loadShowVoided('purchases', 'u1')).toBe(false);
  });
  it('works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadShowVoided('sales', 'u1')).toBe(false);
    expect(() => saveShowVoided('sales', 'u1', true)).not.toThrow();
  });
});
