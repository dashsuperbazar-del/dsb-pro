import { describe, expect, it, vi } from 'vitest';
vi.mock('@dsb-pro/adapters', () => ({}));
import { runBulkPayments, validateBulk, type BulkDeps } from './bulkSupplierPayment';
import { fifoAllocate } from './supplierPaymentFlow';

const bill = (id: string, date: string, out: number) => ({
  purchase_bill_id: id,
  business_date: date,
  outstanding_paise: out,
});

describe('fifoAllocate', () => {
  it('pays oldest bills first and keeps the rest as advance, in exact paise', () => {
    const r = fifoAllocate([bill('b2', '2026-10-02', 500), bill('b1', '2026-10-01', 300)], 1000n);
    expect(r.allocations).toEqual([
      { purchaseBillId: 'b1', amountPaise: '300' },
      { purchaseBillId: 'b2', amountPaise: '500' },
    ]);
    expect(r.remainderPaise).toBe(200n);
    expect(fifoAllocate([bill('b1', '2026-10-01', 300)], 100n).allocations).toEqual([
      { purchaseBillId: 'b1', amountPaise: '100' },
    ]);
  });
});

describe('validateBulk', () => {
  const e = (partyId: string, amount: string) => ({ partyId, partyName: partyId, amount });
  it('ignores blanks, totals exactly and refuses bad amounts', () => {
    const ok = validateBulk([e('a', '10.50'), e('b', ''), e('c', '0.01')]);
    expect(ok.ok && ok.totalPaise).toBe(1051n);
    const bad = validateBulk([e('a', '10.555'), e('b', '0'), e('c', 'x')]);
    expect(!bad.ok && bad.errors).toHaveLength(3);
    expect(validateBulk([e('a', '')]).ok).toBe(false);
  });
});

function deps(
  states: Record<string, 'COMMITTED' | 'REJECTED' | 'UNKNOWN' | 'READY'>,
  open: string[] = [],
  drafts: string[] = [],
  today = '2026-10-17',
) {
  const sent: string[] = [];
  const d: BulkDeps = {
    lock: (_s, _p, fn) => fn(),
    listOpen: async (_s, p) => (open.includes(p) ? [{ id: 'x' } as never] : []),
    listDrafts: async (_s, p) =>
      drafts.includes(p) ? [{ id: 'd', operation: 'supplier.record.v1' } as never] : [],
    businessDate: async () => today,
    listBills: async () => [bill('b1', '2026-10-01', 300) as never],
    newDraft: async (input) => ({ id: input.accountId, payload: input.payload }) as never,
    send: async (id) => {
      sent.push(id);
      return { id, state: states[id], errorMessage: 'refused' } as never;
    },
  };
  return { d, sent };
}
const ctx = { shopId: 's', businessDate: '2026-10-17', mode: 'cash' as const, reference: null };

describe('runBulkPayments', () => {
  it('records each supplier separately and reports advance and rejections', async () => {
    const { d, sent } = deps({ a: 'COMMITTED', b: 'REJECTED' });
    const out = await runBulkPayments(
      [
        { partyId: 'a', amountPaise: 500n },
        { partyId: 'b', amountPaise: 100n },
      ],
      ctx,
      d,
    );
    expect(sent).toEqual(['a', 'b']);
    expect(out[0]).toEqual({
      partyId: 'a',
      status: 'committed',
      amountPaise: '500',
      advancePaise: '200',
    });
    expect(out[1]).toMatchObject({ status: 'rejected' });
  });
  it('skips a supplier with a payment awaiting confirmation and sends nothing for it', async () => {
    const { d, sent } = deps({ b: 'COMMITTED' }, ['a']);
    const out = await runBulkPayments(
      [
        { partyId: 'a', amountPaise: 500n },
        { partyId: 'b', amountPaise: 100n },
      ],
      ctx,
      d,
    );
    expect(sent).toEqual(['b']);
    expect(out[0]).toMatchObject({ partyId: 'a', status: 'skipped' });
  });
  it('stops at the first lost answer and sends nothing after it', async () => {
    const { d, sent } = deps({ a: 'UNKNOWN', b: 'COMMITTED' });
    const out = await runBulkPayments(
      [
        { partyId: 'a', amountPaise: 500n },
        { partyId: 'b', amountPaise: 100n },
      ],
      ctx,
      d,
    );
    expect(sent).toEqual(['a']);
    expect(out.map((r) => r.status)).toEqual(['unknown', 'not-sent']);
  });
  it('a failure before sending also stops the run', async () => {
    const { d, sent } = deps({ b: 'COMMITTED' });
    d.listBills = async () => {
      throw new Error('offline');
    };
    const out = await runBulkPayments(
      [
        { partyId: 'a', amountPaise: 5n },
        { partyId: 'b', amountPaise: 5n },
      ],
      ctx,
      d,
    );
    expect(sent).toEqual([]);
    expect(out.map((r) => r.status)).toEqual(['unknown', 'not-sent']);
  });
  it('sends the exact payload the single-payment path sends', async () => {
    const payloads: unknown[] = [];
    const { d } = deps({ a: 'COMMITTED' });
    const orig = d.newDraft;
    d.newDraft = async (input) => {
      payloads.push(input);
      return orig(input);
    };
    await runBulkPayments([{ partyId: 'a', amountPaise: 250n }], { ...ctx, reference: 'R1' }, d);
    expect(payloads[0]).toEqual({
      operation: 'supplier.record.v1',
      shopId: 's',
      accountId: 'a',
      payload: {
        shopId: 's',
        partyId: 'a',
        businessDate: '2026-10-17',
        amountPaise: '250',
        mode: 'cash',
        reference: 'R1',
        allocations: [{ purchaseBillId: 'b1', amountPaise: '250' }],
      },
    });
  });
});

describe('double-recording guards', () => {
  it('skips a supplier with a saved payment draft', async () => {
    const { d, sent } = deps({ b: 'COMMITTED' }, [], ['a']);
    const out = await runBulkPayments(
      [
        { partyId: 'a', amountPaise: 500n },
        { partyId: 'b', amountPaise: 100n },
      ],
      ctx,
      d,
    );
    expect(sent).toEqual(['b']);
    expect(out[0]).toMatchObject({ status: 'skipped', message: expect.stringContaining('draft') });
  });
  it('sends nothing when the shop date has moved on', async () => {
    const { d, sent } = deps({ a: 'COMMITTED' }, [], [], '2026-10-18');
    const out = await runBulkPayments([{ partyId: 'a', amountPaise: 5n }], ctx, d);
    expect(sent).toEqual([]);
    expect(out[0]).toMatchObject({
      status: 'not-sent',
      message: expect.stringContaining('2026-10-18'),
    });
  });
  it('a send left READY (never confirmed) stops the run like a lost answer', async () => {
    const { d, sent } = deps({ a: 'READY', b: 'COMMITTED' });
    const out = await runBulkPayments(
      [
        { partyId: 'a', amountPaise: 5n },
        { partyId: 'b', amountPaise: 5n },
      ],
      ctx,
      d,
    );
    expect(sent).toEqual(['a']);
    expect(out.map((r) => r.status)).toEqual(['unknown', 'not-sent']);
  });
});
