import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

// FIFO profit report (migration 0060). Read-only. Money is integer paise carried as TEXT so a large figure
// never passes through a float; quantities are base-unit decimals as text.
export type ProfitSummary = {
  netRevenuePaise: string;
  costedRevenuePaise: string;
  unknownCostRevenuePaise: string;
  knownCostPaise: string;
  estimatedCostPaise: string;
  costOfGoodsPaise: string;
  grossProfitPaise: string;
  /** Profit / costed revenue in basis points; null when nothing could be costed. */
  marginBp: number | null;
  itemCount: number;
  unknownCostItemCount: number;
  estimatedCostItemCount: number;
};
/** Report label for the one row that gathers every free-text sale line (backlog 0070). */
export const FREE_TEXT_REPORT_NAME = 'Items not in the list (free text)';
export type ProfitItem = {
  itemId: string;
  name: string;
  qtySold: string;
  qtyReturned: string;
  netRevenuePaise: string;
  costOfGoodsPaise: string;
  estimatedCostPaise: string;
  unknownCostQty: string;
  unknownCostRevenuePaise: string;
  grossProfitPaise: string;
  marginBp: number | null;
};
export type ProfitReport = {
  method: 'FIFO';
  shopId: string;
  from: string;
  to: string;
  summary: ProfitSummary;
  items: ProfitItem[];
  itemsTruncated: boolean;
};

const PAISE_TEXT = /^-?\d+$/;
const QTY_TEXT = /^-?\d+(\.\d+)?$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const paise = (v: unknown) => typeof v === 'string' && PAISE_TEXT.test(v);
const qty = (v: unknown) => typeof v === 'string' && QTY_TEXT.test(v);
const bp = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));

function requireReport(data: unknown): ProfitReport {
  const fail = () => new Error('The server sent an unexpected profit report. Nothing is shown.');
  if (
    !isRecord(data) ||
    data.method !== 'FIFO' ||
    !isRecord(data.summary) ||
    !Array.isArray(data.items)
  )
    throw fail();
  const s = data.summary;
  for (const key of [
    'netRevenuePaise',
    'costedRevenuePaise',
    'unknownCostRevenuePaise',
    'knownCostPaise',
    'estimatedCostPaise',
    'costOfGoodsPaise',
    'grossProfitPaise',
  ])
    if (!paise(s[key])) throw fail();
  if (!bp(s.marginBp)) throw fail();
  for (const key of ['itemCount', 'unknownCostItemCount', 'estimatedCostItemCount'])
    if (typeof s[key] !== 'number') throw fail();
  for (const item of data.items) {
    // backlog (0070): all free-text sale lines (no item) come back as one row with itemId null.
    if (isRecord(item) && item.itemId === null) {
      item.itemId = '';
      item.name = FREE_TEXT_REPORT_NAME;
    }
    if (!isRecord(item) || typeof item.itemId !== 'string' || typeof item.name !== 'string')
      throw fail();
    for (const key of [
      'netRevenuePaise',
      'costOfGoodsPaise',
      'estimatedCostPaise',
      'unknownCostRevenuePaise',
      'grossProfitPaise',
    ])
      if (!paise(item[key])) throw fail();
    for (const key of ['qtySold', 'qtyReturned', 'unknownCostQty'])
      if (!qty(item[key])) throw fail();
    if (!bp(item.marginBp)) throw fail();
  }
  if (typeof data.itemsTruncated !== 'boolean') throw fail();
  return data as unknown as ProfitReport;
}

export async function getProfitReport(
  shopId: string,
  from: string,
  to: string,
): Promise<ProfitReport> {
  const { data, error } = await getSupabaseClient().rpc('get_profit_report', {
    p_shop_id: shopId,
    p_from: from,
    p_to: to,
  });
  if (error) {
    const message = (error as { message?: string }).message ?? '';
    const period = /^DSB_INVALID_PERIOD:\s*(.+)$/s.exec(message);
    if (period) throw new Error(period[1]!.replace(/^./, (c) => c.toUpperCase()) + '.');
    throw new Error(errorMessage(classifyError(error), error));
  }
  return requireReport(data);
}
