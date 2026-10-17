import { parseRupeesToPaise } from '@dsb-pro/core';
import type { SupplierPaymentDue } from '@dsb-pro/adapters';

export type ScheduleForm = { dueDay: string; amount: string; note: string };
export type ScheduleParsed =
  | { ok: true; dueDay: number; expectedAmountPaise: string | null; note: string }
  | { ok: false; message: string };

// An amount is optional ("pay something"); when given it must be exact rupees and paise, never rounded.
export function parseScheduleForm(form: ScheduleForm): ScheduleParsed {
  const day = form.dueDay.trim();
  if (!/^\d{1,2}$/.test(day) || Number(day) < 1 || Number(day) > 28)
    return { ok: false, message: 'Due day must be a whole number from 1 to 28.' };
  const note = form.note.trim();
  if (note.length > 300) return { ok: false, message: 'Keep the note under 300 characters.' };
  const amount = form.amount.trim();
  if (amount === '') return { ok: true, dueDay: Number(day), expectedAmountPaise: null, note };
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(amount))
    return { ok: false, message: 'Expected amount must be rupees with at most 2 decimals.' };
  const paise = parseRupeesToPaise(amount);
  if (paise <= 0) return { ok: false, message: 'Expected amount must be greater than zero.' };
  return { ok: true, dueDay: Number(day), expectedAmountPaise: String(paise), note };
}

// Sum of what is still expected across due suppliers. Suppliers with no expected amount are counted
// separately because their amount is unknown; they must not look like zero.
export function summarizeDue(rows: SupplierPaymentDue[]) {
  let remaining = 0n;
  let openAmount = 0;
  for (const r of rows) {
    if (r.remainingPaise === null) openAmount += 1;
    else remaining += BigInt(r.remainingPaise);
  }
  return {
    count: rows.length,
    remainingPaise: remaining.toString(),
    openAmountCount: openAmount,
    worst: rows.slice(0, 3),
  };
}
