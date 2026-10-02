# DSB Pro — STATE (read this instead of HANDOVER.md)

Process + order: `docs/SINGLE_BUILDER_PLAN.md` v2.0. Design/invariants: `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1.
Always verify the SHA below with `git log origin/main -1` before trusting it.

## Current
- `main` at last update: `9475aa4` (O2 merged, PR #57; `o2` live apply run 740).
  Migrations 0001–0055 (immutable). In review: **O3** (supplier payment history counts settlements; UI only).
- Decision 2026-10-02 (user): the return that completes a rounded bill also reverses its round-off;
  partial returns carry item value, capped so a bill's returns never exceed what was billed for its
  items (total - extra charges). Extra charges still stay with the shop.
- Live DB: D1 applied 2026-10-01 (run 36894777286, only group `d1` pending; verify green). Fully upgraded.
  D1 deployed after the apply (run 36897126086, green).
- Verifier log V003 (2026-10-02): VF-005/006/008 CLOSED. Open MAJORs fixed in V4: VF-007 follow-up
  (a finished action repainted/voided the previous customer) and VF-009 (two stored intents blocked
  each other's retry). Watch: held-cart repeat once showed "Saved locally" instead of "Sale finalized"
  (main push run 36909385562, 9/10) — check eventual exactly-once sync if it recurs.
- V2 residual closed by V3: receipt/payment check+create+send is serialized per account across windows
  (Web Locks). Browsers without Web Locks keep the unserialized check.
- Rule (V2): every money/stock write stores its exact request on the device BEFORE sending (fail
  closed) and only a definitive DB rejection unlocks it; use `rpcOutcome`/`*Outcome` adapters, never
  `classifyError` to decide an outcome.
- Decision 2026-10-02 (user): old DSB is retired; no legacy import, no shadow run. DSB Pro goes live
  with real data once daily-usable, then is patched in use. F0/F3 dropped; F1 (fiscal numbering) later.
- O1 design: one POSTED opening per account (signed paise; customer + = owes shop, supplier + = shop
  owes), owner only, void + re-enter to correct. Feeds customer_ledger, party ledger v2, supplier
  outstanding and both as-of aging reports (aged from as_of_date), export. DEFERRED to O2: allocating
  payments/credits against an opening — until then such cash shows as unassigned; net balance exact.
- O2 design (2026-10-02): separate `opening_settlements` (payment ↔ positive opening, owner only, void to
  correct) instead of editing the 5 live payment writers; a new BEFORE INSERT trigger on payment_allocations
  counts settlements so a payment is never assigned twice (DSB_ALLOCATION_EXCEEDS_PAYMENT); voiding a payment
  voids its settlements; a settled opening cannot be voided. Credit (negative) openings are not applied to
  bills (stay as credits in the net). Known gap: the supplier payment screen showed the pre-settlement
  unassigned amount; an allocation over it is refused by the trigger. Closed for suppliers by O3 (payment
  history counts settlements); the customer screen only allocates at receipt time, so no gap there.
- Watch (2026-10-02, local parallel e2e): recovery 'expense crash after commit' and suppliers 'lost
  response' timed out at 30 s under load, both passed alone. Not O2 code; check CI runs.
- Decision 2026-10-02 (user): build, merge, apply and deploy the next 5 packets, each only on green CI.
  Chosen (M2 list, daily-use first): O3 settlement-aware supplier payments → F1 fiscal-year bill
  numbering → D2 receipt snapshots → D4 health v2 → D3 export v5.
- M1 gate (daily-usable): O1 ✓ + H3 (user, offline→restart→reconnect, each entry once) + first clean
  real-data week (Compare page + invariants). Waiting on the user for H3 and the cutover date.

## Workflow (single builder)
failing tests → migration → adapters/UI → `pnpm lint && pnpm typecheck && pnpm test` (+pgTAP) →
fresh sub-agent review (BLOCKER/MAJOR fixed, max 2 rounds) → PR → CI → 5-line summary → user says `merge`.
CI gate: UI/no-migration packet = one green full run on final head. Migration packet = PR run +
`workflow_dispatch operation=validate`, both on the unchanged final head. Squash-merge is the ratified practice.
Ask the user only for: merge, live migration/deploy approval, money/data-loss trade-off.
Before a live `phase6_db_upgrade`, list EVERY group the preflight will apply (it applies all pending groups).

## Local environment
- Docker works in the cloud session: `dockerd &`, then `pnpm exec supabase start` (CLI 2.116.0).
- After every migration: `pnpm exec supabase db reset && pnpm exec supabase gen types typescript --local >
  packages/db/src/types.ts` — CI fails if the committed types are stale.
- `pnpm exec prettier --check "apps/**/*.{ts,tsx,css,json,html}"` (config `.prettierrc.json`).

## Open risks / debts
- D1-lite: old `get_customer_aging_report` (current-state balances labelled as-of) stays for compatibility but the
  UI no longer calls it. 100k-invoice EXPLAIN not done (one shop; revisit at S1). Cash counts as assigned only
  when allocated/linked to a document in the same as-of set, so stranded allocations show as unassigned cash.
- R0: a walk-in bill under ₹0.50 rounds to ₹0.00 (no payment possible) — consistent both sides; product edge.
- Watch: suppliers 'lost response' e2e failed again on main (run 36904189128, form never shown). Hypothesis:
  waitForOfflineRuntime timed out at 5 s under load; raised to 30 s in V3. Close after 5 clean main runs.
- Every new migration packet adds its own upgrade group (manifest, ALLOWED_GROUPS, GROUP_ORDER, apply wrapper,
  classifier state + CI proof/apply/verify) — P2 is the template; freeze its checksum in the manifest once merged.
- C0 lock protocol: every money writer is a wrapper (shop finance advisory lock) over a client-revoked
  `c0_*_body`. `phase5_sync_post_sale` is intentionally unwrapped (own key first, no cycle; keeps Batch B signal).
  New money writers MUST take `dsb_lock_shop_finance` first. Wrappers lock before the body's permission check
  (tenant member could serialize own shop; MINOR, not fixed).
- Allocation `effective_date_source`: `EXPLICIT` = set by the server at insert (default = later of payment/doc
  date), `LEGACY_INFERRED` = pre-C0 backfill (latest of payment date, doc date, shop-local created date).
- Pre-C0 `void_purchase` never checked allocations: live may hold VOID bills with POSTED allocations (stranded
  money). C1 reports them in `get_supplier_outstanding().strandedAllocationsOnVoidBills`; owner releases them
  via `release_supplier_allocation`. Check that field on live right after the `c1` apply.
- C1 tightens `payments`/`payment_allocations` read RLS: party (supplier) rows need POST_PURCHASES or VIEW_REPORTS,
  and rows are scoped to the caller's shops. Generic `void_payment` refuses party payments (use supplier void).
- FIXED LIVE (C2/0048, 2026-10-01): C1 `get_party_ledger_v2` fails through PostgREST (temp-table
  DELETE without WHERE blocked by safeupdate). Read-only; no money affected. pgTAP/psql cannot see safeupdate —
  every new SQL read path needs an e2e (PostgREST) call, not only pgTAP.
- C1 review MINORs (open): c1 classifier probes only 2 schema anchors; customer writers accept
  `supplier.`-prefixed client_ids (DoS-only squatting).
- Stranded allocations on VOID bills: not yet checked on live. After C2 deploys, the Suppliers summary shows ⚠ per
  supplier; owner releases each with a reason.
- C2 deferred e2e vectors (to C3/U1): same supplier two shops, another tab, switch user, auth expiry. Covered at
  unit level (attempt store) and pgTAP (RLS); browser proof pending.
- C1 has no cutover-date floor on supplier allocations (no cutover date exists yet); add it in F-packets.
- Classifier c0 state 1 (schema without receipt) is a fresh-reset/bootstrap state; on a live DB it needs the
  attended baseline-receipt init (P1 debt #5), not `apply`.
- `AppDatabase` widens every RPC arg to `T|null` (generator limitation); names/types are checked, nullability is not.
- `bootstrap-disposable-receipts.mjs` writes receipts for every manifest entry, even groups not applied (P1 debt #4).
- Every gate H1–H9 from Phase 3 on is NOT GO; needs dated real-shop evidence. H3 needs an explicit
  offline→restart→reconnect device test. Returns/offline returns/Batch B are now live on the DB, so these matter.
- P1 deferred follow-ups 1–6 (see ledger P1 row) are moved to M2.

## Decisions log
- 2026-10-01: USER DECISION (B1) — item values stay in exact paise; the BILL total rounds to the nearest rupee
  (half-up, as old DSB) with a separate round-off amount. New packet R0 (migration). Old/queued sales stay exact.
- 2026-10-01: U1 daily-entry forms (expense, stock adjust, purchase) freeze the request after an unconfirmed
  attempt and only offer a same-id retry; start-over only on a definitive server answer.
- 2026-10-01: C3b scope. POS sales never call post_sale directly (outbox -> Batch B fingerprinted sync), so the only
  direct UI money writer was post_purchase: 0050 verifies every retry against the stored bill (PAYLOAD_MISMATCH on
  any difference; covers pre-0050 bills). Direct post_sale (API-only) and outbox UNKNOWN labels deferred: Batch B
  fingerprints already make sale/return replays exact. POS customer receipts stay on the request-recorded old
  endpoint (C3). Future migrations rewriting post_purchase must keep the 0050 marker text (c3b classifier signal).
- 2026-10-01: C3 split. C3 = customer v2 writers + request-recorded old endpoint (legacy retry verified field
  by field before any validation; mismatch -> DSB_LEGACY_REQUEST_UNVERIFIABLE). C3b = direct post_sale/post_purchase
  wrappers + outbox UNKNOWN (touches the live offline sale/return path; kept separate to limit money-path risk).
- 2026-10-01: Old customer endpoint now rejects duplicate invoice targets and cross-shop invoices for NEW receipts
  (retries of recorded receipts still return them).
- 2026-10-01: C2 carries mig 0048 (ledger fix) so C3's planned customer-request migration becomes 0049 (unchanged).
- 2026-10-01: Offline snapshot schemaVersion 4 adds `financialAttempts` + `onlineRequestsAwaitingConfirmation`.
- 2026-10-01: C1 cutover-date restriction deferred (no cutover date defined); supplier read RLS tightened.
- 2026-09-30: GPT verification log V001 findings VF-001..004 accepted; fixed in PR #42 (VF-002 rated MINOR by builder).
- 2026-09-30: undici pinned `^7.29.1` via pnpm override (GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3).
- 2026-09-30: brace-expansion pinned `^5.0.11` via pnpm override (GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p).
- 2026-09-29: scheduled builder routine (every 6h, this session) builds packets up to PR; never merges.
- 2026-09-29: dual-builder (GPT+Claude) retired; sub-agent review replaces it. GPT optional for C0, C1, F2, F3.
- 2026-09-29: C0a+C0b merged into C0; 20-session benchmark dropped for M1.
