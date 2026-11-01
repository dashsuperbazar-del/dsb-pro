import { useEffect, useRef } from 'preact/hooks';
import type { ReviewCard } from '../lib/syncReview';
import './d9.css';

// "Mark all reviewed": lists exactly the cards that were on screen when it opened and flags the ones that
// involve money. Reviewing only hides alerts; the caller acts on this snapshot only.
export function BulkReviewDialog(props: {
  cards: ReviewCard[];
  busy: boolean;
  canShop: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const money = props.cards.filter((c) => c.money).length;
  return (
    <div
      class="review-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onCancel();
      }}
    >
      <div class="review-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
        <h2 id="bulk-title" tabIndex={-1} ref={heading}>
          Mark {props.cards.length} reviewed?
        </h2>
        <p>
          This only hides the alerts{props.canShop ? ' here and for the shop' : ' on this device'}.
          Nothing is deleted, changed or posted.
        </p>
        {money > 0 && (
          <p class="alert">
            {money} of these {money === 1 ? 'involves' : 'involve'} money (a purchase, payment, sale
            or return). Reviewing does not post or fix them: check each one first.
          </p>
        )}
        <ul>
          {props.cards.map((c) => (
            <li key={c.key}>
              {c.title} {c.money && <span class="badge warning">Involves money</span>}
            </li>
          ))}
        </ul>
        <div class="review-actions">
          <button type="button" class="primary" disabled={props.busy} onClick={props.onConfirm}>
            Mark {props.cards.length} reviewed
          </button>
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
