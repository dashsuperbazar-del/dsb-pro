type ExportRow = Record<string, unknown>;

export type ExportFile = { name: string; bytes: Uint8Array };

const encoder = new TextEncoder();

function asRows(value: unknown): ExportRow[] {
  return Array.isArray(value) ? value.filter((row): row is ExportRow => Boolean(row) && typeof row === 'object') : [];
}

function csv(rows: ExportRow[]): string {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  const escape = (value: unknown) => {
    const raw = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
    const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [keys.map(escape).join(','), ...rows.map((row) => keys.map((key) => escape(row[key])).join(','))].join('\r\n');
}

function safeName(value: unknown): string {
  const name = String(value ?? 'invoice').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (name || 'invoice').slice(0, 100);
}

function pdfText(value: unknown): string {
  return String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '?').replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function money(value: unknown): string {
  const paise = Number(value ?? 0);
  return Number.isFinite(paise) ? `INR ${(paise / 100).toFixed(2)}` : 'INR 0.00';
}

/** Creates a small, dependency-free, printable PDF for a single exported invoice. */
export function buildInvoicePdf(invoice: ExportRow, lines: ExportRow[]): Uint8Array {
  const textLines = [
    'DSB Pro invoice',
    `Invoice: ${String(invoice.doc_no ?? invoice.id ?? '')}`,
    `Date: ${String(invoice.business_date ?? '')}`,
    `Status: ${String(invoice.status ?? '')}`,
    '',
    'Item | Qty | Rate | Amount',
    ...lines.map((line) => `${String(line.item_name_snapshot ?? '')} | ${String(line.qty ?? '')} ${String(line.unit_name_snapshot ?? '')} | ${money(line.unit_price_paise)} | ${money(line.line_total_paise)}`),
    '',
    `Subtotal: ${money(invoice.subtotal_paise)}`,
    `Discount: ${money(invoice.discount_paise)}`,
    `Extra charges: ${money(invoice.extra_charges_paise)}`,
    `Total: ${money(invoice.total_paise)}`,
    '',
    'Generated from the portable DSB Pro business-data export.',
  ];
  const pages = Array.from({ length: Math.max(1, Math.ceil(textLines.length / 44)) }, (_, index) => textLines.slice(index * 44, (index + 1) * 44));
  const objects: string[] = [];
  const pageIds: number[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const pageLines of pages) {
    const content = `BT\n/F1 10 Tf\n45 800 Td\n14 TL\n${pageLines.map((line, index) => `${index ? 'T* ' : ''}(${pdfText(line).slice(0, 110)}) Tj`).join('\n')}\nET`;
    const contentId = objects.push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);
    const pageId = objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(body).length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = encoder.encode(body).length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(body);
}

export function buildBusinessExportFiles(data: Record<string, unknown>): ExportFile[] {
  const files: ExportFile[] = [{ name: 'dsb-pro-export.json', bytes: encoder.encode(JSON.stringify(data, null, 2)) }];
  for (const [key, value] of Object.entries(data).sort(([a], [b]) => a.localeCompare(b))) {
    if (Array.isArray(value)) files.push({ name: `csv/${safeName(key)}.csv`, bytes: encoder.encode(csv(asRows(value))) });
  }
  const sales = asRows(data.sales);
  const saleLines = asRows(data.saleLines);
  sales.forEach((invoice, index) => {
    const id = String(invoice.id ?? '');
    const lines = saleLines.filter((line) => String(line.sale_invoice_id ?? '') === id);
    files.push({ name: `invoice-pdfs/${safeName(invoice.doc_no ?? id ?? index + 1)}.pdf`, bytes: buildInvoicePdf(invoice, lines) });
  });
  const manifest = {
    schemaVersion: 1,
    exportSchemaVersion: data.schemaVersion ?? null,
    exportedAt: data.exportedAt ?? null,
    csvFileCount: files.filter((file) => file.name.endsWith('.csv')).length,
    invoicePdfCount: sales.length,
  };
  files.push({ name: 'archive-manifest.json', bytes: encoder.encode(JSON.stringify(manifest, null, 2)) });
  files.push({ name: 'README.txt', bytes: encoder.encode('DSB Pro full device backup\n\nContains the portable JSON export, one CSV per exported table, and one PDF per invoice. Keep an encrypted copy off this device.\n') });
  return files;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): number[] { return [value & 0xff, (value >>> 8) & 0xff]; }
function u32(value: number): number[] { return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]; }

/** Builds a standards-compliant ZIP using STORE entries so recovery needs no proprietary tool. */
export function buildBusinessExportArchive(data: Record<string, unknown>): Uint8Array {
  const files = buildBusinessExportFiles(data);
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    local.push(Uint8Array.from([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(file.bytes.length), ...u32(file.bytes.length), ...u16(name.length), ...u16(0), ...name]), file.bytes);
    central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(file.bytes.length), ...u32(file.bytes.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]));
    offset += 30 + name.length + file.bytes.length;
  }
  const localSize = local.reduce((sum, part) => sum + part.length, 0);
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(localSize), ...u16(0)]);
  const output = new Uint8Array(localSize + centralSize + end.length);
  let cursor = 0;
  for (const part of [...local, ...central, end]) { output.set(part, cursor); cursor += part.length; }
  return output;
}
