import { formatQuantity, splitGst } from '@dsb-pro/core';
import type { PurchaseBalance, PurchaseHistoryLine, PurchaseRecord } from '@dsb-pro/adapters';
import type { SaleReceipt } from '@dsb-pro/adapters';
import { rupees } from './money';
import { percentText } from './billExtras';

// "Share as image": a clean receipt picture of a bill, invoice or statement. Display only: every amount
// shown is a value the server already stored (or a statement row it returned); nothing here is posted.
// Text is drawn with canvas fillText, which never interprets markup, and the WhatsApp text is URL-encoded,
// so user-entered names/notes are escaped only where they are rendered.

export type ReceiptRow = { left: string; right?: string; sub?: string; strong?: boolean };
export type ReceiptDoc = {
  /** Shop name first, then address / GSTIN lines. */
  header: string[];
  title: string;
  meta: string[];
  items: ReceiptRow[];
  totals: ReceiptRow[];
  footer: string[];
  /** One-line text for WhatsApp / the share sheet. */
  summary: string;
  fileName: string;
  /** Digits only, with country code (wa.me form), or null when unknown. */
  phone: string | null;
};
export type ShopLine = { name: string; address?: string | null; gstin?: string | null } | null;
export type PartyRef = { name: string; phone?: string | null } | null;

/** Max statement rows drawn; the rest are summarised (the full statement stays downloadable). */
export const STATEMENT_IMAGE_ROWS = 150;

const safeName = (s: string) =>
  s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';

function header(shop: ShopLine): string[] {
  if (!shop) return ['Shop'];
  return [shop.name, shop.address ?? null, shop.gstin ? `GSTIN ${shop.gstin}` : null].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/** Indian mobile → wa.me digits ("91" + 10 digits); anything unrecognised → null (generic share link). */
export function whatsappPhone(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(d)) return `91${d}`;
  if (/^0[6-9]\d{9}$/.test(d)) return `91${d.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(d)) return d;
  return null;
}
export function whatsappLink(phone: string | null, text: string): string {
  return `https://wa.me/${phone ?? ''}?text=${encodeURIComponent(text)}`;
}

export function saleInvoiceDoc(
  receipt: SaleReceipt,
  shop: ShopLine,
  customer: PartyRef,
): ReceiptDoc {
  const inv = receipt.invoice;
  const extra = inv.invoice_type === 'gst_extra';
  const tax = inv.tax_paise ?? 0;
  const totals: ReceiptRow[] = [
    { left: extra ? 'Subtotal (before GST)' : 'Subtotal', right: rupees(inv.subtotal_paise - tax) },
  ];
  if (inv.discount_paise > 0)
    totals.push({ left: 'Discount', right: `−${rupees(inv.discount_paise)}` });
  if (extra) {
    const g = splitGst(tax);
    totals.push(
      { left: 'CGST', right: rupees(g.cgstPaise) },
      { left: 'SGST', right: rupees(g.sgstPaise) },
    );
  }
  if (inv.extra_charges_paise > 0)
    totals.push({ left: 'Extra charges', right: rupees(inv.extra_charges_paise) });
  if ((inv.round_off_paise ?? 0) !== 0)
    totals.push({
      left: 'Round off',
      right: `${(inv.round_off_paise ?? 0) > 0 ? '+' : ''}${rupees(inv.round_off_paise ?? 0)}`,
    });
  totals.push({ left: 'Total', right: rupees(inv.total_paise), strong: true });
  for (const p of receipt.payments)
    if (p.status === 'POSTED')
      totals.push({
        left: `${p.direction === 'out' ? 'Refund' : 'Received'} (${p.mode.toUpperCase()})`,
        right: rupees(p.amount_paise),
      });
  if (inv.status !== 'VOID' && !receipt.payments.some((p) => p.status === 'POSTED'))
    totals.push({ left: 'Credit / unpaid', right: rupees(inv.total_paise) });
  const shopName = shop?.name ?? 'Shop';
  return {
    header: header(shop),
    title: inv.status === 'VOID' ? 'Sale invoice (VOID)' : 'Sale invoice',
    meta: [
      `Invoice ${inv.doc_no}`,
      ...(inv.bill_code ? [`Bill code ${inv.bill_code}`] : []),
      `Date ${inv.business_date}`,
      customer?.name ? `Customer ${customer.name}` : 'Walk-in customer',
    ],
    items: receipt.lines.map((l) => ({
      left: l.item_name_snapshot,
      sub: `${formatQuantity(l.qty)} ${l.unit_name_snapshot} × ${rupees(l.unit_price_paise)}${
        l.discount_paise ? ` · discount ${rupees(l.discount_paise)}` : ''
      }${extra ? ` · GST ${percentText(l.tax_rate_bp_snapshot ?? 0)}%` : ''}`,
      right: rupees(l.line_total_paise - (l.tax_paise ?? 0)),
    })),
    totals,
    footer: [inv.notes ? `Notes: ${inv.notes}` : '', 'Thank you · Powered by DSB Pro'].filter(
      Boolean,
    ),
    summary: `${shopName}: invoice ${inv.doc_no} dated ${inv.business_date}, total ${rupees(inv.total_paise)}.`,
    fileName: `invoice-${safeName(inv.doc_no)}.png`,
    phone: whatsappPhone(customer?.phone),
  };
}

export function purchaseBillDoc(
  detail: { bill: PurchaseRecord; lines: PurchaseHistoryLine[]; balance: PurchaseBalance | null },
  shop: ShopLine,
  supplier: PartyRef,
  lineExtras: { lineNo: number; discountBp: number; gstBp: number | null }[] = [],
): ReceiptDoc {
  const b = detail.bill;
  const totals: ReceiptRow[] = [{ left: 'Items', right: rupees(b.subtotal_paise) }];
  if (BigInt(b.discount_paise) !== 0n)
    totals.push({ left: 'Discount', right: `−${rupees(b.discount_paise)}` });
  if (BigInt(b.extra_charges_paise) !== 0n)
    totals.push({ left: 'Extra charges', right: rupees(b.extra_charges_paise) });
  if (b.round_off_paise && BigInt(b.round_off_paise) !== 0n)
    totals.push({
      left: 'Round off',
      right: `${b.round_off_paise.startsWith('-') ? '' : '+'}${rupees(b.round_off_paise)}`,
    });
  totals.push({ left: 'Total', right: rupees(b.total_paise), strong: true });
  if (detail.balance) {
    totals.push({ left: 'Paid', right: rupees(detail.balance.allocated_paise) });
    if (BigInt(detail.balance.returned_paise) !== 0n)
      totals.push({ left: 'Returned', right: rupees(detail.balance.returned_paise) });
    totals.push({
      left: 'Balance due',
      right: rupees(detail.balance.outstanding_paise),
      strong: true,
    });
  }
  const billNo = b.bill_no || 'Purchase bill';
  const shopName = shop?.name ?? 'Shop';
  return {
    header: header(shop),
    title: b.status === 'VOID' ? 'Purchase bill (VOID)' : 'Purchase bill',
    meta: [
      `Bill ${billNo}`,
      ...(b.bill_code ? [`Bill code ${b.bill_code}`] : []),
      `Date ${b.business_date}`,
      `Supplier ${supplier?.name || 'Unknown supplier'}`,
    ],
    items: detail.lines.map((l) => {
      const x = lineExtras.find((e) => e.lineNo === l.line_no);
      return {
        left: l.item_name_snapshot,
        sub: `${formatQuantity(l.qty)} ${l.unit_name_snapshot} × ${rupees(l.unit_price_paise)}${
          x?.discountBp ? ` − ${percentText(x.discountBp)}% discount` : ''
        }${x && x.gstBp !== null ? ` + ${percentText(x.gstBp)}% GST` : ''}`,
        right: rupees(l.line_total_paise),
      };
    }),
    totals,
    footer: ['Powered by DSB Pro'],
    summary: `${shopName}: purchase bill ${billNo} dated ${b.business_date}, total ${rupees(b.total_paise)}${
      detail.balance ? `, due ${rupees(detail.balance.outstanding_paise)}` : ''
    }.`,
    fileName: `purchase-${safeName(billNo)}-${b.business_date}.png`,
    phone: whatsappPhone(supplier?.phone),
  };
}

export type StatementInput = {
  kind: 'Customer' | 'Supplier';
  partyName: string;
  phone?: string | null;
  shop: ShopLine;
  from: string | null;
  to: string;
  openingBalancePaise: string;
  closingBalancePaise: string;
  entries: Array<{
    date: string;
    label: string;
    document: string;
    amountPaise: string;
    runningBalancePaise: string;
  }>;
  note: string;
};
export function statementDoc(s: StatementInput): ReceiptDoc {
  const shown = s.entries.slice(-STATEMENT_IMAGE_ROWS);
  const hidden = s.entries.length - shown.length;
  const items: ReceiptRow[] = shown.map((e) => ({
    left: `${e.date} · ${e.label}`,
    sub: `${e.document ? `${e.document} · ` : ''}Balance ${rupees(e.runningBalancePaise)}`,
    right: rupees(e.amountPaise),
  }));
  if (hidden > 0)
    items.unshift({ left: `${hidden} earlier entries not shown — download the full statement.` });
  if (!s.entries.length) items.push({ left: 'No posted entries in this period.' });
  const shopName = s.shop?.name ?? 'Shop';
  const period = `${s.from ?? 'All recorded history'} to ${s.to}`;
  return {
    header: header(s.shop),
    title: `${s.kind} statement`,
    meta: [`${s.kind} ${s.partyName}`, `Period ${period}`],
    items,
    totals: [
      { left: 'Opening balance', right: rupees(s.openingBalancePaise) },
      { left: 'Closing balance', right: rupees(s.closingBalancePaise), strong: true },
    ],
    footer: [s.note],
    summary: `${shopName}: ${s.kind.toLowerCase()} statement for ${s.partyName} (${period}), balance ${rupees(s.closingBalancePaise)}.`,
    fileName: `${s.kind.toLowerCase()}-statement-${safeName(s.partyName)}-${s.to}.png`,
    phone: whatsappPhone(s.phone),
  };
}

// ---- Layout (pure; unit-tested) ----

export type DrawOp =
  | {
      kind: 'text';
      x: number;
      y: number;
      text: string;
      size: number;
      bold: boolean;
      align: 'left' | 'right' | 'center';
      muted: boolean;
    }
  | { kind: 'rule'; y: number };
export type Layout = { width: number; height: number; ops: DrawOp[] };
export type Measure = (text: string, size: number, bold: boolean) => number;
/** Rough width estimate used when no canvas is available (tests); the canvas passes measureText. */
export const estimateWidth: Measure = (text, size, bold) =>
  text.length * size * (bold ? 0.6 : 0.55);

export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  bold: boolean,
  measure: Measure,
): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, size, bold) <= maxWidth || !line) {
      line = next;
      // A single word wider than the column is hard-broken.
      while (measure(line, size, bold) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut), size, bold) > maxWidth) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

export function layoutReceipt(
  doc: ReceiptDoc,
  measure: Measure = estimateWidth,
  width = 720,
): Layout {
  const pad = 32;
  const inner = width - pad * 2;
  const ops: DrawOp[] = [];
  let y = pad;
  const text = (
    t: string,
    size: number,
    opts: {
      bold?: boolean;
      align?: 'left' | 'right' | 'center';
      muted?: boolean;
      max?: number;
    } = {},
  ) => {
    const bold = Boolean(opts.bold);
    const align = opts.align ?? 'left';
    const lines = wrapText(t, opts.max ?? inner, size, bold, measure);
    for (const l of lines) {
      y += Math.round(size * 1.35);
      const x = align === 'center' ? width / 2 : align === 'right' ? width - pad : pad;
      ops.push({ kind: 'text', x, y, text: l, size, bold, align, muted: Boolean(opts.muted) });
    }
  };
  const rule = () => {
    y += 12;
    ops.push({ kind: 'rule', y });
    y += 4;
  };
  const row = (r: ReceiptRow, size: number) => {
    const bold = Boolean(r.strong);
    const rightW = r.right ? measure(r.right, size, bold) + 16 : 0;
    const startY = y;
    text(r.left, size, { bold, max: inner - rightW });
    const endY = y;
    if (r.right)
      ops.push({
        kind: 'text',
        x: width - pad,
        y: startY + Math.round(size * 1.35),
        text: r.right,
        size,
        bold,
        align: 'right',
        muted: false,
      });
    y = endY;
    if (r.sub) text(r.sub, size - 6, { muted: true, max: inner - rightW });
    y += 6;
  };
  const [shopName, ...shopRest] = doc.header;
  text(shopName ?? 'Shop', 30, { bold: true, align: 'center' });
  for (const h of shopRest) text(h, 18, { align: 'center', muted: true });
  rule();
  text(doc.title, 24, { bold: true, align: 'center' });
  for (const m of doc.meta) text(m, 20);
  rule();
  for (const it of doc.items) row(it, 22);
  rule();
  for (const t of doc.totals) row(t, t.strong ? 24 : 21);
  if (doc.footer.length) rule();
  for (const f of doc.footer) text(f, 16, { muted: true, align: 'center' });
  y += pad;
  return { width, height: y, ops };
}

// ---- Canvas + share (browser) ----

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';
const font = (size: number, bold: boolean) => `${bold ? '700 ' : ''}${size}px ${FONT}`;

export function renderReceiptCanvas(doc: ReceiptDoc, d: Document = document): HTMLCanvasElement {
  const canvas = d.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Images cannot be drawn in this browser.');
  const measure: Measure = (t, size, bold) => {
    ctx.font = font(size, bold);
    return ctx.measureText(t).width;
  };
  const layout = layoutReceipt(doc, measure);
  canvas.width = layout.width;
  canvas.height = layout.height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, layout.width, layout.height);
  for (const op of layout.ops) {
    if (op.kind === 'rule') {
      ctx.fillStyle = '#d0d4da';
      ctx.fillRect(32, op.y, layout.width - 64, 2);
      continue;
    }
    ctx.font = font(op.size, op.bold);
    ctx.textAlign = op.align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = op.muted ? '#5b6470' : '#111418';
    ctx.fillText(op.text, op.x, op.y);
  }
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The image could not be made.'))),
      'image/png',
    ),
  );
}

export type ShareOutcome = 'shared' | 'downloaded' | 'downloaded-no-popup' | 'cancelled';
/**
 * Shares the receipt picture through the system share sheet when it accepts files; otherwise downloads
 * the PNG and opens WhatsApp with the one-line summary (to the party's number when known).
 */
export async function shareReceiptImage(doc: ReceiptDoc): Promise<ShareOutcome> {
  const blob = await toBlob(renderReceiptCanvas(doc));
  const file = new File([blob], doc.fileName, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (
    typeof nav.share === 'function' &&
    typeof nav.canShare === 'function' &&
    nav.canShare({ files: [file] })
  ) {
    try {
      await nav.share({ files: [file], title: doc.title, text: doc.summary });
      return 'shared';
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return 'cancelled';
      // Share sheet failed: fall through to the download fallback.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // May be stopped by a popup blocker (no user gesture after the async render): the caller shows the link.
  // ('noopener' would make window.open return null even when it opened, so the opener is cut by hand.)
  const w = window.open(whatsappLink(doc.phone, doc.summary), '_blank');
  if (!w) return 'downloaded-no-popup';
  w.opener = null;
  return 'downloaded';
}
