import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
import {
  findBillsByCode,
  isMissingBillCodeColumn,
  readBillCodes,
  relabelRawIds,
  resetBillCodeSupport,
  withBillCode,
} from './billCodes';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
beforeEach(() => {
  vi.resetAllMocks();
  resetBillCodeSupport();
});

test('a database without the column is read again without it, once, and remembered', async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({
      data: null,
      error: { code: '42703', message: 'column bill_code does not exist' },
    })
    .mockResolvedValue({ data: [1], error: null });
  expect(await withBillCode(run)).toEqual({ data: [1], error: null });
  expect(run.mock.calls.map((c) => c[0])).toEqual([true, false]);
  await withBillCode(run);
  expect(run.mock.calls.map((c) => c[0])).toEqual([true, false, false]);
});
test('any other error is returned unchanged and not retried', async () => {
  const run = vi
    .fn()
    .mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } });
  expect((await withBillCode(run)).error?.code).toBe('42501');
  expect(run).toHaveBeenCalledTimes(1);
  expect(isMissingBillCodeColumn({ code: '42703' })).toBe(true);
  expect(isMissingBillCodeColumn(null)).toBe(false);
});

test('codes are read for valid ids only and a failed table leaves a gap, never an error', async () => {
  const q = (result: unknown) => ({ select: () => ({ in: vi.fn().mockResolvedValue(result) }) });
  mocks.from.mockImplementation((t: string) =>
    t === 'purchase_bills'
      ? q({ data: [{ id: A, bill_code: 'K7M2-QX9P' }], error: null })
      : q({ data: null, error: { code: '42501', message: 'denied' } }),
  );
  const codes = await readBillCodes([A, 'not-a-uuid', A, B]);
  expect([...codes]).toEqual([[A, 'K7M2-QX9P']]);
});

test('a raw uuid label becomes the bill code; a typed bill no. and unreadable codes stay', async () => {
  const q = (result: unknown) => ({ select: () => ({ in: vi.fn().mockResolvedValue(result) }) });
  mocks.from.mockImplementation((t: string) =>
    t === 'purchase_bills'
      ? q({
          data: [
            { id: A, bill_code: 'K7M2-QX9P' },
            { id: B, bill_code: 'ZZZZ-2222' },
          ],
          error: null,
        })
      : q({ data: [], error: null }),
  );
  const rows = [
    { id: A, document: A, amount: '100' },
    { id: B, document: 'INV-9', amount: '200' },
    { id: 'c', document: 'c', amount: '300' },
  ];
  const out = await relabelRawIds(
    rows,
    (r) => r.id,
    (r) => r.document,
    (r, code) => ({ ...r, document: code }),
  );
  expect(out).toEqual([
    { id: A, document: 'K7M2-QX9P', amount: '100' },
    { id: B, document: 'INV-9', amount: '200' },
    { id: 'c', document: 'c', amount: '300' },
  ]);
  mocks.from.mockImplementation(() => {
    throw new Error('offline');
  });
  expect(
    await relabelRawIds(
      rows,
      (r) => r.id,
      (r) => r.document,
      (r, code) => ({ ...r, document: code }),
    ),
  ).toBe(rows);
});

test('code search needs 4 characters, tolerates a database without it and surfaces other failures', async () => {
  expect(await findBillsByCode('shop', 'K7M')).toEqual([]);
  expect(mocks.rpc).not.toHaveBeenCalled();
  mocks.rpc.mockResolvedValueOnce({
    data: [
      {
        kind: 'sale',
        id: A,
        bill_code: 'K7M2-QX9P',
        doc_no: 'S-1',
        party_id: null,
        business_date: '2026-10-01',
        total_paise: '1500',
        status: 'FINALIZED',
      },
    ],
    error: null,
  });
  const hits = await findBillsByCode('shop', 'k7m2-qx');
  expect(mocks.rpc).toHaveBeenCalledWith('find_bills_by_code', {
    p_shop_id: 'shop',
    p_query: 'k7m2-qx',
  });
  expect(hits[0]).toMatchObject({ kind: 'sale', bill_code: 'K7M2-QX9P', total_paise: 1500 });
  mocks.rpc.mockResolvedValueOnce({
    data: null,
    error: { code: 'PGRST202', message: 'not found' },
  });
  expect(await findBillsByCode('shop', 'k7m2')).toEqual([]);
  mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
  await expect(findBillsByCode('shop', 'k7m2')).rejects.toThrow(/timeout/);
});
