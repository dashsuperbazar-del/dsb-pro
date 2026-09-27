# Build Execution Ledger

Packet-state tracker for `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1, per that plan's §4.1 and
§0.4 execution protocol. States: `NOT_STARTED` / `IN_PROGRESS` / `CODE_REVIEW` / `CI_PASSED` /
`HUMAN_PENDING` / `ACCEPTED` / `BLOCKED`. `ACCEPTED` is this file's terminal state and is the same
event the dual-builder peer protocol's own gate language (§9) calls "MERGED" -- both terms describe
the same thing (code merged to `main`, CI-proven, peer-reviewed); a row may show either or both. No
row is marked `ACCEPTED` without the two-green-runs-
on-unchanged-head evidence this file requires; no evidence is recorded here without an actual run
ID/URL to back it — an unverified claim is not entered.

**Recording sequence for the two-green-runs gate:** while a packet's evidence is still being
collected, its two final-head CI run IDs are posted in that packet's PR discussion, not committed
to this file — committing them here would itself be a new commit, producing a new head and
invalidating the "unchanged head" the two runs were supposed to prove. Only once a head has its
two green runs and independent review does a follow-up commit (part of the acceptance step, not
part of freezing the head) copy those run IDs into this table's `CI run 1`/`CI run 2` columns.

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
| P0 | ACCEPTED (MERGED) | Squash-merged to `main` at `ed678512b257002bb31fc42c60ef9a91ebfbccfc` (was PR #37, `claude/dsb-pro-p0-docs-pgnc2w` @ frozen head `22a58b04fa6d5d9dd096d1d0edb3cc2d1725c269`) | none | n/a (docs only) | `36232843034` (`pull_request`, success) | `36233177164` (`workflow_dispatch operation=validate`, success) — both on the exact frozen head `22a58b04f`, verified directly against `get_check_runs`, not merely cited | GPT (PLANNER role): round 1 on `bf90858` requested changes, resolved on the corrected candidate; round 2 APPROVE @ `22a58b04fa6d5d9dd096d1d0edb3cc2d1725c269` relayed and cross-checked against live CI before merge | none | none — gate satisfied | Historical PR #36 (superseded) and stale PR #24 closed by user authorization same session. Next: P1 build in Lane A (Claude); Packet 0.5 dependency graph sent to GPT for round-1 debate, not yet recorded here. |
| P1 | ACCEPTED (MERGED) | Squash-merged to `main` at `81ac0d11f7247e5231a808b5f5e026028ae273d3` (was PR #38, `claude/dsb-pro-peer-protocol-kzokxq` @ frozen/re-verified head `c92069474a785936560b4a787e1d68d0de98013d`) | `0044 / upgrade_receipts` | `remaining_p1_upgrade_receipts.sql` (11 pgTAP assertions) + 6 live CI proof-matrix scenarios + 5 extracted-function probes for the schema-exists guard | `36262018417` (`pull_request`, success, head `c243128`) | `36262539113` (`workflow_dispatch operation=validate`, success, head `c243128`) — plus a third confirmatory run `36263106941` (`pull_request`, success) on the actual final merged head `c920694`, triggered when the PR was marked ready-for-review | GPT (rounds 1-7; 6 real bugs/design-risks found and fixed, each independently reproduced by the builder before fixing; **PEER_APPROVED, conditional**, for the user-requested reduced-scope merge — 4 conditions: don't declare full P1 spec complete; Claude owns the follow-up list below; complete/verify that foundation before dependent-packet acceptance; two green runs + user merge authorization, both satisfied) | none (staging proof only) | **P1-FOLLOWUP packet** must close/test the 7 items below before C0a (or any dependent migration packet) is accepted — C0a may be *coded* per the reconciled Packet 0.5 graph, but its acceptance is blocked on this row per GPT's condition 3 | **Reduced scope, ACCEPTED by user decision (2026-09-26, directly confirmed: "Proceed")** after 7 review rounds finding and fixing 6 real bugs. Deferred as explicit follow-up work, now the P1-FOLLOWUP packet's scope, not silently dropped: (1) full 11-scenario live proof matrix — 6 of 11 covered by CI in P1 itself; (2) registry-driven CI orchestration for future packet groups; (3) legacy groups (0030-0043) replay SQL on rerun rather than becoming verified no-ops like p1; (4) bootstrap target identity verified by caller flags only, needs strengthening; (5) attended legacy-baseline receipt initialization for a live schema without receipts is unbuilt (disposable-target-only for now, never live); (6) `packages/db/src/types.ts` not regenerated (pre-existing gap since 2026-09-10, not a P1 regression); (7) compact per-packet human/launch-readiness reference beyond H1-H9. GPT's follow-up brief also requires: every item gets an explicit test and disposition, not just documentation. |
| P1-FOLLOWUP | CODE_REVIEW | PR #39, `p1-followup` (branch), round-2 fixes pushed | none (no new migration; disposable-target-only proof/tooling work) | none yet | none yet | GPT round 1: REQUEST_CHANGES on 7 findings, 2 were real bugs (an import-time side-effect crashing the new CI probe; a flawed rollback demonstration that never invoked the runner and would report success even if its intended failure didn't occur), both independently reproduced and fixed; round-2 disposition below | none | scope: the 7 items from P1's row above | **Per-item disposition, corrected after GPT round-1 review** (this session discovered a real local PostgreSQL 16 install with no Docker needed for the server — enabled genuine live-DB proof for most items): (1) **NOT "full matrix CLOSED" as first claimed — corrected to an explicit 11-scenario mapping**: (a) empty reset — CI, existing. (b) baseline Phase 5 — CI, existing. (c) every legacy prefix — CI, existing. (d) each new packet prefix (p1) — CI, existing. (e) rerun-completed-group-is-no-op — CI, both legacy (NEW this packet) and p1 (existing) paths proved. (f) **partial group — still NOT separately proven** (p1 has only one file; no sub-group partial state to construct; unchanged gap, honestly still open). (g) out-of-order object — NEW, proved (drop-a-function/restore against live DB; same underlying mechanism as partial-schema, which is what this scenario actually is). (h) changed historical checksum — CI, existing. (i) **deliberately missing required grant — still NOT proven**: the existing/new CI tests a STRAY grant (excess access), which is a different scenario from a MISSING required grant (e.g. backup_ro losing its SELECT) — GPT's exact point, and it was right; this is a genuine, distinct, still-open gap, not covered by relabeling the stray-grant test. (j) failure-halfway-rolls-back-schema-and-receipt — **fixed and reproven for real** after GPT's round-1 finding that the original `do $$ ... exception when others ...$$` SQL block never invoked the runner, inserted no receipt, and would report success even if its own intended duplicate-key failure never happened (its WHEN OTHERS also caught its own RAISE EXCEPTION). Replaced with a genuine integration test: extracted `applyGroupEntries()` from `main()` so it's directly callable, fed it synthetic non-frozen entries (version 9998/9999, a real division-by-zero forcing failure on the second statement after the first succeeds), and proved both the schema change AND the receipt roll back together. (k) rollback-then-successful-retry — same test as (j), second half. **Round-2 update (GPT review of `037f1dc`):** (g) out-of-order now has its own distinct CI fixture (`phase6_db_upgrade_proof` → staged step: a Batch B object created while Batch A is absent; classifier refuses `0/2 Batch A, 1/3 Batch B`, runner refuses to apply Batch A over it) — no longer relabeled partial-schema, which keeps its own drop-a-function fixture. (i) missing required grant now covered twice: classifier refuses `backup_ro` lacking SELECT (`phase6_db_upgrade_proof` → P1 step) and the exact schema verifier refuses it (`pgtap` → `scripts/test-receipts-schema-verifier.mjs`). **Honest count: 10 of 11 covered with executable tests; (f) partial-group still open** (needs a target where only some of a multi-file group's files were applied, which the per-group-transactional runner cannot itself produce and which one shared disposable target cannot be rolled back from).
(2) registry-driven CI orchestration — still NOT closed, unchanged, honestly disclosed.
(3) legacy rerun as verified no-op — **scope corrected after a real test disproved the first version's premise**: originally scoped only to `foundation`/`phase65` on the theory that `hardening`/`batcha`/`batchb` were safe to blindly replay (all `create or replace function`) and would even self-heal a changed function body. Directly rerunning `hardening` against a fully-applied database failed ("already exists") — 0035 contains `alter function ... rename to phase6_export_tenant_v3_base`, non-idempotent like a plain create table. A broader grep found the same pattern (renames, unconditional drops/inserts) in every one of the five legacy groups. There was no real self-healing being traded away — blind replay was never going to survive far enough to reach a "healing" step. Reverted to applying the shortcut uniformly to all five legacy groups (still excluding p1, whose per-entry checksum check is strictly more precise and must not be bypassed). **Remaining honest limitation** (GPT's underlying point, which survives this correction): neither blind replay nor this shortcut re-verifies that a group's *definitions* still match the migration files — only the classifier's own per-group signals do, and their depth varies (batcha/batchb's signals already regex-match function-body content; foundation/hardening/phase65's are mostly existence-only). That is the classifier's own pre-existing design, not something this shortcut could itself close, and is not claimed closed here.
(4) bootstrap target identity — **claim softened, not "CLOSED" as an identity guarantee**: `isLocalHost()` (real host check) and a live tenant/shop-data-emptiness check are real, proved safety layers, but GPT is right that a loopback address can still be a forwarded tunnel and an empty database can still be a real one that simply hasn't been used yet — neither check "establishes identity." A real guarantee needs a harness-issued, verifiable marker, which is not built. Documented as an open limitation in the code itself, not claimed solved.
(5) attended baseline-receipt initialization — **strengthened after GPT's finding that shape/RLS/grant-existence checks don't validate types, nullability, defaults, constraints, or effective privileges**: replaced the shallow check with exact column-level comparison (type/nullable/default per column against 0044's actual definition), real CHECK-constraint-definition comparison (not just name), an effective-privilege check via `has_table_privilege()` (catches role-membership-based access a grants-table check would miss), and a `backup_ro` coverage check. Proved: correct schema still succeeds; a nullability drift (`applied_by` made nullable) is now caught where the old check would have missed it; an indirect anon-membership grant is caught. Still disposable-only per this round's explicit constraint.
(6) database types — unchanged from round 1: genuinely Docker-blocked (confirmed directly), one table hand-added from the live schema, not full regeneration.
(7) compact per-packet readiness reference — **corrected**: fixed the CODE_REVIEW/IN_PROGRESS mismatch GPT flagged, and replaced generic "blocked on prior packet in chain" rows with the actual reconciled Packet 0.5 graph dependencies (C0a real dependency is P0 only; C0b needs C0a's lock helper; F1's real dependencies are C0b+C3+D2+D3, not the full E0-E3 chain the migration-fence ordering implies; etc.) instead of reverting to generic chain language.
Branched fresh from `main` @ `81ac0d1`. Preserves P1's reduced-scope acceptance; blocks C0a's *acceptance* (not its coding) until this row is itself accepted, per GPT's condition 3 on P1. Migration-number merge fence preserved: no new migration in this packet, 0046 (C0a) still must not merge ahead of 0045 (P2) |
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

## Packet 0.5 — reconciled dependency graph (recorded here per plan §4.1, in P1's PR)

Round-1/round-2 debate between Claude (Lane A: P1, C0a, C0b, C1, C3, F1, F2, F3) and GPT (Lane B: P2,
C2, D1-D4, E0-E3, F0, F4, F5, G0-G6, S0-S4), reconciled with no unresolved disagreement. §4's own
packet-schedule table is the conservative, migration-number-ordered chain; this section records the
real hard-code edges where they differ from that chain, per §4.1's instruction to derive the actual
graph rather than assume the ledger's serialization is the dependency graph.

1. **P1 and P2 overlap after this graph is approved**; 0044 still merges before 0045 (migration-number
   merge fence only, not a functional dependency — P1's upgrade-receipts table and P2's report-query
   fix touch disjoint code).
2. **C0a's real dependency is P0 only**, not P2 — additive schema (`financial_requests`,
   `effective_date`), touches nothing P2 changes.
3. **C0b hard-depends on C0a** (real): C0b's writer-wrappers call `dsb_lock_shop_finance`, defined in
   C0a. **C1 hard-depends on C0b** (real): supplier RPCs must acquire the same shop-finance lock C0b
   establishes.
4. **C3 hard-depends on C2** (confirmed, not just the ledger's stated chain): `packages/sync/src/db.ts`
   lines 30-46 show C2 owns Dexie schema version 5 and the durable-attempt state model; C3 must reuse
   that store and the existing outbox rather than build a second sender.
5. **E0 runs after C2, parallel with C3** — remove the ledger's D4 dependency for E0; no evidence i18n/
   error infra needs anything from the D-chain.
6. **F1's ledger prerequisite (E3) is a migration merge-fence, not a real dependency.** F1's real hard
   dependencies are C0b (lock discipline), C3 (request-aware posting wrappers), D2 (`document_profile_
   snapshots` is what F1 calls "profile/number snapshots"), and D3 (export/restore coverage must account
   for F1's new numbering-series state — "restore continuation"). F1 may build in parallel with E1-E3;
   it does not need the entire D1-D4/E0-E3 UI+i18n+rehearsal lane finished first. Separately, §3.4
   documents a real forward coupling: C0b/C1's lock-acquisition order already reserves a slot for "F1's
   issuer-registration lock" — meaning F1's lock contract must be designed before C0b/C1 ship, even
   though F1 itself is built much later.
7. **G1's `public_catalog` schema has no migration allocation in Appendix C1.** Its SQL foundation
   (projection/grants/RLS tests) moves into G0's `0057_storefront_configuration.sql`; G1 keeps API/
   cache/asset work and integration tests only.
8. **S3's support-ticket persistence has no baseline tables and no S3 migration.** That schema
   foundation and its operator-read policy move into S2's `0061_saas_billing.sql`; S3 implements the
   service/UI and isolation tests against it.
9. **No future-fixture cycles:** D3 proves currently-existing C/D sources only. F2, G2/G3 and S packets
   each extend export/restore/health proofs in their own packet; D3 never depends on schema that doesn't
   exist yet when D3 merges.
10. **Ledger gains three status dimensions, not one:** `codeState` (this table's existing State column),
    `humanEvidence` (H1-H9, unaffected by code state), `launchReadiness` (F5 own-shop acceptance, H7,
    friend/external-trial gates). A packet's row being `ACCEPTED` (code merged, CI green, reviewed) must
    never be read as "launched" or "cutover complete" — those require the human gates in the table above,
    independent of code state. This directly enforces the distinction plan §11/§13 (repository system
    prompt) already requires in prose.
11. **G/S coding-decoupling amendment (user decision, 2026-09-26, recorded here per §4.1):** G0-S4 coding
    may proceed once each packet's own code dependencies (per this graph, not H-gates) are merged, without
    waiting for H1-H6 or F5. G/S may use core money/stock/allocation logic only through its public RPCs
    and adapters, never by duplicating or bypassing it. After H1-H6 and F5, both builders re-run the full
    G/S suite and review every G/S money/stock path against any core change the shop trial caused; anything
    broken is fixed before launch. Launch itself stays gated — no storefront goes live and no external shop
    is onboarded until F5 own-shop acceptance and H7 pass. This covers coding only, never deployment. The
    S0 paying-shop decision remains the user's call before S1 begins.

Both builders approved this reconciled graph via relay; the user approved starting P1 under it. No
migration numbers were renumbered — Appendix C1's existing 0044-0061 sequence stands unless G1/S3's
moved schema work above requires updating those two migrations' own file contents (not their numbers)
when G0/S2 are actually built.

## Compact per-packet readiness reference (P1-FOLLOWUP item 7)

The Packet table above tracks `State` (codeState). The H1-H9 table tracks human evidence. Neither
alone answers "is packet X launch-ready" at a glance across all three dimensions, so this table adds
that view without duplicating either source. `codeState` mirrors the Packet table's `State` column
exactly (read that table for detail); `humanEvidence` is `n/a` for a packet with no H-gate dependency,
or lists the specific H-gate(s) that must pass first; `launchReadiness` is `blocked` until every
dependency in both other columns clears.

| Packet | codeState | humanEvidence | launchReadiness |
|---|---|---|---|
| P0 | ACCEPTED | n/a | n/a (docs only) |
| P1 | ACCEPTED (reduced scope) | n/a | blocked on P1-FOLLOWUP acceptance |
| P1-FOLLOWUP | CODE_REVIEW | n/a | blocked on this packet's own acceptance |
| P2 | NOT_STARTED | n/a | real dependency: P0 only (Packet 0.5 graph); migration merge-fence: 0044 before 0045 |
| C0a | NOT_STARTED | n/a | real dependency: P0 only (additive schema, touches nothing P2 changes); C0b needs C0a's `dsb_lock_shop_finance` |
| C0b | NOT_STARTED | n/a | real dependency: C0a (lock helper it wraps writers with) |
| C1 | NOT_STARTED | n/a | real dependency: C0b (lock discipline must exist first) |
| C2 | NOT_STARTED | n/a | real dependency: C1 |
| C3 | NOT_STARTED | n/a | real dependency: C0b hard; C2 (Dexie v5/attempt-store reuse, confirmed via `packages/sync/src/db.ts`) |
| D1-D4 | NOT_STARTED | n/a | D1 needs C0a's `effective_date`; D2-D4 chain sequentially after D1 |
| E0-E3 | NOT_STARTED | n/a | E0 needs C2 only (parallel with C3); E1-E3 chain after E0/D4 |
| F0 | NOT_STARTED | n/a (evidence-gathering only) | can start after P0 |
| F1 | NOT_STARTED | n/a | real dependency: C0b + C3 + D2 + D3 (restore continuation), NOT the full E0-E3 chain the ledger's migration-fence ordering implies |
| F2 | NOT_STARTED | n/a | real dependency: F1 + C1 (allocation/credit logic reuse) |
| F3-F4 | NOT_STARTED | n/a | real dependency: F2; F3's importer also needs F0's mapping |
| F5 | NOT_STARTED | H1-H6 | blocked on F4 + all of H1-H6 |
| G0-G6 | NOT_STARTED | n/a for coding (§13 decoupling); H7 for launch | coding unblocked once own dependencies merge; **launch blocked on F5 + H7** regardless of code state |
| S0-S4 | NOT_STARTED | H8 (S-adjacent friend deployment), H9 (paying external trial) | coding unblocked per §13; launch blocked on H8/H9 |

This table is a view, not a second source of truth — if it and the Packet table or the H1-H9 table
ever disagree, the more detailed source (Packet table for code state, H1-H9 table for human evidence)
wins, and this table should be corrected to match, not the other way around.

## Maintenance rule

Update this file's packet row at every state transition, in the same PR/commit that causes the
transition where possible. Never mark `ACCEPTED` without both CI run IDs recorded and an
independent reviewer name. Never mark an H-gate done without a specific evidence reference (a
handover entry, a linked artifact, a dated observation) — a plan citing this file as satisfied is
itself not evidence.
