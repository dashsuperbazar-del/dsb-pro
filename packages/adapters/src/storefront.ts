import type { Json } from '@dsb-pro/db';
import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

/** Online shop settings (mig 0077). Money in integer paise. */
export type StorefrontSettings = {
  enabled: boolean;
  slug: string;
  displayName: string;
  publicContact: string | null;
  pickupNote: string | null;
  orderHours: string | null;
  reservationMinutes: number;
  maxLines: number;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  deliveryFeePaise: number;
  minOrderPaise: number;
  freeDeliveryAbovePaise: number | null;
  deliverySlots: string[];
  deliveryNote: string | null;
  /** mig 0081 (read only here; saved with saveStorefrontUpi). */
  upiId?: string | null;
  upiName?: string | null;
};
export type StorefrontItem = { itemId: string; published: boolean; description: string | null };

const fail = (error: unknown) =>
  new Error(errorMessage(classifyError(error as never), error as never));

type Row = {
  enabled: boolean;
  slug: string;
  display_name: string;
  public_contact: string | null;
  pickup_note: string | null;
  order_hours: string | null;
  reservation_minutes: number;
  max_lines: number;
  pickup_enabled: boolean;
  delivery_enabled: boolean;
  delivery_fee_paise: number | string;
  min_order_paise: number | string;
  free_delivery_above_paise: number | string | null;
  delivery_slots: unknown;
  delivery_note: string | null;
  upi_id?: string | null;
  upi_name?: string | null;
};

/** The shop's online shop settings, or null when never set up. */
export async function getStorefrontSettings(shopId: string): Promise<StorefrontSettings | null> {
  const { data, error } = await getSupabaseClient()
    .from('storefront_settings')
    .select(
      'enabled,slug,display_name,public_contact,pickup_note,order_hours,reservation_minutes,max_lines,pickup_enabled,delivery_enabled,delivery_fee_paise,min_order_paise,free_delivery_above_paise,delivery_slots,delivery_note,upi_id,upi_name',
    )
    .eq('shop_id', shopId)
    .maybeSingle();
  if (error) throw fail(error);
  if (!data) return null;
  const r = data as Row;
  return {
    enabled: r.enabled,
    slug: r.slug,
    displayName: r.display_name,
    publicContact: r.public_contact,
    pickupNote: r.pickup_note,
    orderHours: r.order_hours,
    reservationMinutes: r.reservation_minutes,
    maxLines: r.max_lines,
    pickupEnabled: r.pickup_enabled,
    deliveryEnabled: r.delivery_enabled,
    deliveryFeePaise: Number(r.delivery_fee_paise),
    minOrderPaise: Number(r.min_order_paise),
    freeDeliveryAbovePaise:
      r.free_delivery_above_paise === null ? null : Number(r.free_delivery_above_paise),
    deliverySlots: Array.isArray(r.delivery_slots)
      ? r.delivery_slots.filter((s): s is string => typeof s === 'string')
      : [],
    deliveryNote: r.delivery_note,
    upiId: r.upi_id ?? null,
    upiName: r.upi_name ?? null,
  };
}

export async function saveStorefrontSettings(
  shopId: string,
  s: StorefrontSettings,
  clientId: string,
): Promise<void> {
  const { upiId: _u, upiName: _n, ...settings } = s;
  void _u;
  void _n;
  const { error } = await getSupabaseClient().rpc('set_storefront_settings', {
    p_shop_id: shopId,
    p_settings: settings as unknown as Json,
    p_client_id: clientId,
  });
  if (error) throw fail(error);
}

/** Published flags of this shop's items (items never set up are simply absent). */
export async function listStorefrontItems(shopId: string): Promise<StorefrontItem[]> {
  const out: StorefrontItem[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await getSupabaseClient()
      .from('storefront_items')
      .select('item_id,published,description')
      .eq('shop_id', shopId)
      .is('deleted_at', null)
      .order('item_id')
      .range(from, from + 999);
    if (error) throw fail(error);
    const rows = (data ?? []) as {
      item_id: string;
      published: boolean;
      description: string | null;
    }[];
    for (const r of rows)
      out.push({ itemId: r.item_id, published: r.published, description: r.description });
    if (rows.length < 1000) return out;
  }
}

/** Publish/unpublish up to 500 items per call (more are sent in batches). Returns rows written. */
export async function saveStorefrontItems(
  shopId: string,
  items: StorefrontItem[],
  clientId: string,
): Promise<number> {
  let n = 0;
  for (let i = 0; i < items.length; i += 500) {
    const { data, error } = await getSupabaseClient().rpc('set_storefront_items', {
      p_shop_id: shopId,
      p_items: items.slice(i, i + 500) as unknown as Json,
      p_client_id: `${clientId}:${i / 500}`,
    });
    if (error) throw fail(error);
    n += Number(data ?? 0);
  }
  return n;
}

/** The shop's UPI ID for "Pay by UPI" on the public order page (mig 0081). Blank clears it. */
export async function saveStorefrontUpi(
  shopId: string,
  upiId: string,
  upiName: string,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('set_storefront_upi', {
    p_shop_id: shopId,
    p_upi_id: upiId,
    p_upi_name: upiName,
  });
  if (error) throw fail(error);
}
