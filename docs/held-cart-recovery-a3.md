# Held-cart resume safety (A3)

A held cart is local, unposted work. Resume must prefer a duplicate over lost
work: the record is never deleted before every item, unit, quantity, price,
discount, customer and shop reference has been validated and the complete
candidate cart has been committed to the POS state.

## Claim protocol

- A resume attempt atomically writes a random `resumeToken` and `resumingAt`
  timestamp in the same Dexie transaction that reads the cart.
- A different token cannot claim the cart for 60 seconds. This blocks two tabs
  from independently completing the same resume.
- At 60 seconds the lease is stale and a new token may replace it. This lets a
  cashier recover after a browser/tab crash without deleting any cart data.
- Only the current token may release a handled failure or delete the held copy.
  An expired claimant cannot delete a newer claimant's work.
- `discardHeldCart` remains the only direct destructive user action.

## UI commit and cleanup

Resolution builds the whole cart in memory. No line is appended to UI state
during asynchronous lookups. Once resolution succeeds, customer, adjustments
and every line are installed together. A post-render effect then performs the
token-checked delete.

If deletion fails, the active cart and durable held copy both remain. POS
blocks finalization and holding another cart until the cashier uses the visible
cleanup retry. A refresh loses the unposted active UI state but retains the held
record; after the lease expires it can be resumed again.

The hold-label and add-quantity inputs use stable test IDs. CI runs the complete
held-cart scenario once within the full E2E suite and then ten more times to
guard against the former reconciliation/locator race.
