import { describe, expect, it, vi } from 'vitest';
import { __setSupabaseClientForTest, type DsbSupabaseClient } from './client';
import {
  archiveCustomer,
  archiveParty,
  normalizePartyDetails,
  updateCustomer,
  updateParty,
} from './partyEdit';

function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown[]> = {};
  const chain: Record<string, unknown> = {};
  for (const name of ['update', 'eq', 'is', 'select']) {
    chain[name] = vi.fn((...args: unknown[]) => {
      calls[name] = args;
      return chain;
    });
  }
  chain.maybeSingle = vi.fn(async () => result);
  const from = vi.fn((table: string) => {
    calls.from = [table];
    return chain;
  });
  __setSupabaseClientForTest({ from } as unknown as DsbSupabaseClient);
  return calls;
}

describe('normalizePartyDetails', () => {
  it('trims, turns blanks into null and upper-cases the GSTIN', () => {
    expect(
      normalizePartyDetails({
        name: '  Sharma  Traders ',
        phone: ' ',
        gstin: '22aaaaa0000a1z5',
        address: '',
      }),
    ).toEqual({ name: 'Sharma Traders', phone: null, gstin: '22AAAAA0000A1Z5', address: null });
  });
  it('requires a name and rejects an over-long one', () => {
    expect(() => normalizePartyDetails({ name: '   ' })).toThrow(/name/i);
    expect(() => normalizePartyDetails({ name: 'x'.repeat(121) })).toThrow(/name/i);
  });
  it('rejects a malformed GSTIN or phone instead of storing it', () => {
    expect(() => normalizePartyDetails({ name: 'A', gstin: '123' })).toThrow(/GSTIN/);
    expect(() => normalizePartyDetails({ name: 'A', phone: 'call me' })).toThrow(/phone/i);
    expect(normalizePartyDetails({ name: 'A', phone: '+91 98765-43210' }).phone).toBe(
      '+91 98765-43210',
    );
  });
});

describe('legacy values', () => {
  it('does not re-validate a phone/GSTIN left exactly as stored, but still validates a changed one', () => {
    const existing = { phone: '98765/43210', gstin: '22aaaa', address: null };
    expect(
      normalizePartyDetails({ name: 'A', phone: '98765/43210', gstin: '22aaaa', existing }).phone,
    ).toBe('98765/43210');
    expect(() => normalizePartyDetails({ name: 'A', phone: 'ext 12', existing })).toThrow(/phone/i);
    expect(() => normalizePartyDetails({ name: 'A', gstin: '123', existing })).toThrow(/GSTIN/);
  });
});

describe('updateParty', () => {
  it('updates only the editable columns of a live supplier by id', async () => {
    const calls = fakeClient({
      data: { id: 'p1', name: 'New', phone: null, gstin: null },
      error: null,
    });
    const out = await updateParty({
      id: 'p1',
      name: ' New ',
      phone: '',
      gstin: '',
      address: 'Main road',
    });
    expect(out.name).toBe('New');
    expect(calls.from).toEqual(['parties']);
    expect(calls.update).toEqual([{ name: 'New', phone: null, gstin: null, address: 'Main road' }]);
    expect(calls.eq).toEqual(['id', 'p1']);
    expect(calls.is).toEqual(['deleted_at', null]);
  });
  it('says so when the supplier is gone or archived instead of pretending it saved', async () => {
    fakeClient({ data: null, error: null });
    await expect(updateParty({ id: 'p1', name: 'X' })).rejects.toThrow(/not found|archived/i);
  });
});

describe('updateCustomer', () => {
  it('sends credit limit as integer paise and notes, never as a float', async () => {
    const calls = fakeClient({
      data: {
        id: 'c1',
        name: 'Asha',
        phone: null,
        address: null,
        gstin: null,
        credit_limit_paise: 150000,
        notes: null,
      },
      error: null,
    });
    await updateCustomer({ id: 'c1', name: 'Asha', creditLimitPaise: 150000, notes: ' vip ' });
    expect(calls.update).toEqual([
      {
        name: 'Asha',
        phone: null,
        address: null,
        gstin: null,
        sale_credit_limit_paise: 150000,
        notes: 'vip',
      },
    ]);
    await updateCustomer({ id: 'c1', name: 'Asha', creditLimitPaise: null });
    expect(calls.update[0]).toMatchObject({ sale_credit_limit_paise: null });
    expect(calls.update[0]).not.toHaveProperty('credit_limit_paise');
    await updateCustomer({ id: 'c1', name: 'Asha' });
    expect(calls.update[0]).not.toHaveProperty('sale_credit_limit_paise');
    await expect(
      updateCustomer({ id: 'c1', name: 'Asha', creditLimitPaise: 10.5 }),
    ).rejects.toThrow(/credit limit/i);
    await expect(updateCustomer({ id: 'c1', name: 'Asha', creditLimitPaise: -1 })).rejects.toThrow(
      /credit limit/i,
    );
  });
  it('turns a duplicate-name database error into a plain message', async () => {
    fakeClient({ data: null, error: { code: '23505', message: 'duplicate key value' } });
    await expect(updateCustomer({ id: 'c1', name: 'Asha' })).rejects.toThrow(
      /already has this name/i,
    );
  });
});

describe('archiveParty / archiveCustomer', () => {
  function fakeRpc(result: { data: unknown; error: unknown }) {
    const rpc = vi.fn(async () => result);
    __setSupabaseClientForTest({ rpc } as unknown as DsbSupabaseClient);
    return rpc;
  }
  it('calls the guarded server functions with the argument names they declare', async () => {
    const rpc = fakeRpc({ data: 'p1', error: null });
    await archiveParty('p1');
    expect(rpc).toHaveBeenCalledWith('archive_party', { p_party_id: 'p1' });
    await archiveCustomer('c1');
    expect(rpc).toHaveBeenCalledWith('archive_customer', { p_customer_id: 'c1' });
  });
  it('explains a refusal because of ledger history in plain words', async () => {
    fakeRpc({
      data: null,
      error: {
        code: 'P0001',
        message:
          'DSB_PARTY_HAS_HISTORY: this supplier has bills, payments, returns or an opening balance and cannot be archived',
      },
    });
    await expect(archiveParty('p1')).rejects.toThrow(
      /has bills, payments, returns or an opening balance and cannot be archived/,
    );
    await expect(archiveParty('p1')).rejects.not.toThrow(/DSB_PARTY_HAS_HISTORY/);
  });
  it('passes other failures through the normal error classes', async () => {
    fakeRpc({ data: null, error: { message: 'not permitted' } });
    await expect(archiveCustomer('c1')).rejects.toThrow(/not permitted/i);
  });
});
