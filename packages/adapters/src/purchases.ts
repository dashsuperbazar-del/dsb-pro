import { getSupabaseClient } from './client';
import { getCurrentMembership } from './tenancy';
import { errorMessage, classifyError } from './errors';

export type PurchaseRecord = {
  id: string;
  party_id: string | null;
  bill_no: string | null;
  business_date: string;
  created_at: string;
  status: 'POSTED' | 'VOID';
  subtotal_paise: string;
  discount_paise: string;
  extra_charges_paise: string;
  total_paise: string;
};
export type PurchaseHistoryLine = {
  id: string;
  item_id: string;
  line_no: number;
  item_name_snapshot: string;
  unit_name_snapshot: string;
  conv1_snapshot: number | null;
  conv2_snapshot: number | null;
  unit_level: 1 | 2 | 3;
  qty: string;
  unit_price_paise: string;
  line_total_paise: string;
};
export type PurchaseBalance = {
  purchase_bill_id: string;
  outstanding_paise: string;
  allocated_paise: string;
  returned_paise: string;
};
const header =
  'id,party_id,bill_no,business_date,created_at,status,subtotal_paise::text,discount_paise::text,extra_charges_paise::text,total_paise::text';
async function authorize(shopId: string) {
  const m = await getCurrentMembership();
  if (!m || !['owner', 'manager', 'accountant'].includes(m.role) || !m.shopIds.includes(shopId))
    throw new Error('Purchase history is restricted to your permitted shop.');
}
export async function listPurchaseHistory(shopId: string, offset = 0): Promise<PurchaseRecord[]> {
  await authorize(shopId);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid purchase page.');
  const { data, error } = await getSupabaseClient()
    .from('purchase_bills')
    .select(header)
    .eq('shop_id', shopId)
    .is('deleted_at', null)
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id')
    .range(offset, offset + 49);
  if (error) throw new Error(errorMessage(classifyError(error), error));
  return (data ?? []) as unknown as PurchaseRecord[];
}
export async function getPurchaseDetail(
  shopId: string,
  id: string,
): Promise<{
  bill: PurchaseRecord;
  lines: PurchaseHistoryLine[];
  balance: PurchaseBalance | null;
}> {
  await authorize(shopId);
  const client = getSupabaseClient();
  const result = await client
    .from('purchase_bills')
    .select(header)
    .eq('shop_id', shopId)
    .eq('id', id)
    .is('deleted_at', null)
    .single();
  if (result.error) throw new Error(errorMessage(classifyError(result.error), result.error));
  const [lines, balance] = await Promise.all([
    client
      .from('purchase_bill_items')
      .select(
        'id,item_id,line_no,item_name_snapshot,unit_name_snapshot,conv1_snapshot,conv2_snapshot,unit_level,qty::text,unit_price_paise::text,line_total_paise::text',
      )
      .eq('shop_id', shopId)
      .eq('purchase_bill_id', id)
      .is('deleted_at', null)
      .order('line_no')
      .order('id'),
    client
      .from('purchase_bill_outstanding' as never)
      .select('purchase_bill_id,outstanding_paise::text,allocated_paise::text,returned_paise::text')
      .eq('shop_id', shopId)
      .eq('purchase_bill_id', id)
      .maybeSingle(),
  ]);
  if (lines.error) throw new Error(errorMessage(classifyError(lines.error), lines.error));
  if (balance.error) throw new Error(errorMessage(classifyError(balance.error), balance.error));
  return {
    bill: result.data as unknown as PurchaseRecord,
    lines: (lines.data ?? []) as unknown as PurchaseHistoryLine[],
    balance: balance.data as unknown as PurchaseBalance | null,
  };
}
