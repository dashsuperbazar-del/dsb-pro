import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePurchaseVoidId, purchaseVoidRequestId, voidPurchaseOutcome } from './purchaseVoid';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('./client', () => ({ getSupabaseClient: () => ({ rpc, from }) }));
const REQ = '22222222-2222-4222-8222-222222222222';
const BILL = '55555555-5555-4555-8555-555555555555';
const NEW = '77777777-7777-4777-8777-777777777777';

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

describe('purchase void request id', () => {
  it('carries the reason and parses back only from an exact stock movement id', () => {
    const r = purchaseVoidRequestId(REQ, { reason: '  entered   twice ' });
    expect(r).toBe(`purchase.void.v1:${REQ}:reason:entered twice`);
    expect(parsePurchaseVoidId(`${r}:stock:2`)).toEqual({ reason: 'entered twice' });
    expect(parsePurchaseVoidId(r)).toBeNull();
    expect(parsePurchaseVoidId(`x${r}:stock:2`)).toBeNull();
    expect(parsePurchaseVoidId(`purchase.void.v1:${REQ}:reason:a:b:stock:1`)).toBeNull();
    expect(parsePurchaseVoidId('purchase.void_paid.v1:x:stock:1')).toBeNull();
    expect(parsePurchaseVoidId(`${REQ}:stock:1`)).toBeNull();
  });
  it('refuses an empty, too long or colon-containing reason', () => {
    expect(() => purchaseVoidRequestId(REQ, { reason: '  ' })).toThrow(/Reason required/);
    expect(() => purchaseVoidRequestId(REQ, { reason: 'x'.repeat(201) })).toThrow();
    expect(() => purchaseVoidRequestId(REQ, { reason: 'a:stock:1' })).toThrow(/colon/);
    expect(() => purchaseVoidRequestId('nope', { reason: 'x' })).toThrow();
  });
});

describe('voidPurchaseOutcome', () => {
  it('commits only on this bill id; a refusal is rejected; a lost answer is unknown', async () => {
    rpc.mockResolvedValueOnce({ data: BILL, error: null });
    await expect(voidPurchaseOutcome({ purchaseId: BILL, clientId: 'c' })).resolves.toEqual({
      kind: 'committed',
      value: BILL,
    });
    expect(rpc).toHaveBeenCalledWith('void_purchase', { p_purchase_id: BILL, p_client_id: 'c' });
    rpc.mockResolvedValueOnce({ data: NEW, error: null });
    await expect(voidPurchaseOutcome({ purchaseId: BILL, clientId: 'c' })).resolves.toMatchObject({
      kind: 'unknown',
    });
    rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'P0001',
        message: 'purchase has active allocations; void or release allocations first',
      },
    });
    await expect(voidPurchaseOutcome({ purchaseId: BILL, clientId: 'c' })).resolves.toMatchObject({
      kind: 'rejected',
    });
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(voidPurchaseOutcome({ purchaseId: BILL, clientId: 'c' })).resolves.toMatchObject({
      kind: 'unknown',
    });
  });
});
