import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mergeCatalog, watchOfflineCatalog } from './catalogWatch';

type It = { id: string; name: string };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('mergeCatalog only adds: shown rows win, nothing is removed, result is sorted', () => {
  const shown: It[] = [
    { id: 'b', name: 'Beta shown' },
    { id: 'z', name: 'Zulu' },
  ];
  const merged = mergeCatalog(shown, [
    { id: 'b', name: 'Beta from cache' },
    { id: 'a', name: 'Alpha' },
  ]);
  expect(merged.map((i) => `${i.id}:${i.name}`)).toEqual(['a:Alpha', 'b:Beta shown', 'z:Zulu']);
});

test('mergeCatalog returns the very same array when there is nothing to add', () => {
  const shown: It[] = [{ id: 'a', name: 'A' }];
  expect(mergeCatalog(shown, [{ id: 'a', name: 'A changed' }])).toBe(shown);
  expect(mergeCatalog(shown, [])).toBe(shown);
});

test('an item archived while the screen is open is not resurrected and a newer shown row is kept', () => {
  const shown: It[] = [{ id: 'live', name: 'Edited just now' }];
  // The cache no longer holds an archived item and holds an older copy of the live one.
  const merged = mergeCatalog(shown, [{ id: 'live', name: 'Older cached copy' }]);
  expect(merged).toBe(shown);
  expect(merged[0].name).toBe('Edited just now');
});

test('a growing device catalog is reloaded as it fills (the 1000-item POS bug)', async () => {
  let stored = 1000;
  const shown: number[] = [];
  const stop = watchOfflineCatalog({
    count: async () => stored,
    load: async () =>
      Array.from({ length: stored }, (_, i) => ({ id: String(i), name: String(i) })),
    onChange: (rows) => shown.push(rows.length),
    intervalMs: 2000,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(shown).toEqual([1000]); // first look loads once
  stored = 7000;
  await vi.advanceTimersByTimeAsync(2000);
  stored = 10000;
  await vi.advanceTimersByTimeAsync(2000);
  expect(shown).toEqual([1000, 7000, 10000]);
  stop();
});

test('growth between the screen painting and the first look is still picked up', async () => {
  // POS painted 1,000 items; by the first look the device already holds 10,000 and stops growing.
  const shown: number[] = [];
  const stop = watchOfflineCatalog({
    count: async () => 10000,
    load: async () => Array.from({ length: 10000 }, (_, i) => ({ id: String(i), name: String(i) })),
    onChange: (rows) => shown.push(rows.length),
    intervalMs: 2000,
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(shown).toEqual([10000]);
  stop();
});

test('an unchanged or shrinking catalog is not reloaded again', async () => {
  let n = 5;
  const load = vi.fn(async () => []);
  const stop = watchOfflineCatalog({
    count: async () => n,
    load,
    onChange: vi.fn(),
    intervalMs: 1000,
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(1);
  n = 3;
  await vi.advanceTimersByTimeAsync(3000);
  expect(load).toHaveBeenCalledTimes(1);
  n = 4; // grows again from the new lower baseline
  await vi.advanceTimersByTimeAsync(1000);
  expect(load).toHaveBeenCalledTimes(2);
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
  expect(seen).toEqual([]);
  fail = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(seen).toEqual([1]);
  n = 2;
  await vi.advanceTimersByTimeAsync(1000);
  expect(seen).toEqual([1, 1]);
  stop();
  n = 3;
  await vi.advanceTimersByTimeAsync(5000);
  expect(seen).toEqual([1, 1]);
});

test('a result that arrives after stop is dropped', async () => {
  let release: (() => void) | undefined;
  const seen: number[] = [];
  const stop = watchOfflineCatalog({
    count: async () => 1,
    load: () => new Promise<It[]>((res) => (release = () => res([{ id: 'a', name: 'a' }]))),
    onChange: (rows) => seen.push(rows.length),
    intervalMs: 1000,
  });
  await vi.advanceTimersByTimeAsync(0);
  stop();
  release?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([]);
});
