import { getSupabaseClient } from './client';
import { isUuid, rpcOutcome, type WriteOutcome } from './outcomes';

// Offline new items (mig 0071 create_item_v2): the device generates the item id. A replay of the same
// request returns the same item; a same-name item with the same units is matched (nothing written).
// A match writes nothing and a create writes a row with this client id, so a client-id lookup decides
// every refused or unanswered attempt exactly: a row means created, no row means nothing was written.

export type CreateItemV2Input = {
  itemId: string;
  clientId: string;
  item: {
    name: string;
    sku?: string;
    unit1: string;
    unit2?: string;
    unit3?: string;
    conv1?: number;
    conv2?: number;
    taxRateBp?: number;
  };
};
export type CreateItemV2Result = { itemId: string; mapped: boolean; name: string | null };

async function lookupByClientId(
  clientId: string,
): Promise<
  { kind: 'found'; id: string } | { kind: 'none' } | { kind: 'unavailable'; message: string }
> {
  try {
    const { data, error } = await getSupabaseClient()
      .from('items')
      .select('id')
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) return { kind: 'unavailable', message: error.message };
    const id = (data as { id?: unknown } | null)?.id;
    return isUuid(id) ? { kind: 'found', id } : { kind: 'none' };
  } catch (error) {
    return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function createItemV2Outcome(
  input: CreateItemV2Input,
): Promise<WriteOutcome<CreateItemV2Result>> {
  if (!isUuid(input.itemId) || !isUuid(input.clientId))
    return { kind: 'rejected', code: 'INVALID_INPUT', message: 'Item ids must be UUIDs.' };
  const f = input.item;
  const outcome = await rpcOutcome(
    'create_item_v2',
    {
      p_item_id: input.itemId,
      p_client_id: input.clientId,
      p_item: {
        name: f.name,
        sku: f.sku ?? null,
        unit1: f.unit1,
        unit2: f.unit2 ?? null,
        unit3: f.unit3 ?? null,
        conv1: f.conv1 ?? null,
        conv2: f.conv2 ?? null,
        tax_rate_bp: f.taxRateBp ?? 0,
      },
    },
    (data) => {
      const r = data as Record<string, unknown> | null;
      if (!r || !isUuid(r.itemId) || r.requestedItemId !== input.itemId) return null;
      if (typeof r.mapped !== 'boolean') return null;
      // Only a match may return another id; a create or replay is always the device id.
      if (!r.mapped && r.itemId !== input.itemId) return null;
      return {
        itemId: r.itemId,
        mapped: r.mapped,
        name: typeof r.name === 'string' ? r.name : null,
      };
    },
  );
  if (outcome.kind === 'committed') return outcome;
  const mismatch = outcome.kind === 'unknown' && /DSB_PAYLOAD_MISMATCH/.test(outcome.message);
  if (outcome.kind === 'unknown' && !mismatch) return outcome;
  // Refused (or the id is taken): decided by whether a row with this client id exists.
  const found = await lookupByClientId(input.clientId);
  if (found.kind === 'unavailable')
    return { kind: 'unknown', message: `${outcome.message} (could not verify: ${found.message})` };
  if (found.kind === 'found')
    return found.id === input.itemId
      ? { kind: 'committed', value: { itemId: found.id, mapped: false, name: null } }
      : { kind: 'unknown', message: 'This item request id belongs to another item.' };
  return outcome.kind === 'rejected'
    ? outcome
    : { kind: 'rejected', code: 'DSB_PAYLOAD_MISMATCH', message: outcome.message };
}

/** Plain words for a refused item create, saying what to do next. */
export function plainItemRefusal(message: string): string {
  if (/DSB_ITEM_NAME_TAKEN/.test(message))
    return `${message.replace(/^.*DSB_ITEM_NAME_TAKEN:\s*/, '')}.`;
  if (/DSB_ITEM_SKU_TAKEN/.test(message))
    return `${message.replace(/^.*DSB_ITEM_SKU_TAKEN:\s*/, '')}.`;
  if (/DSB_INVALID_ITEM/.test(message)) return message.replace(/^.*DSB_INVALID_ITEM:\s*/, '');
  if (/DSB_PAYLOAD_MISMATCH/.test(message))
    return 'This item id was already used. Create the item again.';
  if (/not permitted|permission/i.test(message))
    return 'Only the owner or a manager can create items.';
  return message;
}
