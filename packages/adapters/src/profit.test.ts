import { describe, expect, it, vi } from 'vitest';
import { __setSupabaseClientForTest, type DsbSupabaseClient } from './client';
import { getProfitReport } from './profit';

const good = {
  method: 'FIFO',
  shopId: 's',
  from: '2026-09-01',
  to: '2026-09-30',
  summary: {
    netRevenuePaise: '45000',
    costedRevenuePaise: '42000',
    unknownCostRevenuePaise: '3000',
    knownCostPaise: '22000',
    estimatedCostPaise: '1200',
    costOfGoodsPaise: '23200',
    grossProfitPaise: '18800',
    marginBp: 4476,
    itemCount: 2,
    unknownCostItemCount: 1,
    estimatedCostItemCount: 1,
  },
  items: [
    {
      itemId: 'a',
      name: 'Item A',
      qtySold: '21.000000',
      qtyReturned: '0.000000',
      netRevenuePaise: '42000',
      costOfGoodsPaise: '23200',
      estimatedCostPaise: '1200',
      unknownCostQty: '0.000000',
      unknownCostRevenuePaise: '0',
      grossProfitPaise: '18800',
      marginBp: 4476,
    },
  ],
  itemsTruncated: false,
};
function fake(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  __setSupabaseClientForTest({ rpc } as unknown as DsbSupabaseClient);
  return rpc;
}

describe('getProfitReport', () => {
  it('calls the report with the argument names the SQL function declares and returns money as text paise', async () => {
    const rpc = fake({ data: good, error: null });
    const out = await getProfitReport('s', '2026-09-01', '2026-09-30');
    expect(rpc).toHaveBeenCalledWith('get_profit_report', {
      p_shop_id: 's',
      p_from: '2026-09-01',
      p_to: '2026-09-30',
    });
    expect(out.summary.grossProfitPaise).toBe('18800');
    expect(typeof out.summary.grossProfitPaise).toBe('string');
    expect(out.items[0]!.name).toBe('Item A');
  });
  it('refuses a response that is not the FIFO shape instead of showing wrong figures', async () => {
    fake({ data: { ...good, method: 'AVERAGE' }, error: null });
    await expect(getProfitReport('s', '2026-09-01', '2026-09-30')).rejects.toThrow(/unexpected/i);
    fake({
      data: { ...good, summary: { ...good.summary, grossProfitPaise: 18800 } },
      error: null,
    });
    await expect(getProfitReport('s', '2026-09-01', '2026-09-30')).rejects.toThrow(/unexpected/i);
    fake({ data: null, error: null });
    await expect(getProfitReport('s', '2026-09-01', '2026-09-30')).rejects.toThrow(/unexpected/i);
  });
  it('passes the server refusal through, including a plain message for an invalid period', async () => {
    fake({
      data: null,
      error: { message: 'DSB_INVALID_PERIOD: choose a start date on or before the end date' },
    });
    await expect(getProfitReport('s', '2026-09-05', '2026-09-01')).rejects.toThrow(
      /start date on or before the end date/,
    );
    fake({ data: null, error: { message: 'not permitted' } });
    await expect(getProfitReport('s', '2026-09-01', '2026-09-30')).rejects.toThrow(
      /not permitted/i,
    );
  });
});
