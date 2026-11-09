import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

/** Online orders (mig 0079/0080). Money in integer paise (as numbers; well inside safe range). */
export type OrderStatus =
  'NEW' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';
export type OnlineOrder = {
  id: string;
  publicRef: string;
  status: OrderStatus;
  fulfilment: 'pickup' | 'delivery';
  deliverySlot: string | null;
  contactName: string;
  contactPhone: string;
  contactAddress: string | null;
  customerNote: string | null;
  subtotalPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  expiresAt: string;
  revision: number;
  saleInvoiceId: string | null;
  cancelReason: string | null;
  createdAt: string;
};
export type OnlineOrderLine = {
  lineNo: number;
  itemName: string;
  unitName: string;
  qty: string;
  unitPricePaise: number;
  lineTotalPaise: number;
};

const fail = (e: unknown) => new Error(errorMessage(classifyError(e as never), e as never));
const COLS =
  'id,public_ref,status,fulfilment,delivery_slot,contact_name,contact_phone,contact_address,customer_note,subtotal_paise,delivery_fee_paise,total_paise,reservation_expires_at,revision,sale_invoice_id,cancel_reason,created_at';
type Row = Record<string, unknown>;
const toOrder = (r: Row): OnlineOrder => ({
  id: String(r.id),
  publicRef: String(r.public_ref),
  status: r.status as OrderStatus,
  fulfilment: r.fulfilment as 'pickup' | 'delivery',
  deliverySlot: (r.delivery_slot as string | null) ?? null,
  contactName: String(r.contact_name),
  contactPhone: String(r.contact_phone),
  contactAddress: (r.contact_address as string | null) ?? null,
  customerNote: (r.customer_note as string | null) ?? null,
  subtotalPaise: Number(r.subtotal_paise),
  deliveryFeePaise: Number(r.delivery_fee_paise),
  totalPaise: Number(r.total_paise),
  expiresAt: String(r.reservation_expires_at),
  revision: Number(r.revision),
  saleInvoiceId: (r.sale_invoice_id as string | null) ?? null,
  cancelReason: (r.cancel_reason as string | null) ?? null,
  createdAt: String(r.created_at),
});

/** Open orders (oldest first) or finished ones (newest first, last 100). */
export async function listOnlineOrders(shopId: string, open: boolean): Promise<OnlineOrder[]> {
  let q = getSupabaseClient().from('orders').select(COLS).eq('shop_id', shopId);
  q = open
    ? q
        .in('status', ['NEW', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'])
        .order('created_at', { ascending: true })
    : q
        .in('status', ['DELIVERED', 'CANCELLED'])
        .order('created_at', { ascending: false })
        .limit(100);
  const { data, error } = await q;
  if (error) throw fail(error);
  return ((data ?? []) as Row[]).map(toOrder);
}

export async function listOnlineOrderLines(orderId: string): Promise<OnlineOrderLine[]> {
  const { data, error } = await getSupabaseClient()
    .from('order_items')
    .select('line_no,item_name,unit_name,qty,unit_price_paise,line_total_paise')
    .eq('order_id', orderId)
    .order('line_no');
  if (error) throw fail(error);
  return ((data ?? []) as Row[]).map((r) => ({
    lineNo: Number(r.line_no),
    itemName: String(r.item_name),
    unitName: String(r.unit_name),
    qty: String(r.qty),
    unitPricePaise: Number(r.unit_price_paise),
    lineTotalPaise: Number(r.line_total_paise),
  }));
}

export async function setOnlineOrderStatus(
  orderId: string,
  to: OrderStatus,
  revision: number,
  reason?: string,
): Promise<{ status: OrderStatus; expired?: boolean }> {
  const { data, error } = await getSupabaseClient().rpc('set_order_status', {
    p_order_id: orderId,
    p_to: to,
    p_revision: revision,
    p_reason: reason ?? undefined,
  });
  if (error) throw fail(error);
  return data as unknown as { status: OrderStatus; expired?: boolean };
}

/** Hand over a READY order: one normal sale through post_sale. Payments as post_sale expects. */
export async function fulfilOnlineOrder(
  orderId: string,
  revision: number,
  payments: { mode: string; amount_paise: number }[],
): Promise<{ status: OrderStatus; saleId?: string; expired?: boolean }> {
  const { data, error } = await getSupabaseClient().rpc('fulfil_order', {
    p_order_id: orderId,
    p_revision: revision,
    p_payments: payments,
  });
  if (error) throw fail(error);
  return data as unknown as { status: OrderStatus; saleId?: string; expired?: boolean };
}

export async function expireDueOnlineOrders(shopId: string): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc('expire_due_orders', { p_shop_id: shopId });
  if (error) throw fail(error);
  return Number(data ?? 0);
}

/** Light read for staff alerts: open orders with their status and hold expiry only. */
export async function openOrderPulse(
  shopId: string,
): Promise<{ id: string; status: OrderStatus; expiresAt: string }[]> {
  const { data, error } = await getSupabaseClient()
    .from('orders')
    .select('id,status,reservation_expires_at')
    .eq('shop_id', shopId)
    .in('status', ['NEW', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'])
    .limit(200);
  if (error) throw fail(error);
  return ((data ?? []) as Row[]).map((r) => ({
    id: String(r.id),
    status: r.status as OrderStatus,
    expiresAt: String(r.reservation_expires_at),
  }));
}
