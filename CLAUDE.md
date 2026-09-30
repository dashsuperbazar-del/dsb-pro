You are the single builder of DSB Pro. Process and packet order: docs/SINGLE_BUILDER_PLAN.md v2.0 (supersedes
the dual-builder protocol and the packet order of docs/COMPLETE_REMAINING_BUILD_PLAN.md v1.1). Design,
schemas and invariants: COMPLETE_REMAINING_BUILD_PLAN.md v1.1 — read only the sections for the current packet.
Current state, next packet, open risks: docs/STATE.md. Read it first every session; do NOT read docs/HANDOVER.md.
Never trust a claim about "current main" or "next packet" in any file — verify with `git log origin/main -1`.

Workflow per packet (v2.0 §3): failing tests → SQL migration → adapters/UI → `pnpm lint && pnpm typecheck &&
pnpm test` (+ pgTAP via local Supabase) → fresh sub-agent review → PR → CI → 5-line summary → user says `merge`.
CI gate (v2.0 §4): UI/no-migration packet = one green full run on the final head; migration packet = PR run +
`workflow_dispatch operation=validate`, both on the unchanged final head. Squash-merge is the ratified practice.
Ask the user only for: merge, live migration/deploy approval, the legacy export (F0), a money/data-loss
trade-off with no safe default. Decide everything else and record the decision in STATE.md.
Before any live `phase6_db_upgrade` run, read the live preflight state and tell the user EVERY group it will
apply — the workflow applies all pending groups in order, not just the newest packet.
End of session / packet: update docs/STATE.md (≤120 lines) and the ledger row; do not append to HANDOVER.md.

Financial rules (unchanged): treat this as a production financial system; for every packet list silent
data-corruption risks before crashes, and flag security/sync/data-loss risks BEFORE code. Financial events are
never lost to LWW/conflict resolution. Stock and balances are derived from immutable ledgers. Cash up to actual
receipts and remainder against balance is confirmed shop policy. Offline returns persist provisionally with
reversible stock disposition; no cash payout or confirmed balance split until server confirmation. Old DSB
behaviour is locked by golden tests before any refactor. No phase closes until invariant, failure and restore
tests and real-shop reconciliation pass; every H-gate from Phase 3 on stays NOT GO until dated shop evidence.
Code rules: standard columns on every table; RLS + pgTAP for every new table; no client DELETE; server-set
updated_at; escape at render only; providers only behind adapters; never print full files; never "done" without
output. Forward-only migrations: every merged migration is immutable; corrections are new numbered migrations.
Each new migration adds its own upgrade group (manifest, ALLOWED_GROUPS, GROUP_ORDER, apply wrapper, classifier,
CI proof/apply/verify) — see P2 as the template — and regenerates packages/db/src/types.ts.

Repo: pnpm monorepo per DSB_PRO_BUILD_PLAN.md §4. Docker works in cloud sessions: start `dockerd &`, then
`pnpm exec supabase start`. Commands: pnpm test | pnpm build | pnpm exec supabase db reset |
pnpm exec supabase gen types typescript --local > packages/db/src/types.ts (CI fails if it is stale).
