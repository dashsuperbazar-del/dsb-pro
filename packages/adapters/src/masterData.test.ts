import { describe, expect, it, vi } from 'vitest';
import { collectPaginatedRows, createItem, findItemByClientId } from './masterData';

const client = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
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

describe('createItem (0073: online create shares create_item_v2 lock and rule)', () => {
  const C = 'b7300000-0000-4000-8000-000000000001';
  const itemRead = (row: unknown) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      single: async () => ({ data: row, error: null }),
    };
    client.from.mockReturnValue(chain);
  };
  it('creates through create_item_v2 with the client id as the item id (a retry is a replay)', async () => {
    client.rpc.mockResolvedValueOnce({
      data: { itemId: C, requestedItemId: C, created: true, mapped: false },
      error: null,
    });
    itemRead({ id: C, name: 'Tea' });
    await expect(
      createItem({
        tenantId: 't1',
        name: 'Tea',
        unit1: 'box',
        unit2: 'pack',
        conv1: 10,
        taxRateBp: 500,
        clientId: C,
      }),
    ).resolves.toEqual({ id: C, name: 'Tea', mapped: false });
    expect(client.rpc).toHaveBeenCalledWith('create_item_v2', {
      p_item_id: C,
      p_client_id: C,
      p_item: {
        name: 'Tea',
        sku: null,
        unit1: 'box',
        unit2: 'pack',
        unit3: null,
        conv1: 10,
        conv2: null,
        tax_rate_bp: 500,
      },
    });
  });
  it('returns the existing item, marked mapped, when the name and units already exist', async () => {
    client.rpc.mockResolvedValueOnce({
      data: { itemId: 'i-old', requestedItemId: C, created: false, mapped: true, name: 'Tea' },
      error: null,
    });
    itemRead({ id: 'i-old', name: 'Tea' });
    await expect(
      createItem({ tenantId: 't1', name: 'tea', unit1: 'box', clientId: C }),
    ).resolves.toEqual({
      id: 'i-old',
      name: 'Tea',
      mapped: true,
    });
  });
  it('refuses a taken name with other units in plain words', async () => {
    client.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        message:
          'DSB_ITEM_NAME_TAKEN: an item called Tea already exists with different units; pick that item or use another name',
      },
    });
    await expect(
      createItem({ tenantId: 't1', name: 'Tea', unit1: 'kg', clientId: C }),
    ).rejects.toThrow(/already exists/);
  });
  it('rejects a malformed answer instead of guessing', async () => {
    client.rpc.mockResolvedValueOnce({
      data: { itemId: 'other', requestedItemId: C, mapped: false },
      error: null,
    });
    await expect(
      createItem({ tenantId: 't1', name: 'Tea', unit1: 'kg', clientId: C }),
    ).rejects.toThrow();
  });
});
