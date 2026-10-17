import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

// I08: an item's recent purchase costs (old DSB price chart). Read-only; voided bills are left out.
export type ItemPurchasePrice = {
  billId: string;
  lineNo: number;
  createdAt: string;
  businessDate: string;
  partyId: string | null;
  unitName: string;
  unitLevel: number;
  qty: number;
  baseQty: number;
  unitPricePaise: number;
  lineTotalPaise: number;
};

const fail = () => new Error('The server sent an unexpected price history. Nothing is shown.');
const num = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw fail();
  return n;
};

export async function listItemPurchasePrices(
  shopId: string,
  itemId: string,
  limit = 20,
): Promise<ItemPurchasePrice[]> {
  const client = getSupabaseClient();
  const lines = await client
    .from('purchase_bill_items')
    .select(
      'purchase_bill_id,line_no,unit_level,unit_name_snapshot,qty,base_qty,unit_price_paise,line_total_paise,created_at',
    )
    .eq('shop_id', shopId)
    .eq('item_id', itemId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    // Over-fetch: voided bills' lines are dropped below and must not use up the limit.
    .limit(limit * 3);
  if (lines.error) throw new Error(errorMessage(classifyError(lines.error), lines.error));
  if (!Array.isArray(lines.data)) throw fail();
  const ids = [...new Set(lines.data.map((l) => l.purchase_bill_id as string))];
  if (!ids.length) return [];
  const bills = await client
    .from('purchase_bills')
    .select('id,business_date,status,party_id')
    .in('id', ids);
  if (bills.error) throw new Error(errorMessage(classifyError(bills.error), bills.error));
  if (!Array.isArray(bills.data)) throw fail();
  const byId = new Map(bills.data.map((b) => [b.id as string, b]));
  const out: ItemPurchasePrice[] = [];
  for (const l of lines.data) {
    const bill = byId.get(l.purchase_bill_id as string);
    // A bill we cannot see (other shop, permissions) or a voided one is not part of the history.
    if (!bill || bill.status !== 'POSTED') continue;
    if (typeof bill.business_date !== 'string' || typeof l.unit_name_snapshot !== 'string')
      throw fail();
    out.push({
      billId: l.purchase_bill_id as string,
      lineNo: num(l.line_no),
      createdAt: String(l.created_at),
      businessDate: bill.business_date,
      partyId: (bill.party_id as string | null) ?? null,
      unitName: l.unit_name_snapshot,
      unitLevel: num(l.unit_level),
      qty: num(l.qty),
      baseQty: num(l.base_qty),
      unitPricePaise: num(l.unit_price_paise),
      lineTotalPaise: num(l.line_total_paise),
    });
    if (out.length >= limit) break;
  }
  return out;
}
