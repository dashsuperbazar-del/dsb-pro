import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mergeCatalog, watchOfflineCatalog } from './catalogWatch';

type It = { id: string; name: string };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('mergeCatalog keeps what is shown, lets fresh rows win, and sorts by name', () => {
  const merged = mergeCatalog<It>(
    [
      { id: 'b', name: 'Beta old' },
      { id: 'z', name: 'Zulu' },
    ],
    [
      { id: 'b', name: 'Beta new' },
      { id: 'a', name: 'Alpha' },
    ],
  );
  expect(merged.map((i) => `${i.id}:${i.name}`)).toEqual(['a:Alpha', 'b:Beta new', 'z:Zulu']);
});

test('a growing device catalog replaces a partial first page (the 1000-item POS bug)', async () => {
  let stored = 1000;
  const shown: number[] = [];
  const stop = watchOfflineCatalog({
    count: async () => stored,
    load: async () =>
      Array.from({ length: stored }, (_, i) => ({ id: String(i), name: String(i) })),
    onChange: (rows) => shown.push(rows.length),
    intervalMs: 2000,
  });
  await vi.advanceTimersByTimeAsync(0); // first look only records the starting size
  expect(shown).toEqual([]);
  stored = 7000;
  await vi.advanceTimersByTimeAsync(2000);
  stored = 10000;
  await vi.advanceTimersByTimeAsync(2000);
  expect(shown).toEqual([7000, 10000]);
  stop();
});

test('an unchanged catalog is never reloaded', async () => {
  const load = vi.fn(async () => []);
  const stop = watchOfflineCatalog({
    count: async () => 5,
    load,
    onChange: vi.fn(),
    intervalMs: 1000,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(load).not.toHaveBeenCalled();
  stop();
});

test('stopping ends all work, and a read error is ignored then retried', async () => {
  let n = 1;
  let fail = true;
  const seen: number[] = [];
  const stop = watchOfflineCatalog({
    count: async () => {
      if (fail) throw new Error('db closed');
      return n;
    },
    load: async () => [{ id: 'a', name: 'a' }],
    onChange: (rows) => seen.push(rows.length),
    intervalMs: 1000,
  });
  await vi.advanceTimersByTimeAsync(3000);
  fail = false;
  await vi.advanceTimersByTimeAsync(1000); // first successful look records the size
  n = 2;
  await vi.advanceTimersByTimeAsync(1000);
  expect(seen).toEqual([1]);
  stop();
  n = 3;
  await vi.advanceTimersByTimeAsync(5000);
  expect(seen).toEqual([1]);
});

test('a result that arrives after stop is dropped', async () => {
  let release: (() => void) | undefined;
  let n = 1;
  const seen: number[] = [];
  const stop = watchOfflineCatalog({
    count: async () => n,
    load: () => new Promise<It[]>((res) => (release = () => res([{ id: 'a', name: 'a' }]))),
    onChange: (rows) => seen.push(rows.length),
    intervalMs: 1000,
  });
  await vi.advanceTimersByTimeAsync(0);
  n = 2;
  await vi.advanceTimersByTimeAsync(1000);
  stop();
  release?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([]);
});
