import { canonicalQuantity, quantityTimesPaise } from '@dsb-pro/core';
import { BILL_DOCUMENT_PATH, type Item, type Party, type BillDocument } from '@dsb-pro/adapters';
import type { PurchaseDraftLine } from './purchaseWorkflow';

export type PurchaseDraft = {
  version: 1;
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
  editingLine: number | null;
  document?: BillDocument | null;
  documentIssue?: string;
};
export type SavedPurchaseDraft = { key: string; draft: PurchaseDraft };
export function purchaseDraftPrefix(userId: string, shopId: string) {
  if (!userId || !shopId) throw new Error('Sign in and select a shop to save a draft.');
  return `dsb-purchase-draft:${encodeURIComponent(userId)}:${encodeURIComponent(shopId)}:`;
}
function checked(value: unknown): PurchaseDraft {
  const d = value as PurchaseDraft | null;
  if (
    !d ||
    d.version !== 1 ||
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
  if (d.documentIssue !== undefined && typeof d.documentIssue !== 'string')
    throw new Error('Saved document selection state is unreadable. The draft has been kept.');
  if (d.document) {
    const photo = d.document,
      parts = BILL_DOCUMENT_PATH.exec(photo.path);
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
export function listPurchaseDrafts(prefix: string): SavedPurchaseDraft[] {
  const out: SavedPurchaseDraft[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const raw = localStorage.getItem(key);
    if (raw) out.push({ key, draft: checked(JSON.parse(raw)) });
  }
  return out.sort((a, b) => b.draft.savedAt - a.draft.savedAt);
}
// Each mounted editor writes its own snapshot, so another window cannot erase its work.
// Restored snapshots keep their posting identity: two windows cannot post the same draft twice.
export function savePurchaseDraft(prefix: string, writer: string, draft: PurchaseDraft) {
  const key = `${prefix}${draft.clientId}:${writer}`;
  const text = JSON.stringify(checked(draft));
  localStorage.setItem(key, text);
  if (localStorage.getItem(key) !== text) throw new Error('This device did not keep the draft.');
}
export function removePurchaseDraft(key: string) {
  localStorage.removeItem(key);
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
  };
}
