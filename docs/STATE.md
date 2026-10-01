# DSB Pro — STATE (read this instead of HANDOVER.md)

Process + order: `docs/SINGLE_BUILDER_PLAN.md` v2.0. Design/invariants: `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1.
Always verify the SHA below with `git log origin/main -1` before trusting it.

## Current
- `main` at last update: `dd37ae5` (C2 merged, PR #45). Migrations 0001–0048 (immutable).
- Last merged: **C2** (mig 0048). In review: **C3** customer requests (mig 0049, group `c3`); C3b next.
- Live DB: C2 applied 2026-10-01 (run 36804657756, only group `c2` pending); live state
  `5:2:5:2:3:4:1:2:2:2` (fully upgraded). App deployed from `dd37ae5` (run 36805399708).
- Next after C3: **C3b** (request-aware post_sale/post_purchase direct callers; outbox UNKNOWN metadata +
  reconcile-by-id for sale/return; POS receipts to v2), then U1, F0–F3, D1-lite, R1.
- Milestone in progress: **M1 Daily-usable** (exit = 7-day shadow run vs old DSB).

## Workflow (single builder)
failing tests → migration → adapters/UI → `pnpm lint && pnpm typecheck && pnpm test` (+pgTAP) →
fresh sub-agent review (BLOCKER/MAJOR fixed, max 2 rounds) → PR → CI → 5-line summary → user says `merge`.
CI gate: UI/no-migration packet = one green full run on final head. Migration packet = PR run +
`workflow_dispatch operation=validate`, both on the unchanged final head. Squash-merge is the ratified practice.
Ask the user only for: merge, live migration/deploy approval, legacy export (F0), money/data-loss trade-off.
Before a live `phase6_db_upgrade`, list EVERY group the preflight will apply (it applies all pending groups).

## Local environment
- Docker works in the cloud session: `dockerd &`, then `pnpm exec supabase start` (CLI 2.116.0).
- After every migration: `pnpm exec supabase db reset && pnpm exec supabase gen types typescript --local >
  packages/db/src/types.ts` — CI fails if the committed types are stale.
- `pnpm exec prettier --check "apps/**/*.{ts,tsx,css,json,html}"` (config `.prettierrc.json`).

## Open risks / debts
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
- No supplier-payment RPC/screen yet (C1/C2). Expenses live in Reports; no stock-adjust screen (U1).
- Every gate H1–H9 from Phase 3 on is NOT GO; needs dated real-shop evidence. H3 needs an explicit
  offline→restart→reconnect device test. Returns/offline returns/Batch B are now live on the DB, so these matter.
- P1 deferred follow-ups 1–6 (see ledger P1 row) are moved to M2.
- Legacy old-DSB JSON export needed from the user when F0 starts.

## Decisions log
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
