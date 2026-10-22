import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ from: mocks.from }) }));
import { resetBillCodeSupport } from './billCodes';
import { labelPurchaseRegister, labelSupplierAging } from './reportLabels';
import type { AgingReportV2, PurchaseRegisterRow } from './reports';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
beforeEach(() => {
  vi.resetAllMocks();
  resetBillCodeSupport();
});
const codes = (rows: Array<{ id: string; bill_code: string }>) =>
  mocks.from.mockImplementation(() => ({
    select: () => ({ in: vi.fn().mockResolvedValue({ data: rows, error: null }) }),
  }));

test('only purchase bills are read for purchase reports, and a typed number is kept', async () => {
  codes([{ id: A, bill_code: 'K7M2-QX9P' }]);
  const rows = [
    { bill_id: A, doc_no: A },
    { bill_id: 'b2', doc_no: 'INV-2' },
  ] as unknown as PurchaseRegisterRow[];
  const out = await labelPurchaseRegister(rows);
  expect(out.map((r) => r.doc_no)).toEqual(['K7M2-QX9P', 'INV-2']);
  expect(mocks.from.mock.calls.map((c) => c[0])).toEqual(['purchase_bills']);
});

test('aging details are relabelled by position: two rows of one document id each keep their own place', async () => {
  codes([{ id: A, bill_code: 'K7M2-QX9P' }]);
  const detail = (documentNo: string, documentId = A) => ({ documentId, documentNo });
  const report = {
    accounts: [
      { name: 'one', details: [detail(A), detail('OPENING', A)] },
      { name: 'two', details: [detail(A)] },
      { name: 'three', details: undefined },
    ],
  } as unknown as AgingReportV2;
  const out = await labelSupplierAging(report);
  expect(out.accounts.map((a) => (a.details ?? []).map((d) => d.documentNo))).toEqual([
    ['K7M2-QX9P', 'OPENING'],
    ['K7M2-QX9P'],
    [],
  ]);
});

test('a failed read leaves the report exactly as the server returned it', async () => {
  mocks.from.mockImplementation(() => {
    throw new Error('offline');
  });
  const report = {
    accounts: [{ details: [{ documentId: A, documentNo: A }] }],
  } as unknown as AgingReportV2;
  expect(await labelSupplierAging(report)).toBe(report);
});
