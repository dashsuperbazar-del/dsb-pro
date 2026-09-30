# DSB Pro — STATE (read this instead of HANDOVER.md)

Process + order: `docs/SINGLE_BUILDER_PLAN.md` v2.0. Design/invariants: `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1.
Always verify the SHA below with `git log origin/main -1` before trusting it.

## Current
- `main` at last update: `c03e7c6` (P2 merged, PR #41). Migrations 0001–0045 (immutable).
- Last merged packet: **P2** item-sales discount fix (PR #41). Follow-up **VF fixes** (PR #42) in review.
- Live DB (2026-09-30, run 36650456557): 0036–0045 applied (Phase 6.5, Batch A, Batch B, P1, P2) after an
  encrypted B2+R2 backup; live state `5:2:5:2:3:4:1`. The deployed app build was NOT redeployed since.
- Next packet: **C0** (mig 0046), then C1, C2, C3, U1, F0–F3, D1-lite, R1.
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
- `void_sale` adapter sent the wrong arg name (fixed in PR #42): "Void sale" fails in the live app until redeploy.
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
- 2026-09-29: scheduled builder routine (every 6h, this session) builds packets up to PR; never merges.
- 2026-09-29: dual-builder (GPT+Claude) retired; sub-agent review replaces it. GPT optional for C0, C1, F2, F3.
- 2026-09-29: C0a+C0b merged into C0; 20-session benchmark dropped for M1.
