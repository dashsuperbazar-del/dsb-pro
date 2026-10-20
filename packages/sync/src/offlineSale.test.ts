import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { DsbSyncDb } from './db';
import { completeOfflineSale, queueOfflineSale } from './offlineSale';
import type { OfflineSaleRecord, OutboxEntry, SyncedSaleResult } from './types';

const open: DsbSyncDb[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) {
    db.close();
    await db.delete();
  }
});

function record(totalPaise: number): OfflineSaleRecord {
  return {
    clientId: 'client-145',
    provisionalDocNo: 'T-device-1',
    officialSaleId: null,
    officialDocNo: null,
    shopId: 'shop',
    customerId: null,
    businessDate: '2026-09-20',
    subtotalPaise: totalPaise,
    discountPaise: 0,
    extraChargesPaise: 0,
    totalPaise,
    payments: [{ amountPaise: totalPaise, mode: 'cash' }],
    lines: [
      {
        itemId: 'item',
        unitLevel: 1,
        qty: '0.145',
        priceKind: 'retail',
        discountPaise: 0,
        expectedUnitPricePaise: 100,
        itemName: 'Tie item',
        unitName: 'Each',
        unitPricePaise: 100,
        baseQty: 0.145,
        lineTotalPaise: totalPaise,
      },
    ],
    status: 'QUEUED',
    createdAt: 1,
    syncedAt: null,
    rejectionReason: null,
    intentFingerprint: 'intent-v1:test',
    reconciliationWarning: null,
    reconciliationReviewedAt: null,
  };
}

function result(totalPaise = 15): SyncedSaleResult {
  return {
    saleId: 'sale-1',
    docNo: 'INV-000001',
    clientId: 'client-145',
    intentFingerprint: 'intent-v1:test',
    stock: [],
    subtotalPaise: totalPaise,
    discountPaise: 0,
    extraChargesPaise: 0,
    totalPaise,
    lines: [
      {
        itemId: 'item',
        unitLevel: 1,
        qty: '0.145',
        priceKind: 'retail',
        unitPricePaise: 100,
        discountPaise: 0,
        lineTotalPaise: totalPaise,
      },
    ],
    payments: [{ amountPaise: totalPaise, mode: 'cash' }],
  };
}

async function seeded(totalPaise: number): Promise<DsbSyncDb> {
  const db = new DsbSyncDb(`sale-reconcile-${crypto.randomUUID()}`);
  open.push(db);
  await db.open();
  const outbox: OutboxEntry = {
    sequence: 1,
    clientId: 'client-145',
    kind: 'financial-rpc',
    target: 'post_sale',
    payload: {},
    createdAt: 1,
    attempts: 1,
    state: 'sending',
    nextAttemptAt: 0,
    lastError: null,
  };
  await db.offlineSales.put(record(totalPaise));
  await db.outbox.put(outbox);
  return db;
}

describe('authoritative offline-sale acknowledgement', () => {
  it('replaces a pre-fix 0.145 × 100 snapshot and preserves a persistent warning', async () => {
    const db = await seeded(14);
    await completeOfflineSale(db, 'client-145', result(15));
    const sale = await db.offlineSales.get('client-145');
    expect(sale).toMatchObject({
      status: 'SYNCED',
      officialSaleId: 'sale-1',
      totalPaise: 15,
      provisionalTotals: { subtotalPaise: 14, totalPaise: 14 },
      reconciliationReviewedAt: null,
    });
    expect(sale?.lines[0].lineTotalPaise).toBe(15);
    expect(sale?.reconciliationWarning).toMatch(/Server totals replaced/);
    expect(await db.outbox.count()).toBe(0);
  });

  it('queues and reconciles the new-format 0.145 × 100 sale without a false warning', async () => {
    const db = new DsbSyncDb(`sale-compound-${crypto.randomUUID()}`);
    open.push(db);
    await db.open();
    await db.items.put({
      id: 'item',
      tenant_id: 'tenant',
      name: 'Tie item',
      sku: null,
      unit1: 'Each',
      unit2: null,
      unit3: null,
      conv1: null,
      conv2: null,
      tax_rate_bp: 0,
      min_stock: 0,
      image_path: null,
      is_active: true,
      updated_at: 1,
      deleted_at: null,
    });
    await db.prices.put({
      id: 'price',
      tenant_id: 'tenant',
      item_id: 'item',
      shop_id: 'shop',
      kind: 'retail',
      unit_level: 1,
      price_paise: 100,
      effective_from: '2026-01-01T00:00:00Z',
      effective_to: null,
      updated_at: 1,
      deleted_at: null,
    });
    await db.stock.put({
      id: 'shop:item',
      key: 'shop:item',
      tenant_id: 'tenant',
      shop_id: 'shop',
      item_id: 'item',
      on_hand: 1,
      reserved: 0,
      available: 1,
      qty_base: 1,
      updated_at: 1,
      deleted_at: null,
    });
    const queued = await queueOfflineSale(
      db,
      {
        clientId: 'client-145',
        shopId: 'shop',
        businessDate: '2026-09-20',
        discountPaise: 0,
        extraChargesPaise: 0,
        lines: [
          { itemId: 'item', unitLevel: 1, qty: '0.145', priceKind: 'retail', discountPaise: 0 },
        ],
        payments: [{ amountPaise: 15, mode: 'cash' }],
      },
      {
        deviceId: 'device',
        role: 'owner',
        policy: {
          allowCashierOfflineFinalization: false,
          allowNegativeStock: false,
          canViewCostPrices: true,
        },
        onlineInitiated: false,
      },
    );
    expect(queued).toMatchObject({ subtotalPaise: 15, totalPaise: 15, status: 'QUEUED' });
    const fingerprint = queued.intentFingerprint!;
    await completeOfflineSale(db, 'client-145', { ...result(15), intentFingerprint: fingerprint });
    expect(await db.offlineSales.get('client-145')).toMatchObject({
      status: 'SYNCED',
      totalPaise: 15,
      reconciliationWarning: null,
    });
    expect(await db.outbox.count()).toBe(0);
  });

  it('rounds an opted-in bill total and requires the rounded payment (R0)', async () => {
    const db = new DsbSyncDb(`sale-round-${crypto.randomUUID()}`);
    open.push(db);
    await db.open();
    await db.items.put({
      id: 'item',
      tenant_id: 'tenant',
      name: 'Round item',
      sku: null,
      unit1: 'Each',
      unit2: null,
      unit3: null,
      conv1: null,
      conv2: null,
      tax_rate_bp: 0,
      min_stock: 0,
      image_path: null,
      is_active: true,
      updated_at: 1,
      deleted_at: null,
    });
    await db.prices.put({
      id: 'price',
      tenant_id: 'tenant',
      item_id: 'item',
      shop_id: 'shop',
      kind: 'retail',
      unit_level: 1,
      price_paise: 1049,
      effective_from: '2026-01-01T00:00:00Z',
      effective_to: null,
      updated_at: 1,
      deleted_at: null,
    });
    await db.stock.put({
      id: 'shop:item',
      key: 'shop:item',
      tenant_id: 'tenant',
      shop_id: 'shop',
      item_id: 'item',
      on_hand: 5,
      reserved: 0,
      available: 5,
      qty_base: 5,
      updated_at: 1,
      deleted_at: null,
    });
    const ctx = {
      deviceId: 'device',
      role: 'owner' as const,
      policy: {
        allowCashierOfflineFinalization: false,
        allowNegativeStock: false,
        canViewCostPrices: true,
      },
      onlineInitiated: false,
    };
    const base = {
      shopId: 'shop',
      businessDate: '2026-09-20',
      discountPaise: 0,
      extraChargesPaise: 0,
      lines: [
        {
          itemId: 'item',
          unitLevel: 1 as const,
          qty: '1',
          priceKind: 'retail' as const,
          discountPaise: 0,
        },
      ],
    };
    await expect(
      queueOfflineSale(
        db,
        {
          ...base,
          clientId: 'r-exact',
          roundTotal: true,
          payments: [{ amountPaise: 1049, mode: 'cash' }],
        },
        ctx,
      ),
    ).rejects.toThrow(/exceed/);
    const queued = await queueOfflineSale(
      db,
      {
        ...base,
        clientId: 'r-ok',
        roundTotal: true,
        payments: [{ amountPaise: 1000, mode: 'cash' }],
      },
      ctx,
    );
    expect(queued).toMatchObject({ subtotalPaise: 1049, roundOffPaise: -49, totalPaise: 1000 });
    const legacy = await queueOfflineSale(
      db,
      { ...base, clientId: 'r-old', payments: [{ amountPaise: 1049, mode: 'cash' }] },
      ctx,
    );
    expect(legacy).toMatchObject({ totalPaise: 1049, roundOffPaise: 0 });
  });

  it('does not mutate or acknowledge a response for another intent', async () => {
    const db = await seeded(14);
    await expect(
      completeOfflineSale(db, 'client-145', { ...result(), intentFingerprint: 'intent-v1:wrong' }),
    ).rejects.toThrow(/fingerprint mismatch/);
    expect(await db.offlineSales.get('client-145')).toMatchObject({
      status: 'QUEUED',
      totalPaise: 14,
    });
    expect(await db.outbox.count()).toBe(1);
  });
});

describe('salepricing (0065): typed prices, GST-extra and credit override on the device', () => {
  async function shopDb() {
    const db = new DsbSyncDb(`sale-v2-${crypto.randomUUID()}`);
    open.push(db);
    await db.open();
    for (const [id, rate] of [
      ['priced', 1800],
      ['unpriced', 500],
    ] as const) {
      await db.items.put({
        id,
        tenant_id: 'tenant',
        name: id,
        sku: null,
        unit1: 'Each',
        unit2: null,
        unit3: null,
        conv1: null,
        conv2: null,
        tax_rate_bp: rate,
        min_stock: 0,
        image_path: null,
        is_active: true,
        updated_at: 1,
        deleted_at: null,
      });
      await db.stock.put({
        id: `shop:${id}`,
        key: `shop:${id}`,
        tenant_id: 'tenant',
        shop_id: 'shop',
        item_id: id,
        on_hand: 10,
        reserved: 0,
        available: 10,
        qty_base: 10,
        updated_at: 1,
        deleted_at: null,
      });
    }
    await db.prices.put({
      id: 'price',
      tenant_id: 'tenant',
      item_id: 'priced',
      shop_id: 'shop',
      kind: 'retail',
      unit_level: 1,
      price_paise: 1049,
      effective_from: '2026-01-01T00:00:00Z',
      effective_to: null,
      updated_at: 1,
      deleted_at: null,
    });
    return db;
  }
  const policy = {
    allowCashierOfflineFinalization: true,
    allowNegativeStock: false,
    canViewCostPrices: true,
  };
  const ctx = (role: 'owner' | 'manager' | 'cashier') => ({
    deviceId: 'device',
    role,
    policy,
    onlineInitiated: true,
  });
  const base = {
    shopId: 'shop',
    businessDate: '2026-09-20',
    discountPaise: 0,
    extraChargesPaise: 0,
    saleV2: true as const,
  };

  it('a manager types a price for an unpriced item; the payload carries it and the device total', async () => {
    const db = await shopDb();
    const sale = await queueOfflineSale(
      db,
      {
        ...base,
        clientId: 'v2-m',
        invoiceType: 'gst_included',
        lines: [
          {
            itemId: 'unpriced',
            unitLevel: 1,
            qty: '2',
            priceKind: 'retail',
            discountPaise: 0,
            manualUnitPricePaise: 1250,
          },
        ],
        payments: [{ amountPaise: 2500, mode: 'cash' }],
      },
      ctx('manager'),
    );
    expect(sale.lines[0]).toMatchObject({
      unitPricePaise: 1250,
      priceSource: 'manual',
      listPricePaise: null,
      lineTotalPaise: 2500,
    });
    const out = (await db.outbox.toArray())[0].payload as {
      lines: Array<Record<string, unknown>>;
      expectedTotalPaise: number;
      saleV2: boolean;
    };
    expect(out.saleV2).toBe(true);
    expect(out.expectedTotalPaise).toBe(2500);
    expect(out.lines[0]).toMatchObject({ manualUnitPricePaise: 1250 });
    expect(out.lines[0]).not.toHaveProperty('expectedUnitPricePaise');
  });

  it('a cashier can neither type a price nor sell an unpriced item', async () => {
    const db = await shopDb();
    await expect(
      queueOfflineSale(
        db,
        {
          ...base,
          clientId: 'v2-c1',
          lines: [
            {
              itemId: 'priced',
              unitLevel: 1,
              qty: '1',
              priceKind: 'retail',
              discountPaise: 0,
              manualUnitPricePaise: 900,
            },
          ],
          payments: [{ amountPaise: 900, mode: 'cash' }],
        },
        ctx('cashier'),
      ),
    ).rejects.toThrow(/owner or a manager/);
    await expect(
      queueOfflineSale(
        db,
        {
          ...base,
          clientId: 'v2-c2',
          lines: [
            { itemId: 'unpriced', unitLevel: 1, qty: '1', priceKind: 'retail', discountPaise: 0 },
          ],
          payments: [{ amountPaise: 900, mode: 'cash' }],
        },
        ctx('cashier'),
      ),
    ).rejects.toThrow(/No cached retail price/);
    expect(await db.outbox.count()).toBe(0);
  });

  it('an owner override keeps the list price it replaced', async () => {
    const db = await shopDb();
    const sale = await queueOfflineSale(
      db,
      {
        ...base,
        clientId: 'v2-o',
        lines: [
          {
            itemId: 'priced',
            unitLevel: 1,
            qty: '1',
            priceKind: 'retail',
            discountPaise: 0,
            manualUnitPricePaise: 900,
          },
        ],
        payments: [{ amountPaise: 900, mode: 'cash' }],
      },
      ctx('owner'),
    );
    expect(sale.lines[0]).toMatchObject({
      unitPricePaise: 900,
      priceSource: 'manual',
      listPricePaise: 1049,
    });
    expect(
      ((await db.outbox.toArray())[0].payload as { lines: Array<Record<string, unknown>> })
        .lines[0],
    ).toMatchObject({ manualUnitPricePaise: 900, expectedUnitPricePaise: 1049 });
  });

  it('GST-extra totals match the server fixture and refuse a bill discount', async () => {
    const db = await shopDb();
    const sale = await queueOfflineSale(
      db,
      {
        ...base,
        clientId: 'v2-g',
        invoiceType: 'gst_extra',
        lines: [
          { itemId: 'priced', unitLevel: 1, qty: '2', priceKind: 'retail', discountPaise: 98 },
          {
            itemId: 'unpriced',
            unitLevel: 1,
            qty: '1',
            priceKind: 'retail',
            discountPaise: 0,
            manualUnitPricePaise: 1250,
          },
        ],
        payments: [{ amountPaise: 3700, mode: 'cash' }],
      },
      ctx('owner'),
    );
    expect(sale).toMatchObject({
      subtotalPaise: 3771,
      discountPaise: 98,
      roundOffPaise: 27,
      totalPaise: 3700,
      invoiceType: 'gst_extra',
      taxPaise: 423,
    });
    expect(sale.lines.map((l) => l.taxPaise)).toEqual([360, 63]);
    await expect(
      queueOfflineSale(
        db,
        {
          ...base,
          clientId: 'v2-gd',
          invoiceType: 'gst_extra',
          discountPaise: 100,
          lines: [
            { itemId: 'priced', unitLevel: 1, qty: '1', priceKind: 'retail', discountPaise: 0 },
          ],
          payments: [],
        },
        ctx('owner'),
      ),
    ).rejects.toThrow(/bill discount/i);
  });

  it('a device total that differs from the computed total is refused before queueing', async () => {
    const db = await shopDb();
    await expect(
      queueOfflineSale(
        db,
        {
          ...base,
          clientId: 'v2-t',
          expectedTotalPaise: 1049,
          lines: [
            { itemId: 'priced', unitLevel: 1, qty: '1', priceKind: 'retail', discountPaise: 0 },
          ],
          payments: [{ amountPaise: 1000, mode: 'cash' }],
        },
        ctx('owner'),
      ),
    ).rejects.toThrow(/total changed/);
    expect(await db.outbox.count()).toBe(0);
  });

  it('an old-format payload with a typed price is refused (never silently priced from the list)', async () => {
    const db = await shopDb();
    await expect(
      queueOfflineSale(
        db,
        {
          shopId: 'shop',
          businessDate: '2026-09-20',
          discountPaise: 0,
          extraChargesPaise: 0,
          clientId: 'v1-m',
          roundTotal: true,
          lines: [
            {
              itemId: 'priced',
              unitLevel: 1,
              qty: '1',
              priceKind: 'retail',
              discountPaise: 0,
              manualUnitPricePaise: 900,
            },
          ],
          payments: [{ amountPaise: 900, mode: 'cash' }],
        },
        ctx('owner'),
      ),
    ).rejects.toThrow(/new sale format/);
  });
});
