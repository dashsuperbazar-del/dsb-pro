import { describe, expect, it, vi, beforeEach } from 'vitest';
import { __setSupabaseClientForTest } from './client';
import { getShopSettings, updateShopSettings } from './shopSettings';

function makeMockClient(rpcResults: Record<string, unknown> = {}, fromResults: Record<string, unknown> = {}) {
  return {
    rpc: vi.fn<(fn: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: null }>>(
      (fn) => Promise.resolve({ data: rpcResults[fn] ?? null, error: null }),
    ),
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: fromResults[table] ?? null, error: null }),
        }),
      }),
    })),
  };
}

describe('shop settings adapter', () => {
  beforeEach(() => { __setSupabaseClientForTest(makeMockClient() as never); });

  it('getShopSettings maps the shops row to camelCase', async () => {
    const client = makeMockClient({}, {
      shops: {
        id: 'shop-1', tenant_id: 'tenant-1', name: 'Ramesh Store', address: '12 Market Road', gstin: '27ABCDE1234F1Z5',
        invoice_prefix: 'RS', timezone: 'Asia/Kolkata', printer_width: '58mm', fiscal_year_start_month: 4,
      },
    });
    __setSupabaseClientForTest(client as never);
    await expect(getShopSettings('shop-1')).resolves.toEqual({
      id: 'shop-1', tenantId: 'tenant-1', name: 'Ramesh Store', address: '12 Market Road', gstin: '27ABCDE1234F1Z5',
      invoicePrefix: 'RS', timezone: 'Asia/Kolkata', printerWidth: '58mm', fiscalYearStartMonth: 4,
    });
  });

  it('updateShopSettings sends every field to update_shop_settings, defaulting optional text to null', async () => {
    const client = makeMockClient({ update_shop_settings: null });
    __setSupabaseClientForTest(client as never);
    await updateShopSettings({ shopId: 'shop-1', name: 'Ramesh Store', timezone: 'Asia/Kolkata', printerWidth: '80mm', fiscalYearStartMonth: 4 });
    expect(client.rpc).toHaveBeenCalledWith('update_shop_settings', {
      p_shop_id: 'shop-1', p_name: 'Ramesh Store', p_address: null, p_gstin: null, p_invoice_prefix: null,
      p_timezone: 'Asia/Kolkata', p_printer_width: '80mm', p_fiscal_year_start_month: 4,
    });
  });
});
