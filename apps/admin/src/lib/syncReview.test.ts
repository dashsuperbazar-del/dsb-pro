import { describe, expect, it } from 'vitest';
import type { LocalSyncConflict, OfflineItemRecord, OfflinePurchaseRecord } from '@dsb-pro/sync';
import type { ServerSyncConflict } from '@dsb-pro/adapters';
import { buildReviewCards, groupReviewCards, suggestRename } from './syncReview';

const REQ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BILL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const reason =
  'an item called Camel match box already exists with different units; pick that item or use another name.';
const local = (over: Partial<LocalSyncConflict>): LocalSyncConflict => ({
  id: 1,
  createdAt: 1000,
  status: 'OPEN',
  kind: 'financial-rejection',
  target: 'create_item_v2',
  clientId: REQ,
  reason,
  payload: null,
  serverRef: null,
  ...over,
});
const shop = (over: Partial<ServerSyncConflict>): ServerSyncConflict => ({
  id: 's1',
  op_client_id: REQ,
  kind: 'financial-rejection',
  target: 'create_item_v2',
  reason,
  status: 'OPEN',
  created_at: new Date(2000).toISOString(),
  resolved_at: null,
  ...over,
});
const item: OfflineItemRecord = {
  clientId: REQ,
  itemId: ITEM,
  tenantId: 't',
  fields: { name: 'Camel match box', unit1: 'box', unit2: 'pcs', conv1: 12 },
  status: 'REJECTED',
  createdAt: 1,
  syncedAt: null,
  serverItemId: null,
  mapped: false,
  rejectionCode: 'DSB_ITEM_NAME_TAKEN',
  rejectionReason: reason,
};
const bill = {
  clientId: BILL,
  shopId: 'shop',
  request: { shopId: 'shop', clientId: BILL, lines: [{ itemId: ITEM }] },
  billNo: '12',
  supplierName: 'Sharma Traders',
  totalPaise: 104500,
  status: 'REJECTED',
  rejectionCode: 'DSB_ITEM_REJECTED',
} as unknown as OfflinePurchaseRecord;

describe('buildReviewCards', () => {
  it('merges the device alert and the shop record of one refused item into ONE card', () => {
    const cards = buildReviewCards({
      conflicts: [local({})],
      serverConflicts: [shop({})],
      items: [item],
    });
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.where).toBe('both');
    expect(c.localIds).toEqual([1]);
    expect(c.serverIds).toEqual(['s1']);
    expect(c.title).toBe("New item 'Camel match box' was not created");
    expect(c.sentence).toMatch(/already exists with different units/);
    expect(c.fix).toBe('item-name');
    expect(c.details.join('\n')).toContain(REQ);
    expect(c.title + c.sentence).not.toMatch(/create_item_v2|financial-rejection|[0-9a-f]{8}-/);
  });
  it('folds the bills held by the item into its card and clears them together', () => {
    const cards = buildReviewCards({
      conflicts: [
        local({}),
        local({ id: 2, target: 'post_purchase_v2', clientId: BILL, reason: 'held' }),
      ],
      serverConflicts: [
        shop({}),
        shop({ id: 's2', op_client_id: BILL, target: 'post_purchase_v2' }),
      ],
      items: [item],
      purchases: [bill],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.affected[0]!.label).toBe('Purchase 12 for Sharma Traders ₹1,045.00');
    expect(cards[0]!.localIds.sort()).toEqual([1, 2]);
    expect(cards[0]!.serverIds.sort()).toEqual(['s1', 's2']);
    expect(cards[0]!.money).toBe(true);
  });
  it('a shop record hidden on this device does not make a card; resolved ones never do', () => {
    expect(
      buildReviewCards({
        conflicts: [local({ status: 'RESOLVED' })],
        serverConflicts: [shop({}), shop({ id: 's9', status: 'RESOLVED' })],
        hiddenServerIds: new Set(['s1']),
      }),
    ).toEqual([]);
  });
  it('after Mark reviewed a refused item and its held bill stay on screen as ON HOLD with the fix', () => {
    const cards = buildReviewCards({
      conflicts: [local({ status: 'RESOLVED' })],
      serverConflicts: [],
      items: [item],
      purchases: [
        { ...bill, closedAt: null, heldBeforeSend: true } as unknown as OfflinePurchaseRecord,
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: 'held', fix: 'item-name', money: true });
    expect(cards[0]!.affected[0]!.label).toContain('Purchase 12');
    expect(cards[0]!.localIds).toEqual([]);
  });
  it('a closed or renamed refusal and a bill waiting for its new item are not on hold', () => {
    expect(
      buildReviewCards({
        conflicts: [],
        serverConflicts: [],
        items: [{ ...item, replacedBy: 'new' }],
        purchases: [
          { ...bill, closedAt: 5 } as unknown as OfflinePurchaseRecord,
          {
            ...bill,
            clientId: 'w',
            releaseWithItem: 'new-item',
          } as unknown as OfflinePurchaseRecord,
        ],
      }),
    ).toEqual([]);
  });
  it('the same request id for two different targets is two cards', () => {
    const cards = buildReviewCards({
      conflicts: [local({}), local({ id: 2, target: 'supplier_payment', clientId: REQ })],
      serverConflicts: [],
    });
    expect(cards).toHaveLength(2);
  });
  it('groups by kind and flags money', () => {
    const cards = buildReviewCards({
      conflicts: [
        local({}),
        local({
          id: 3,
          target: 'supplier_payment',
          clientId: 'p1',
          reason: 'DSB_PAYLOAD_MISMATCH',
        }),
        local({ id: 4, target: 'post_sale', clientId: 'x', kind: 'financial-rejection' }),
        local({ id: 5, target: 'weird', kind: 'other', clientId: null }),
      ],
      serverConflicts: [],
      items: [item],
    });
    const groups = groupReviewCards(cards);
    expect(groups.map((g) => g.kind)).toEqual(['item', 'payment', 'sale', 'other']);
    expect(cards.filter((c) => c.money).map((c) => c.kind)).toEqual(['payment', 'sale']);
    expect(cards.find((c) => c.kind === 'payment')!.link!.label).toBe('Redo this payment');
  });
  it('suggests a name from the units', () => {
    expect(suggestRename(item)).toBe('Camel match box 12 pcs');
  });
});
