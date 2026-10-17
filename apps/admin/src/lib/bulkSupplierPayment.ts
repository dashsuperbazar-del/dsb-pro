import type { PaymentMode, SupplierBill } from '@dsb-pro/adapters';
import { parseRupeesToPaise } from '@dsb-pro/core';
import type { FinancialAttempt } from './offlineSync';
import { fifoAllocate, type RecordPayload } from './supplierPaymentFlow';

// S05 bulk supplier payments (old DSB saveBulkPayment). Records money ALREADY PAID to several suppliers.
// Each supplier goes through exactly the single-payment path: account lock, unresolved-attempt check,
// fresh open bills, oldest-first allocation (remainder stays as advance), durable attempt, idempotent send.
// The run stops at the first lost server answer so nothing is ever recorded twice by retrying blindly.
export type BulkEntry = { partyId: string; partyName: string; amount: string };
export type BulkRowResult =
  | { partyId: string; status: 'committed'; amountPaise: string; advancePaise: string }
  | { partyId: string; status: 'rejected' | 'skipped' | 'unknown' | 'not-sent'; message: string };

const RUPEES = /^\d{1,12}(\.\d{1,2})?$/;

export function validateBulk(entries: BulkEntry[]):
  | {
      ok: true;
      rows: { partyId: string; partyName: string; amountPaise: bigint }[];
      totalPaise: bigint;
    }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const rows: { partyId: string; partyName: string; amountPaise: bigint }[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const text = e.amount.trim();
    if (!text) continue;
    if (seen.has(e.partyId)) {
      errors.push(`${e.partyName}: listed twice.`);
      continue;
    }
    seen.add(e.partyId);
    if (!RUPEES.test(text)) {
      errors.push(`${e.partyName}: enter rupees with at most 2 decimals.`);
      continue;
    }
    const paise = BigInt(parseRupeesToPaise(text));
    if (paise <= 0n) {
      errors.push(`${e.partyName}: the amount must be greater than zero.`);
      continue;
    }
    rows.push({ partyId: e.partyId, partyName: e.partyName, amountPaise: paise });
  }
  if (!errors.length && !rows.length) errors.push('Enter an amount for at least one supplier.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, rows, totalPaise: rows.reduce((s, r) => s + r.amountPaise, 0n) };
}

export type BulkDeps = {
  lock: <T>(shopId: string, partyId: string, fn: () => Promise<T>) => Promise<T>;
  listOpen: (shopId: string, partyId: string) => Promise<FinancialAttempt[]>;
  listBills: (shopId: string, partyId: string) => Promise<SupplierBill[]>;
  newDraft: (input: {
    operation: 'supplier.record.v1';
    shopId: string;
    accountId: string;
    payload: RecordPayload;
  }) => Promise<FinancialAttempt>;
  send: (attemptId: string) => Promise<FinancialAttempt>;
};

export async function runBulkPayments(
  rows: { partyId: string; amountPaise: bigint }[],
  ctx: { shopId: string; businessDate: string; mode: PaymentMode; reference: string | null },
  deps: BulkDeps,
  onProgress?: (r: BulkRowResult) => void,
): Promise<BulkRowResult[]> {
  const results: BulkRowResult[] = [];
  const push = (r: BulkRowResult) => {
    results.push(r);
    onProgress?.(r);
  };
  let stopped = false;
  for (const row of rows) {
    if (stopped) {
      push({
        partyId: row.partyId,
        status: 'not-sent',
        message: 'Not sent: an earlier answer was lost. Check it first, then pay this one.',
      });
      continue;
    }
    try {
      const outcome = await deps.lock(ctx.shopId, row.partyId, async () => {
        const open = await deps.listOpen(ctx.shopId, row.partyId);
        if (open.length)
          return {
            status: 'skipped' as const,
            message: 'A payment for this supplier is awaiting confirmation or saved as a draft.',
          };
        const bills = await deps.listBills(ctx.shopId, row.partyId);
        const { allocations, remainderPaise } = fifoAllocate(bills, row.amountPaise);
        const draft = await deps.newDraft({
          operation: 'supplier.record.v1',
          shopId: ctx.shopId,
          accountId: row.partyId,
          payload: {
            shopId: ctx.shopId,
            partyId: row.partyId,
            businessDate: ctx.businessDate,
            amountPaise: row.amountPaise.toString(),
            mode: ctx.mode,
            reference: ctx.reference,
            allocations,
          },
        });
        return { status: 'sent' as const, attempt: await deps.send(draft.id), remainderPaise };
      });
      if (outcome.status === 'skipped')
        push({ partyId: row.partyId, status: 'skipped', message: outcome.message });
      else if (outcome.attempt.state === 'COMMITTED')
        push({
          partyId: row.partyId,
          status: 'committed',
          amountPaise: row.amountPaise.toString(),
          advancePaise: outcome.remainderPaise.toString(),
        });
      else if (outcome.attempt.state === 'REJECTED')
        push({
          partyId: row.partyId,
          status: 'rejected',
          message: `Not recorded: ${outcome.attempt.errorMessage ?? outcome.attempt.errorCode ?? 'refused'}`,
        });
      else {
        stopped = true;
        push({
          partyId: row.partyId,
          status: 'unknown',
          message:
            'The server answer was lost. Do NOT pay again; open this supplier and use “Check status”.',
        });
      }
    } catch (e) {
      // Nothing was sent (lock, read or draft failed) or the send threw: treat as unknown and stop.
      stopped = true;
      push({
        partyId: row.partyId,
        status: 'unknown',
        message: `Stopped: ${e instanceof Error ? e.message : String(e)}. Open this supplier to check before retrying.`,
      });
    }
  }
  return results;
}
