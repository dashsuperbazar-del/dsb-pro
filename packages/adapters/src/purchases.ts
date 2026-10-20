import { getSupabaseClient } from './client';
import { getCurrentMembership } from './tenancy';
import { errorMessage, classifyError } from './errors';

export type PurchaseRecord = {
  id: string;
  party_id: string | null;
  bill_no: string | null;
  bill_image_path: string | null;
  business_date: string;
  created_at: string;
  status: 'POSTED' | 'VOID';
  subtotal_paise: string;
  discount_paise: string;
  extra_charges_paise: string;
  /** billextras (0064): signed rupee round-off; 0 for v1/old bills. Optional for older saved lists. */
  round_off_paise?: string;
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
  'id,party_id,bill_no,business_date,created_at,status,bill_image_path,subtotal_paise::text,discount_paise::text,extra_charges_paise::text,round_off_paise::text,total_paise::text';
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
  const client = getSupabaseClient();
  // One round trip: the membership check and all three reads run together (RLS still guards every
  // read; the results are discarded when the check fails).
  const [, result, lines, balance] = await Promise.all([
    authorize(shopId),
    client
      .from('purchase_bills')
      .select(header)
      .eq('shop_id', shopId)
      .eq('id', id)
      .is('deleted_at', null)
      .single(),
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
  if (result.error) throw new Error(errorMessage(classifyError(result.error), result.error));
  if (lines.error) throw new Error(errorMessage(classifyError(lines.error), lines.error));
  if (balance.error) throw new Error(errorMessage(classifyError(balance.error), balance.error));
  return {
    bill: result.data as unknown as PurchaseRecord,
    lines: (lines.data ?? []) as unknown as PurchaseHistoryLine[],
    balance: balance.data as unknown as PurchaseBalance | null,
  };
}

const LINE_PAGE = 500;
const MAX_LINE_PAGES = 40;
/** One line of a supplier's posted bill, with the bill's date (for the "usual items" list). */
export type SupplierPurchaseLine = {
  purchase_bill_id: string;
  business_date: string;
  created_at: string;
  line_no: number;
  item_id: string;
  item_name_snapshot: string;
  unit_level: 1 | 2 | 3;
  unit_name_snapshot: string;
  /** The item's conversions when the bill was posted (a unit redefined since makes the rate stale). */
  conv1_snapshot: number | null;
  conv2_snapshot: number | null;
  unit_price_paise: string;
  discount_bp: number;
  gst_bp: number | null;
};
/**
 * Lines of a supplier's most recent POSTED bills (voided and deleted bills excluded), newest bill
 * first. Read-only: two PostgREST reads under the caller's RLS. Each line's discount/GST come from the
 * same read as its rate, so a line is never returned without them.
 */
export async function listSupplierPurchaseLines(
  shopId: string,
  partyId: string,
  maxBills = 40,
): Promise<SupplierPurchaseLine[]> {
  await authorize(shopId);
  if (!Number.isSafeInteger(maxBills) || maxBills < 1 || maxBills > 100)
    throw new Error('Invalid bill count.');
  const client = getSupabaseClient();
  const bills = await client
    .from('purchase_bills')
    .select('id,business_date,created_at')
    .eq('shop_id', shopId)
    .eq('party_id', partyId)
    .eq('status', 'POSTED')
    .is('deleted_at', null)
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id')
    .limit(maxBills);
  if (bills.error) throw new Error(errorMessage(classifyError(bills.error), bills.error));
  if (!Array.isArray(bills.data)) throw new Error('Supplier bills could not be read.');
  if (!bills.data.length) return [];
  const order = new Map(bills.data.map((b, i) => [b.id as string, { ...b, i }]));
  // Paged with a stable order (bill, line, id) below the server's row cap: a long history is read
  // completely, never cut off silently; past MAX_LINE_PAGES it fails instead.
  const rows: unknown[] = [];
  for (let page = 0; ; page++) {
    if (page >= MAX_LINE_PAGES) throw new Error('Too many supplier bill lines to read.');
    const from = page * LINE_PAGE;
    const lines = await client
      .from('purchase_bill_items')
      .select(
        'purchase_bill_id,line_no,item_id,item_name_snapshot,unit_level,unit_name_snapshot,conv1_snapshot,conv2_snapshot,unit_price_paise::text,discount_bp,gst_bp',
      )
      .eq('shop_id', shopId)
      .in('purchase_bill_id', [...order.keys()])
      .is('deleted_at', null)
      .order('purchase_bill_id')
      .order('line_no')
      .order('id')
      .range(from, from + LINE_PAGE - 1);
    if (lines.error) throw new Error(errorMessage(classifyError(lines.error), lines.error));
    if (!Array.isArray(lines.data)) throw new Error('Supplier bill lines could not be read.');
    rows.push(...lines.data);
    if (lines.data.length < LINE_PAGE) break;
  }
  type Row = Omit<SupplierPurchaseLine, 'business_date' | 'created_at'>;
  const out: { i: number; line: SupplierPurchaseLine }[] = [];
  for (const l of rows as Row[]) {
    const bill = order.get(l.purchase_bill_id);
    if (!bill) continue;
    out.push({
      i: bill.i,
      line: {
        ...l,
        business_date: bill.business_date as string,
        created_at: bill.created_at as string,
      },
    });
  }
  out.sort((a, b) => a.i - b.i || a.line.line_no - b.line.line_no);
  return out.map((o) => o.line);
}
