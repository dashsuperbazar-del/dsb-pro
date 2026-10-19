import { describe, expect, it, vi } from 'vitest';
import { collectPaginatedRows, findItemByClientId } from './masterData';

const client = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => client }));

describe('findItemByClientId', () => {
  it('reads the tenant item saved under that client id through the RLS items read', async () => {
    const calls: unknown[][] = [];
    const chain = {
      select: (...a: unknown[]) => (calls.push(['select', ...a]), chain),
      eq: (...a: unknown[]) => (calls.push(['eq', ...a]), chain),
      maybeSingle: async () => ({ data: { id: 'i1', name: 'Rice' }, error: null }),
    };
    client.from.mockReturnValue(chain);
    await expect(findItemByClientId('t1', 'c1')).resolves.toEqual({ id: 'i1', name: 'Rice' });
    expect(client.from).toHaveBeenCalledWith('items');
    expect(calls).toContainEqual(['eq', 'tenant_id', 't1']);
    expect(calls).toContainEqual(['eq', 'client_id', 'c1']);
  });

  it('returns null when no item has that client id, and throws on a read error', async () => {
    const maybeSingle = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    const chain = { select: () => chain, eq: () => chain, maybeSingle };
    client.from.mockReturnValue(chain);
    await expect(findItemByClientId('t1', 'c1')).resolves.toBeNull();
    await expect(findItemByClientId('t1', 'c1')).rejects.toThrow('permission denied');
  });
});

describe('collectPaginatedRows', () => {
  it('loads all 10,000 rows instead of stopping at the API response cap', async () => {
    const source = Array.from({ length: 10_000 }, (_, i) => i);
    const readPage = vi.fn(async (from: number, to: number) => source.slice(from, to + 1));

    const rows = await collectPaginatedRows(readPage, 1000);

    expect(rows).toEqual(source);
    expect(readPage).toHaveBeenCalledTimes(11);
    expect(readPage).toHaveBeenLastCalledWith(10_000, 10_999);
  });

  it('rejects an invalid page size instead of looping forever', async () => {
    await expect(collectPaginatedRows(async () => [], 0)).rejects.toThrow(
      'Page size must be a positive integer.',
    );
  });
});
