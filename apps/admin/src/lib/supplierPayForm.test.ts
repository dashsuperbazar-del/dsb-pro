import { describe, expect, it } from 'vitest';
import type { SupplierPayCopySupplier } from '@dsb-pro/sync';
import { checkPayForm, fifoPlan, rupeesTextToPaise, type PayFormInput } from './supplierPayForm';

const V = '0123456789abcdef0123456789abcdef';
const supplier: SupplierPayCopySupplier = {
  partyId: '11111111-1111-4111-8111-111111111111',
  name: 'Acme',
  owedPaise: '1500000',
  version: V,
  bills: [
    {
      billId: 'b2',
      billNo: 'A-2',
      businessDate: '2026-10-05',
      outstandingPaise: '500000',
      version: V,
    },
    {
      billId: 'b1',
      billNo: 'A-1',
      businessDate: '2026-10-01',
      outstandingPaise: '1000000',
      version: V,
    },
  ],
};
const base: PayFormInput = {
  supplier,
  amountText: '1000',
  mode: 'cash',
  reference: '',
  dateText: '',
  allocTexts: {},
  businessDate: '2026-10-26',
  queuedForSupplier: 0n,
  queuedByBill: {},
};
const run = (over: Partial<PayFormInput> = {}) => checkPayForm({ ...base, ...over });
const errors = (over: Partial<PayFormInput> = {}) => {
  const r = run(over);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
};

describe('rupeesTextToPaise', () => {
  it.each([
    ['1500', 150000n],
    ['1,500.5', 150050n],
    ['0.07', 7n],
    [' 12 ', 1200n],
  ])('reads %s exactly', (text, paise) => expect(rupeesTextToPaise(text)).toBe(paise));
  it.each(['', 'abc', '-5', '1.005', '1e3', '1.', '.5', '1 000'])('refuses %j', (text) =>
    expect(rupeesTextToPaise(text)).toBeNull(),
  );
});

describe('checkPayForm', () => {
  it('a plain payment carries the supplier version, the limits and no bill versions', () => {
    const r = run();
    expect(r).toMatchObject({
      ok: true,
      value: {
        partyId: supplier.partyId,
        amountPaise: '100000',
        mode: 'cash',
        reference: null,
        businessDate: null,
        allocations: [],
        baseVersions: { supplier: V, bills: {} },
        limits: { owedPaise: '1500000', bills: { b1: '1000000', b2: '500000' } },
      },
    });
  });

  it('assigns to bills with each bill version, keeping the typed exact paise', () => {
    const r = run({ allocTexts: { b1: '600.50', b2: '399.50' } });
    expect(r).toMatchObject({
      ok: true,
      value: {
        allocations: [
          { purchaseBillId: 'b2', amountPaise: '39950', billLabel: 'A-2' },
          { purchaseBillId: 'b1', amountPaise: '60050', billLabel: 'A-1' },
        ],
        baseVersions: { bills: { b1: V, b2: V } },
      },
    });
  });

  it('refuses zero, negative, blank, 3-decimal and non-numbers with an inline message', () => {
    expect(errors({ amountText: '' }).amount).toMatch(/Enter the amount/);
    expect(errors({ amountText: '0' }).amount).toMatch(/more than zero/);
    expect(errors({ amountText: '-5' }).amount).toMatch(/rupees/);
    expect(errors({ amountText: '10.005' }).amount).toMatch(/at most 2 decimals/);
    expect(errors({ amountText: 'ten' }).amount).toMatch(/rupees/);
  });

  it('refuses a missing supplier, a future date, a long reference and a bad mode', () => {
    expect(errors({ supplier: null }).supplier).toMatch(/Choose a supplier/);
    expect(errors({ dateText: '2026-10-27' }).date).toMatch(/after today/);
    expect(errors({ dateText: '26/10/2026' }).date).toMatch(/year-month-day/);
    expect(run({ dateText: '2026-10-26' })).toMatchObject({
      ok: true,
      value: { businessDate: '2026-10-26' },
    });
    expect(errors({ reference: 'x'.repeat(201) }).reference).toMatch(/too long/);
    expect(errors({ mode: 'barter' }).amount).toMatch(/payment mode/);
  });

  it('refuses more than is owed, counting what is already saved on this device', () => {
    expect(errors({ amountText: '15000.01' }).amount).toMatch(
      /more than is owed to Acme: ₹15,000.00/,
    );
    expect(run({ amountText: '15000' }).ok).toBe(true);
    const e = errors({ amountText: '5000.01', queuedForSupplier: 1_000_000n });
    expect(e.amount).toMatch(/₹5,000.00 is left to pay.*already saved on this device/);
    expect(run({ amountText: '5000', queuedForSupplier: 1_000_000n }).ok).toBe(true);
  });

  it('refuses more than a bill has left (counting queued payments) and more assigned than paid', () => {
    expect(errors({ amountText: '2000', allocTexts: { b2: '5000.01' } }).allocations.b2).toMatch(
      /Only ₹5,000.00 is left/,
    );
    expect(
      errors({ amountText: '2000', allocTexts: { b2: '100' }, queuedByBill: { b2: 500_000n } })
        .allocations.b2,
    ).toMatch(/already covered/);
    expect(errors({ allocTexts: { b1: 'x' } }).allocations.b1).toMatch(/rupees/);
    expect(
      errors({ amountText: '1000', allocTexts: { b1: '600', b2: '400.01' } }).allocationsTotal,
    ).toMatch(/more than the payment/);
    // A zero amount typed for a bill is the same as not assigning it.
    expect(run({ allocTexts: { b1: '0' } })).toMatchObject({
      ok: true,
      value: { allocations: [] },
    });
  });
});

describe('fifoPlan', () => {
  it('oldest bill first, exact paise, the rest stays unassigned', () => {
    expect(fifoPlan(supplier, {}, 1_200_000n)).toEqual({
      allocations: { b1: '10000.00', b2: '2000.00' },
      remainderPaise: 0n,
    });
    expect(fifoPlan(supplier, {}, 1_600_000n).remainderPaise).toBe(100_000n);
  });
  it('skips what payments saved on this device already cover', () => {
    expect(fifoPlan(supplier, { b1: 1_000_000n }, 300_000n)).toEqual({
      allocations: { b2: '3000.00' },
      remainderPaise: 0n,
    });
  });
});
