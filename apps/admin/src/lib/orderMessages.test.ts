import { expect, test } from 'vitest';
import type { OnlineOrder } from '@dsb-pro/adapters';
import { orderMessage, whatsAppLink } from './orderMessages';

const o = {
  id: 'o1',
  publicRef: 'Z9TL7KL4XV',
  status: 'READY',
  fulfilment: 'pickup',
  deliverySlot: null,
  contactName: 'Ravi',
  contactPhone: '98765 43210',
  contactAddress: null,
  customerNote: null,
  subtotalPaise: 18000,
  deliveryFeePaise: 0,
  totalPaise: 18000,
  expiresAt: '',
  revision: 4,
  saleInvoiceId: null,
  cancelReason: null,
  createdAt: '',
} as OnlineOrder;

test('ready for pickup mentions the total and the UPI ID when set', () => {
  const m = orderMessage(o, 'READY', { name: 'DSB', upiId: 'dsb@okaxis' });
  expect(m).toContain('ready for pickup');
  expect(m).toContain('₹180.00');
  expect(m).toContain('dsb@okaxis');
  expect(orderMessage(o, 'READY', { name: 'DSB', upiId: null })).not.toContain('UPI');
});

test('cancel carries the reason; delivery carries the slot', () => {
  expect(orderMessage(o, 'CANCELLED', { name: 'DSB', upiId: null }, 'Out of stock')).toContain(
    'Out of stock',
  );
  const d = { ...o, fulfilment: 'delivery', deliverySlot: '5-7 pm' } as OnlineOrder;
  expect(orderMessage(d, 'READY', { name: 'DSB', upiId: null })).toContain('5-7 pm');
});

test('WhatsApp link adds 91 to a 10-digit number and keeps longer ones', () => {
  expect(whatsAppLink('98765 43210', 'hi')).toBe('https://wa.me/919876543210?text=hi');
  expect(whatsAppLink('+91 98765-43210', 'a b')).toBe('https://wa.me/919876543210?text=a%20b');
  expect(whatsAppLink('09876543210', 'x')).toBe('https://wa.me/919876543210?text=x');
});
