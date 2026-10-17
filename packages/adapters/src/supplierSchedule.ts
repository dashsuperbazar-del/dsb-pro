import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';

// Supplier payment schedule (migration 0061). A reminder only: it never records money. What is due is
// derived by the server from the payments ledger. Money is integer paise carried as TEXT.
export type SupplierSchedule = {
  id: string;
  partyId: string;
  dueDay: number;
  expectedAmountPaise: string | null;
  note: string | null;
  active: boolean;
};
export type SupplierPaymentDue = {
  scheduleId: string;
  partyId: string;
  partyName: string;
  dueDay: number;
  dueDate: string;
  expectedAmountPaise: string | null;
  paidThisMonthPaise: string;
  remainingPaise: string | null;
  daysOverdue: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = () => new Error('The server sent an unexpected payment schedule. Nothing is shown.');

function paise(v: unknown, nullable: boolean): string | null {
  if (v === null && nullable) return null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  throw fail();
}
function dueDay(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 28) throw fail();
  return v;
}

function readError(error: unknown): Error {
  const message = (error as { message?: string }).message ?? '';
  const known = /^DSB_(?:INVALID_SCHEDULE|PARTY_NOT_FOUND|SCHEDULE_NOT_FOUND):\s*(.+)$/s.exec(
    message,
  );
  if (known) return new Error(known[1]!.replace(/^./, (c) => c.toUpperCase()));
  return new Error(errorMessage(classifyError(error), error));
}

export async function listSupplierSchedules(shopId: string): Promise<SupplierSchedule[]> {
  const { data, error } = await getSupabaseClient()
    .from('supplier_payment_schedules')
    .select('id,party_id,due_day,expected_amount_paise,note,status')
    .eq('shop_id', shopId)
    .is('deleted_at', null)
    .limit(1000);
  if (error) throw readError(error);
  if (!Array.isArray(data)) throw fail();
  return data.map((row: unknown) => {
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.party_id !== 'string')
      throw fail();
    if (row.status !== 'ACTIVE' && row.status !== 'PAUSED') throw fail();
    if (row.note !== null && typeof row.note !== 'string') throw fail();
    return {
      id: row.id,
      partyId: row.party_id,
      dueDay: dueDay(row.due_day),
      expectedAmountPaise: paise(row.expected_amount_paise, true),
      note: row.note as string | null,
      active: row.status === 'ACTIVE',
    };
  });
}

export async function saveSupplierSchedule(input: {
  shopId: string;
  partyId: string;
  dueDay: number;
  expectedAmountPaise: string | null;
  note: string;
  active: boolean;
  clientId: string;
}): Promise<string> {
  if (!Number.isInteger(input.dueDay) || input.dueDay < 1 || input.dueDay > 28)
    throw new Error('Due day must be between 1 and 28.');
  if (input.expectedAmountPaise !== null && !/^[1-9]\d{0,14}$/.test(input.expectedAmountPaise))
    throw new Error('Expected amount must be a positive amount.');
  const { data, error } = await getSupabaseClient().rpc('set_supplier_payment_schedule', {
    p_shop_id: input.shopId,
    p_party_id: input.partyId,
    p_due_day: input.dueDay,
    // The generated type is number; the amount is validated above to fit 1e14 (exact in a double).
    p_expected_amount_paise:
      input.expectedAmountPaise === null ? (null as never) : Number(input.expectedAmountPaise),
    p_note: input.note,
    p_active: input.active,
    p_client_id: input.clientId,
  });
  if (error) throw readError(error);
  if (typeof data !== 'string') throw fail();
  return data;
}

export async function removeSupplierSchedule(scheduleId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('remove_supplier_payment_schedule', {
    p_schedule_id: scheduleId,
  });
  if (error) throw readError(error);
}

export async function getSupplierPaymentsDue(
  shopId: string,
  on: string,
): Promise<SupplierPaymentDue[]> {
  const { data, error } = await getSupabaseClient().rpc('get_supplier_payments_due', {
    p_shop_id: shopId,
    p_on: on,
  });
  if (error) throw readError(error);
  if (!Array.isArray(data)) throw fail();
  return data.map((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row.schedule_id !== 'string' ||
      typeof row.party_id !== 'string' ||
      typeof row.party_name !== 'string' ||
      typeof row.due_date !== 'string' ||
      typeof row.days_overdue !== 'number'
    )
      throw fail();
    return {
      scheduleId: row.schedule_id,
      partyId: row.party_id,
      partyName: row.party_name,
      dueDay: dueDay(row.due_day),
      dueDate: row.due_date,
      expectedAmountPaise: paise(row.expected_amount_paise, true),
      paidThisMonthPaise: paise(row.paid_this_month_paise, false)!,
      remainingPaise: paise(row.remaining_paise, true),
      daysOverdue: row.days_overdue,
    };
  });
}
