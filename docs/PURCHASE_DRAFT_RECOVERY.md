# DW2a — Purchase draft recovery

Baseline: DW1 main `41dfd4b6e4202a3fc90de29a143247d6f82e9885` (PR #70).
Scope: durable unposted purchase entry. Bill photos, uploads, document sharing and full legacy parity remain later work.

## User behaviour

Purchase edits save on this device for the signed-in owner/manager and shop. Supplier, bill number,
business date, all item/unit/cost/quantity snapshots, discount/extra, search, selected item and unfinished
line-edit state survive reload. Saved drafts can be resumed explicitly; no restore automatically posts.
An unfinished edit must be updated or cancelled before posting. Discard requires confirmation.
This device-local draft is neither a backup nor a server-confirmed purchase; clearing browser data loses it.

UNKNOWN requests remain separate, exact and frozen. Resume and discard controls are disabled while a
request awaits confirmation. Confirmation removes only drafts with the confirmed request identity;
another window's pending request cannot clear the current cart. Definitive rejection keeps editable work and its original identity, including a payload mismatch
from a concurrently posted copy; it cannot silently become a second bill with a new identity.

Each mounted editor writes a separate snapshot. Restoring keeps the same posting identity, preventing
parallel restored copies from creating duplicate purchases. Distinct payloads using one identity are
rejected by the existing server contract. A snapshot may remain in another still-open editor after
confirmation; its original identity is retained, so it cannot create a second purchase.

Restore validates item availability, unit labels/conversions and supplier availability before replacing
the editor. Changed units refuse restore and retain the original bytes. Unreadable/quota/dropped writes
show a warning, never a durable-success claim. Account change hides the editor and requires reload.
Drafts are scoped locally, not encrypted; browser profiles are still a trusted device boundary.

## Proof and limits

- Local lint/typecheck, 328 unit tests, production build, format, bundle ceiling and installability checks: PASS.
- DOM regression restores all monetary/date fields and unfinished editing, asserts no automatic RPC,
  then posts with the original identity and checks exact quantities/costs/adjustments and draft cleanup.
- Unit regressions: user/shop isolation, simultaneous editor snapshots, exact identity cleanup,
  changed conversion/missing supplier refusal, storage denial/dropped writes/malformed data preservation.
- Account-switch DOM regression hides the previous editor without deleting its saved draft.
- Browser regression extends the existing purchase/repeat/payment/stock reconciliation at 390px:
  reload mid-edit, resume, review adjustments and supplier, update the line, post, reconcile as before.
- Existing lost-response purchase browser test still reloads and retries the frozen request exactly once.
- Local Docker, PostgreSQL and Chromium are unavailable. Full database/browser proof must run in CI.
- Independent review not yet completed. No review pass, merge, production deployment, live migration,
  Android picker/process-eviction test, H3 or real-shop acceptance is claimed.
