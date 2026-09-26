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
| P1 | CODE_REVIEW | PR #38, `claude/dsb-pro-peer-protocol-kzokxq` @ `857b161` | `0044 / upgrade_receipts` | `remaining_p1_upgrade_receipts.sql` (11 pgTAP assertions) + 6 live CI proof-matrix scenarios + 5 extracted-function probes for the schema-exists guard | none yet on `857b161` | none yet on `857b161` | GPT (rounds 1-6; each round's failure independently reproduced by the builder before fixing — 6 real bugs/design-risks found and fixed: unconditional receipt INSERT breaking legacy groups, a checksum-shape completeness gap, a bootstrap classifier circularity fixed at its root cause, a connection-string leak, a normal-apply silent-backfill integrity risk, and a severe over-broad refusal that would have permanently blocked every future migration's first-time apply after P1 merged — caught by GPT via direct extracted-function probe before it reached CI) | none (staging proof only) | two green CI runs on the unchanged head `857b161` + GPT sign-off, given user's explicit convergence decision below. Note: an earlier row here misattributed CI run `36260084321` to `7f24248`; it actually belongs to `70b870d` -- corrected per GPT's catch, real run for `7f24248` was `36260638385` | **User decision (2026-09-26): converge now, do not keep iterating.** After 5 review rounds each finding and fixing real bugs, user chose "merge with tracked follow-ups" over "keep iterating until every finding closes." Deferred as explicit follow-up work (not silently dropped, not claimed done): (1) full 11-scenario live proof matrix — 6 of 11 now covered by CI, remainder needs a second disposable Postgres target this session doesn't have; (2) registry-driven CI orchestration for future packet groups (each new group still needs a hardcoded CI step, same pattern already used for foundation..batchb); (3) legacy groups (0030-0043) replay their SQL on rerun rather than becoming verified no-ops like p1 does; (4) bootstrap target identity is verified by caller flags only, not a stronger disposable-target assertion; (5) attended legacy-baseline receipt initialization for an existing live schema without receipts is unbuilt; (6) `packages/db/src/types.ts` not regenerated (pre-existing gap since 2026-09-10, confirmed via `git log`, not a P1 regression) — no Supabase CLI available in this sandbox to regenerate it; (7) a compact per-packet human/launch-readiness reference beyond the existing H1-H9 table. Whoever builds C0a next (or a dedicated P1-follow-up packet) should read this row before assuming P1 is fully closed. |
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

## Maintenance rule

Update this file's packet row at every state transition, in the same PR/commit that causes the
transition where possible. Never mark `ACCEPTED` without both CI run IDs recorded and an
independent reviewer name. Never mark an H-gate done without a specific evidence reference (a
handover entry, a linked artifact, a dated observation) — a plan citing this file as satisfied is
itself not evidence.
