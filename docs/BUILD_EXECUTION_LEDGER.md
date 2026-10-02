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
| P1 | ACCEPTED (MERGED) | PR #38, `claude/dsb-pro-peer-protocol-kzokxq` @ `c243128` | `0044 / upgrade_receipts` | `remaining_p1_upgrade_receipts.sql` (11 pgTAP assertions) + 6 live CI proof-matrix scenarios + 5 extracted-function probes for the schema-exists guard | `36262018417` (`pull_request`, success) | `36262539113` (`workflow_dispatch operation=validate`, success) — both on unchanged head `c2431280dcf32b6fea68dfa165ed732ccf5bce2a`, posted in PR #38's discussion | GPT (rounds 1-7; 6 real bugs/design-risks found and fixed, each independently reproduced by the builder before fixing; **PEER_APPROVED, conditional**, at this exact SHA, for the user-requested reduced-scope merge — 4 conditions recorded in the PR #38 comment thread: don't declare full P1 spec complete; Claude owns the follow-up list below; complete/verify that foundation before dependent-packet acceptance; two green runs + user merge authorization required) | none (staging proof only) | none — satisfied; squash-merged to `main` as `81ac0d11f7247e5231a808b5f5e026028ae273d3` | **User decision (2026-09-26): converge now, do not keep iterating**, directly confirmed by the user (asked to state it for verbatim relay to GPT; replied "Proceed"). After 7 review rounds finding and fixing 6 real bugs, deferred as explicit follow-up work (not silently dropped, not claimed done): (1) full 11-scenario live proof matrix — 6 of 11 now covered by CI, remainder needs a second disposable Postgres target this session doesn't have; (2) registry-driven CI orchestration for future packet groups; (3) legacy groups (0030-0043) replay SQL on rerun rather than becoming verified no-ops like p1; (4) bootstrap target identity verified by caller flags only; (5) attended legacy-baseline receipt initialization for a live schema without receipts is unbuilt; (6) `packages/db/src/types.ts` not regenerated (pre-existing gap since 2026-09-10, not a P1 regression, no Supabase CLI here); (7) compact per-packet human/launch-readiness reference beyond H1-H9. Whoever builds C0a next should read this row first. (Correction: an earlier version of this row misattributed CI run `36260084321` to `7f24248`; it belongs to `70b870d` — real run for `7f24248` was `36260638385`, per GPT's catch.) |
| P2 | ACCEPTED (MERGED) | PR #41, `claude/loving-lovelace-co7jut` @ `12a9b38` | `0045 / item_sales_fix` (+ index `sale_invoice_items_sale_invoice_idx`) | `remaining_p2_item_sales_fix.sql` (22 pgTAP; 9 fail on the 0040 body) + CI disposable P2 proof (apply, receipt, no-op rerun, checksum tamper refusal) | `36649747594` (`pull_request`, success) | `36649746437` (`workflow_dispatch operation=validate`, success) — both on unchanged head `12a9b382da12ac755fdc2a9e688dd76d00a955d5` | fresh sub-agent review (0 BLOCKER/MAJOR) + Codex review (2 findings fixed) + GPT V001 (VF-002 fixed in PR #42) | applied live 2026-09-30 by run `36650456557` together with pending 0036–0044, after encrypted B2+R2 backup `phase6-pre-ledgers-reports-c03e7c6….pgcustom.age` | none — squash-merged to `main` as `c03e7c643b191993288e874aaa5c8460a51d3a42` | Follow-up PR #42 (VF-001/002/004). Includes undici `^7.29.1` override. |
| C0 (C0a+C0b, v2.0) | MERGED + LIVE (ed04da7; live apply run 36796971685; deploy 36796983942) | `claude/loving-lovelace-co7jut` | `0046 / finance_requests_and_locking` (group `c0`) | `remaining_c0_finance_requests_locking.sql` (61 pgTAP) + `scripts/test-finance-lock-concurrency.mjs` (5-session no-double-allocation; same-shop serialized, other shop unblocked) + CI disposable C0 proof (apply, receipt, wrapper contract, no-op, tamper) | pending | pending (`workflow_dispatch operation=validate`) | fresh sub-agent review: 0 BLOCKER; 1 MAJOR fixed (void_purchase retry of already-VOID bill); MINORs noted in STATE | live apply of group `c0` — needs user approval | CI green + user `merge` | Benchmark dropped per v2.0 (re-evaluate at S1). |
| C1 | MERGED + LIVE (e1d5f58, PR #44; apply run 36801167492; deploy 36801959224) | `claude/loving-lovelace-co7jut` | `0047 / supplier_payments` (group `c1`) | `remaining_c1_supplier_payments.sql` (53 pgTAP, C01–C26, C31–C32) + `scripts/test-supplier-payment-concurrency.mjs` (C27–C30) + CI disposable C1 proof (apply, receipt, writer contract, no-op, tamper) | pending | pending (`workflow_dispatch operation=validate`) | fresh sub-agent review: 0 BLOCKER, 0 MAJOR; MINOR 1 fixed (release reconciliation status); MINORs 2–5 in STATE | live apply of group `c1` — needs user approval | CI green + user `merge` | Opus |
| C2 | MERGED + LIVE (dd37ae5, PR #45; apply run 36804657756; deploy 36805399708) | `claude/loving-lovelace-co7jut` | `0048 / supplier_ledger_fix` (group `c2`) | `financialAttempts.test.ts` (8) + `supplierPayments.test.ts` (7) + `remaining_c2_supplier_ledger_fix.sql` (5 pgTAP) + `e2e/suppliers.spec.ts` (3: lifecycle, lost response after commit, offline before dispatch) + CI disposable C2 proof | pending | pending (`workflow_dispatch operation=validate`) | fresh sub-agent review: 0 BLOCKER; 2 MAJOR fixed (PAYLOAD_MISMATCH never a rejection; shop attribution resolved by it); MINORs fixed (cross-tab finalize, draft reset) | live apply of group `c2` — needs user approval | CI green + user `merge` | Sonnet |
| C3 | MERGED + LIVE (5e3d518, PR #46; apply run 36843143208; deploy dispatched 2026-10-01) | `claude/loving-lovelace-co7jut` | `0049 / customer_requests` (group `c3`) | `remaining_c3_customer_requests.sql` (34 pgTAP; golden 0020/0021 unchanged) + adapter test + `e2e/customers.spec.ts` lost-response case + CI disposable C3 proof | pending | pending (`workflow_dispatch operation=validate`) | fresh sub-agent review: 0 BLOCKER; 2 MAJOR fixed (legacy retry resolved before validation; only the call's own :alloc: rows compared) | live apply of group `c3` — needs user approval | CI green + user `merge` | Opus; C3b (direct-caller wrappers, outbox UNKNOWN) follows |
| C3b | MERGED + LIVE (a0437e0, PR #47; apply run 36846504793) | `claude/loving-lovelace-co7jut` | `0050 / purchase_retry_verification` (group `c3b`) | `remaining_c3b_purchase_retry.sql` (11 pgTAP) + `e2e/purchases.spec.ts` lost-response + reload case + CI disposable C3b proof | pending | pending (`workflow_dispatch operation=validate`) | fresh sub-agent review: 0 BLOCKER; 1 MAJOR fixed (unit_level default in retry compare); MINORs fixed (qty precision, perm-before-lock, frozen request survives reload) | live apply of group `c3b` — needs user approval | CI green + user `merge` | Opus |
| U1 | MERGED + LIVE (7020cc5, PR #48; deployed) | `claude/loving-lovelace-co7jut` | none | `e2e/daily-entry.spec.ts` (4) + core discount-parity test (3) | pending | n/a (UI packet: one green full run) | fresh sub-agent review: 0 BLOCKER; 3 MAJOR fixed (frozen retry for stock count/expense; recount/already-posted handling); MINOR fixed (stock-adjust link owner/manager only) | none | CI green + user `merge` | Sonnet |
| R0 | MERGED + LIVE (609de41, PR #49; apply run 36882980791) | `claude/loving-lovelace-co7jut` | `0051 / bill_round_off` (group `r0`) | `remaining_r0_bill_round_off.sql` (21 pgTAP) + core billRoundOff tests (8) + sync opt-in test + `e2e/pos.spec.ts` round-off case + CI disposable R0 proof | run 689 green | run 690 green | fresh sub-agent review: 0 BLOCKER; 1 MAJOR = rollout order (apply r0 before deploy, recorded); MINORs fixed (ack carries round-off, receipts show it, negative guard, GUC/immutability tests) | live apply of group `r0` BEFORE deploy — needs user approval | CI green + user `merge` | Opus |
| D1-lite | MERGED + LIVE (3e04068, PR #50; apply run 36894777286, deploy 36897126086) | `claude/loving-lovelace-co7jut` | `0052 / aging_as_of` (group `d1`) | `remaining_d1_aging_as_of.sql` (33 pgTAP: as-of allocation, returns/refunds, voids, stranded allocation, bridge, shop isolation, guards) + `e2e/reports.spec.ts` PostgREST calls + CI disposable D1 proof | run 697 green | run 698 green | fresh sub-agent review: 0 BLOCKER; 2 MAJOR fixed (cash not tied to the as-of document set broke the bridge; returns/refunds attributed by row customer instead of invoice customer); MINOR fixed (net formula hint in UI) | live apply of group `d1` — needs user approval | CI green + user `merge` | Opus |
| V2 (VF-005–008) | MERGED (04df545, PR #51; deploy 36901510335) | `claude/loving-lovelace-co7jut` | — (no migration) | `e2e/recovery.spec.ts` (7 commit-then-crash/502/storage-refusal/account-switch/two-window cases on the real local DB) + `outcomes.test.ts` (17) + `pendingIntent.test.ts` (4) + errors transport tests | run 704 green | not required (no migration) | fresh sub-agent review: 0 BLOCKER; 2 MAJOR fixed (two windows shared one intent slot; a refused RETRY unlocked without proof — now verified by client-id lookup, access refusals stay unknown); 1 MAJOR recorded as MINOR residual (cross-tab receipt race, attempts stay durable); MINORs fixed (load-failure retry hint, frozen stock date) | none (deploy only) | CI green + user `merge` | Opus |
| R1 | MERGED (a6cd057, PR #52) | `claude/loving-lovelace-co7jut` | — (no migration) | `e2e/compare.spec.ts` (day totals, supplier balance, stock, CSV content) + `csv.test.ts` (formula neutralization, exact decimals) | run 708 green | not required (no migration) | fresh sub-agent review: 0 BLOCKER; 2 MAJOR fixed (figures shown under an unloaded date; out-of-order loads); MINORs fixed (no-row note, role gate, stock file named "now", TOTAL row in CSV); kept: text cells starting with -, +, = get an apostrophe (CSV injection safety) | deploy only | CI green + user `merge` | Opus |
| V3 (cross-window receipt lock) | MERGED + LIVE (57413c3, PR #53; deploy 36909385797) | `claude/loving-lovelace-co7jut` | — (no migration) | `accountLock.test.ts` (serialization) + `e2e/recovery.spec.ts` two-window receipt case | run 713 green | not required | self-review (small, local) | deploy only | CI green + user `merge` | Opus |
| R0b | MERGED (9221177, PR #54; applied live run 721, deployed 724) | `claude/loving-lovelace-co7jut` | `0053 / return_round_off` (group `r0b`) | `remaining_r0b_return_round_off.sql` (20 pgTAP: walk-in/credit/round-up full returns, partial then completing, bigger line first capped, void then re-complete, immutability, invariants) + CI disposable R0b proof | run 718 green | run 719 green | fresh sub-agent review: 1 MAJOR fixed (bigger line returned first could exceed the bill and make the completing return negative, blocking the last item — returns on rounded bills now capped at what remains); MINORs noted (item-level reports sum line values by design) | applied | CI green + user `merge` | Opus |
| V4 (VF-007 follow-up, VF-009) | MERGED (842a8c4, PR #55) | `claude/loving-lovelace-co7jut` | — (no migration) | `e2e/recovery.spec.ts` two-intent drain + customer switch during receipt (fails on old screen, passes now) + no-supplier purchase same-window retry + `pendingIntent.test.ts` retry semantics | green | not required | fresh sub-agent review: 1 BLOCKER fixed (in-memory undefined fields made a no-supplier purchase retry mismatch its stored copy forever); MINORs fixed (message when another purchase is locked in; effect uses selectedRef) | deploy only | CI green + user `merge` | Opus |
| O1 opening balances | MERGED (8b68b15, PR #56) | `claude/loving-lovelace-co7jut` | `0054 / account_openings` (group `o1`) | `remaining_o1_account_openings.sql` (28 pgTAP: RLS, owner only, idempotent retry, mismatch, one active per account, future date, void then re-enter, ledgers, supplier outstanding, as-of aging, invariants) + `e2e/openings.spec.ts` (record → Compare balance → void → re-enter) | run 732 green | run 731 green | fresh sub-agent review: 0 BLOCKER; 1 MAJOR fixed (screen did not pick up another window's stored opening after finishing its own); MINORs fixed (rejection message points to the list; voided same-id replay reported; deleted_at filters added except in get_party_ledger_v2 where the C2 test bans the word) | applied live run 734 (only o1), deployed 735 | CI green + user `merge` | Opus |
| O2 opening settlements | MERGED (9475aa4, PR #57) | `claude/loving-lovelace-co7jut` | `0055 / opening_settlements` (group `o2`) | `remaining_o2_opening_settlements.sql` (30 pgTAP: settle, replay, mismatch, over-payment, over-opening, wrong account, as-of reports, voids, payment void cascade, immutability, RLS, bill allocation cannot reuse settled cash) + `e2e/openings.spec.ts` settle step | run 738 green | run 739 green | fresh sub-agent review: 0 BLOCKER; 1 MAJOR fixed (check_invariants now counts settlements per payment and checks every settlement); MINORs fixed (replay of a voided settlement raises DSB_SETTLEMENT_VOIDED; void checks auth); MINOR open: receipt/payment screens show pre-settlement unassigned amounts (trigger refuses definitively) | applied live run 740 (only o2); deploy with O3 | done | Opus |
| O3 settlement-aware supplier payments | MERGED (143c11e, PR #58) | `claude/loving-lovelace-co7jut` | — (no migration) | `e2e/openings.spec.ts`: after settling, supplier payment history shows ₹0.00 left | run 743 green | not required | fresh sub-agent review: 0 BLOCKER/MAJOR; MINOR fixed (column renamed Assigned); MINOR noted (settlement read needs POST_PURCHASES or VIEW_REPORTS, same roles that allocate) | deployed with O2 | CI green (user pre-approved merge/deploy 2026-10-02) | Opus |
| D2a receipt header | MERGED (50b77ab, PR #59) | `claude/loving-lovelace-co7jut` | — (no migration) | `e2e/offline-sync.spec.ts`: offline provisional receipt names the shop from the cached profile | run 747 green | not required | fresh sub-agent review: 0 BLOCKER/MAJOR; MINORs fixed (timer cleared, empty shop id guarded); MINORs noted (profile cache stays after sign-out — semi-public shop details; POS printed within 5 s of opening with no cache shows the honest "incomplete" header; no 58mm print test) | deploy only | CI green (user pre-approved 2026-10-02) | Opus |
| D2b shop settings guard | IN REVIEW | `claude/loving-lovelace-co7jut` | `0056 / shop_settings_guard` (group `d2b`) | `remaining_d2b_shop_settings.sql` (12 pgTAP: unknown timezone, legacy timezone still saves, no partial update, fiscal month frozen, owner-only negative stock, manager profile edit, trim) + `0029` manager case updated to the new contract + `e2e/settings.spec.ts` fiscal month disabled | pending | pending | fresh sub-agent review: 0 BLOCKER; 1 MAJOR fixed (timezone validated only when it changes, so a shop holding a legacy free-text timezone can still save; test added); MINORs noted (owner toggle briefly disabled while role loads) | live apply of group `d2b` (pre-approved) | CI green (user pre-approved 2026-10-02) | Opus |
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

## Process change 2026-09-29 (SINGLE_BUILDER_PLAN v2.0)
P1 is MERGED as `81ac0d1` (PR #38, squash). Dual-builder protocol retired; packet order and CI policy now per
`docs/SINGLE_BUILDER_PLAN.md`. Current status lives in `docs/STATE.md`. M0 Hygiene row: see PR for this change.
