import { beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ listener: null as null | (() => void) }));
vi.mock('@dsb-pro/adapters', () => ({
  onAuthStateChange: vi.fn((cb: () => void) => {
    auth.listener = cb;
    return () => {};
  }),
  getSession: vi.fn(),
}));
import { clearSnapshots, peekSnapshot, putSnapshot, snapshotAge } from './routeSnapshot';

beforeEach(() => clearSnapshots());

describe('route snapshots', () => {
  it('returns the last value only to the same user and shop', () => {
    putSnapshot('list', 'u1', 's1', [1, 2], 1000);
    expect(peekSnapshot('list', 'u1', undefined, 2000)?.value).toEqual([1, 2]);
    expect(peekSnapshot('list', 'u1', 's1', 2000)?.shopId).toBe('s1');
    expect(peekSnapshot('list', 'u2', undefined, 2000)).toBeNull();
    expect(peekSnapshot('list', 'u1', 's2', 2000)).toBeNull();
    expect(peekSnapshot('list', '', undefined, 2000)).toBeNull();
  });
  it('expires after 12 hours and ignores incomplete identities', () => {
    putSnapshot('list', 'u1', 's1', 1, 0);
    expect(peekSnapshot('list', 'u1', undefined, 12 * 3600_000 + 1)).toBeNull();
    putSnapshot('list', '', 's1', 1, 0);
    expect(peekSnapshot('list', '', undefined, 1)).toBeNull();
  });
  it('describes the age plainly', () => {
    expect(snapshotAge(0, 30_000)).toBe('just now');
    expect(snapshotAge(0, 5 * 60_000)).toBe('5 min ago');
    expect(snapshotAge(0, 3 * 3600_000)).toBe('3 h ago');
  });
});

describe('sign-in changes', () => {
  it('any auth event drops every snapshot', () => {
    putSnapshot('list', 'u1', 's1', 1);
    expect(auth.listener).not.toBeNull();
    auth.listener!();
    expect(peekSnapshot('list', 'u1')).toBeNull();
  });
});
