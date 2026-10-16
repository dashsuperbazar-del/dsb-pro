import { getSupabaseClient } from './client';
import { classifyError, errorMessage } from './errors';
import type { Customer } from './sales';
import type { Party } from './masterData';

// Editing supplier and customer details. These are master data, not money: the audit trigger on both tables
// already records old and new values, and nothing here touches a ledger. Archiving is a separate, guarded step.
const friendly = (error: unknown) => errorMessage(classifyError(error), error);

export type PartyDetailsInput = {
  name: string;
  phone?: string;
  gstin?: string;
  address?: string;
  /**
   * What is stored today. A phone/GSTIN/address left exactly as stored is not re-validated, so a legacy
   * value that predates these rules never blocks an unrelated edit (e.g. fixing only a credit limit).
   */
  existing?: { phone?: string | null; gstin?: string | null; address?: string | null };
};
export type NormalizedPartyDetails = {
  name: string;
  phone: string | null;
  gstin: string | null;
  address: string | null;
};

const GSTIN = /^[0-9]{2}[A-Z0-9]{13}$/;
const PHONE = /^[0-9+()\-\s]{7,20}$/;

export function normalizePartyDetails(input: PartyDetailsInput): NormalizedPartyDetails {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Enter a name.');
  if (name.length > 120) throw new Error('The name is too long (120 characters at most).');
  const phone = (input.phone ?? '').trim();
  const same = (now: string, was?: string | null) => now !== '' && now === (was ?? '').trim();
  if (phone && !same(phone, input.existing?.phone) && !PHONE.test(phone))
    throw new Error('Enter a valid phone number, or leave it empty.');
  const gstin = (input.gstin ?? '').trim().toUpperCase();
  if (gstin && !same(gstin, (input.existing?.gstin ?? '').toUpperCase()) && !GSTIN.test(gstin))
    throw new Error('A GSTIN is 15 letters and digits, e.g. 22AAAAA0000A1Z5.');
  const address = (input.address ?? '').trim();
  if (address.length > 300 && !same(address, input.existing?.address))
    throw new Error('The address is too long (300 characters at most).');
  return { name, phone: phone || null, gstin: gstin || null, address: address || null };
}

export async function updateParty(input: { id: string } & PartyDetailsInput): Promise<Party> {
  const fields = normalizePartyDetails(input);
  const { data, error } = await getSupabaseClient()
    .from('parties')
    .update(fields)
    .eq('id', input.id)
    .is('deleted_at', null)
    .select('id,name,phone,gstin,address')
    .maybeSingle();
  if (error) throw new Error(friendly(error));
  if (!data) throw new Error('That supplier was not found, or it has been archived.');
  return data as Party;
}

export async function updateCustomer(
  input: { id: string; creditLimitPaise?: number; notes?: string } & PartyDetailsInput,
): Promise<Customer> {
  const fields = normalizePartyDetails(input);
  const limit = input.creditLimitPaise ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error('Enter a credit limit of zero or more rupees.');
  const notes = (input.notes ?? '').trim();
  if (notes.length > 500) throw new Error('The note is too long (500 characters at most).');
  const { data, error } = await getSupabaseClient()
    .from('customers')
    .update({ ...fields, credit_limit_paise: limit, notes: notes || null })
    .eq('id', input.id)
    .is('deleted_at', null)
    .select('id,name,phone,address,gstin,credit_limit_paise,notes')
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === '23505')
      throw new Error('Another customer already has this name.');
    throw new Error(friendly(error));
  }
  if (!data) throw new Error('That customer was not found, or it has been archived.');
  return data as Customer;
}

// Archive is soft and guarded on the server: a party with any bill, invoice, payment, return or opening
// balance is refused, so a ledger row never loses its owner. Unused parties (typos, duplicates) archive.
async function archive(fn: 'archive_party' | 'archive_customer', args: Record<string, string>) {
  const { error } = await getSupabaseClient().rpc(fn, args as never);
  if (error) {
    const message = (error as { message?: string }).message ?? '';
    const refusal = /^DSB_PARTY_HAS_HISTORY:\s*(.+)$/s.exec(message);
    if (refusal) throw new Error(refusal[1]!.replace(/^./, (c) => c.toUpperCase()) + '.');
    throw new Error(friendly(error));
  }
}
export function archiveParty(partyId: string): Promise<void> {
  return archive('archive_party', { p_party_id: partyId });
}
export function archiveCustomer(customerId: string): Promise<void> {
  return archive('archive_customer', { p_customer_id: customerId });
}
