import { useEffect, useRef, useState } from 'preact/hooks';
import {
  getPartyMergePreview,
  listSupplierDuplicateBills,
  mergeParties,
  type DuplicateBillGroup,
  type MergePreview,
} from '@dsb-pro/adapters';
import { rupees } from '../lib/money';
import { appRoute } from '../lib/paths';

const newRequestId = () => crypto.randomUUID();

// Merge a duplicate supplier into the one to keep. Both suppliers' records are kept: the server moves every
// bill, payment, return, opening balance and schedule to the kept supplier and archives the duplicate.
// Nothing is deleted or added together. One request id per attempt, so a retry after a lost reply is the
// same merge, never a second one.
export function PartyMergePanel(props: {
  shopId: string;
  party: { id: string; name: string };
  others: { id: string; name: string }[];
  blockedReason: string | null;
  onMerged: (targetId: string, targetName: string) => Promise<void> | void;
}) {
  const { party, others, blockedReason } = props;
  const [targetId, setTargetId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(newRequestId());
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  // Like old DSB: show what moves and the combined balance before the owner confirms.
  useEffect(() => {
    let live = true;
    setPreview(null);
    setPreviewError('');
    if (!targetId) return;
    getPartyMergePreview(props.shopId, party.id, targetId).then(
      (p) => live && setPreview(p),
      (e: unknown) =>
        live && setPreviewError(e instanceof Error ? e.message : 'Could not load the preview.'),
    );
    return () => {
      live = false;
    };
  }, [props.shopId, party.id, targetId]);
  useEffect(() => {
    setTargetId('');
    setConfirming(false);
    setError('');
    requestId.current = newRequestId();
  }, [party.id]);

  const target = others.find((o) => o.id === targetId) ?? null;
  async function merge() {
    if (!target || busy) return;
    setBusy(true);
    setError('');
    try {
      await mergeParties({
        sourcePartyId: party.id,
        targetPartyId: target.id,
        requestId: requestId.current,
      });
      setConfirming(false);
    } catch (e) {
      // Keep the request id: trying again after a lost reply returns the same merge.
      setError(e instanceof Error ? e.message : 'Could not merge the suppliers.');
      setBusy(false);
      return;
    }
    // The merge is committed; a failed refresh must not read as a failed merge.
    requestId.current = newRequestId();
    try {
      await props.onMerged(target.id, target.name);
    } catch {
      setError('Merged. The screen could not refresh; reopen Suppliers to see the kept supplier.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details class="party-merge" data-testid="party-merge">
      <summary>Merge into another supplier…</summary>
      <p class="muted">
        Use this when {party.name} was entered twice. All of its bills, payments, returns, opening
        balance and schedule move to the supplier you keep, unchanged, and {party.name} is archived.
        This cannot be undone.
      </p>
      {blockedReason ? (
        <p class="alert" role="alert">
          {blockedReason}
        </p>
      ) : (
        <>
          <label>
            Keep this supplier
            <select
              value={targetId}
              disabled={busy}
              onChange={(e) => {
                setTargetId((e.target as HTMLSelectElement).value);
                setConfirming(false);
                setError('');
                requestId.current = newRequestId();
              }}
              aria-label="Supplier to keep"
            >
              <option value="">Select…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          {target && !preview && !previewError && (
            <p class="muted" role="status">
              Checking what will move…
            </p>
          )}
          {previewError && (
            <p class="alert" role="alert">
              {previewError}
            </p>
          )}
          {target && preview && (
            <p data-testid="merge-preview">
              {preview.bills} bill(s), {preview.payments} payment(s), {preview.returns} return(s)
              and {preview.openings} opening balance(s) move to {target.name}. Combined balance in
              this shop after the merge: {rupees(preview.combinedBalancePaise)}
              {BigInt(preview.combinedBalancePaise) > 0n ? ' (you owe)' : ''}.
            </p>
          )}
          {preview?.openingConflict && (
            <p class="alert" role="alert">
              Both suppliers have an opening balance in the same shop. Void one and record the
              combined opening first.
            </p>
          )}
          {target && preview && !preview.openingConflict && !confirming && (
            <button type="button" onClick={() => setConfirming(true)}>
              Merge {party.name} into {target.name}
            </button>
          )}
          {target && preview && !preview.openingConflict && confirming && (
            <div role="group" aria-label="Confirm merge">
              <p>
                Move everything from <b>{party.name}</b> to <b>{target.name}</b> and archive{' '}
                {party.name}?
              </p>
              <button type="button" disabled={busy} onClick={() => void merge()}>
                {busy ? 'Merging…' : 'Yes, merge'}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p class="alert" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}

// Self-check after a merge: bills of the kept supplier that are identical (same date, total and bill
// number). Listing only; a real duplicate is voided from Purchase bills with the normal audited void.
export function DuplicateBillsCheck(props: { shopId: string; partyId: string; partyName: string }) {
  const { shopId, partyId } = props;
  const [groups, setGroups] = useState<DuplicateBillGroup[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setGroups(null);
    setError('');
    listSupplierDuplicateBills(shopId, partyId).then(
      (g) => live && setGroups(g),
      (e: unknown) =>
        live && setError(e instanceof Error ? e.message : 'Could not check for identical bills.'),
    );
    return () => {
      live = false;
    };
  }, [shopId, partyId]);

  if (error)
    return (
      <p class="alert" role="alert" data-testid="duplicate-bills">
        {error}
      </p>
    );
  if (groups === null)
    return (
      <p class="muted" role="status" data-testid="duplicate-bills">
        Checking {props.partyName} for identical bills in this shop…
      </p>
    );
  if (groups.length === 0)
    return (
      <p class="muted" role="status" data-testid="duplicate-bills">
        No identical bills found for {props.partyName} in this shop.
      </p>
    );
  return (
    <section class="alert" role="alert" data-testid="duplicate-bills">
      <h2>Possible duplicate bills</h2>
      <p>
        These bills of {props.partyName} in this shop have the same date, total and bill number. If
        one was entered twice, void the extra one in <a href={appRoute.purchases}>Purchase bills</a>
        . Nothing was removed automatically.
      </p>
      <ul>
        {groups.map((g) => (
          <li key={g.billIds.join(',')}>
            {g.billNo ? `Bill ${g.billNo}` : 'No bill number'} · {g.businessDate} ·{' '}
            {rupees(g.totalPaise)} · {g.billIds.length} bills
          </li>
        ))}
      </ul>
    </section>
  );
}
