# DSB Pro — STATE (read this instead of HANDOVER.md)

Process + order: `docs/SINGLE_BUILDER_PLAN.md` v2.0. Design/invariants: `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1.
Always verify the SHA below with `git log origin/main -1` before trusting it.

## Current
- `main` at last update: `80a9247` (VF fixes merged, PR #42; deployed 2026-09-30). Migrations 0001–0045 (immutable).
- Last merged: **VF fixes** (PR #42) after **P2** (PR #41). In review: **C0** (mig 0046, group `c0`).
- Live DB (2026-09-30, run 36650456557): 0036–0045 applied (Phase 6.5, Batch A, Batch B, P1, P2) after an
  encrypted B2+R2 backup; live state `5:2:5:2:3:4:1`. App redeployed from `80a9247` (run 36656319852).
- Next packet after C0 merges: **C1** supplier payments (mig 0047), then C2, C3, U1, F0–F3, D1-lite, R1.
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
  money). C1 must add an invariant/report for them before supplier payments go live.
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
- 2026-09-30: GPT verification log V001 findings VF-001..004 accepted; fixed in PR #42 (VF-002 rated MINOR by builder).
- 2026-09-30: undici pinned `^7.29.1` via pnpm override (GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3).
- 2026-09-30: brace-expansion pinned `^5.0.11` via pnpm override (GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p).
- 2026-09-29: scheduled builder routine (every 6h, this session) builds packets up to PR; never merges.
- 2026-09-29: dual-builder (GPT+Claude) retired; sub-agent review replaces it. GPT optional for C0, C1, F2, F3.
- 2026-09-29: C0a+C0b merged into C0; 20-session benchmark dropped for M1.
