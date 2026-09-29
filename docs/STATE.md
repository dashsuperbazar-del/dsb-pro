# DSB Pro — STATE (read this instead of HANDOVER.md)

Process + order: `docs/SINGLE_BUILDER_PLAN.md` v2.0. Design/invariants: `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1.
Always verify the SHA below with `git log origin/main -1` before trusting it.

## Current
- `main` at last update: `81ac0d1` (P1 merged, PR #38). Migrations 0001–0044 (immutable).
- Last packet: **M0 Hygiene** (this PR) — Prettier on `apps/**`, STATE.md, ledger fix, CI policy.
- Next packet: **P2** item-sales discount fix (mig 0045), then C0, C1, C2, C3, U1, F0–F3, D1-lite, R1.
- Milestone in progress: **M1 Daily-usable** (exit = 7-day shadow run vs old DSB).

## Workflow (single builder)
failing tests → migration → adapters/UI → `pnpm lint && pnpm typecheck && pnpm test` (+pgTAP) →
fresh sub-agent review (BLOCKER/MAJOR fixed, max 2 rounds) → PR → CI → 5-line summary → user says `merge`.
CI gate: UI/no-migration packet = one green full run on final head. Migration packet = PR run +
`workflow_dispatch operation=validate`. Squash-merge is the ratified practice.
Ask the user only for: merge, live migration approval, legacy export (F0), money/data-loss trade-off.

## Format
- `pnpm exec prettier --check "apps/**/*.{ts,tsx,css,json,html}"` (config `.prettierrc.json`). New code stays formatted.

## Open risks / debts
- `packages/db/src/types.ts` is HAND-WRITTEN (106 lines), not generated. Regeneration needs Docker or a Supabase
  PAT (`pnpm gen:types`, see script). No Docker daemon in the cloud builder session → M0 could NOT regenerate.
  Do it on a machine with Docker/local Supabase; until then RPC typing is not schema-checked.
- No supplier-payment RPC/screen yet (C1/C2). Expenses live in Reports; no stock-adjust screen (U1).
- Every gate H1–H9 from Phase 3 on is NOT GO; needs dated real-shop evidence. H3 needs an explicit offline→restart→reconnect device test, not just the shadow run.
- P1 deferred follow-ups 1–6 (see ledger P1 row) are moved to M2.
- Legacy old-DSB JSON export needed from the user when F0 starts.

## Decisions log
- 2026-09-29: dual-builder (GPT+Claude) retired; sub-agent review replaces it. GPT optional for C0, C1, F2, F3.
- 2026-09-29: C0a+C0b merged into C0; 20-session benchmark dropped for M1.
