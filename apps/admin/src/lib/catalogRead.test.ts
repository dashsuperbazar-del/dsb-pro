import { expect, test, vi } from 'vitest';
import { readCatalogForScreen } from './catalogRead';

type It = { id: string; name: string };
const rows = (n: number): It[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: `n${i}` }));

test('a device catalog that has completed a sync is used and the server catalog is not downloaded', async () => {
  const server = vi.fn(async () => rows(5));
  const out = await readCatalogForScreen({ device: async () => rows(276), server });
  expect(out.source).toBe('device');
  expect(out.items).toHaveLength(276);
  expect(server).not.toHaveBeenCalled();
});

test('an empty but synced catalog is still the device answer (a new shop has no items yet)', async () => {
  const server = vi.fn(async () => rows(5));
  const out = await readCatalogForScreen({ device: async () => [], server });
  expect(out).toEqual({ source: 'device', items: [] });
  expect(server).not.toHaveBeenCalled();
});

test('a device cache that has not finished a sync (null) is read from the server instead', async () => {
  const server = vi.fn(async () => rows(3));
  const out = await readCatalogForScreen({ device: async () => null, server });
  expect(out).toEqual({ source: 'server', items: rows(3) });
});

test('a device cache that is not ready falls back to the server', async () => {
  const server = vi.fn(async () => rows(2));
  const out = await readCatalogForScreen({
    device: async () => {
      throw new Error('Offline sync is not running.');
    },
    server,
  });
  expect(out.source).toBe('server');
});

test('a server failure with no usable device cache is an error, not an empty list', async () => {
  await expect(
    readCatalogForScreen({
      device: async () => null,
      server: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow('offline');
});
