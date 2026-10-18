import { describe, expect, it, vi } from 'vitest';
import { __setSupabaseClientForTest, type DsbSupabaseClient } from './client';
import { getPartyMergePreview, listSupplierDuplicateBills, mergeParties } from './partyMerge';

const rpcClient = (result: { data: unknown; error: unknown }) => {
  const rpc = vi.fn(async () => result);
  __setSupabaseClientForTest({ rpc } as unknown as DsbSupabaseClient);
  return rpc;
};

describe('party merge adapter', () => {
  it('sends the arguments the SQL function declares', async () => {
    const rpc = rpcClient({ data: 'm1', error: null });
    expect(await mergeParties({ sourcePartyId: 'a', targetPartyId: 'b', requestId: 'r' })).toBe(
      'm1',
    );
    expect(rpc).toHaveBeenCalledWith('merge_parties', {
      p_source_party_id: 'a',
      p_target_party_id: 'b',
      p_client_id: 'r',
    });
  });
  it('refuses merging a supplier into itself before calling the server', async () => {
    const rpc = rpcClient({ data: 'm1', error: null });
    await expect(
      mergeParties({ sourcePartyId: 'a', targetPartyId: 'a', requestId: 'r' }),
    ).rejects.toThrow('two different suppliers');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('shows the server refusal in plain words', async () => {
    rpcClient({
      data: null,
      error: {
        message:
          'DSB_MERGE_OPENING_CONFLICT: both suppliers have an opening balance in the same shop; void one and record the combined opening first',
      },
    });
    await expect(
      mergeParties({ sourcePartyId: 'a', targetPartyId: 'b', requestId: 'r' }),
    ).rejects.toThrow(/^Both suppliers have an opening balance/);
  });
  it('rejects an unexpected merge reply', async () => {
    rpcClient({ data: null, error: null });
    await expect(
      mergeParties({ sourcePartyId: 'a', targetPartyId: 'b', requestId: 'r' }),
    ).rejects.toThrow('unexpected');
  });
  it('reads identical-bill groups and validates them', async () => {
    const rpc = rpcClient({
      data: [
        { billNo: 'rt-1', businessDate: '2026-09-10', totalPaise: '10000', billIds: ['x', 'y'] },
      ],
      error: null,
    });
    expect(await listSupplierDuplicateBills('s', 'p')).toEqual([
      { billNo: 'rt-1', businessDate: '2026-09-10', totalPaise: '10000', billIds: ['x', 'y'] },
    ]);
    expect(rpc).toHaveBeenCalledWith('get_supplier_duplicate_bills', {
      p_shop_id: 's',
      p_party_id: 'p',
    });
    rpcClient({
      data: [{ billNo: '', businessDate: '2026-09-10', totalPaise: '-1', billIds: ['x', 'y'] }],
      error: null,
    });
    await expect(listSupplierDuplicateBills('s', 'p')).rejects.toThrow('unexpected');
  });
  it('reads the merge preview, signed balance included', async () => {
    const rpc = rpcClient({
      data: {
        bills: 2,
        payments: 1,
        returns: 0,
        openings: 0,
        openingConflict: false,
        combinedBalancePaise: '-500',
      },
      error: null,
    });
    expect(await getPartyMergePreview('s', 'a', 'b')).toEqual({
      bills: 2,
      payments: 1,
      returns: 0,
      openings: 0,
      openingConflict: false,
      combinedBalancePaise: '-500',
    });
    expect(rpc).toHaveBeenCalledWith('get_party_merge_preview', {
      p_shop_id: 's',
      p_source_party_id: 'a',
      p_target_party_id: 'b',
    });
    rpcClient({
      data: {
        bills: -1,
        payments: 1,
        returns: 0,
        openings: 0,
        openingConflict: false,
        combinedBalancePaise: '0',
      },
      error: null,
    });
    await expect(getPartyMergePreview('s', 'a', 'b')).rejects.toThrow('unexpected');
  });
});
