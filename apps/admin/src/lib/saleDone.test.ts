import { describe, expect, it } from 'vitest';
import type { SaleReceipt } from '@dsb-pro/adapters';
import type { OfflineSaleRecord } from '@dsb-pro/sync';
import {
  figuresFromReceipt,
  figuresFromRecord,
  friendlySaleName,
  saleStateLabel,
} from './saleDone';

const record = (over: Partial<OfflineSaleRecord> = {}): OfflineSaleRecord =>
  ({
    clientId: 'c',
    provisionalDocNo: 'T-aff303fa-ae95-492c-aaaa-bbbbbbbbbbbb',
    officialSaleId: null,
    officialDocNo: null,
    shopId: 's',
    customerId: null,
    businessDate: '2026-10-26',
    subtotalPaise: 0,
    discountPaise: 0,
    extraChargesPaise: 0,
    totalPaise: 240000,
    payments: [{ amountPaise: 100000, mode: 'cash' }],
    lines: [],
    status: 'QUEUED',
    createdAt: new Date(2026, 9, 26, 9, 5).getTime(),
    syncedAt: null,
    rejectionReason: null,
    ...over,
  }) as OfflineSaleRecord;

describe('sale done figures', () => {
  it('reads total, paid and the credit left from the saved sale', () => {
    expect(figuresFromRecord(record())).toEqual({
      totalPaise: 240000,
      paidPaise: 100000,
      balancePaise: 140000,
    });
    expect(figuresFromRecord(record({ payments: [] })).balancePaise).toBe(240000);
  });
  it('reads the server invoice and counts only posted receipts, refunds taken off', () => {
    const receipt = {
      invoice: { total_paise: 264700 },
      lines: [],
      payments: [
        {
          id: '1',
          amount_paise: 200000,
          direction: 'in',
          mode: 'cash',
          reference: null,
          status: 'POSTED',
        },
        {
          id: '2',
          amount_paise: 50000,
          direction: 'in',
          mode: 'upi',
          reference: null,
          status: 'VOID',
        },
        {
          id: '3',
          amount_paise: 10000,
          direction: 'out',
          mode: 'cash',
          reference: null,
          status: 'POSTED',
        },
      ],
    } as unknown as SaleReceipt;
    expect(figuresFromReceipt(receipt)).toEqual({
      totalPaise: 264700,
      paidPaise: 190000,
      balancePaise: 74700,
      paymentsUnclear: true, // one of the payments is VOID
    });
  });
  it('does not flag a receipt whose payments are all posted', () => {
    const receipt = {
      invoice: { total_paise: 1000 },
      lines: [],
      payments: [
        {
          id: '1',
          amount_paise: 400,
          direction: 'in',
          mode: 'cash',
          reference: null,
          status: 'POSTED',
        },
      ],
    } as unknown as SaleReceipt;
    expect(figuresFromReceipt(receipt).paymentsUnclear).toBe(false);
  });
  it('never shows a negative balance', () => {
    expect(
      figuresFromRecord(record({ payments: [{ amountPaise: 300000, mode: 'cash' }] })).balancePaise,
    ).toBe(0);
  });
});

describe('friendly saved-sale labels', () => {
  it('names a synced sale by its official number and a waiting one by its time', () => {
    expect(friendlySaleName(record({ officialDocNo: 'INV-000005', status: 'SYNCED' }))).toBe(
      'Sale 5',
    );
    expect(friendlySaleName(record())).toBe('Sale 09:05');
  });
  it('says synced, waiting or needs review', () => {
    expect(saleStateLabel(record({ status: 'SYNCED' }))).toBe('synced');
    expect(saleStateLabel(record())).toBe('waiting');
    expect(saleStateLabel(record({ status: 'REJECTED' }))).toBe('needs review');
    expect(
      saleStateLabel(record({ status: 'SYNCED', reconciliationWarning: 'Totals changed' })),
    ).toBe('needs review');
    expect(
      saleStateLabel(
        record({ status: 'SYNCED', reconciliationWarning: 'x', reconciliationReviewedAt: 1 }),
      ),
    ).toBe('synced');
  });
});
