import { describe, expect, it } from 'vitest';
import type { SaleReceipt } from '@dsb-pro/adapters';
import {
  STATEMENT_IMAGE_ROWS,
  layoutReceipt,
  purchaseBillDoc,
  saleInvoiceDoc,
  statementDoc,
  whatsappLink,
  whatsappPhone,
  wrapText,
  estimateWidth,
} from './shareImage';

const shop = { name: 'Sharma Kirana', address: 'MG Road', gstin: '29ABCDE1234F1Z5' };

const receipt = (over: Partial<SaleReceipt['invoice']> = {}): SaleReceipt => ({
  invoice: {
    id: 's1',
    customer_id: 'c1',
    doc_no: 'INV-7',
    business_date: '2026-10-20',
    status: 'FINALIZED',
    subtotal_paise: 10500,
    discount_paise: 0,
    extra_charges_paise: 0,
    round_off_paise: 0,
    total_paise: 10500,
    notes: null,
    created_at: '2026-10-20T10:00:00Z',
    invoice_type: 'gst_extra',
    tax_paise: 501,
    ...over,
  },
  lines: [
    {
      item_name_snapshot: 'Rice <b>1kg</b>',
      unit_name_snapshot: 'kg',
      qty: 1.5,
      unit_price_paise: 6666,
      discount_paise: 0,
      line_total_paise: 10500,
      tax_paise: 501,
      tax_rate_bp_snapshot: 500,
    },
  ],
  payments: [
    {
      id: 'p1',
      amount_paise: 10500,
      direction: 'in',
      mode: 'upi',
      reference: null,
      status: 'POSTED',
    },
  ],
});

describe('whatsapp', () => {
  it('normalises Indian mobiles and leaves others generic', () => {
    expect(whatsappPhone('98765 43210')).toBe('919876543210');
    expect(whatsappPhone('+91-98765-43210')).toBe('919876543210');
    expect(whatsappPhone('098765 43210')).toBe('919876543210');
    expect(whatsappPhone('12345')).toBeNull();
    expect(whatsappPhone(null)).toBeNull();
    expect(whatsappLink(null, 'a & b')).toBe('https://wa.me/?text=a%20%26%20b');
    expect(whatsappLink('919876543210', 'x')).toBe('https://wa.me/919876543210?text=x');
  });
});

describe('sale invoice image', () => {
  it('shows stored amounts, GST split and quantities without HTML interpretation', () => {
    const doc = saleInvoiceDoc(receipt(), shop, { name: 'Asha', phone: '9876543210' });
    expect(doc.header).toEqual(['Sharma Kirana', 'MG Road', 'GSTIN 29ABCDE1234F1Z5']);
    expect(doc.meta).toEqual(['Invoice INV-7', 'Date 2026-10-20', 'Customer Asha']);
    expect(doc.items[0]).toEqual({
      left: 'Rice <b>1kg</b>',
      sub: '1.5 kg × ₹66.66 · GST 5%',
      right: '₹99.99',
    });
    const totals = Object.fromEntries(doc.totals.map((t) => [t.left, t.right]));
    expect(totals['Subtotal (before GST)']).toBe('₹99.99');
    expect(totals.CGST).toBe('₹2.51');
    expect(totals.SGST).toBe('₹2.50');
    expect(totals.Total).toBe('₹105.00');
    expect(totals['Received (UPI)']).toBe('₹105.00');
    expect(doc.phone).toBe('919876543210');
    expect(doc.summary).toBe('Sharma Kirana: invoice INV-7 dated 2026-10-20, total ₹105.00.');
    expect(doc.fileName).toBe('invoice-INV-7.png');
  });
  it('marks an unpaid invoice as credit', () => {
    const r = receipt({ invoice_type: 'gst_included', tax_paise: 0 });
    r.payments = [];
    const doc = saleInvoiceDoc(r, null, null);
    expect(doc.header).toEqual(['Shop']);
    expect(doc.meta[2]).toBe('Walk-in customer');
    expect(doc.totals.map((t) => t.left)).toEqual(['Subtotal', 'Total', 'Credit / unpaid']);
  });
});

describe('purchase bill image', () => {
  it('uses server totals and balance', () => {
    const doc = purchaseBillDoc(
      {
        bill: {
          id: 'b1',
          party_id: 'p1',
          bill_no: 'A/12',
          bill_image_path: null,
          business_date: '2026-10-19',
          created_at: '',
          status: 'POSTED',
          subtotal_paise: '20000',
          discount_paise: '500',
          extra_charges_paise: '0',
          round_off_paise: '-50',
          total_paise: '19450',
        },
        lines: [
          {
            id: 'l1',
            item_id: 'i1',
            line_no: 1,
            item_name_snapshot: 'Oil',
            unit_name_snapshot: 'box',
            conv1_snapshot: 12,
            conv2_snapshot: null,
            unit_level: 1,
            qty: '2.000',
            unit_price_paise: '10000',
            line_total_paise: '20000',
          },
        ],
        balance: {
          purchase_bill_id: 'b1',
          outstanding_paise: '9450',
          allocated_paise: '10000',
          returned_paise: '0',
        },
      },
      shop,
      { name: 'Gupta Traders', phone: null },
      [{ lineNo: 1, discountBp: 0, gstBp: 1200 }],
    );
    expect(doc.items[0]!.sub).toBe('2 box × ₹100.00 + 12% GST');
    expect(doc.totals.map((t) => `${t.left}=${t.right}`)).toEqual([
      'Items=₹200.00',
      'Discount=−₹5.00',
      'Round off=−₹0.50',
      'Total=₹194.50',
      'Paid=₹100.00',
      'Balance due=₹94.50',
    ]);
    expect(doc.fileName).toBe('purchase-A-12-2026-10-19.png');
    expect(doc.phone).toBeNull();
  });
});

describe('statement image', () => {
  it('caps rows and keeps the closing balance', () => {
    const entries = Array.from({ length: STATEMENT_IMAGE_ROWS + 5 }, (_, i) => ({
      date: '2026-10-01',
      label: 'Sale',
      document: `INV-${i}`,
      amountPaise: '100',
      runningBalancePaise: String((i + 1) * 100),
    }));
    const doc = statementDoc({
      kind: 'Customer',
      partyName: 'Asha',
      phone: '9876543210',
      shop,
      from: null,
      to: '2026-10-20',
      openingBalancePaise: '0',
      closingBalancePaise: String(entries.length * 100),
      entries,
      note: 'note',
    });
    expect(doc.items).toHaveLength(STATEMENT_IMAGE_ROWS + 1);
    expect(doc.items[0]!.left).toMatch(/^5 earlier entries/);
    expect(doc.totals.at(-1)).toEqual({ left: 'Closing balance', right: '₹155.00', strong: true });
    expect(doc.meta[1]).toBe('Period All recorded history to 2026-10-20');
  });
});

describe('layout', () => {
  it('wraps long words and text within the column', () => {
    expect(wrapText('aaaa bbbb cccc', 40, 10, false, estimateWidth)).toEqual([
      'aaaa',
      'bbbb',
      'cccc',
    ]);
    const hard = wrapText('x'.repeat(30), 50, 10, false, estimateWidth);
    expect(hard.join('')).toBe('x'.repeat(30));
    expect(hard.every((l) => estimateWidth(l, 10, false) <= 50)).toBe(true);
  });
  it('places every text inside the canvas, amounts right-aligned', () => {
    const doc = saleInvoiceDoc(receipt(), shop, null);
    const layout = layoutReceipt(doc);
    expect(layout.width).toBe(720);
    const texts = layout.ops.filter((o) => o.kind === 'text');
    for (const t of texts) {
      expect(t.y).toBeLessThanOrEqual(layout.height);
      if (t.align === 'left')
        expect(estimateWidth(t.text, t.size, t.bold)).toBeLessThanOrEqual(656);
    }
    expect(texts[0]).toMatchObject({ text: 'Sharma Kirana', align: 'center', bold: true });
    const total = texts.find((t) => t.text === '₹105.00' && t.bold);
    expect(total).toMatchObject({ align: 'right', x: 688 });
    expect(texts.map((t) => t.text)).toContain('Rice <b>1kg</b>');
  });
});
