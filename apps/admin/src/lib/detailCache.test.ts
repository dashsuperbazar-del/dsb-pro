import { describe, expect, it, vi } from 'vitest';
import { createDetailCache } from './detailCache';

describe('detail cache (display only)', () => {
  it('shares one in-flight read per key and keeps the result', async () => {
    const load = vi.fn(async (k: string) => `v:${k}`);
    const c = createDetailCache(load, 2);
    const [a, b] = await Promise.all([c.fetch('x'), c.fetch('x')]);
    expect(a).toBe('v:x');
    expect(b).toBe('v:x');
    expect(load).toHaveBeenCalledTimes(1);
    expect(c.peek('x')).toBe('v:x');
  });
  it('evicts the least recently used entry and forgets on invalidate', async () => {
    const c = createDetailCache(async (k: string) => k, 2);
    await c.fetch('a');
    await c.fetch('b');
    c.peek('a');
    await c.fetch('c');
    expect(c.peek('b')).toBeUndefined();
    expect(c.peek('a')).toBe('a');
    c.invalidate('a');
    expect(c.peek('a')).toBeUndefined();
    c.clear();
    expect(c.peek('c')).toBeUndefined();
  });
  it('does not cache failures, and a read started before invalidate is not stored', async () => {
    let fail = true;
    const c = createDetailCache(async (k: string) => {
      if (fail) throw new Error('down');
      return k;
    }, 2);
    await expect(c.fetch('a')).rejects.toThrow('down');
    expect(c.peek('a')).toBeUndefined();
    fail = false;
    const p = c.fetch('a');
    c.invalidate('a');
    await p;
    expect(c.peek('a')).toBeUndefined();
  });
});
