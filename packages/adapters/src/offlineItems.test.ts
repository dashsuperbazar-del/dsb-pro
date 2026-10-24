import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createItemV2Outcome, plainItemRefusal } from './offlineItems';

const { rpc, from, maybeSingle } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ rpc, from }) }));
const ITEM = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';
const input = {
  itemId: ITEM,
  clientId: REQ,
  item: { name: 'Atta', unit1: 'bag', unit2: 'kg', conv1: 10 },
};

beforeEach(() => {
  rpc.mockReset();
  maybeSingle.mockReset();
  from.mockReset();
  from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
});

describe('createItemV2Outcome', () => {
  it('sends the device id and fields; commits a create or a match', async () => {
    rpc.mockResolvedValueOnce({
      data: { itemId: ITEM, requestedItemId: ITEM, created: true, mapped: false },
      error: null,
    });
    await expect(createItemV2Outcome(input)).resolves.toEqual({
      kind: 'committed',
      value: { itemId: ITEM, mapped: false, name: null },
    });
    expect(rpc).toHaveBeenCalledWith('create_item_v2', {
      p_item_id: ITEM,
      p_client_id: REQ,
      p_item: {
        name: 'Atta',
        sku: null,
        unit1: 'bag',
        unit2: 'kg',
        unit3: null,
        conv1: 10,
        conv2: null,
        tax_rate_bp: 0,
      },
    });
    rpc.mockResolvedValueOnce({
      data: { itemId: OLD, requestedItemId: ITEM, created: false, mapped: true, name: 'ATTA' },
      error: null,
    });
    await expect(createItemV2Outcome(input)).resolves.toEqual({
      kind: 'committed',
      value: { itemId: OLD, mapped: true, name: 'ATTA' },
    });
  });

  it('never accepts another id unless it is a match', async () => {
    rpc.mockResolvedValueOnce({
      data: { itemId: OLD, requestedItemId: ITEM, mapped: false },
      error: null,
    });
    await expect(createItemV2Outcome(input)).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('a refusal is decided by the client-id lookup', async () => {
    const refusal = {
      data: null,
      error: { code: 'P0001', message: 'DSB_ITEM_NAME_TAKEN: an item called Atta already exists' },
    };
    rpc.mockResolvedValueOnce(refusal);
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(createItemV2Outcome(input)).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DSB_ITEM_NAME_TAKEN',
    });
    // A refused retry after a committed first send (e.g. permission revoked): the row proves the create.
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'not permitted' } });
    maybeSingle.mockResolvedValueOnce({ data: { id: ITEM }, error: null });
    await expect(createItemV2Outcome(input)).resolves.toEqual({
      kind: 'committed',
      value: { itemId: ITEM, mapped: false, name: null },
    });
    rpc.mockResolvedValueOnce(refusal);
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
    await expect(createItemV2Outcome(input)).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('a mismatch with no row under this request is a refusal; a network loss stays unknown', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'DSB_PAYLOAD_MISMATCH: item id already used' },
    });
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(createItemV2Outcome(input)).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DSB_PAYLOAD_MISMATCH',
    });
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(createItemV2Outcome(input)).resolves.toMatchObject({ kind: 'unknown' });
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('plain refusals', () => {
    expect(
      plainItemRefusal(
        'DSB_ITEM_NAME_TAKEN: an item called Atta already exists with different units',
      ),
    ).toMatch(/^an item called Atta/);
    expect(plainItemRefusal('not permitted')).toMatch(/owner or a manager/);
  });
});
