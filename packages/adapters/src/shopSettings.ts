import { getSupabaseClient } from './client';

export type PrinterWidth = '58mm' | '80mm';
export type ShopSettings = {
  id: string; tenantId: string; name: string; address: string | null; gstin: string | null;
  invoicePrefix: string | null; timezone: string; printerWidth: PrinterWidth; fiscalYearStartMonth: number;
};
export type ShopSettingsInput = {
  shopId: string; name: string; address?: string; gstin?: string; invoicePrefix?: string;
  timezone: string; printerWidth: PrinterWidth; fiscalYearStartMonth: number;
};

export async function getShopSettings(shopId: string): Promise<ShopSettings> {
  const { data, error } = await getSupabaseClient().from('shops')
    .select('id,tenant_id,name,address,gstin,invoice_prefix,timezone,printer_width,fiscal_year_start_month')
    .eq('id', shopId).single();
  if (error) throw error;
  const row = data as { id:string; tenant_id:string; name:string; address:string|null; gstin:string|null; invoice_prefix:string|null; timezone:string; printer_width:PrinterWidth; fiscal_year_start_month:number };
  return { id: row.id, tenantId: row.tenant_id, name: row.name, address: row.address, gstin: row.gstin, invoicePrefix: row.invoice_prefix, timezone: row.timezone, printerWidth: row.printer_width, fiscalYearStartMonth: row.fiscal_year_start_month };
}

export async function updateShopSettings(input: ShopSettingsInput): Promise<void> {
  const { error } = await getSupabaseClient().rpc('update_shop_settings', {
    p_shop_id: input.shopId, p_name: input.name, p_address: input.address ?? null, p_gstin: input.gstin ?? null,
    p_invoice_prefix: input.invoicePrefix ?? null, p_timezone: input.timezone, p_printer_width: input.printerWidth,
    p_fiscal_year_start_month: input.fiscalYearStartMonth,
  });
  if (error) throw error;
}
