import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSupplierOutstanding,
  lookupSupplierRequest,
  recordSupplierPayment,
  releaseSupplierAllocation,
} from './supplierPayments';
import { recordCustomerPaymentV2 } from './supplierPayments';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ rpc }) }));
const U = '11111111-1111-4111-8111-111111111111',
  B = '22222222-2222-4222-8222-222222222222';
const rec = () =>
  recordSupplierPayment({
    requestId: U,
    shopId: U,
    partyId: U,
    businessDate: '2026-10-01',
    amountPaise: '100000',
    mode: 'cash',
    allocations: [{ purchaseBillId: B, amountPaise: '40000' }],
  });
beforeEach(() => rpc.mockReset());

describe('supplier payment adapter', () => {
  it('sends the request id and snake_case allocations', async () => {
    rpc.mockResolvedValue({ data: U, error: null });
    await expect(rec()).resolves.toEqual({ kind: 'committed', result: { paymentId: U } });
    expect(rpc).toHaveBeenCalledWith(
      'record_supplier_payment',
      expect.objectContaining({
        p_client_id: U,
        p_amount_paise: 100000,
        p_allocations: [{ purchase_bill_id: B, amount_paise: 40000 }],
      }),
    );
  });
  it('keeps the structured DSB code on a definitive rejection', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'DSB_ALLOCATION_EXCEEDS_BILL: allocation exceeds bill' },
    });
    await expect(rec()).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DSB_ALLOCATION_EXCEEDS_BILL',
    });
  });
  it('never treats an existing request id (payload mismatch) as a rejection', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'DSB_PAYLOAD_MISMATCH: client_id already used for a different request',
      },
    });
    await expect(rec()).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('treats network loss, timeouts and deadlocks as unknown, never as failure', async () => {
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(rec()).resolves.toMatchObject({ kind: 'unknown' });
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    });
    await expect(rec()).resolves.toMatchObject({ kind: 'unknown' });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '', message: 'FetchError: 502' } });
    await expect(rec()).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('rejects a malformed acknowledgment as unknown', async () => {
    rpc.mockResolvedValue({ data: 'not-a-uuid', error: null });
    await expect(rec()).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('accepts a release acknowledgment as the allocation id', async () => {
    rpc.mockResolvedValue({ data: B, error: null });
    await expect(
      releaseSupplierAllocation({ requestId: U, allocationId: B, reason: 'wrong bill' }),
    ).resolves.toEqual({ kind: 'committed', result: { allocationId: B } });
  });
  it('maps request lookup states', async () => {
    rpc.mockResolvedValueOnce({ data: { state: 'NOT_FOUND' }, error: null });
    await expect(lookupSupplierRequest(U, 'supplier.record.v1', U)).resolves.toEqual({
      kind: 'not_found',
    });
    rpc.mockResolvedValueOnce({
      data: { state: 'COMMITTED', result: { paymentId: U }, currentStatus: 'POSTED' },
      error: null,
    });
    await expect(lookupSupplierRequest(U, 'supplier.record.v1', U)).resolves.toMatchObject({
      kind: 'committed',
      currentStatus: 'POSTED',
    });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'not permitted' } });
    await expect(lookupSupplierRequest(U, 'supplier.record.v1', U)).resolves.toMatchObject({
      kind: 'unavailable',
    });
  });
  it('keeps a malformed committed status answer unresolved', async () => {
    rpc.mockResolvedValue({
      data: { state: 'COMMITTED', result: { paymentId: 'nope' } },
      error: null,
    });
    await expect(lookupSupplierRequest(U, 'supplier.record.v1', U)).resolves.toMatchObject({
      kind: 'unavailable',
    });
  });
  it('sends customer v2 receipts with the request id and checks the ack', async () => {
    rpc.mockResolvedValue({ data: U, error: null });
    const input = {
      requestId: U,
      shopId: U,
      customerId: U,
      businessDate: null,
      amountPaise: '500',
      mode: 'upi' as const,
      allocations: [{ saleInvoiceId: B, amountPaise: '200' }],
    };
    await expect(recordCustomerPaymentV2(input)).resolves.toEqual({
      kind: 'committed',
      result: { paymentId: U },
    });
    expect(rpc).toHaveBeenCalledWith(
      'record_customer_payment_v2',
      expect.objectContaining({
        p_client_id: U,
        p_allocations: [{ sale_invoice_id: B, amount_paise: 200 }],
      }),
    );
    rpc.mockResolvedValue({ data: 'x', error: null });
    await expect(recordCustomerPaymentV2(input)).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('refuses a non-integer-text outstanding report', async () => {
    rpc.mockResolvedValue({
      data: {
        parties: [
          {
            partyId: U,
            partyName: 'A',
            grossOpenBills: '1.5',
            unallocatedCashAdvances: '0',
            returnCredits: '0',
            netLedgerBalance: '0',
            strandedAllocationsOnVoidBills: 0,
          },
        ],
      },
      error: null,
    });
    await expect(getSupplierOutstanding(U)).rejects.toThrow(/Malformed/);
  });
});
