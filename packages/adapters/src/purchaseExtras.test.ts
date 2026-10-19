import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPurchaseV2Payload,
  postPurchaseV2Outcome,
  voidPaidPurchaseOutcome,
} from './purchaseExtras';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ rpc, from }) }));
const SHOP = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';
const SUP = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const BILL = '55555555-5555-4555-8555-555555555555';
const PAY = '66666666-6666-4666-8666-666666666666';

const request = (over: object = {}) => ({
  shopId: SHOP,
  clientId: REQ,
  partyId: SUP,
  businessDate: '2026-10-01',
  discountPaise: 500,
  notes: '  check rate ',
  lines: [
    { itemId: ITEM, unitLevel: 1 as const, qty: '20', unitPricePaise: 871, gstBp: 500 },
    {
      itemId: ITEM,
      unitLevel: 1 as const,
      qty: '3',
      unitPricePaise: 9999,
      discountBp: 1000,
      gstBp: 1800,
    },
  ],
  charges: [
    { label: ' Freight ', amountPaise: 20000 },
    { label: 'Loading', amountPaise: 5000 },
  ],
  ...over,
});

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

describe('post_purchase_v2 payload', () => {
  it('carries exact line and bill totals the server recomputes', () => {
    const { bill, totals } = buildPurchaseV2Payload(request());
    expect(totals.totalPaise).toBe(74648);
    expect(bill).toEqual({
      party_id: SUP,
      bill_no: null,
      business_date: '2026-10-01',
      discount_paise: 500,
      payment_type: 'credit',
      notes: 'check rate',
      total_paise: 74648,
      lines: [
        {
          item_id: ITEM,
          unit_level: 1,
          qty: '20',
          unit_price_paise: 871,
          discount_bp: 0,
          gst_bp: 500,
          line_total_paise: 18291,
        },
        {
          item_id: ITEM,
          unit_level: 1,
          qty: '3',
          unit_price_paise: 9999,
          discount_bp: 1000,
          gst_bp: 1800,
          line_total_paise: 31857,
        },
      ],
      charges: [
        { label: 'Freight', amount_paise: 20000 },
        { label: 'Loading', amount_paise: 5000 },
      ],
      images: [],
    });
  });
  it('refuses cheque, a paid bill without supplier, and unnamed charges before sending', async () => {
    expect(() => buildPurchaseV2Payload(request({ paymentType: 'cheque' }))).toThrow();
    expect(() => buildPurchaseV2Payload(request({ paymentType: 'cash', partyId: null }))).toThrow();
    expect(() =>
      buildPurchaseV2Payload(request({ charges: [{ label: ' ', amountPaise: 1 }] })),
    ).toThrow();
    await expect(
      postPurchaseV2Outcome(request({ paymentType: 'upi', partyId: null })),
    ).resolves.toMatchObject({
      kind: 'rejected',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('post_purchase_v2 outcome', () => {
  it('a cash bill is committed only with its payment id', async () => {
    rpc.mockResolvedValue({
      data: { billId: BILL, paymentId: PAY, totalPaise: '74648', businessDate: '2026-10-01' },
      error: null,
    });
    await expect(postPurchaseV2Outcome(request({ paymentType: 'cash' }))).resolves.toEqual({
      kind: 'committed',
      value: { billId: BILL, paymentId: PAY, totalPaise: 74648, businessDate: '2026-10-01' },
    });
    expect(rpc).toHaveBeenCalledWith(
      'post_purchase_v2',
      expect.objectContaining({ p_client_id: REQ }),
    );
  });
  it('a paid answer without a payment, or a different total, is unknown', async () => {
    rpc.mockResolvedValueOnce({
      data: { billId: BILL, paymentId: null, totalPaise: '74648', businessDate: '2026-10-01' },
      error: null,
    });
    await expect(postPurchaseV2Outcome(request({ paymentType: 'upi' }))).resolves.toMatchObject({
      kind: 'unknown',
    });
    rpc.mockResolvedValueOnce({
      data: { billId: BILL, paymentId: null, totalPaise: '74647', businessDate: '2026-10-01' },
      error: null,
    });
    await expect(postPurchaseV2Outcome(request())).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('a total mismatch from the server is a rejection; a payload mismatch is unknown', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'DSB_TOTAL_MISMATCH: x' },
    });
    await expect(postPurchaseV2Outcome(request())).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DSB_TOTAL_MISMATCH',
    });
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'DSB_PAYLOAD_MISMATCH: x' },
    });
    await expect(postPurchaseV2Outcome(request())).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('a refused retry of a saved paid bill stays unknown (payment not confirmable from the bill row)', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'DSB_FUTURE_DATE: x' } });
    from.mockReturnValue({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: BILL }, error: null }) }),
      }),
    });
    await expect(
      postPurchaseV2Outcome(request({ paymentType: 'cash' }), true),
    ).resolves.toMatchObject({
      kind: 'unknown',
    });
    await expect(postPurchaseV2Outcome(request(), true)).resolves.toMatchObject({
      kind: 'committed',
      value: { billId: BILL, paymentId: null },
    });
  });
});

describe('void_paid_purchase outcome', () => {
  it('accepts only an answer for this bill', async () => {
    rpc.mockResolvedValueOnce({
      data: { billId: BILL, paymentId: PAY, paymentVoided: true },
      error: null,
    });
    await expect(
      voidPaidPurchaseOutcome({ purchaseId: BILL, reason: 'twice', clientId: REQ }),
    ).resolves.toEqual({
      kind: 'committed',
      value: { billId: BILL, paymentId: PAY, paymentVoided: true },
    });
    rpc.mockResolvedValueOnce({
      data: { billId: PAY, paymentId: PAY, paymentVoided: true },
      error: null,
    });
    await expect(
      voidPaidPurchaseOutcome({ purchaseId: BILL, reason: 'twice', clientId: REQ }),
    ).resolves.toMatchObject({
      kind: 'unknown',
    });
  });
});
