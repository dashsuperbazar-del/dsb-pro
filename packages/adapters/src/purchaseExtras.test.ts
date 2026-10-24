import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPurchaseV2Payload,
  deriveSettlement,
  editPurchaseBillOutcome,
  plainEditRefusal,
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
const answer = (over: object = {}) => ({
  billId: BILL,
  paymentId: null,
  totalPaise: '74600',
  roundOffPaise: '-48',
  businessDate: '2026-10-01',
  ...over,
});

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

describe('post_purchase_v2 payload', () => {
  it('carries exact line and bill totals the server recomputes', () => {
    const { bill, totals } = buildPurchaseV2Payload(request());
    expect([totals.totalPaise, totals.roundOffPaise]).toEqual([74600, -48]);
    expect(bill).toEqual({
      party_id: SUP,
      bill_no: null,
      business_date: '2026-10-01',
      discount_paise: 500,
      payment_type: 'credit',
      notes: 'check rate',
      round_off_paise: -48,
      total_paise: 74600,
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
  it('keeps blank GST (null) distinct from an explicit 0%', () => {
    const line = { itemId: ITEM, unitLevel: 1 as const, qty: '1', unitPricePaise: 1000 };
    const { bill } = buildPurchaseV2Payload(
      request({
        discountPaise: 0,
        charges: [],
        lines: [
          { ...line, gstBp: null },
          { ...line, gstBp: 0 },
        ],
      }),
    );
    expect(bill.lines.map((l) => l.gst_bp)).toEqual([null, 0]);
    // A blank field passed through as '' or a fraction is refused, never coerced to 0.
    expect(() =>
      buildPurchaseV2Payload(request({ lines: [{ ...line, gstBp: '' as unknown as number }] })),
    ).toThrow(/blank \(null\)/);
    expect(() => buildPurchaseV2Payload(request({ lines: [{ ...line, gstBp: 2.5 }] }))).toThrow();
  });
  it('refuses cheque, a paid bill without supplier, and unnamed charges before sending', async () => {
    expect(() => buildPurchaseV2Payload(request({ paymentType: 'cheque' }))).toThrow();
    expect(() => buildPurchaseV2Payload(request({ paymentType: 'cash', partyId: null }))).toThrow();
    expect(() =>
      buildPurchaseV2Payload(request({ charges: [{ label: ' ', amountPaise: 1 }] })),
    ).toThrow();
    await expect(
      postPurchaseV2Outcome(request({ paymentType: 'upi', partyId: null })),
    ).resolves.toMatchObject({ kind: 'rejected' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('post_purchase_v2 outcome', () => {
  it('a cash bill is committed only with its payment id', async () => {
    rpc.mockResolvedValue({ data: answer({ paymentId: PAY }), error: null });
    await expect(postPurchaseV2Outcome(request({ paymentType: 'cash' }))).resolves.toEqual({
      kind: 'committed',
      value: {
        billId: BILL,
        paymentId: PAY,
        totalPaise: 74600,
        roundOffPaise: -48,
        businessDate: '2026-10-01',
      },
    });
    expect(rpc).toHaveBeenCalledWith(
      'post_purchase_v2',
      expect.objectContaining({ p_client_id: REQ }),
    );
  });
  it('a paid answer without a payment, or a different total, is unknown', async () => {
    rpc.mockResolvedValueOnce({ data: answer(), error: null });
    await expect(postPurchaseV2Outcome(request({ paymentType: 'upi' }))).resolves.toMatchObject({
      kind: 'unknown',
    });
    rpc.mockResolvedValueOnce({ data: answer({ totalPaise: '74648' }), error: null });
    await expect(postPurchaseV2Outcome(request())).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('an answer with a different round-off is unknown', async () => {
    rpc.mockResolvedValueOnce({ data: answer({ roundOffPaise: '52' }), error: null });
    await expect(postPurchaseV2Outcome(request())).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('a total mismatch from the server is a rejection', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'DSB_TOTAL_MISMATCH: x' },
    });
    await expect(postPurchaseV2Outcome(request())).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DSB_TOTAL_MISMATCH',
    });
  });
  it('a payload mismatch is a final refusal (never an endless resend), naming the existing bill', async () => {
    rpc
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'DSB_PAYLOAD_MISMATCH: client_id already used' },
      })
      .mockResolvedValueOnce({
        data: { state: 'COMMITTED', result: answer(), currentStatus: null },
        error: null,
      });
    const out = await postPurchaseV2Outcome(request());
    expect(out).toMatchObject({ kind: 'rejected', code: 'DSB_PAYLOAD_MISMATCH' });
    expect(out.kind === 'rejected' && out.message).toContain(BILL);
    expect(rpc).toHaveBeenLastCalledWith('get_financial_request', {
      p_shop_id: SHOP,
      p_operation: 'purchase.post.v2',
      p_client_id: REQ,
    });
    // Used by a v1 bill (no v2 request stored): still final.
    rpc
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'DSB_PAYLOAD_MISMATCH: x' },
      })
      .mockResolvedValueOnce({ data: { state: 'NOT_FOUND' }, error: null });
    await expect(postPurchaseV2Outcome(request())).resolves.toMatchObject({ kind: 'rejected' });
    // Lookup unreachable: unknown (cannot prove anything yet).
    rpc
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'DSB_PAYLOAD_MISMATCH: x' },
      })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(postPurchaseV2Outcome(request())).resolves.toMatchObject({ kind: 'unknown' });
  });
  it('a refused retry is decided by the stored answer, including the payment id', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'not permitted' } })
      .mockResolvedValueOnce({
        data: { state: 'COMMITTED', result: answer({ paymentId: PAY }), currentStatus: 'POSTED' },
        error: null,
      });
    await expect(
      postPurchaseV2Outcome(request({ paymentType: 'cash' }), true),
    ).resolves.toMatchObject({ kind: 'committed', value: { billId: BILL, paymentId: PAY } });
    rpc
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'DSB_FUTURE_DATE: x' },
      })
      .mockResolvedValueOnce({ data: { state: 'NOT_FOUND' }, error: null });
    await expect(postPurchaseV2Outcome(request(), true)).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DSB_FUTURE_DATE',
    });
  });
});

describe('settlement is derived from the ledger, not the payment type', () => {
  it.each([
    [
      'POSTED',
      { outstanding_paise: '0', allocated_paise: '12000', returned_paise: '0' },
      'settled',
    ],
    ['POSTED', { outstanding_paise: '12000', allocated_paise: '0', returned_paise: '0' }, 'unpaid'],
    [
      'POSTED',
      { outstanding_paise: '2000', allocated_paise: '10000', returned_paise: '0' },
      'partial',
    ],
    ['VOID', null, 'void'],
    ['POSTED', null, 'unknown'],
  ] as const)('%s %j -> %s', (status, row, expected) => {
    expect(deriveSettlement(status, row).status).toBe(expected);
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
    ).resolves.toMatchObject({ kind: 'unknown' });
  });
});

describe('edit_purchase_bill outcome (0066)', () => {
  const ORIG = '77777777-7777-4777-8777-777777777777';
  const editAnswer = (over: object = {}) => ({
    ...answer(),
    originalBillId: ORIG,
    carriedPaise: '0',
    ...over,
  });
  it('sends the original id and the v2 bill, and accepts only an answer for this edit', async () => {
    rpc.mockResolvedValueOnce({ data: editAnswer({ carriedPaise: '5000' }), error: null });
    await expect(editPurchaseBillOutcome({ ...request(), originalId: ORIG })).resolves.toEqual({
      kind: 'committed',
      value: {
        billId: BILL,
        originalBillId: ORIG,
        paymentId: null,
        totalPaise: 74600,
        roundOffPaise: -48,
        businessDate: '2026-10-01',
        carriedPaise: 5000,
      },
    });
    expect(rpc).toHaveBeenCalledWith(
      'edit_purchase_bill',
      expect.objectContaining({ p_original_id: ORIG, p_client_id: REQ }),
    );
    for (const bad of [
      editAnswer({ originalBillId: BILL }),
      editAnswer({ billId: ORIG }),
      editAnswer({ totalPaise: '74601' }),
      editAnswer({ carriedPaise: 5 }),
    ]) {
      rpc.mockResolvedValueOnce({ data: bad, error: null });
      await expect(
        editPurchaseBillOutcome({ ...request(), originalId: ORIG }),
      ).resolves.toMatchObject({ kind: 'unknown' });
    }
  });
  it('offline edit (0072) sends the base version to the guarded RPC; a stale refusal is rejected', async () => {
    const V = '0123456789abcdef0123456789abcdef';
    rpc
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'DSB_BILL_CHANGED: changed' },
      })
      .mockResolvedValueOnce({ data: { state: 'NOT_FOUND' }, error: null });
    const out = await editPurchaseBillOutcome({ ...request(), originalId: ORIG }, true, V);
    expect(rpc.mock.calls[0]![0]).toBe('edit_purchase_bill_if_unchanged');
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_base_version: V, p_original_id: ORIG });
    expect(out).toMatchObject({ kind: 'rejected', code: 'DSB_BILL_CHANGED' });
  });
  it('refuses without sending when the original is missing', async () => {
    await expect(editPurchaseBillOutcome({ ...request(), originalId: '' })).resolves.toMatchObject({
      kind: 'rejected',
      code: 'INVALID_INPUT',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a refused retry is decided by the stored edit answer', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'not permitted' } })
      .mockResolvedValueOnce({
        data: { state: 'COMMITTED', result: editAnswer(), currentStatus: null },
        error: null,
      });
    await expect(
      editPurchaseBillOutcome({ ...request(), originalId: ORIG }, true),
    ).resolves.toMatchObject({ kind: 'committed', value: { billId: BILL } });
    expect(rpc).toHaveBeenLastCalledWith('get_financial_request', {
      p_shop_id: SHOP,
      p_operation: 'purchase.edit.v1',
      p_client_id: REQ,
    });
  });
  it('a payload mismatch is final', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'DSB_PAYLOAD_MISMATCH: x' },
    });
    await expect(
      editPurchaseBillOutcome({ ...request(), originalId: ORIG }),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'DSB_PAYLOAD_MISMATCH' });
  });
  it('explains each refusal in plain words', () => {
    expect(plainEditRefusal('DSB_EDIT_STOCK_CONSUMED: E6 Dal was already sold')).toContain(
      'E6 Dal was already sold',
    );
    expect(plainEditRefusal('DSB_EDIT_BILL_HAS_RETURNS: x')).toMatch(/supplier returns/);
    expect(plainEditRefusal('DSB_EDIT_PAYMENT_TYPE_CHANGED: x')).toMatch(/same payment type/);
  });
});
