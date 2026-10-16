import { describe, expect, it, vi } from 'vitest';
import { __setSupabaseClientForTest, type DsbSupabaseClient } from './client';
import { normalizePartyDetails, updateCustomer, updateParty } from './partyEdit';

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
        credit_limit_paise: 150000,
        notes: 'vip',
      },
    ]);
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
