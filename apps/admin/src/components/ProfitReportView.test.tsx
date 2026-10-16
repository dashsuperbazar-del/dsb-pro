// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { ProfitReport } from '@dsb-pro/adapters';
import { ProfitReportView } from './ProfitReportView';

const host = document.createElement('div');
afterEach(() => act(() => render(null, host)));
const base: ProfitReport = {
  method: 'FIFO',
  shopId: 's',
  from: '2026-09-01',
  to: '2026-09-30',
  summary: {
    netRevenuePaise: '4500000',
    costedRevenuePaise: '4200000',
    unknownCostRevenuePaise: '300000',
    knownCostPaise: '2200000',
    estimatedCostPaise: '120000',
    costOfGoodsPaise: '2320000',
    grossProfitPaise: '1880000',
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
      qtyReturned: '2.000000',
      netRevenuePaise: '4200000',
      costOfGoodsPaise: '2320000',
      estimatedCostPaise: '120000',
      unknownCostQty: '0.000000',
      unknownCostRevenuePaise: '0',
      grossProfitPaise: '1880000',
      marginBp: 4476,
    },
    {
      itemId: 'b',
      name: 'Item B',
      qtySold: '3.500000',
      qtyReturned: '0.000000',
      netRevenuePaise: '300000',
      costOfGoodsPaise: '0',
      estimatedCostPaise: '0',
      unknownCostQty: '3.500000',
      unknownCostRevenuePaise: '300000',
      grossProfitPaise: '0',
      marginBp: null,
    },
  ],
  itemsTruncated: false,
};
const text = () => host.textContent ?? '';

test('shows exact rupees, the margin and the method', async () => {
  await act(async () => render(<ProfitReportView report={base} />, host));
  expect(text()).toContain('₹45,000.00'); // net revenue
  expect(text()).toContain('₹23,200.00'); // cost of goods
  expect(text()).toContain('₹18,800.00'); // gross profit
  expect(text()).toContain('44.76%');
  expect(text()).toMatch(/FIFO/);
});

test('says plainly how much of the cost is estimated and how much revenue has no cost at all', async () => {
  await act(async () => render(<ProfitReportView report={base} />, host));
  expect(host.querySelector('[data-testid="estimated-note"]')?.textContent).toContain('₹1,200.00');
  const unknown = host.querySelector('[data-testid="unknown-note"]')?.textContent ?? '';
  expect(unknown).toContain('₹3,000.00');
  expect(unknown).toMatch(/not counted/i);
});

test('per-item rows flag estimated and no-cost items and never show a margin for an uncosted item', async () => {
  await act(async () => render(<ProfitReportView report={base} />, host));
  const rows = [...host.querySelectorAll('tbody tr')];
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain('Item A');
  expect(rows[0]!.textContent).toContain('estimated');
  expect(rows[0]!.textContent).toContain('21'); // trailing zeros trimmed, not 21.000000
  expect(rows[0]!.textContent).not.toContain('21.000000');
  expect(rows[1]!.textContent).toContain('no cost on record');
  expect(rows[1]!.textContent).toContain('3.5');
  expect(rows[1]!.textContent).not.toContain('%');
});

test('an item that is only partly costed shows its profit and says how many units had no cost', async () => {
  const partly: ProfitReport = {
    ...base,
    items: [{ ...base.items[0]!, unknownCostQty: '2.000000', unknownCostRevenuePaise: '20000' }],
  };
  await act(async () => render(<ProfitReportView report={partly} />, host));
  const row = host.querySelector('tbody tr')!.textContent ?? '';
  expect(row).toContain('2 unit(s) with no cost on record');
  expect(row).toContain('₹18,800.00');
});

test('no notes when everything was costed from purchases, and a clear empty state', async () => {
  const clean: ProfitReport = {
    ...base,
    summary: {
      ...base.summary,
      estimatedCostPaise: '0',
      unknownCostRevenuePaise: '0',
      unknownCostItemCount: 0,
      estimatedCostItemCount: 0,
    },
  };
  await act(async () => render(<ProfitReportView report={clean} />, host));
  expect(host.querySelector('[data-testid="estimated-note"]')).toBeNull();
  expect(host.querySelector('[data-testid="unknown-note"]')).toBeNull();
  const empty: ProfitReport = {
    ...base,
    summary: {
      ...base.summary,
      netRevenuePaise: '0',
      costedRevenuePaise: '0',
      unknownCostRevenuePaise: '0',
      knownCostPaise: '0',
      estimatedCostPaise: '0',
      costOfGoodsPaise: '0',
      grossProfitPaise: '0',
      marginBp: null,
      itemCount: 0,
      unknownCostItemCount: 0,
      estimatedCostItemCount: 0,
    },
    items: [],
  };
  await act(async () => render(<ProfitReportView report={empty} />, host));
  expect(text()).toMatch(/no sales/i);
  expect(text()).not.toContain('NaN');
});

test('a loss is shown as a negative amount, and truncation is announced', async () => {
  const loss: ProfitReport = {
    ...base,
    summary: { ...base.summary, grossProfitPaise: '-50000', marginBp: -119 },
    itemsTruncated: true,
  };
  await act(async () => render(<ProfitReportView report={loss} />, host));
  expect(text()).toContain('−₹500.00');
  expect(text()).toContain('-1.19%');
  expect(text()).toMatch(/top 500/i);
});
