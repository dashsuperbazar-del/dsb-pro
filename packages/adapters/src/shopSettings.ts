import { getSupabaseClient } from './client';

export type PrinterWidth = '58mm' | '80mm';
export type ShopSettings = {
  id: string;
  tenantId: string;
  name: string;
  address: string | null;
  gstin: string | null;
  invoicePrefix: string | null;
  timezone: string;
  printerWidth: PrinterWidth;
  fiscalYearStartMonth: number;
  allowNegativeStock: boolean;
};
export type ShopSettingsInput = {
  shopId: string;
  name: string;
  address?: string;
  gstin?: string;
  invoicePrefix?: string;
  timezone: string;
  printerWidth: PrinterWidth;
  fiscalYearStartMonth: number;
  allowNegativeStock: boolean;
};

export async function getShopSettings(shopId: string): Promise<ShopSettings> {
  const { data, error } = await getSupabaseClient()
    .from('shops')
    .select(
      'id,tenant_id,name,address,gstin,invoice_prefix,timezone,printer_width,fiscal_year_start_month,allow_negative_stock',
    )
    .eq('id', shopId)
    .single();
  if (error) throw error;
  const row = data as {
    id: string;
    tenant_id: string;
    name: string;
    address: string | null;
    gstin: string | null;
    invoice_prefix: string | null;
    timezone: string;
    printer_width: PrinterWidth;
    fiscal_year_start_month: number;
    allow_negative_stock: boolean;
  };
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    address: row.address,
    gstin: row.gstin,
    invoicePrefix: row.invoice_prefix,
    timezone: row.timezone,
    printerWidth: row.printer_width,
    fiscalYearStartMonth: row.fiscal_year_start_month,
    allowNegativeStock: row.allow_negative_stock,
  };
}

export async function updateShopSettings(input: ShopSettingsInput): Promise<void> {
  const { error } = await getSupabaseClient().rpc('update_shop_settings', {
    p_shop_id: input.shopId,
    p_name: input.name,
    p_address: input.address ?? null,
    p_gstin: input.gstin ?? null,
    p_invoice_prefix: input.invoicePrefix ?? null,
    p_timezone: input.timezone,
    p_printer_width: input.printerWidth,
    p_fiscal_year_start_month: input.fiscalYearStartMonth,
    p_allow_negative_stock: input.allowNegativeStock,
  });
  if (error) throw error;
}

/** Shop phone and receipt footer (mig 0076). Read separately and tolerant: any failure reads as empty. */
export type ShopContact = { phone: string | null; receiptFooter: string | null };
export async function getShopContact(shopId: string): Promise<ShopContact> {
  try {
    const { data, error } = await getSupabaseClient()
      .from('shops')
      .select('phone,receipt_footer')
      .eq('id', shopId)
      .single();
    if (error || !data) return { phone: null, receiptFooter: null };
    const row = data as { phone: string | null; receipt_footer: string | null };
    return { phone: row.phone ?? null, receiptFooter: row.receipt_footer ?? null };
  } catch {
    return { phone: null, receiptFooter: null };
  }
}

export async function updateShopContact(input: {
  shopId: string;
  phone: string;
  receiptFooter: string;
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('update_shop_contact', {
    p_shop_id: input.shopId,
    p_phone: input.phone,
    p_footer: input.receiptFooter,
  });
  if (error) throw error;
}
