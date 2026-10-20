import { canonicalQuantity, quantityTimesPaise } from '@dsb-pro/core';
import { BILL_DOCUMENT_PATH, type Item, type Party, type BillDocument } from '@dsb-pro/adapters';
import type { PurchaseDraftLine } from './purchaseWorkflow';
import type { BillCardDraft } from './billCards';
import { hasTypedSale } from './billSalePrices';

export type PurchaseDraft = {
  /** 2 = written by the bill-extras editor (payment type, notes, charges, discount/GST, photos). Older app
   * versions accept only 1, so they keep a v2 draft as unreadable instead of posting it without those fields. */
  version: 1 | 2;
  clientId: string;
  savedAt: number;
  supplier: string;
  billNo: string;
  businessDate: string;
  discount: string;
  extra: string;
  cart: PurchaseDraftLine[];
  search: string;
  lineItem: Item | null;
  unitLevel: 1 | 2 | 3;
  qty: string;
  price: string;
  /** How `price` is to be read: per unit (default, older drafts) or the whole line total. */
  costMode?: 'unit' | 'total';
  /** P06 quick bill: the paper bill's total in paise, checked against the items before posting. */
  expectedTotalPaise?: string;
  editingLine: number | null;
  document?: BillDocument | null;
  documentIssue?: string;
  /** Bill entry cards (every item editable at once). Absent in drafts saved by the older single-form editor,
   * which restore from `cart` plus the half-typed form instead. `cart` always holds the complete cards. */
  cards?: BillCardDraft[];
  /** billextras: Credit (default, absent in older drafts) / Cash / UPI. */
  paymentType?: 'credit' | 'cash' | 'upi';
  notes?: string;
  /** Named extra charges as typed. Older drafts carry one amount in `extra` instead (shown as one row). */
  charges?: { label: string; amount: string }[];
  /** Bill photos in order (≤10). Older drafts carry one in `document`; new drafts keep `document` = the first. */
  documents?: BillDocument[];
};
export type SavedPurchaseDraft = { key: string; draft: PurchaseDraft };
/** N08: the purchase editor holds typed input (a preselected supplier alone does not count). */
export function hasTypedPurchaseInput(d: PurchaseDraft): boolean {
  return Boolean(
    d.document ||
    d.documents?.length ||
    (d.paymentType && d.paymentType !== 'credit') ||
    d.notes?.trim() ||
    d.charges?.some((c) => c.label.trim() || c.amount.trim()) ||
    d.cart.length ||
    d.billNo ||
    d.discount ||
    d.extra ||
    d.lineItem ||
    d.qty ||
    d.price ||
    // Typed sale prices sit on a card with an item, so they count through c.item; hasTypedSale is
    // checked as well so a price edit can never be the one unsaved entry the guard misses.
    d.cards?.some(
      (c) =>
        c.item ||
        c.search.trim() ||
        c.qty ||
        c.price ||
        c.discount?.trim() ||
        c.gst?.trim() ||
        hasTypedSale(c),
    ),
  );
}
// VF-017: a snapshot stores only what restore compares (id, name, units, conversions); restore swaps in
// the current catalog row. Whole item records made drafts large and could fill the device quota.
export const MAX_DRAFT_BYTES = 200_000;
const SNAP_KEYS = ['id', 'name', 'unit1', 'unit2', 'unit3', 'conv1', 'conv2'] as const;
function compactItem(i: Item): Item {
  const out: Record<string, unknown> = {};
  for (const k of SNAP_KEYS)
    if ((i as Record<string, unknown>)[k] !== undefined) out[k] = (i as Record<string, unknown>)[k];
  return out as unknown as Item;
}
function compactDraft(d: PurchaseDraft): PurchaseDraft {
  return {
    ...d,
    cart: d.cart.map((l) => ({ ...l, item: compactItem(l.item) })),
    lineItem: d.lineItem ? compactItem(d.lineItem) : null,
    ...(d.cards
      ? { cards: d.cards.map((c) => ({ ...c, item: c.item ? compactItem(c.item) : null })) }
      : {}),
  };
}
export function purchaseDraftPrefix(userId: string, shopId: string) {
  if (!userId || !shopId) throw new Error('Sign in and select a shop to save a draft.');
  return `dsb-purchase-draft:${encodeURIComponent(userId)}:${encodeURIComponent(shopId)}:`;
}
function checked(value: unknown): PurchaseDraft {
  const d = value as PurchaseDraft | null;
  if (
    !d ||
    (d.version !== 1 && d.version !== 2) ||
    typeof d.clientId !== 'string' ||
    !d.clientId ||
    !Number.isFinite(d.savedAt) ||
    !['supplier', 'billNo', 'businessDate', 'discount', 'extra', 'search', 'qty', 'price'].every(
      (key) => typeof (d as unknown as Record<string, unknown>)[key] === 'string',
    ) ||
    !Array.isArray(d.cart) ||
    ![1, 2, 3].includes(d.unitLevel) ||
    !(
      d.lineItem === null ||
      (typeof d.lineItem?.id === 'string' && typeof d.lineItem.unit1 === 'string')
    ) ||
    !(
      d.editingLine === null ||
      (Number.isInteger(d.editingLine) && d.editingLine >= 0 && d.editingLine < d.cart.length)
    ) ||
    !d.cart.every(
      (l) =>
        l &&
        typeof l.item?.id === 'string' &&
        typeof l.item.unit1 === 'string' &&
        [1, 2, 3].includes(l.unitLevel) &&
        typeof l.qty === 'string' &&
        Number.isSafeInteger(l.unitPricePaise) &&
        l.unitPricePaise >= 0,
    )
  )
    throw new Error('A saved purchase draft is unreadable. It has been kept on this device.');
  if (
    d.cards !== undefined &&
    !(
      Array.isArray(d.cards) &&
      d.cards.every(
        (c) =>
          c &&
          (c.item === null ||
            (typeof c.item?.id === 'string' && typeof c.item.unit1 === 'string')) &&
          [1, 2, 3].includes(c.unitLevel) &&
          typeof c.search === 'string' &&
          typeof c.qty === 'string' &&
          typeof c.price === 'string' &&
          (c.costMode === 'unit' || c.costMode === 'total') &&
          (c.unitHint === undefined || (Number.isSafeInteger(c.unitHint) && c.unitHint >= 0)) &&
          (c.discount === undefined || typeof c.discount === 'string') &&
          (c.gst === undefined || typeof c.gst === 'string') &&
          (c.suggested === undefined ||
            (!!c.suggested &&
              typeof c.suggested.date === 'string' &&
              typeof c.suggested.price === 'string')) &&
          (c.sale === undefined ||
            (!!c.sale &&
              [1, 2, 3].includes(c.sale.level) &&
              (['retail', 'wsQty', 'wsPrice'] as const).every(
                (k) => c.sale![k] === undefined || typeof c.sale![k] === 'string',
              ))),
      )
    )
  )
    throw new Error('Saved bill items are unreadable. The draft has been kept.');
  if (d.costMode !== undefined && d.costMode !== 'unit' && d.costMode !== 'total')
    throw new Error('Saved cost entry mode is unreadable. The draft has been kept.');
  if (
    d.expectedTotalPaise !== undefined &&
    !(typeof d.expectedTotalPaise === 'string' && /^[1-9]\d{0,14}$/.test(d.expectedTotalPaise))
  )
    throw new Error('Saved paper bill total is unreadable. The draft has been kept.');
  if (d.documentIssue !== undefined && typeof d.documentIssue !== 'string')
    throw new Error('Saved document selection state is unreadable. The draft has been kept.');
  if (d.paymentType !== undefined && !['credit', 'cash', 'upi'].includes(d.paymentType))
    throw new Error('Saved payment type is unreadable. The draft has been kept.');
  if (d.notes !== undefined && typeof d.notes !== 'string')
    throw new Error('Saved notes are unreadable. The draft has been kept.');
  if (
    d.charges !== undefined &&
    !(
      Array.isArray(d.charges) &&
      d.charges.every((c) => c && typeof c.label === 'string' && typeof c.amount === 'string')
    )
  )
    throw new Error('Saved extra charges are unreadable. The draft has been kept.');
  if (d.documents !== undefined && !(Array.isArray(d.documents) && d.documents.length <= 10))
    throw new Error('Saved bill photos are unreadable. The draft has been kept.');
  const photos = [...(d.document ? [d.document] : []), ...(d.documents ?? [])];
  if (d.documents && new Set(d.documents.map((p) => p?.id)).size !== d.documents.length)
    throw new Error('Saved bill photos are unreadable. The draft has been kept.');
  for (const photo of photos) {
    const parts = photo ? BILL_DOCUMENT_PATH.exec(photo.path) : null;
    if (
      !parts ||
      parts[3] !== d.clientId ||
      parts[4] !== photo.id ||
      typeof photo.name !== 'string' ||
      !['image/webp', 'application/pdf'].includes(photo.mime) ||
      typeof photo.uploaded !== 'boolean' ||
      !Number.isSafeInteger(photo.size) ||
      photo.size <= 0 ||
      photo.size > 5242880 ||
      !/^[0-9a-f]{64}$/.test(photo.sha256)
    )
      throw new Error('Saved bill attachment metadata is unreadable. The draft has been kept.');
  }
  for (const line of d.cart) {
    canonicalQuantity(line.qty);
    quantityTimesPaise(line.qty, line.unitPricePaise);
  }
  return d;
}
// VF-016: one unreadable snapshot must not hide the readable ones. Each key is parsed on its own;
// unreadable keys are reported separately (kept, never deleted silently) so the user can discard them.
export function scanPurchaseDrafts(prefix: string): {
  drafts: SavedPurchaseDraft[];
  unreadable: string[];
} {
  const drafts: SavedPurchaseDraft[] = [];
  const unreadable: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      drafts.push({ key, draft: checked(JSON.parse(raw)) });
    } catch {
      unreadable.push(key);
    }
  }
  drafts.sort((a, b) => b.draft.savedAt - a.draft.savedAt);
  return { drafts, unreadable: unreadable.sort() };
}
export function listPurchaseDrafts(prefix: string): SavedPurchaseDraft[] {
  return scanPurchaseDrafts(prefix).drafts;
}
// Each mounted editor writes its own snapshot, so another window cannot erase its work.
// Restored snapshots keep their posting identity: two windows cannot post the same draft twice.
export function savePurchaseDraft(prefix: string, writer: string, draft: PurchaseDraft): string {
  const key = `${prefix}${draft.clientId}:${writer}`;
  const text = JSON.stringify(compactDraft(checked(draft)));
  if (text.length > MAX_DRAFT_BYTES)
    throw new Error(
      `This draft is too large to save on this device (${draft.cards?.length ?? draft.cart.length} items). Post it in smaller bills; the page keeps your work meanwhile`,
    );
  localStorage.setItem(key, text);
  if (localStorage.getItem(key) !== text) throw new Error('This device did not keep the draft.');
  return key;
}
export function removePurchaseDraft(key: string) {
  localStorage.removeItem(key);
}
// Explicit user action only: snapshots older than the cut-off, listed first and never removed silently.
export function staleDrafts(drafts: SavedPurchaseDraft[], now: number, days: number) {
  return drafts.filter((s) => now - s.draft.savedAt > days * 86_400_000);
}
export function removePurchaseDrafts(keys: string[]) {
  for (const key of keys) localStorage.removeItem(key);
}
export function clearPurchaseDrafts(prefix: string, clientId: string) {
  // Remove only snapshots belonging to the server-confirmed request.
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(`${prefix}${clientId}:`)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}
/** The bill photos of a draft, whichever version saved it. */
export function draftDocuments(d: PurchaseDraft): BillDocument[] {
  return d.documents ?? (d.document ? [d.document] : []);
}
export function restorePurchaseDraft(
  draft: PurchaseDraft,
  items: Item[],
  parties: Party[],
): PurchaseDraft {
  checked(draft);
  if (draft.supplier && !parties.some((p) => p.id === draft.supplier))
    throw new Error('The saved supplier is unavailable. The draft has been kept.');
  function current(old: Item, level: 1 | 2 | 3) {
    const item = items.find((i) => i.id === old.id);
    const unit = (i: Item) => (level === 1 ? i.unit1 : level === 2 ? i.unit2 : i.unit3);
    if (
      !item ||
      !unit(item) ||
      unit(item) !== unit(old) ||
      Number(item.conv1 ?? 1) !== Number(old.conv1 ?? 1) ||
      Number(item.conv2 ?? 1) !== Number(old.conv2 ?? 1)
    )
      throw new Error(
        `${old.name || old.id}: item or units changed. The draft has been kept; review its original units before re-entering.`,
      );
    return item;
  }
  return {
    ...draft,
    cart: draft.cart.map((l) => ({ ...l, item: current(l.item, l.unitLevel) })),
    lineItem: draft.lineItem ? current(draft.lineItem, draft.unitLevel) : null,
    ...(draft.cards
      ? {
          cards: draft.cards.map((c) => ({
            ...c,
            item: c.item ? current(c.item, c.unitLevel) : null,
          })),
        }
      : {}),
  };
}
