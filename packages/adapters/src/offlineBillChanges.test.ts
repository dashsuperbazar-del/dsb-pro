import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPurchaseBillVersion,
  plainOfflineVoidRefusal,
  voidPurchaseIfUnchangedOutcome,
} from './offlineBillChanges';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ rpc }) }));
const BILL = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';
const V = '0123456789abcdef0123456789abcdef';
const input = { shopId: 's', purchaseId: BILL, clientId: REQ, reason: 'twice', baseVersion: V };
const stale = {
  data: null,
  error: { code: 'P0001', message: 'DSB_BILL_CHANGED: this bill changed' },
};

beforeEach(() => rpc.mockReset());

describe('offline bill changes adapters', () => {
  it('reads the version token; anything else is null', async () => {
    rpc.mockResolvedValueOnce({ data: V, error: null });
    await expect(getPurchaseBillVersion(BILL)).resolves.toBe(V);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    await expect(getPurchaseBillVersion(BILL)).resolves.toBeNull();
  });

  it('void: commits on this bill; a stale refusal with no stored answer is rejected', async () => {
    rpc.mockResolvedValueOnce({ data: { billId: BILL, voided: true }, error: null });
    await expect(voidPurchaseIfUnchangedOutcome(input)).resolves.toEqual({
      kind: 'committed',
      value: { billId: BILL },
    });
    expect(rpc).toHaveBeenCalledWith('void_purchase_if_unchanged', {
      p_purchase_id: BILL,
      p_client_id: REQ,
      p_reason: 'twice',
      p_base_version: V,
    });
    rpc
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ data: { state: 'NOT_FOUND' }, error: null });
    await expect(voidPurchaseIfUnchangedOutcome(input)).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DSB_BILL_CHANGED',
    });
  });

  it('void: a refusal after a committed first send is committed (stored answer)', async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'not permitted' } })
      .mockResolvedValueOnce({
        data: { state: 'COMMITTED', result: { billId: BILL, voided: true } },
        error: null,
      });
    await expect(voidPurchaseIfUnchangedOutcome(input)).resolves.toEqual({
      kind: 'committed',
      value: { billId: BILL },
    });
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'not permitted' } })
      .mockResolvedValueOnce({ data: { state: 'NOT_FOUND' }, error: null });
    await expect(voidPurchaseIfUnchangedOutcome(input)).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('plain words', () => {
    expect(plainOfflineVoidRefusal('DSB_VOID_HAS_PAYMENTS: x')).toMatch(/payment is assigned/);
    expect(plainOfflineVoidRefusal('DSB_BILL_CHANGED: x')).toMatch(/changed after the void/);
  });
});
