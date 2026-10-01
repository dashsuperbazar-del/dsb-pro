import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postExpenseOutcome, postStockCountOutcome } from './outcomes';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ rpc, from }) }));
const U = '11111111-1111-4111-8111-111111111111';
const expense = () =>
  postExpenseOutcome({
    shopId: U,
    businessDate: '2026-10-01',
    category: 'Rent',
    description: 'Rent',
    amountPaise: 1000,
    mode: 'cash',
    reference: null,
    clientId: U,
  });
const status = (s: string | null) =>
  from.mockReturnValueOnce({
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: s ? { status: s } : null, error: null }),
      }),
    }),
  });
beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

describe('write outcomes (V002 VF-006)', () => {
  it('a verified id is committed', async () => {
    rpc.mockResolvedValue({ data: U, error: null });
    await expect(expense()).resolves.toEqual({ kind: 'committed', value: U });
  });
  it('a raised database error is a rejection', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'amount must be positive' },
    });
    await expect(expense()).resolves.toMatchObject({ kind: 'rejected' });
  });
  it.each([
    ['abort', { message: 'AbortError: The operation was aborted.', code: '' }],
    ['timeout', { message: 'Request timed out' }],
    ['gateway', { message: 'Bad Gateway', code: '502' }],
    ['deadlock', { message: 'deadlock detected', code: '40P01' }],
    ['payload mismatch', { message: 'DSB_PAYLOAD_MISMATCH: x', code: 'P0001' }],
  ])('%s is unknown, never a rejection', async (_n, error) => {
    rpc.mockResolvedValue({ data: null, error });
    await expect(expense()).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('a thrown transport error is unknown', async () => {
    rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(expense()).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('an unverifiable success answer is unknown', async () => {
    rpc.mockResolvedValue({ data: 'not-a-uuid', error: null });
    await expect(expense()).resolves.toMatchObject({ kind: 'unknown' });
  });
});

describe('stock count resumes by client id (V002 VF-005)', () => {
  const count = () =>
    postStockCountOutcome({
      shopId: U,
      businessDate: '2026-10-01',
      lines: [{ item_id: U, counted_qty: 7 }],
      notes: 'n',
      clientId: U,
    });
  it('an already posted count is committed without posting again', async () => {
    rpc.mockResolvedValueOnce({ data: U, error: null });
    status('POSTED');
    await expect(count()).resolves.toEqual({
      kind: 'committed',
      value: { countId: U, alreadyPosted: true },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('a draft is posted', async () => {
    rpc
      .mockResolvedValueOnce({ data: U, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    status('DRAFT');
    await expect(count()).resolves.toEqual({
      kind: 'committed',
      value: { countId: U, alreadyPosted: false },
    });
  });
  it('a rejection raced by an earlier attempt that posted it is committed', async () => {
    rpc.mockResolvedValueOnce({ data: U, error: null }).mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'stock count unavailable' },
    });
    status('DRAFT');
    status('POSTED');
    await expect(count()).resolves.toMatchObject({
      kind: 'committed',
      value: { alreadyPosted: true },
    });
  });
  it('a recount rejection on a still-draft count is a rejection', async () => {
    rpc.mockResolvedValueOnce({ data: U, error: null }).mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'stock changed since count was captured; recount required' },
    });
    status('DRAFT');
    status('DRAFT');
    await expect(count()).resolves.toMatchObject({ kind: 'rejected' });
  });
});

describe('a rejected RETRY is verified by client id (V2 review M2)', () => {
  const lookup = (id: string | null, error: unknown = null) =>
    from.mockReturnValueOnce({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: id ? { id } : null, error }) }),
      }),
    });
  const retry = () =>
    postExpenseOutcome({
      isRetry: true,
      shopId: U,
      businessDate: '2026-10-01',
      category: 'Rent',
      description: 'Rent',
      amountPaise: 1000,
      mode: 'cash',
      reference: null,
      clientId: U,
    });
  it('an existing row means the first send committed', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'not permitted' } });
    lookup(U);
    await expect(retry()).resolves.toEqual({ kind: 'committed', value: U });
  });
  it('an access refusal with no visible row stays unknown', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'not permitted' } });
    lookup(null);
    await expect(retry()).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('a validation refusal with no row is a rejection', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'amount must be positive' },
    });
    lookup(null);
    await expect(retry()).resolves.toMatchObject({ kind: 'rejected' });
  });
  it('a failed lookup stays unknown', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'amount must be positive' },
    });
    lookup(null, { message: 'network' });
    await expect(retry()).resolves.toMatchObject({ kind: 'unknown' });
  });
});
