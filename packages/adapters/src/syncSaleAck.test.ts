import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./client', () => ({ getSupabaseClient: () => ({ rpc }) }));

import { pushSyncedSale } from './sync';

const input = {
  deviceId: 'device',
  shopId: 'shop',
  businessDate: '2026-09-20',
  discountPaise: 0,
  extraChargesPaise: 0,
  clientId: 'client',
  intentFingerprint: 'intent-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  lines: [
    {
      itemId: 'item',
      unitLevel: 1 as const,
      qty: '0.145',
      priceKind: 'retail' as const,
      discountPaise: 0,
      expectedUnitPricePaise: 100,
    },
  ],
  payments: [{ amountPaise: 15, mode: 'cash' as const }],
};
const acknowledgement = {
  saleId: 'sale',
  docNo: 'INV-1',
  clientId: 'client',
  intentFingerprint: input.intentFingerprint,
  subtotalPaise: 15,
  discountPaise: 0,
  extraChargesPaise: 0,
  totalPaise: 15,
  stock: [],
  lines: [
    {
      itemId: 'item',
      unitLevel: 1,
      qty: '0.145',
      priceKind: 'retail',
      unitPricePaise: 100,
      discountPaise: 0,
      lineTotalPaise: 15,
    },
  ],
  payments: [{ amountPaise: 15, mode: 'cash', reference: null }],
};

describe('synced-sale authoritative acknowledgement', () => {
  beforeEach(() => rpc.mockReset());

  it('sends canonical quantity and the intent checksum in every server line', async () => {
    rpc.mockResolvedValue({ data: acknowledgement, error: null });
    await expect(pushSyncedSale(input)).resolves.toEqual(acknowledgement);
    expect(rpc).toHaveBeenCalledWith(
      'phase5_sync_post_sale',
      expect.objectContaining({
        p_lines: [
          expect.objectContaining({ qty: '0.145', intent_fingerprint: input.intentFingerprint }),
        ],
      }),
    );
  });

  it('sends a free-text line with its name and GST and no item; accepts the item-less answer (0070)', async () => {
    const ft = {
      itemId: '',
      unitLevel: 1 as const,
      qty: '1',
      priceKind: 'retail' as const,
      discountPaise: 0,
      manualUnitPricePaise: 1000,
      freeText: { name: 'Gift wrap', taxRateBp: 500 },
    };
    const ack = { ...acknowledgement, lines: [{ ...acknowledgement.lines[0], itemId: null }] };
    rpc.mockResolvedValue({ data: ack, error: null });
    await expect(
      pushSyncedSale({
        ...input,
        lines: [ft],
        saleV2: { invoiceType: 'gst_included', creditOverride: false, expectedTotalPaise: 1000 },
      }),
    ).resolves.toEqual(ack);
    const sent = rpc.mock.calls[0]![1].p_lines[0];
    expect(rpc.mock.calls[0]![0]).toBe('sp_sync_post_sale');
    expect(sent).toMatchObject({
      free_text_name: 'Gift wrap',
      free_text_tax_rate_bp: 500,
      manual_unit_price_paise: 1000,
    });
    expect(sent).not.toHaveProperty('item_id');
  });

  it('refuses a shallow or malformed acknowledgement before local reconciliation', async () => {
    rpc.mockResolvedValue({
      data: { ...acknowledgement, lines: [{ itemId: 'item', lineTotalPaise: 15 }] },
      error: null,
    });
    await expect(pushSyncedSale(input)).rejects.toThrow(/invalid synced-sale result/);
  });
});
