import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSupplierPayContext,
  paySupplierIfUnchangedOutcome,
  plainOfflineSupplierPaymentRefusal,
} from './offlineSupplierPayments';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ rpc }) }));
const SHOP = '33333333-3333-4333-8333-333333333333';
const PARTY = '11111111-1111-4111-8111-111111111111';
const BILL = '44444444-4444-4444-8444-444444444444';
const REQ = '22222222-2222-4222-8222-222222222222';
const PAY = '55555555-5555-4555-8555-555555555555';
const V = '0123456789abcdef0123456789abcdef';
const input = {
  requestId: REQ,
  shopId: SHOP,
  partyId: PARTY,
  businessDate: '2026-10-26',
  amountPaise: '6000',
  mode: 'cash' as const,
  reference: null,
  allocations: [{ purchaseBillId: BILL, amountPaise: '6000' }],
  baseVersions: { supplier: V, bills: { [BILL]: V } },
};
const stale = { data: null, error: { code: 'P0001', message: 'DSB_BILL_CHANGED: it changed' } };
const done = { data: { paymentId: PAY, allocationIds: [BILL] }, error: null };

beforeEach(() => rpc.mockReset());

describe('offline supplier payment adapters', () => {
  it('reads and validates the pay context; a malformed answer throws', async () => {
    const ctx = {
      shopId: SHOP,
      businessDate: '2026-10-26',
      suppliers: [
        {
          partyId: PARTY,
          name: 'Traders',
          owedPaise: '15000',
          version: V,
          bills: [
            {
              billId: BILL,
              billNo: 'B-1',
              businessDate: '2026-10-01',
              outstandingPaise: '100',
              version: V,
            },
          ],
        },
      ],
    };
    rpc.mockResolvedValueOnce({ data: ctx, error: null });
    await expect(getSupplierPayContext(SHOP)).resolves.toEqual(ctx);
    expect(rpc).toHaveBeenCalledWith('get_supplier_pay_context', { p_shop_id: SHOP });
    rpc.mockResolvedValueOnce({
      data: { ...ctx, suppliers: [{ ...ctx.suppliers[0], version: 'x' }] },
      error: null,
    });
    await expect(getSupplierPayContext(SHOP)).rejects.toThrow(/Malformed/);
    rpc.mockResolvedValueOnce({ data: { ...ctx, shopId: PARTY }, error: null });
    await expect(getSupplierPayContext(SHOP)).rejects.toThrow(/Malformed/);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'not permitted' } });
    await expect(getSupplierPayContext(SHOP)).rejects.toThrow(/not permitted/);
  });

  it('commits with the stored ids; sends the exact request and the base versions under the request id', async () => {
    rpc.mockResolvedValueOnce(done);
    await expect(paySupplierIfUnchangedOutcome(input)).resolves.toEqual({
      kind: 'committed',
      value: { paymentId: PAY, allocationIds: [BILL] },
    });
    expect(rpc).toHaveBeenCalledWith('pay_supplier_if_unchanged', {
      p_shop_id: SHOP,
      p_party_id: PARTY,
      p_business_date: '2026-10-26',
      p_amount_paise: 6000,
      p_mode: 'cash',
      p_reference: null,
      p_allocations: [{ purchase_bill_id: BILL, amount_paise: 6000 }],
      p_client_id: REQ,
      p_base_versions: { supplier: V, bills: { [BILL]: V } },
    });
  });

  it('an answer that cannot be verified is unknown, never committed; a lost network is unknown', async () => {
    rpc.mockResolvedValueOnce({ data: { paymentId: 'nope' }, error: null });
    await expect(paySupplierIfUnchangedOutcome(input)).resolves.toMatchObject({ kind: 'unknown' });
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(paySupplierIfUnchangedOutcome(input)).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('a stale refusal with no stored answer is rejected with its code', async () => {
    rpc
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ data: { state: 'NOT_FOUND' }, error: null });
    await expect(paySupplierIfUnchangedOutcome(input)).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DSB_BILL_CHANGED',
    });
    expect(rpc).toHaveBeenLastCalledWith('get_financial_request', {
      p_shop_id: SHOP,
      p_operation: 'supplier.pay.offline.v1',
      p_client_id: REQ,
    });
  });

  it('a refusal after a committed first send is committed (stored answer)', async () => {
    rpc.mockResolvedValueOnce(stale).mockResolvedValueOnce({
      data: { state: 'COMMITTED', result: { paymentId: PAY, allocationIds: [BILL] } },
      error: null,
    });
    await expect(paySupplierIfUnchangedOutcome(input)).resolves.toEqual({
      kind: 'committed',
      value: { paymentId: PAY, allocationIds: [BILL] },
    });
  });

  it('a refusal that cannot be checked, or an access error, stays unknown (the queue keeps waiting)', async () => {
    rpc
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(paySupplierIfUnchangedOutcome(input)).resolves.toMatchObject({ kind: 'unknown' });
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'not permitted' } })
      .mockResolvedValueOnce({ data: { state: 'NOT_FOUND' }, error: null });
    await expect(paySupplierIfUnchangedOutcome(input)).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('a request with bad ids or amounts is refused before any call', async () => {
    await expect(
      paySupplierIfUnchangedOutcome({ ...input, requestId: 'x' }),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'INVALID_INPUT' });
    await expect(
      paySupplierIfUnchangedOutcome({ ...input, amountPaise: '-1' }),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'INVALID_INPUT' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('plain words for each refusal; every one says nothing was recorded', () => {
    for (const code of [
      'DSB_BILL_CHANGED',
      'DSB_BILL_ALREADY_PAID',
      'DSB_ALLOCATION_EXCEEDS_BILL',
      'DSB_ALLOCATION_EXCEEDS_PAYMENT',
      'DSB_BILL_UNAVAILABLE',
      'DSB_PAYMENT_EXCEEDS_OWED',
      'DSB_SUPPLIER_MERGED',
      'DSB_SUPPLIER_ARCHIVED',
      'DSB_SUPPLIER_CHANGED',
      'DSB_FUTURE_DATE',
      'DSB_FUTURE_BILL',
    ])
      expect(plainOfflineSupplierPaymentRefusal(`${code}: raw`)).toMatch(/Nothing was recorded/);
    expect(plainOfflineSupplierPaymentRefusal('DSB_SUPPLIER_MERGED: x')).toMatch(/kept supplier/);
    expect(plainOfflineSupplierPaymentRefusal('not permitted')).toMatch(/owner or a manager/);
    expect(plainOfflineSupplierPaymentRefusal('weird')).toBe('weird');
  });
});
