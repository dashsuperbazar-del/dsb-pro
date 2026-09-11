import { describe, expect, it } from 'vitest';
import { buildBusinessExportArchive, buildBusinessExportFiles, buildInvoicePdf } from './businessExport';

const fixture = {
  schemaVersion: 3,
  exportedAt: '2026-09-11T00:00:00Z',
  items: [{ id: 'item-1', name: '=unsafe formula' }],
  sales: [{ id: 'sale-1', doc_no: 'INV/1', business_date: '2026-09-11', status: 'FINALIZED', subtotal_paise: 12345, discount_paise: 0, extra_charges_paise: 0, total_paise: 12345 }],
  saleLines: [{ sale_invoice_id: 'sale-1', item_name_snapshot: 'Rice', qty: 1, unit_name_snapshot: 'bag', unit_price_paise: 12345, line_total_paise: 12345 }],
};

describe('full business export archive', () => {
  it('contains JSON, CSV, a PDF for every invoice, and a manifest', () => {
    const files = buildBusinessExportFiles(fixture);
    expect(files.map((file) => file.name)).toEqual(expect.arrayContaining([
      'dsb-pro-export.json', 'csv/items.csv', 'csv/sales.csv', 'csv/saleLines.csv',
      'invoice-pdfs/INV-1.pdf', 'archive-manifest.json', 'README.txt',
    ]));
    expect(new TextDecoder().decode(files.find((file) => file.name === 'csv/items.csv')?.bytes)).toContain("'=unsafe formula");
  });

  it('emits valid PDF and ZIP signatures', () => {
    expect(new TextDecoder().decode(buildInvoicePdf(fixture.sales[0], fixture.saleLines)).startsWith('%PDF-1.4')).toBe(true);
    expect([...buildBusinessExportArchive(fixture).slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
