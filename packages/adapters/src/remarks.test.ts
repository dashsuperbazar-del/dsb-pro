import { describe, expect, it, vi } from 'vitest';
import { __setSupabaseClientForTest, type DsbSupabaseClient } from './client';
import {
  addRemarkOutcome,
  editRemarkOutcome,
  listDocumentRemarks,
  listOpenRemarks,
  openRemarksCapped,
  OPEN_REMARKS_CAP,
  plainRemarkRefusal,
  savedRemarkClientIds,
  settleRemarkOutcome,
} from './remarks';

const ID = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const rpcClient = (result: { data: unknown; error: unknown }) => {
  const rpc = vi.fn(async () => result);
  __setSupabaseClientForTest({ rpc } as unknown as DsbSupabaseClient);
  return rpc;
};

describe('remarks adapter (0067)', () => {
  it('adds with the client id the SQL function declares, trimmed', async () => {
    const rpc = rpcClient({ data: ID, error: null });
    const out = await addRemarkOutcome({
      shopId: 's',
      docKind: 'purchase',
      docId: DOC,
      body: '  5 kg sugar short ',
      clientId: 'c1',
    });
    expect(out).toEqual({ kind: 'committed', value: ID });
    expect(rpc).toHaveBeenCalledWith('add_document_remark', {
      p_shop_id: 's',
      p_doc_kind: 'purchase',
      p_doc_id: DOC,
      p_body: '5 kg sugar short',
      p_client_id: 'c1',
    });
  });
  it('refuses empty or long text before calling the server', async () => {
    const rpc = rpcClient({ data: ID, error: null });
    const base = { shopId: 's', docKind: 'sale' as const, docId: DOC, clientId: 'c' };
    expect((await addRemarkOutcome({ ...base, body: '   ' })).kind).toBe('rejected');
    expect((await addRemarkOutcome({ ...base, body: 'x'.repeat(301) })).kind).toBe('rejected');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a network failure is unknown (retry with the same id), never rejected', async () => {
    rpcClient({ data: null, error: { message: 'Failed to fetch' } });
    const out = await addRemarkOutcome({
      shopId: 's',
      docKind: 'sale',
      docId: DOC,
      body: 'x',
      clientId: 'c',
    });
    expect(out.kind).toBe('unknown');
  });
  it('a same-id mismatch is unknown, not rejected', async () => {
    rpcClient({ data: null, error: { code: 'P0001', message: 'DSB_PAYLOAD_MISMATCH: used' } });
    const out = await addRemarkOutcome({
      shopId: 's',
      docKind: 'sale',
      docId: DOC,
      body: 'x',
      clientId: 'c',
    });
    expect(out.kind).toBe('unknown');
  });
  it('edits carry the expected version; a stale edit is a rejection', async () => {
    const rpc = rpcClient({ data: null, error: { code: 'P0001', message: 'DSB_REMARK_STALE: x' } });
    const out = await editRemarkOutcome({ remarkId: ID, body: 'y', expectedVersion: 3 });
    expect(out).toMatchObject({ kind: 'rejected', code: 'DSB_REMARK_STALE' });
    expect(rpc).toHaveBeenCalledWith('edit_document_remark', {
      p_remark_id: ID,
      p_body: 'y',
      p_expected_version: 3,
    });
    expect(plainRemarkRefusal('DSB_REMARK_STALE: x')).toMatch(/changed this remark/);
  });
  it('settle answers the new version', async () => {
    rpcClient({ data: 2, error: null });
    expect(await settleRemarkOutcome(ID)).toEqual({ kind: 'committed', value: 2 });
  });
  it('reads remarks and open remarks strictly', async () => {
    rpcClient({
      data: [
        {
          remark_id: ID,
          doc_id: DOC,
          from_earlier_bill: true,
          body: 'b',
          status: 'OPEN',
          version: 1,
          created_by: 'u',
          created_at: 't',
          settled_by: null,
          settled_at: null,
        },
      ],
      error: null,
    });
    expect((await listDocumentRemarks('purchase', DOC))[0]).toMatchObject({
      id: ID,
      fromEarlierBill: true,
      status: 'OPEN',
    });
    rpcClient({ data: [{ remark_id: ID, doc_id: DOC, doc_kind: 'bad' }], error: null });
    await expect(listOpenRemarks('s')).rejects.toThrow(/unexpected/);
  });
});

describe('remarks fixes (0068)', () => {
  it('a full list of open remarks is flagged as capped', () => {
    expect(openRemarksCapped(new Array(OPEN_REMARKS_CAP - 1))).toBe(false);
    expect(openRemarksCapped(new Array(OPEN_REMARKS_CAP))).toBe(true);
  });
  it('finds which queued client ids the server already holds', async () => {
    const inFn = vi.fn(async () => ({ data: [{ client_id: 'c1' }], error: null }));
    const select = vi.fn(() => ({ in: inFn }));
    const from = vi.fn(() => ({ select }));
    __setSupabaseClientForTest({ from } as unknown as DsbSupabaseClient);
    const saved = await savedRemarkClientIds(['c1', 'c2']);
    expect(from).toHaveBeenCalledWith('document_remarks');
    expect(inFn).toHaveBeenCalledWith('client_id', ['c1', 'c2']);
    expect([...saved]).toEqual(['c1']);
    expect((await savedRemarkClientIds([])).size).toBe(0);
  });
  it('a failed lookup throws (the queued copy is kept, never dropped on a guess)', async () => {
    const select = vi.fn(() => ({
      in: async () => ({ data: null, error: { message: 'offline' } }),
    }));
    __setSupabaseClientForTest({ from: () => ({ select }) } as unknown as DsbSupabaseClient);
    await expect(savedRemarkClientIds(['c1'])).rejects.toThrow();
  });
});
