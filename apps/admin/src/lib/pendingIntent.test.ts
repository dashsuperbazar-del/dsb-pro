import { beforeEach, describe, expect, it } from 'vitest';
import { clearPendingIntent, loadPendingIntent, savePendingIntent } from './pendingIntent';

const store = new Map<string, string>();
let refuse = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (refuse) throw new Error('QuotaExceededError');
    store.set(k, v);
  },
  removeItem: (k: string) => store.delete(k),
  get length() {
    return store.size;
  },
  key: (i: number) => [...store.keys()][i] ?? null,
};
beforeEach(() => {
  store.clear();
  refuse = false;
});

describe('pending intent slot', () => {
  it('fails closed when storage refuses the write', () => {
    refuse = true;
    expect(() => savePendingIntent('k', { clientId: 'a' })).toThrow(/Nothing was sent/);
  });
  it("never overwrites another window's unconfirmed entry (V2 review M1)", () => {
    savePendingIntent('k', { clientId: 'a', amount: 1 });
    expect(() => savePendingIntent('k', { clientId: 'b', amount: 2 })).toThrow(/Another window/);
    expect(loadPendingIntent<{ clientId: string }>('k')).toMatchObject({
      ok: true,
      value: { clientId: 'a', amount: 1 },
    });
  });
  it('the same entry can be saved again (retry)', () => {
    savePendingIntent('k', { clientId: 'a' });
    expect(() => savePendingIntent('k', { clientId: 'a' })).not.toThrow();
  });
  it("clearing only removes one's own entry", () => {
    savePendingIntent('k', { clientId: 'a' });
    clearPendingIntent('k', 'b');
    expect(store.size).toBe(1);
    clearPendingIntent('k', 'a');
    expect(store.size).toBe(0);
  });
  it('two windows racing past the check keep separate entries, restored oldest first (Codex P1)', () => {
    // Both windows passed the empty-slot check before either wrote: each write uses its own key.
    store.set('k:a', JSON.stringify({ clientId: 'a', savedAt: 1 }));
    store.set('k:b', JSON.stringify({ clientId: 'b', savedAt: 2 }));
    expect(loadPendingIntent<{ clientId: string }>('k')).toMatchObject({
      value: { clientId: 'a' },
    });
    clearPendingIntent('k', 'a');
    expect(loadPendingIntent<{ clientId: string }>('k')).toMatchObject({
      value: { clientId: 'b' },
    });
  });
  it('still reads the legacy single-key entry', () => {
    store.set('k', JSON.stringify({ clientId: 'old' }));
    expect(loadPendingIntent<{ clientId: string }>('k')).toMatchObject({
      value: { clientId: 'old' },
    });
    clearPendingIntent('k', 'old');
    expect(store.size).toBe(0);
  });
});
