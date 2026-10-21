import type { DerivedCost } from '../lib/purchaseCost';
import { rupees } from '../lib/money';

// Shows what the entered line total becomes once stored as a whole-paise unit cost. An inexact result is a
// visible choice (use the suggested cost, with its exact difference) and never added silently.
export function CostDerivation({
  derived,
  onUse,
}: {
  derived: DerivedCost;
  onUse: (unitPaise: number) => void;
}) {
  if (!derived.ok)
    return (
      <p class="muted" data-testid="cost-derivation">
        {derived.message}
      </p>
    );
  if (derived.exact)
    return (
      <p class="muted" data-testid="cost-derivation">
        = {rupees(derived.unitPaise)} per unit · item total {rupees(derived.lineTotalPaise)}
      </p>
    );
  const diff = Math.abs(derived.diffPaise);
  return (
    <div role="group" aria-label="Cost cannot be stored exactly" data-testid="cost-derivation">
      <p class="alert">
        That total cannot be stored exactly. {rupees(derived.unitPaise)} per unit makes the line{' '}
        {rupees(derived.lineTotalPaise)}, {rupees(diff)} {derived.diffPaise < 0 ? 'less' : 'more'}{' '}
        than you entered.
      </p>
      <button type="button" onClick={() => onUse(derived.unitPaise)}>
        Use {rupees(derived.unitPaise)} per unit
      </button>
    </div>
  );
}
