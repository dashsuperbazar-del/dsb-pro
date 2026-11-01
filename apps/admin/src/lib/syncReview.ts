import type {
  LocalSyncConflict,
  OfflineBillChangeRecord,
  OfflineItemRecord,
  OfflinePurchaseRecord,
  OfflineSaleRecord,
  OfflineSupplierPaymentRecord,
} from '@dsb-pro/sync';
import type { ServerSyncConflict } from '@dsb-pro/adapters';
import { friendlyError } from './friendlyError';
import { friendlySaleName } from './saleDone';
import { rupees } from './money';
import { appRoute } from './paths';

// Sync review (D9): ONE card per underlying event. The device keeps a local alert and the shop keeps a
// shared record of the same event; both carry the request id of the operation (local `clientId`, shop
// `op_client_id`), so they are merged by that id. Everything here is display: nothing changes a record.

export type ReviewKind = 'item' | 'purchase' | 'payment' | 'sale' | 'other';
export type ReviewFix = 'item-name' | 'bill' | 'edit' | 'void' | 'payment' | 'return' | 'none';
export type ReviewLink = { label: string; href: string };
export type ReviewCard = {
  key: string;
  kind: ReviewKind;
  /** Moves money or a bill: flagged in the bulk confirmation. */
  money: boolean;
  title: string;
  sentence: string;
  code: string | null;
  happenedAt: number;
  /** Where the alert lives: this device, the shop, or both. */
  where: 'device' | 'shop' | 'both';
  localIds: number[];
  serverIds: string[];
  clientId: string | null;
  target: string;
  /** Collapsed "Details": the raw technical text. */
  details: string[];
  /** What else is waiting on this (e.g. bills held by a refused item). */
  affected: { label: string; href: string }[];
  fix: ReviewFix;
  link: ReviewLink | null;
  /** The refused item, when this card is about an item create. */
  item: OfflineItemRecord | null;
  nameTaken: boolean;
};

export type ReviewInput = {
  conflicts: readonly LocalSyncConflict[];
  serverConflicts: readonly ServerSyncConflict[];
  items?: readonly OfflineItemRecord[];
  purchases?: readonly OfflinePurchaseRecord[];
  billChanges?: readonly OfflineBillChangeRecord[];
  payments?: readonly OfflineSupplierPaymentRecord[];
  sales?: readonly OfflineSaleRecord[];
  /** Shop alerts already cleared on this device by a person who may not clear them for the shop. */
  hiddenServerIds?: ReadonlySet<string>;
};

export const KIND_ORDER: ReviewKind[] = ['item', 'purchase', 'payment', 'sale', 'other'];
export const KIND_TITLE: Record<ReviewKind, string> = {
  item: 'New items',
  purchase: 'Purchases and bill changes',
  payment: 'Supplier payments',
  sale: 'Sales and returns',
  other: 'Other',
};

const ITEM_TARGET = 'create_item_v2';
const PURCHASE_TARGET = 'post_purchase_v2';
const CHANGE_TARGET = 'purchase_bill_change';
const PAYMENT_TARGET = 'supplier_payment';
const ITEM_REJECTED = 'DSB_ITEM_REJECTED';
const norm = (s: string) => s.trim().toLowerCase();
const linesOf = (r: unknown): { itemId?: unknown }[] => {
  const lines = (r as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? (lines as { itemId?: unknown }[]) : [];
};
const stop = (s: string) => (/[.!?]$/.test(s) ? s : s + '.');

export function billLabel(p: OfflinePurchaseRecord) {
  const bill = p.billNo ? `Purchase ${p.billNo}` : 'Purchase';
  return `${bill}${p.supplierName ? ` for ${p.supplierName}` : ''} ${rupees(p.totalPaise)}`;
}

/** A name hint for "Rename and create", e.g. "Camel match box 12 pcs". */
export function suggestRename(item: OfflineItemRecord) {
  const f = item.fields;
  return f.conv1 && f.unit2 ? `${f.name} ${f.conv1} ${f.unit2}` : `${f.name} (${f.unit1})`;
}

export function sameName(a: string, b: string) {
  return norm(a) === norm(b);
}

// A person who may not clear shop-wide alerts (a cashier), or a device with no connection, still wants the
// alert gone from THIS device's list. Remembered per user in this browser only (a convenience; the shop
// record itself is untouched). Wrapped in try/catch: storage may be unavailable.
const hiddenKey = (userId: string | undefined) => `dsb-pro:sync-hidden:${userId ?? 'anon'}`;
export function readHiddenServerIds(userId: string | undefined): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(hiddenKey(userId)) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}
export function hideServerIds(userId: string | undefined, ids: readonly string[]) {
  if (!ids.length) return;
  try {
    const all = readHiddenServerIds(userId);
    for (const id of ids) all.add(id);
    localStorage.setItem(hiddenKey(userId), JSON.stringify([...all].slice(-500)));
  } catch {
    /* hidden for this visit only */
  }
}

type Group = { key: string; local: LocalSyncConflict[]; server: ServerSyncConflict[] };

export function buildReviewCards(input: ReviewInput): ReviewCard[] {
  const hidden = input.hiddenServerIds ?? new Set<string>();
  const groups = new Map<string, Group>();
  const group = (key: string) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, local: [], server: [] }));
    return g;
  };
  for (const c of input.conflicts)
    if (c.status === 'OPEN') group(c.clientId ?? `local:${c.id}`).local.push(c);
  for (const c of input.serverConflicts)
    if (c.status === 'OPEN' && !hidden.has(c.id))
      group(c.op_client_id ?? `shop:${c.id}`).server.push(c);

  const items = new Map((input.items ?? []).map((r) => [r.clientId, r]));
  const purchases = new Map((input.purchases ?? []).map((r) => [r.clientId, r]));
  const changes = new Map((input.billChanges ?? []).map((r) => [r.clientId, r]));
  const payments = new Map((input.payments ?? []).map((r) => [r.clientId, r]));
  const sales = new Map((input.sales ?? []).map((r) => [r.clientId, r]));

  const cards: ReviewCard[] = [];
  const itemCards = new Map<string, ReviewCard>();
  for (const g of groups.values()) {
    const first = (g.local[0] ?? g.server[0])!;
    const clientId = g.local[0]?.clientId ?? g.server[0]?.op_client_id ?? null;
    const target = first.target;
    const rawReason = first.reason;
    // The central mapping (friendlyError). Its payload-mismatch sentence is about sales, so for other
    // kinds the reason is kept and only the code is moved aside.
    const central = friendlyError(rawReason);
    const friendly =
      central.code === 'DSB_PAYLOAD_MISMATCH' &&
      !/^(post_sale|post_return|void_return)$/.test(target)
        ? { text: rawReason.replace(/\bDSB_[A-Z0-9_]+:?\s*/, '').trim(), code: central.code }
        : central;
    const card: ReviewCard = {
      key: g.key,
      kind: 'other',
      money: false,
      title: 'Something saved on this device needs a look',
      sentence: stop(friendly.text),
      code: friendly.code,
      happenedAt: Math.max(
        ...g.local.map((c) => c.createdAt),
        ...g.server.map((c) => Date.parse(c.created_at) || 0),
      ),
      where: g.local.length && g.server.length ? 'both' : g.local.length ? 'device' : 'shop',
      localIds: g.local.flatMap((c) => (c.id === undefined ? [] : [c.id])),
      serverIds: g.server.map((c) => c.id),
      clientId,
      target,
      details: [
        `${first.kind} · ${target}`,
        ...(clientId ? [clientId] : []),
        ...g.server.map((c) => `shop record ${c.id}`),
        rawReason,
      ],
      affected: [],
      fix: 'none',
      link: null,
      item: null,
      nameTaken: false,
    };
    const item = clientId ? items.get(clientId) : undefined;
    const purchase = clientId ? purchases.get(clientId) : undefined;
    const change = clientId ? changes.get(clientId) : undefined;
    const payment = clientId ? payments.get(clientId) : undefined;
    const sale = clientId ? sales.get(clientId) : undefined;
    if (target === ITEM_TARGET || item) {
      const taken =
        item?.rejectionCode === 'DSB_ITEM_NAME_TAKEN' || /already exists/i.test(rawReason);
      Object.assign(card, {
        kind: 'item',
        title: `New item '${item?.fields.name ?? 'new item'}' was not created`,
        sentence: taken
          ? 'An item with that name already exists with different units.'
          : stop(friendly.text),
        code: item?.rejectionCode ?? friendly.code,
        fix: item && item.status === 'REJECTED' && taken ? 'item-name' : 'none',
        link: { label: 'Open Purchases', href: appRoute.purchases },
        item: item ?? null,
        nameTaken: taken,
      } satisfies Partial<ReviewCard>);
      if (item) itemCards.set(item.itemId, card);
    } else if (target === PURCHASE_TARGET || purchase) {
      Object.assign(card, {
        kind: 'purchase',
        money: true,
        title: `${purchase ? billLabel(purchase) : 'A purchase'} was not saved`,
        fix: 'bill',
        link: { label: 'Correct this bill', href: appRoute.purchases },
      } satisfies Partial<ReviewCard>);
    } else if (target === CHANGE_TARGET || change) {
      Object.assign(card, {
        kind: 'purchase',
        money: true,
        title: `${change?.kind === 'void' ? 'Cancelling' : 'Editing'} ${
          change ? `bill ${change.billLabel}` : 'a bill'
        } was not applied`,
        fix: change?.kind === 'void' ? 'void' : 'edit',
        link: {
          label: change?.kind === 'void' ? 'Open Purchases' : 'Redo this edit',
          href: appRoute.purchases,
        },
      } satisfies Partial<ReviewCard>);
    } else if (target === PAYMENT_TARGET || payment) {
      Object.assign(card, {
        kind: 'payment',
        money: true,
        title: payment
          ? `Payment of ${rupees(payment.amountPaise)} to ${payment.partyName} was not recorded`
          : 'A supplier payment was not recorded',
        fix: 'payment',
        link: { label: 'Redo this payment', href: appRoute.suppliers },
      } satisfies Partial<ReviewCard>);
    } else if (target === 'post_sale') {
      Object.assign(card, {
        kind: 'sale',
        money: true,
        title: sale
          ? `${friendlySaleName(sale)} for ${rupees(sale.totalPaise)} was not accepted`
          : 'A sale saved on this device was not accepted',
        link: { label: 'Open Sales history', href: appRoute.salesHistory },
      } satisfies Partial<ReviewCard>);
    } else if (target === 'post_return' || target === 'void_return') {
      Object.assign(card, {
        kind: 'sale',
        money: true,
        title:
          target === 'void_return'
            ? 'Cancelling a sale return was not accepted'
            : 'A sale return was not accepted',
        fix: 'return',
        link: { label: 'Open Returns', href: appRoute.returns },
      } satisfies Partial<ReviewCard>);
    }
    cards.push(card);
  }

  // Bills (and edits) held by a refused item are consequences of the same event: listed on the item's card
  // as "waiting on this item" and cleared with it.
  const result: ReviewCard[] = [];
  for (const card of cards) {
    const purchase = card.clientId ? purchases.get(card.clientId) : undefined;
    const change = card.clientId ? changes.get(card.clientId) : undefined;
    const held = purchase?.rejectionCode === ITEM_REJECTED ? purchase : undefined;
    const heldEdit = change?.rejectionCode === ITEM_REJECTED ? change : undefined;
    const request = held?.request ?? heldEdit?.request;
    const owner = request
      ? linesOf(request)
          .map((l) => (typeof l.itemId === 'string' ? itemCards.get(l.itemId) : undefined))
          .find(Boolean)
      : undefined;
    if (!owner || !(held || heldEdit)) {
      result.push(card);
      continue;
    }
    owner.affected.push({
      label: held
        ? billLabel(held)
        : `${heldEdit!.kind === 'void' ? 'Cancel' : 'Edit'} of bill ${heldEdit!.billLabel}`,
      href: appRoute.purchases,
    });
    owner.localIds.push(...card.localIds);
    owner.serverIds.push(...card.serverIds);
    owner.money = true;
    owner.details.push(...card.details);
    owner.where =
      owner.localIds.length && owner.serverIds.length
        ? 'both'
        : owner.localIds.length
          ? 'device'
          : 'shop';
    owner.happenedAt = Math.max(owner.happenedAt, card.happenedAt);
  }
  return result.sort((a, b) => b.happenedAt - a.happenedAt);
}

export function groupReviewCards(cards: readonly ReviewCard[]) {
  return KIND_ORDER.map((kind) => ({
    kind,
    title: KIND_TITLE[kind],
    cards: cards.filter((c) => c.kind === kind),
  })).filter((g) => g.cards.length);
}
