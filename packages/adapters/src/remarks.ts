import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';
import { rpcOutcome, uuidAck, isUuid, type WriteOutcome } from './outcomes';

// Pending remarks on purchase bills and sale invoices (migration 0067). A remark is a note ("5 kg sugar still
// to come", "customer collects 2 items tomorrow"): it never posts money or stock. History is append-only on
// the server; edits carry the expected version so a concurrent change is refused, never overwritten.
export type RemarkDocKind = 'purchase' | 'sale';
export type RemarkStatus = 'OPEN' | 'SETTLED';
export type DocumentRemark = {
  id: string;
  /** The document the remark was written on (an earlier bill when the bill was corrected later). */
  docId: string;
  fromEarlierBill: boolean;
  body: string;
  status: RemarkStatus;
  version: number;
  createdBy: string;
  createdAt: string;
  settledBy: string | null;
  settledAt: string | null;
};
export type OpenRemark = {
  id: string;
  docKind: RemarkDocKind;
  /** The document to open (a replaced bill resolves to its corrected bill). */
  docId: string;
  docNo: string | null;
  partyName: string | null;
  businessDate: string | null;
  docStatus: string | null;
  body: string;
  createdAt: string;
  version: number;
};
export type RemarkEvent = {
  version: number;
  action: 'ADD' | 'EDIT' | 'SETTLE' | 'REOPEN';
  body: string;
  status: RemarkStatus;
  actor: string | null;
  createdAt: string;
};

export const REMARK_MAX_LENGTH = 300;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = () => new Error('The server sent unexpected remarks. Nothing is shown.');
const str = (v: unknown): string => {
  if (typeof v !== 'string') throw fail();
  return v;
};
const strOrNull = (v: unknown): string | null => (v === null ? null : str(v));
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw fail();
  return v;
};
const status = (v: unknown): RemarkStatus => {
  if (v !== 'OPEN' && v !== 'SETTLED') throw fail();
  return v;
};
const kind = (v: unknown): RemarkDocKind => {
  if (v !== 'purchase' && v !== 'sale') throw fail();
  return v;
};

function readError(error: unknown): Error {
  return new Error(
    plainRemarkRefusal((error as { message?: string }).message ?? '') ||
      errorMessage(classifyError(error), error),
  );
}

/** Plain words for a refused remark action. Empty when the message is not a known refusal. */
export function plainRemarkRefusal(message: string): string {
  if (/DSB_REMARK_STALE/.test(message))
    return 'Someone changed this remark just now. It was reloaded; check it and try again.';
  if (/DSB_REMARK_SETTLED/.test(message)) return 'This remark is settled. Reopen it to change it.';
  if (/DSB_REMARK_NOT_FOUND/.test(message)) return 'This remark is not available.';
  if (/DSB_REMARK_DOC_NOT_FOUND/.test(message))
    return 'This bill or invoice is not in this shop yet. Sync and try again.';
  if (/DSB_INVALID_REMARK/.test(message))
    return `Write a remark of 1 to ${REMARK_MAX_LENGTH} characters.`;
  if (/DSB_PAYLOAD_MISMATCH/.test(message))
    return 'This remark was already saved with different text. Reload the remarks.';
  if (/not permitted|permission/i.test(message))
    return 'You do not have permission for this. Ask the owner or a manager.';
  return '';
}

export function normalizeRemark(body: string): string {
  return body.trim();
}

export async function listDocumentRemarks(
  docKind: RemarkDocKind,
  docId: string,
): Promise<DocumentRemark[]> {
  const { data, error } = await getSupabaseClient().rpc('list_document_remarks', {
    p_doc_kind: docKind,
    p_doc_id: docId,
  });
  if (error) throw readError(error);
  if (!Array.isArray(data)) throw fail();
  return data.map((row: unknown) => {
    if (!isRecord(row) || !isUuid(row.remark_id) || !isUuid(row.doc_id)) throw fail();
    return {
      id: row.remark_id,
      docId: row.doc_id,
      fromEarlierBill: row.from_earlier_bill === true,
      body: str(row.body),
      status: status(row.status),
      version: int(row.version),
      createdBy: str(row.created_by),
      createdAt: str(row.created_at),
      settledBy: strOrNull(row.settled_by),
      settledAt: strOrNull(row.settled_at),
    };
  });
}

export async function listOpenRemarks(shopId: string): Promise<OpenRemark[]> {
  const { data, error } = await getSupabaseClient().rpc('list_open_remarks', {
    p_shop_id: shopId,
  });
  if (error) throw readError(error);
  if (!Array.isArray(data)) throw fail();
  return data.map((row: unknown) => {
    if (!isRecord(row) || !isUuid(row.remark_id) || !isUuid(row.doc_id)) throw fail();
    return {
      id: row.remark_id,
      docKind: kind(row.doc_kind),
      docId: row.doc_id,
      docNo: strOrNull(row.doc_no ?? null),
      partyName: strOrNull(row.party_name ?? null),
      businessDate: strOrNull(row.business_date ?? null),
      docStatus: strOrNull(row.doc_status ?? null),
      body: str(row.body),
      createdAt: str(row.created_at),
      version: int(row.version),
    };
  });
}

export async function listRemarkHistory(remarkId: string): Promise<RemarkEvent[]> {
  const { data, error } = await getSupabaseClient()
    .from('document_remark_events')
    .select('version,action,body,status,actor,created_at')
    .eq('remark_id', remarkId)
    .order('version', { ascending: true })
    .limit(500);
  if (error) throw readError(error);
  if (!Array.isArray(data)) throw fail();
  return data.map((row: unknown) => {
    if (!isRecord(row)) throw fail();
    const action = row.action;
    if (action !== 'ADD' && action !== 'EDIT' && action !== 'SETTLE' && action !== 'REOPEN')
      throw fail();
    return {
      version: int(row.version),
      action,
      body: str(row.body),
      status: status(row.status),
      actor: strOrNull(row.actor),
      createdAt: str(row.created_at),
    };
  });
}

/**
 * Adds a remark. The client id makes it idempotent: resending the same id with the same text returns the same
 * remark, so a send with an unknown outcome (offline, timeout) is retried with the SAME id.
 */
export async function addRemarkOutcome(input: {
  shopId: string;
  docKind: RemarkDocKind;
  docId: string;
  body: string;
  clientId: string;
}): Promise<WriteOutcome<string>> {
  const body = normalizeRemark(input.body);
  if (body.length < 1 || body.length > REMARK_MAX_LENGTH)
    return {
      kind: 'rejected',
      code: 'DSB_INVALID_REMARK',
      message: `Write a remark of 1 to ${REMARK_MAX_LENGTH} characters.`,
    };
  if (!input.clientId)
    return { kind: 'rejected', code: 'INVALID_INPUT', message: 'Request id missing.' };
  return rpcOutcome(
    'add_document_remark',
    {
      p_shop_id: input.shopId,
      p_doc_kind: input.docKind,
      p_doc_id: input.docId,
      p_body: body,
      p_client_id: input.clientId,
    },
    uuidAck,
  );
}

const versionAck = (data: unknown): number | null =>
  typeof data === 'number' && Number.isInteger(data) && data >= 1 ? data : null;

export async function editRemarkOutcome(input: {
  remarkId: string;
  body: string;
  expectedVersion: number;
}): Promise<WriteOutcome<number>> {
  const body = normalizeRemark(input.body);
  if (body.length < 1 || body.length > REMARK_MAX_LENGTH)
    return {
      kind: 'rejected',
      code: 'DSB_INVALID_REMARK',
      message: `Write a remark of 1 to ${REMARK_MAX_LENGTH} characters.`,
    };
  return rpcOutcome(
    'edit_document_remark',
    { p_remark_id: input.remarkId, p_body: body, p_expected_version: input.expectedVersion },
    versionAck,
  );
}

export async function settleRemarkOutcome(remarkId: string): Promise<WriteOutcome<number>> {
  return rpcOutcome('settle_document_remark', { p_remark_id: remarkId }, versionAck);
}

export async function reopenRemarkOutcome(remarkId: string): Promise<WriteOutcome<number>> {
  return rpcOutcome('reopen_document_remark', { p_remark_id: remarkId }, versionAck);
}
