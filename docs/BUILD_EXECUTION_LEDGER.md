# Build Execution Ledger

Packet-state tracker for `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1, per that plan's §4.1 and
§0.4 execution protocol. States: `NOT_STARTED` / `IN_PROGRESS` / `CODE_REVIEW` / `CI_PASSED` /
`HUMAN_PENDING` / `ACCEPTED` / `BLOCKED`. No row is marked `ACCEPTED` without the two-green-runs-
on-unchanged-head evidence this file requires; no evidence is recorded here without an actual run
ID/URL to back it — an unverified claim is not entered.

**Review-model correction (2026-09-23, amended 2026-09-26)**: the plan's §0.4/§21.3 protocol assumes
an independent reviewer distinct from the implementer. In sessions where the user relays this work
to a second model (ChatGPT or another Claude instance) acting as PLANNER under the Planner/Developer
Operating Protocol, that model performs the independent review at the exact candidate SHA —
"Reviewer" columns should record that model's name, not "Claude (self-review only)", whenever such a
review happened. Only in a session with no second model available does Claude implement and review
the same packet alone; that case is a real gap against the plan's stated gate, not a formality — a
self-reviewer can miss the same blind spot in both passes — and must be labeled as such in this
table, not silently presented as the permanent state "for every packet going forward". Mitigations
for the self-review case: CI (lint, typecheck, pgTAP, e2e, the disposable-DB upgrade proof) is a
mechanical check no self-review bias affects; every packet still gets its own PR with a full diff
for the user to hold as a record even though they cannot evaluate it line-by-line; and the human
evidence gates (H1-H9) remain the actual backstop against a self-review error reaching production,
since none of them can be satisfied by code or by either model alone. The user's role is
authorization (what to build, when to merge, when to run live operations) — that decision authority
is unaffected by this gap and remains theirs alone.

## Packet table

| Packet | State | Branch / head SHA | Migration(s) | Test count/names | CI run 1 | CI run 2 | Reviewer | Rollout req. | Remaining gate | Next step |
|---|---|---|---|---|---|---|---|---|---|---|
| P0 | CODE_REVIEW | **Historical (superseded, do not cite as current evidence):** PR #36, `claude/eloquent-mccarthy-m8m5cj` @ `bf9085863f7f55867dd00460031f847d9e993baf` — run `#594` (`35805773505`) on that exact head: lint/typecheck/test/audit/pgtap/e2e/build all `success`; `deploy`/live-migration jobs `skipped`. That run applies only to `bf90858` and does not carry over to any corrected commit, since a docs change is still a change to the exact-head evidence this file requires. **Current candidate:** `claude/dsb-pro-p0-docs-pgnc2w`, head = whatever `git log -1 origin/claude/dsb-pro-p0-docs-pgnc2w` returns at review time (the corrections landed in commit `2afcff9` and this row's own update commits after it, so do not hardcode a SHA here that this edit would immediately make stale). | none | n/a (docs only) | **none yet** — no CI run has been recorded against the corrected candidate branch/head; PR #36's run #594 does NOT qualify for it | **none** — two-green-runs-on-unchanged-head is NOT satisfied for the current candidate | ChatGPT (PLANNER role, round 1 on `bf90858`: requested changes, since resolved on the new candidate; round 2 pending on the new head) | none | 1) open a PR from `claude/dsb-pro-p0-docs-pgnc2w` to `main`, 2) two full green CI runs on that PR's unchanged head, with run IDs recorded here, 3) PLANNER round-2 review of that exact head, 4) user authorization to accept | Push this ledger/handover correction, open draft PR to `main`, get two green runs on the final head, return SHA + PR number + run links to PLANNER |
| P1 | NOT_STARTED | — | `0044 / upgrade_receipts` | — | — | — | — | none (staging proof only) | P0 ACCEPTED | Start on Sonnet 5 |
| P2 | NOT_STARTED | — | `0045 / item_sales_fix` | — | — | — | — | none | P1 ACCEPTED | Sonnet 5 |
| C0a | NOT_STARTED | — | `0046 / finance_requests` | — | — | — | — | none (additive) | P2 ACCEPTED | Sonnet 5 |
| C0b | NOT_STARTED | — | `0047 / finance_locking` | — | — | — | — | §3.4 benchmark: p95 `post_sale` @ 20 concurrent sessions, ≤15% regression vs pre-C0b baseline | C0a ACCEPTED + benchmark pass | **Switch to Opus** before starting (locking/concurrency design) |
| C1 | NOT_STARTED | — | `0048 / supplier_payments` | — | — | — | — | none | C0b ACCEPTED | **Opus** (allocation-validator trigger surgery) |
| C2 | NOT_STARTED | — | none | — | — | — | — | none | C1 ACCEPTED | Sonnet 5 |
| C3 | NOT_STARTED | — | `0049 / customer_requests` | — | — | — | — | none | C2 ACCEPTED | **Opus** (legacy-compatibility judgment) |
| D1 | NOT_STARTED | — | `0050 / reports_v2` | — | — | — | — | none | C3 ACCEPTED | Sonnet 5 |
| D2 | NOT_STARTED | — | `0051 / settings_v2` | — | — | — | — | none | D1 ACCEPTED | Sonnet 5 |
| D3 | NOT_STARTED | — | `0052 / export_v5` | — | — | — | — | none | D2 ACCEPTED | Sonnet 5 |
| D4 | NOT_STARTED | — | `0053 / health_v2` | — | — | — | — | none | D3 ACCEPTED | Sonnet 5 |
| E0 | NOT_STARTED | — | none | — | — | — | — | none | C2 ACCEPTED, D4 ACCEPTED | Sonnet 5 |
| E1 | NOT_STARTED | — | none | — | — | — | — | none | D4, E0 ACCEPTED | Sonnet 5 |
| E2 | NOT_STARTED | — | none | — | — | — | — | none | E1 ACCEPTED | Sonnet 5 |
| E3 | NOT_STARTED | — | none | — | — | — | — | none | E2 ACCEPTED | Sonnet 5 |
| F0 | NOT_STARTED | — | none | — | — | — | — | none | can start after P0 ACCEPTED | Sonnet 5 |
| F1 | NOT_STARTED | — | `0054 / numbering_v2` | — | — | — | — | none | E3 ACCEPTED | **Opus** (import/fiscal-year edge cases) |
| F2 | NOT_STARTED | — | `0055 / opening_accounts` | — | — | — | — | none | F1 ACCEPTED | **Opus** |
| F3 | NOT_STARTED | — | `0056 / cutover_import` | — | — | — | — | none | F2 ACCEPTED; mapping needs F0 | **Opus** |
| F4 | NOT_STARTED | — | none | — | — | — | — | H1–H5 rehearsal evidence | F3 ACCEPTED | — |
| L/H | HUMAN_PENDING | n/a | none | n/a | n/a | n/a | n/a | H1–H9, see below | exact release passing | user-attended only |
| F5 | NOT_STARTED | — | none | — | — | — | — | F4 + H gates | F4 ACCEPTED + H gates | — |
| G0 | NOT_STARTED | — | `0057 / storefront_config` | — | — | — | — | none | F5 own-shop acceptance | — |
| G1 | NOT_STARTED | — | none | — | — | — | — | none | G0 ACCEPTED | — |
| G2 | NOT_STARTED | — | `0058 / orders_v1` | — | — | — | — | none | G1 ACCEPTED | — |
| G3 | NOT_STARTED | — | `0059 / order_fulfillment` | — | — | — | — | none | G2 ACCEPTED | — |
| G4 | NOT_STARTED | — | none | — | — | — | — | none | G3 ACCEPTED | — |
| G5 | NOT_STARTED | — | operator `0001 / deployment_health` | — | — | — | — | none | G4 ACCEPTED | — |
| G6 | NOT_STARTED | — | none | — | — | — | — | none | G5 ACCEPTED | — |
| S0 | NOT_STARTED | — | none | — | — | — | — | none | G6 ACCEPTED + paying shop decision | — |
| S1 | NOT_STARTED | — | `0060 / saas_access` | — | — | — | — | none | S0 ACCEPTED | — |
| S2 | NOT_STARTED | — | `0061 / saas_billing` | — | — | — | — | none | S1 ACCEPTED | — |
| S3 | NOT_STARTED | — | none | — | — | — | — | none | S2 ACCEPTED | — |
| S4 | NOT_STARTED | — | none | — | — | — | — | H-gate style rehearsal/trial | S3 ACCEPTED | — |

## Human evidence gates (H1–H9)

Per plan §20.2. All recorded `PENDING` — no fabricated or remembered evidence is entered here;
each moves to done only when a specific run's real evidence is attached.

| Gate | Evidence required | Status |
|---|---|---|
| H1 | One week real purchases/payments on rehearsal deployment; physical stock and supplier balances compared | PENDING |
| H2 | One full shop day: every payment mode, expenses, returns, customer/supplier balances, stock and close reconciled | PENDING |
| H3 | Actual shop device offline/restart/network loss and recovery, no lost/duplicate entry | PENDING |
| H4 | Hosted restore + portable Postgres restore, auth recovered from paper key, RPO≤24h/RTO≤2h measured | PENDING |
| H5 | Printer receipt readable at actual width; business identity/GST profile validated for shop use | PENDING |
| H6 | Final legacy diff accepted; cutover freeze/authority switch signed | PENDING |
| H7 | 30-day own-shop observation, zero app-caused corrections and required backups/fallbacks | PENDING |
| H8 | First friend deployment, private data isolation and its own backup/restore | PENDING |
| H9 | Paying external shop 14-day trial without operator data edits | PENDING |

## Merged/closed baseline (pre-P0, for reference — not tracked as packets above)

| Item | State | Head SHA | Evidence |
|---|---|---|---|
| Batch A | ACCEPTED | (prior, see `docs/HANDOVER.md`) | merged to `main` |
| Batch B | ACCEPTED | (prior, see `docs/HANDOVER.md`) | merged to `main` |
| PR #35 (held-cart-label hotfix) | ACCEPTED | `2b8a6dfde52d97f100a0d2652a7c9bac9b9485a6` (squash-merged as `74768c11b327d7920daf0570a301966a853fc7b6`) | Post-merge push run `#589` (`35804537359`) on `main`: lint/typecheck/test/audit/pgtap/`phase6_db_upgrade_proof`/e2e all `success`; `deploy` and every live-migration job `skipped` |

## Maintenance rule

Update this file's packet row at every state transition, in the same PR/commit that causes the
transition where possible. Never mark `ACCEPTED` without both CI run IDs recorded and an
independent reviewer name. Never mark an H-gate done without a specific evidence reference (a
handover entry, a linked artifact, a dated observation) — a plan citing this file as satisfied is
itself not evidence.
