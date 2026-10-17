import { describe, expect, it, vi } from 'vitest';
import { __setSupabaseClientForTest, type DsbSupabaseClient } from './client';
import {
  getSupplierPaymentsDue,
  listSupplierSchedules,
  removeSupplierSchedule,
  saveSupplierSchedule,
} from './supplierSchedule';

const rpcClient = (result: { data: unknown; error: unknown }) => {
  const rpc = vi.fn(async () => result);
  __setSupabaseClientForTest({ rpc } as unknown as DsbSupabaseClient);
  return rpc;
};
const save = {
  shopId: 's',
  partyId: 'p',
  dueDay: 5,
  expectedAmountPaise: '250000',
  note: 'n',
  active: true,
  clientId: 'c',
};

describe('supplier schedule adapter', () => {
  it('sends the arguments the SQL function declares', async () => {
    const rpc = rpcClient({ data: 'id1', error: null });
    expect(await saveSupplierSchedule(save)).toBe('id1');
    expect(rpc).toHaveBeenCalledWith('set_supplier_payment_schedule', {
      p_shop_id: 's',
      p_party_id: 'p',
      p_due_day: 5,
      p_expected_amount_paise: 250000,
      p_note: 'n',
      p_active: true,
      p_client_id: 'c',
    });
  });
  it('refuses a bad day or amount before calling the server', async () => {
    const rpc = rpcClient({ data: 'id1', error: null });
    await expect(saveSupplierSchedule({ ...save, dueDay: 29 })).rejects.toThrow(/1 and 28/);
    await expect(saveSupplierSchedule({ ...save, expectedAmountPaise: '0' })).rejects.toThrow(
      /positive/,
    );
    await expect(saveSupplierSchedule({ ...save, expectedAmountPaise: '1.5' })).rejects.toThrow(
      /positive/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });
  it('shows server refusals plainly', async () => {
    rpcClient({ data: null, error: { message: 'DSB_PARTY_NOT_FOUND: supplier not found' } });
    await expect(saveSupplierSchedule(save)).rejects.toThrow('Supplier not found');
    rpcClient({ data: null, error: { message: 'DSB_SCHEDULE_NOT_FOUND: schedule not found' } });
    await expect(removeSupplierSchedule('x')).rejects.toThrow('Schedule not found');
  });
  it('maps payments due and keeps money as text', async () => {
    rpcClient({
      data: [
        {
          schedule_id: 'a',
          party_id: 'p',
          party_name: 'Acme',
          due_day: 5,
          due_date: '2026-10-05',
          expected_amount_paise: 250000,
          paid_this_month_paise: 100000,
          remaining_paise: 150000,
          days_overdue: 12,
        },
        {
          schedule_id: 'b',
          party_id: 'q',
          party_name: 'Open',
          due_day: 1,
          due_date: '2026-10-01',
          expected_amount_paise: null,
          paid_this_month_paise: 0,
          remaining_paise: null,
          days_overdue: 16,
        },
      ],
      error: null,
    });
    const out = await getSupplierPaymentsDue('s', '2026-10-17');
    expect(out[0]).toMatchObject({ remainingPaise: '150000', paidThisMonthPaise: '100000' });
    expect(out[1]).toMatchObject({ expectedAmountPaise: null, remainingPaise: null });
  });
  it('refuses a malformed due row instead of guessing', async () => {
    rpcClient({ data: [{ schedule_id: 'a' }], error: null });
    await expect(getSupplierPaymentsDue('s', '2026-10-17')).rejects.toThrow(/unexpected/);
    rpcClient({ data: null, error: null });
    await expect(getSupplierPaymentsDue('s', '2026-10-17')).rejects.toThrow(/unexpected/);
  });
  it('lists live schedules and refuses an unknown status', async () => {
    const mk = (rows: unknown) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.is = () => q;
      q.limit = async () => ({ data: rows, error: null });
      __setSupabaseClientForTest({ from: () => q } as unknown as DsbSupabaseClient);
    };
    mk([
      {
        id: 'i',
        party_id: 'p',
        due_day: 3,
        expected_amount_paise: null,
        note: null,
        status: 'PAUSED',
      },
    ]);
    expect(await listSupplierSchedules('s')).toEqual([
      { id: 'i', partyId: 'p', dueDay: 3, expectedAmountPaise: null, note: null, active: false },
    ]);
    mk([
      { id: 'i', party_id: 'p', due_day: 3, expected_amount_paise: null, note: null, status: 'X' },
    ]);
    await expect(listSupplierSchedules('s')).rejects.toThrow(/unexpected/);
  });
});
