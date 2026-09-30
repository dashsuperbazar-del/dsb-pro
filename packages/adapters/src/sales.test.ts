import { describe, expect, it, vi } from 'vitest';
import { __setSupabaseClientForTest, type DsbSupabaseClient } from './client';
import { voidSale } from './sales';

describe('voidSale', () => {
  // Regression: the adapter used to send p_sale_invoice_id, but void_sale
  // (0023) is declared void_sale(p_sale_id uuid, p_client_id text), so
  // PostgREST could not resolve the function and every void failed.
  it('calls void_sale with the argument names the SQL function declares', async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: 'void-id', error: null }));
    __setSupabaseClientForTest({ rpc } as unknown as DsbSupabaseClient);
    await expect(voidSale('sale-1', 'client-1')).resolves.toBe('void-id');
    expect(rpc).toHaveBeenCalledWith('void_sale', { p_sale_id: 'sale-1', p_client_id: 'client-1' });
  });
});
