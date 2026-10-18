import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

// Supplier merge (migration 0062). The server re-attributes every bill, payment, return, opening balance
// and schedule of the duplicate to the kept supplier, archives the duplicate and records what moved.
// Nothing is deleted or summed. The request id makes a retry after a lost reply return the same merge.
export type DuplicateBillGroup = {
  billNo: string;
  businessDate: string;
  totalPaise: string;
  billIds: string[];
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = () => new Error('The server sent an unexpected answer. Nothing is shown.');

function readError(error: unknown): Error {
  const message = (error as { message?: string }).message ?? '';
  const known =
    /^DSB_(?:INVALID_MERGE|PARTY_NOT_FOUND|PARTY_ARCHIVED|MERGE_OPENING_CONFLICT|PAYLOAD_MISMATCH):\s*(.+)$/s.exec(
      message,
    );
  if (known) return new Error(known[1]!.replace(/^./, (c) => c.toUpperCase()) + '.');
  return new Error(errorMessage(classifyError(error), error));
}

export async function mergeParties(input: {
  sourcePartyId: string;
  targetPartyId: string;
  requestId: string;
}): Promise<string> {
  if (!input.sourcePartyId || !input.targetPartyId || input.sourcePartyId === input.targetPartyId)
    throw new Error('Choose two different suppliers.');
  const { data, error } = await getSupabaseClient().rpc('merge_parties', {
    p_source_party_id: input.sourcePartyId,
    p_target_party_id: input.targetPartyId,
    p_client_id: input.requestId,
  });
  if (error) throw readError(error);
  if (typeof data !== 'string' || data === '') throw fail();
  return data;
}

export async function listSupplierDuplicateBills(
  shopId: string,
  partyId: string,
): Promise<DuplicateBillGroup[]> {
  const { data, error } = await getSupabaseClient().rpc('get_supplier_duplicate_bills', {
    p_shop_id: shopId,
    p_party_id: partyId,
  });
  if (error) throw readError(error);
  if (!Array.isArray(data)) throw fail();
  return data.map((g: unknown) => {
    if (
      !isRecord(g) ||
      typeof g.billNo !== 'string' ||
      typeof g.businessDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(g.businessDate) ||
      typeof g.totalPaise !== 'string' ||
      !/^\d+$/.test(g.totalPaise) ||
      !Array.isArray(g.billIds) ||
      g.billIds.length < 2 ||
      !g.billIds.every((id) => typeof id === 'string')
    )
      throw fail();
    return {
      billNo: g.billNo,
      businessDate: g.businessDate,
      totalPaise: g.totalPaise,
      billIds: g.billIds as string[],
    };
  });
}

export type MergePreview = {
  bills: number;
  payments: number;
  returns: number;
  openings: number;
  openingConflict: boolean;
  combinedBalancePaise: string;
};

export async function getPartyMergePreview(
  shopId: string,
  sourcePartyId: string,
  targetPartyId: string,
): Promise<MergePreview> {
  const { data, error } = await getSupabaseClient().rpc('get_party_merge_preview', {
    p_shop_id: shopId,
    p_source_party_id: sourcePartyId,
    p_target_party_id: targetPartyId,
  });
  if (error) throw readError(error);
  const count = (v: unknown) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw fail();
    return v;
  };
  if (
    !isRecord(data) ||
    typeof data.openingConflict !== 'boolean' ||
    typeof data.combinedBalancePaise !== 'string' ||
    !/^-?\d+$/.test(data.combinedBalancePaise)
  )
    throw fail();
  return {
    bills: count(data.bills),
    payments: count(data.payments),
    returns: count(data.returns),
    openings: count(data.openings),
    openingConflict: data.openingConflict,
    combinedBalancePaise: data.combinedBalancePaise,
  };
}
