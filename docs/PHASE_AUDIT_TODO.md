# Phase Audit Todo

Running findings log for the `VERIFY` command (senior-engineer audit pass: build progress vs.
`DSB_PRO_BUILD_PLAN.md` v1.5 / `docs/HANDOVER.md` / actual repo+CI state, verified directly
against `origin`, not assumed). This file accumulates across every audit pass and stays open
— items are checked off with the commit/PR/evidence that resolved them, never deleted — until
Phase 7 is complete.

## VERIFY pass — 2026-09-09

State at time of audit: `origin/main` through Phase 3 hotfix (PR #1–#6 merged). PR #7 (Phase 4)
open/draft, CI green. PR #9 (Phase 5, supersedes closed PR #8) open/draft, CI failing.

### 🔴 Critical / blocking

- [x] **Phase 5 chaos-suite gate was failing** on PR #9's then-head (`2a72891`). **Resolved** —
  see 2026-09-12 pass below: re-checked fresh, now green.
- [ ] **`docs/HANDOVER.md` on `main` has zero entries for Phase 2, Phase 3, or the Phase 3
  hotfix**, despite PR #4/#5/#6 all being merged. Still true as of the 2026-09-12 pass — see
  below. A fix exists (PR #10) but is deliberately unmerged pending authorization.
- [x] **Phase 5's own `docs/HANDOVER.md` entry was stale**, describing only change-set 5.1.
  **Resolved** — the branch's HANDOVER now has a full "Phase 5 implementation status —
  2026-09-09" section covering Dexie, outbox, device revocation, conflict tray, PWA shell,
  cashier policy and chaos evidence (verified by direct read, not assumed).

### 🟡 Open / deferred — tracked, not forgotten

- [ ] **Phase 2's real-invoice reconciliation gate is formally deferred, not done.** Per
  `docs/PHASE2_GATE_DECISION.md` (explicit user authorization, 2026-09-08): deferred until
  after Phase 7. Still outstanding as of 2026-09-12.
- [ ] **Real shop data is live in the dev database** (276 items, 38 suppliers, 1 real customer,
  265 positive stock balances, imported during Phase 4). Backup-before-change discipline
  (checksum-verified encrypted backup in B2+R2 before every live-DB change) was claimed by PR
  #7's body and spot-confirmed structurally; re-confirm it continues to hold as Phase 6 also
  now touches the live dev DB (four Phase 6 workflow runs).
- [x] **Device revocation enforcement** (Phase 1's long-standing deferred item). **Resolved** —
  see 2026-09-12 pass below: implemented in Phase 5, verified by direct read of the branch's
  HANDOVER text (not independently re-run — no local Docker/Supabase on this machine).

### 🟢 Verified healthy this pass (spot-checked directly, not just trusted from PR text)

- No client-facing `GRANT ... DELETE` anywhere across any migration, Phase 0 through the Phase 5
  draft. Deletes are soft (`deleted_at`); financial line rows additionally have
  `BEFORE UPDATE OR DELETE` immutability triggers.
- Every new table in every phase (0–5 draft) has RLS enabled, the standard column set, and a
  server-set `updated_at` via `set_updated_at()`.
- `stock_movements` is documented as the only stock truth; `stock_current` is a projection.
- No `@supabase/supabase-js` import outside `packages/adapters` in the Phase 4 or Phase 5 diffs.
- No `dangerouslySetInnerHTML` / `innerHTML` usage anywhere.
- PR #4/#5/#6/#7: CI independently re-checked via `gh pr checks`, genuinely green.

### Scope limits of this pass

- Structural/documentation/CI-truth audit only — no line-by-line proof of Phase 4/5
  payment-allocation, sale-finalization, or sync-merge business logic; no local suite re-run
  (this machine can't run Docker/local Supabase).
- Local `master`/`main` branches were far behind `origin` (main behind by 177+ commits) —
  always check `origin` directly rather than local branch state.

## VERIFY pass — 2026-09-12

State at time of audit, verified fresh against `origin` (not assumed): `origin/main` at
`2c043f5` (Phase 3 hotfix merge), CI + nightly backup both green. PR #7 (Phase 4) open/draft,
CI green, self-gated **NOT GO** pending a real parallel shop day vs. old DSB. PR #9 (Phase 5,
based on the Phase 4 branch) open/draft, CI green including the previously-failing chaos suite.
Phase 6 branch (`phase-6-ledgers-reports-dr`, 108 commits past the Phase 5 head, started 16
minutes after Phase 5's exact-head CI went fully green — no ordering violation) has its own
green CI (`CI` + three dedicated Phase 6 workflows) at head `e77f09e`, but **no PR opened yet**,
self-gated **NOT GO** per `docs/PHASE6_CLOSURE.md` pending human DR/restore evidence. PR #10
(`docs/phase-audit-handover`) open/draft, CI green, restores the missing Phase 2/3/hotfix
HANDOVER history — not merged. No Phase 7 branch exists.

### 🔴 Critical / blocking

- [ ] **`CLAUDE.md`'s phase marker is badly stale, on both local `master` and `origin/main`.**
  It reads "Current phase: 1 (backend complete; UI follow-up spec pending)". Actual state:
  `origin/main` is through Phase 3 hotfix, Phase 4 and Phase 5 are CI-green on unmerged
  branches, and Phase 6 is CI-green on a branch with no PR yet. `CLAUDE.md` is this project's
  own designated source of truth (per its own text) — a future session (or person) reading it
  fresh would badly misjudge project state. This is a documentation bug, not a code bug, but a
  significant one given `CLAUDE.md`'s role.
- [ ] **`docs/HANDOVER.md` on `main` still has zero entries for Phase 2, Phase 3, or the Phase 3
  hotfix**, unchanged from the 2026-09-09 finding. A correct fix already exists in open PR #10
  (CI green) but remains deliberately unmerged pending explicit authorization — so the rule
  violation is still live on `main` today, three days after it was first caught.
- [ ] **Two divergent, both formerly-stale copies of this checklist existed**: this file
  (`docs/PHASE_AUDIT_TODO.md`, untracked locally, never committed on any branch) and a
  differently-worded, separately-committed version on `origin/docs/phase-audit-handover` (PR
  #10). Neither had been updated to reflect the chaos-suite fix or the new Phase 6 branch before
  this pass. Recommend treating *this* file as canonical going forward; the PR #10 copy should
  be synced or dropped — not resolved here, user's call.

### 🟢 Resolved since the 2026-09-09 pass (re-verified fresh, not carried over blindly)

- [x] Phase 5 chaos-suite Playwright failure — now green. Re-checked directly via
  `gh pr checks 9`: `e2e` pass on both matrix runs, `phase5_preview` pass, `phase5_db_upgrade`
  pass, zero failing/red jobs.
- [x] Device revocation enforcement — implemented in Phase 5 per the branch's own HANDOVER text
  (sync pull/push requires an active registered device; revoked devices rejected next sync; a
  revoked browser identity cannot silently re-register). Verified by direct read of the
  HANDOVER section, not by an independent local test run (still no Docker/Supabase here).

### 🟡 Open / deferred — tracked, not forgotten (carried forward, still true)

- [ ] Phase 2 real-invoice reconciliation, deferred to after Phase 7 per
  `docs/PHASE2_GATE_DECISION.md` — still not run.
- [ ] Phase 4's gate is explicitly **NOT GO** in PR #7's own body (current head `da09298`): "one
  real parallel shop day still required" against old DSB before merge. Correctly un-merged —
  a self-declared, not-yet-satisfied obligation, not a new bug.
- [ ] Phase 6 is explicitly **NOT GO** per `docs/PHASE6_CLOSURE.md` on that branch, pending a
  fresh hosted-Supabase restore drill, paper-only encryption-key recovery, measured RPO/RTO, and
  Phase 3/4 real-shop physical verification. No PR opened for Phase 6 yet.

### 🟢 Verified healthy this pass (spot-checked directly on the new Phase 6 code)

- [x] No client-facing `GRANT ... DELETE` in any Phase 6 migration (`0030`–`0035`).
- [x] No `innerHTML` / `dangerouslySetInnerHTML` anywhere under `apps/` on the Phase 6 branch.
- [x] No `@supabase/supabase-js` import outside `packages/adapters` on the Phase 6 branch —
  adapter boundary still holds.
- [x] Migration `0030` adds 3 tables and enables RLS on all 3; `0031`–`0035` add no new tables.
- [x] `main`'s own CI (head `2c043f5`) and the nightly backup workflow are both green today.

### Scope limits of this pass

- Same constraint as before: no local Docker/Supabase on this machine, so CI's own recorded runs
  (fetched fresh via `gh`, not assumed) remain the checked source of truth rather than a local
  re-run.
- Did **not** re-derive Phase 4/5/6 payment, sync-merge, ledger, or GST/valuation math
  line-by-line this pass — relied on continued-green CI (including pgTAP invariant/failure
  suites) at every subsequent head. Phase 6's ledger/valuation/report math is net-new since the
  last pass and has not had a dedicated line-by-line review yet.
- Did not independently re-run the Phase 5 device-revocation or chaos suites locally — CI green
  is the evidence, not a reproduction.

## VERIFY pass — 2026-09-13 (post-review reconciliation)

Independent review of the 2026-09-12 plan corrected three facts and surfaced one live risk.
Corrections are recorded here rather than silently absorbed.

### 🟢 Resolved by this change-set

- [x] **Phase 2 / Phase 3 / Phase 3-hotfix handover history.** Restored onto this branch by
  cherry-picking `a3e0da2`, placed chronologically ahead of the Phase 5 and Phase 6 sections.
  **PR #10 must be closed unmerged**: its two commits (`a3e0da2`, `ae05cfe`) sit outside
  `phase-6-ledgers-reports-dr`'s ancestry, so merging that PR into `main` would make the two
  lines diverge and destroy the fast-forward consolidation topology.
- [x] **Duplicate audit checklist.** This file is now the single committed copy, on the
  phase-6 line.

### Corrections accepted from independent review

- pgTAP is **342 assertions across 27 files** at the current head. The previously recorded 257
  was Phase 4's figure, carried forward without re-checking.
- **GitHub Pages cannot serve repository-controlled HTTP response headers.** The §8 header set
  is achievable on Cloudflare Pages via `_headers`; the GitHub Pages mirror can carry at most a
  `<meta http-equiv>` CSP, with HSTS and `frame-ancestors` unavailable. Plan for documented
  asymmetry, not parity.
- The admin bundle is **71.5 KB gzip**, comfortably inside the §12 250 KB ceiling — so adding
  the ceiling as a CI gate locks in a healthy number rather than exposing a breach.

### 🔴 New — open

- [ ] **`main`'s nightly backup contains no Auth data.** `main`'s `backup.yml` dumps
  `--schema=public` only; the separate encrypted `auth` artifact exists only on this branch.
  Real user accounts exist now, so until the fast-forward lands, losing the Supabase project
  means the shop data restores and **every login is unrecoverable**. This closes on
  consolidation and on nothing else — as do the nightly JSON export and the weekly proofs,
  since GitHub runs `schedule:` events only from the default branch.
- [ ] **The weekly cron would run a live-schema migration applier unattended.**
  `phase6_backup_proof` and `phase6_portable_restore` both declare `needs: [phase6_db_upgrade]`,
  so the schedule added on 2026-09-12 also fires the upgrade job against the production
  database every Sunday. Gate that job to `workflow_dispatch` only, or prove it is a strict
  no-op on an already-upgraded schema, **before** the schedule reaches the default branch.
- [ ] **`pos.spec.ts` failed once on a detached-DOM timeout and passed on an unchanged rerun.**
  Treat as a suspected race on the billing screen rather than accepted flake; it is the one
  screen where an intermittent failure is most likely to be real.
