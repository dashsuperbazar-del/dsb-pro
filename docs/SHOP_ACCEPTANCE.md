# Shop acceptance — remaining evidence

Status: NOT GO until dated evidence is recorded. Prepared 2026-10-11.
This follows the 2 October user decision: old DSB is retired; no legacy import or shadow run.
The remaining 2–4-session estimate covers technical fixes and review, not seven elapsed shop days.

## Technical gate (builder)

- RP1: green full CI on the final PR head; successful production-scale performance run.
- After approval and merge, run the existing recovery proof and inspect encrypted backup,
  disposable restore and financial parity evidence. A passing cleanup test alone does not close VF-011.
- Keep any observed failure open with its exact commit, run, step and reproducible evidence.
- Merge and live operations require the user's approval. No new schema migration in RP1.

## H3 — actual shop device (user + verifier)

Use the device and browser/install mode intended for the shop. Record date, app version,
device/browser, shop and opening stock/balance. Use genuine entries or a disposable test shop;
do not create fictitious financial events in the live shop merely to test.

1. Open the app online and let its initial sync complete. Record the baseline and queue status.
2. Disconnect the network. Make an offline-supported sale and, where applicable, an offline return.
   Record each local identifier, quantity and amount. Returns stay provisional until confirmation.
3. Close and restart the app while still offline. Confirm the exact pending entries remain visible.
   Do not clear site data, reinstall or discard an unconfirmed request.
4. Reconnect. Wait for sync to finish and verify each entry reached the server exactly once.
   Check history, stock and customer balance against the recorded baseline and intended changes.
5. Restart once more online. Confirm no duplicate entry or additional stock/balance movement.
   Report any pending/UNKNOWN result; retry only the saved request, never create a replacement.

Evidence: date / app commit / device / entry IDs / expected versus actual changes /
queue before and after / PASS or failure details. Screenshots are optional; avoid customer details.

## First clean real-data week (user + verifier)

Choose and record the first trading date. At each day's close use Compare and the invariant
health panel; reconcile sales, returns, expenses, receipts, supplier payments, stock and balances
against that day's actual business records. Record unexplained differences and any unresolved
queue/UNKNOWN requests. UNKNOWN health is not a passing invariant check.

| Day/date | Compare reconciliation | Invariant result | Pending/UNKNOWN | Evidence / discrepancy |
| --- | --- | --- | --- | --- |
| 1 | pending | pending | pending | |
| 2 | pending | pending | pending | |
| 3 | pending | pending | pending | |
| 4 | pending | pending | pending | |
| 5 | pending | pending | pending | |
| 6 | pending | pending | pending | |
| 7 | pending | pending | pending | |

The verifier checks the dated evidence before closing M1. A code review or green CI cannot
substitute for H3 or a clean shop week. Fiscal numbering, receipt snapshots, full D3 JSON restore,
storefront and SaaS remain separately deferred work.
