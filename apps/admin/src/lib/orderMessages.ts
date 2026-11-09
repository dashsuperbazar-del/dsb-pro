import type { OnlineOrder, OrderStatus } from '@dsb-pro/adapters';
import { rupees } from './money';

// One-tap WhatsApp updates for online orders (free: sent from the staff phone, no WhatsApp Business API).
export type ShopInfo = { name: string; upiId: string | null };

export function orderMessage(
  o: OnlineOrder,
  status: OrderStatus,
  shop: ShopInfo,
  reason?: string,
): string {
  const total = rupees(o.totalPaise);
  const hi = `Hello ${o.contactName}, ${shop.name}:`;
  const upi = shop.upiId ? ` You can pay ${total} by UPI to ${shop.upiId}.` : '';
  switch (status) {
    case 'CONFIRMED':
      return `${hi} your order ${o.publicRef} (${total}) is confirmed. We will tell you when it is ready.`;
    case 'PREPARING':
      return `${hi} we are packing your order ${o.publicRef} now.`;
    case 'READY':
      return o.fulfilment === 'delivery'
        ? `${hi} your order ${o.publicRef} is ready and will be delivered${o.deliverySlot ? ` (${o.deliverySlot})` : ''}. Total ${total}.${upi}`
        : `${hi} your order ${o.publicRef} is ready for pickup. Total ${total}.${upi}`;
    case 'DELIVERED':
      return `${hi} thank you! Order ${o.publicRef} is complete (${total}).`;
    case 'CANCELLED':
      return `${hi} sorry, your order ${o.publicRef} was cancelled${reason || o.cancelReason ? `: ${reason || o.cancelReason}` : ''}.`;
    default:
      return `${hi} your order ${o.publicRef} was received (${total}).`;
  }
}

/** wa.me link to the customer's number (10-digit Indian numbers get 91 in front). */
export function whatsAppLink(phone: string, text: string): string {
  const digits = phone.replace(/[^0-9]/g, '').replace(/^0(?=\d{10}$)/, '');
  const full = /^\d{10}$/.test(digits) ? `91${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}
