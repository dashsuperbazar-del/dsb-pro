# DSB Pro — Complete Remaining Build Blueprint

**Version 1.1 · 23 September 2026 · prepared for Apd and the implementing/reviewing models**

**Status: reviewed implementation blueprint, not an implemented or production-tested release.** This document defines the remaining engineering work, contracts, decisions, acceptance tests and release evidence. Reference code in the appendices is identified separately from algorithms requiring implementation. It does not claim that unwritten migrations have passed CI. No plan can guarantee zero defects; the gates below are designed to catch them before production.

### Changelog since v1.0

Four corrections adopted after independent review, incorporated without reopening the underlying design:

1. **C0 split into C0a (additive, §6) and C0b (locking, §6a)**, each its own migration group and merge gate, so a lock-benchmark regression cannot force reverting the request ledger. Rollback is a forward migration restoring prior wrapper behaviour, never a reversal of financial schema (§3.4).
2. **§3.4 locking discipline** now states the benchmark workload, concurrency, and pass threshold before any testing occurs, and states explicitly that per-account locking is an unproven fallback candidate requiring its own cross-entity lock-order proof — not an already-demonstrated substitute.
3. **§B3's 475 reference-helper checks** are restricted to this document's own appendix verification. They satisfy no repository, packet, CI, or release gate; only tests executed in-repository on the exact candidate SHA count as packet evidence.
4. **Item-wise net sales fix hoisted to standalone packet P2 (§5a)**, run immediately after P1 instead of waiting behind the seven-packet supplier-payment chain, since it depends only on `phase65_sale_line_cap` (already in `0036`), not on any C0–C3 work.

Merge policy (main advances only by protected-PR squash merge, exact-head review, required CI) is left for the user to ratify in `CLAUDE.md`; this document does not change that file. `docs/REMAINING_BUILD_PLAN.md` (v1) is retained with a SUPERSEDED notice rather than deleted.

## Navigation

- [Baseline and execution rules](#0-read-this-before-doing-any-work)
- [Source register](#1-source-register-real-objects-and-files)
- [Decisions](#2-decisions-fixed-by-this-blueprint)
- [Architecture and invariants](#3-architecture-and-invariants)
- [Packet schedule](#4-packet-schedule-and-migration-allocation)
- [Financial foundation](#6-c0-financial-request-date-and-locking-foundations)
- [Supplier payments](#7-c1-supplier-payments-and-allocation-integrity)
- [Opening balances](#15-f2-opening-balances-and-settlement-design)
- [Import and cutover](#16-f3f5-strict-import-rehearsal-and-cutover)
- [Phase 8](#17-g0g6-phase-8-storefront-orders-and-friend-deployments)
- [Conditional Phase 9](#18-s0s4-conditional-phase-9-saas)
- [Rollout and human gates](#20-attended-rollout-and-human-gates)
- [Commands and handoff](#21-commands-ci-and-implementing-model-handoff)
- [Reference code](#appendix-a--executable-reference-helpers)
- [Audit and coverage](#appendix-b--final-design-audit-and-requirement-coverage)
- [Exact files and remaining API contracts](#appendix-c--exact-file-allocation-and-endpoint-completion-map)

## 0. Read this before doing any work

### 0.1 Purpose and authority

Finish the original product in order: A, a trustworthy own-shop system through Phase 7; B, storefront/orders and repeatable friend-shop deployments in Phase 8; C, optional paying-customer SaaS in Phase 9. Phase 9 is designed here but must not be implemented before the original paying-shop gate. FIFO cost layers remain waived for v1 by the master plan; this blueprint does not quietly reintroduce them.

This blueprint replaces the C–G design in `docs/REMAINING_BUILD_PLAN.md` at `01a66bf5273127cd754f0788ed7baf59e0346938`. It supplements `DSB_PRO_BUILD_PLAN.md` v1.6; the explicit amendments in §2 must be recorded in that master document when this plan is adopted. Earlier SQL snippets and migration numbers in the superseded remaining plan must not be combined with this design.

The request that produced this file authorized planning and verification. Live database changes, deployment, charging anyone, and sending messages remain separately authorized (§20). Merging #35 was explicitly authorized and is complete (§0.2). Implementation begins at P0.

### 0.2 Verified baseline

| Source | Verified value |
|---|---|
| Repository | `dashsuperbazar-del/dsb-pro` |
| Current main | `74768c11b327d7920daf0570a301966a853fc7b6` — `fix(pos): persist held label across screen reconstruction (#35)` |
| Previous plan branch | `claude/eloquent-mccarthy-m8m5cj` |
| Previous plan commit | `01a66bf5273127cd754f0788ed7baf59e0346938` (superseded by this document) |
| PR #35 | **Merged** (squash) at exact requested head `2b8a6dfde52d97f100a0d2652a7c9bac9b9485a6`. Post-merge push run `#589` (`35804537359`) on real `main` confirmed green: lint/typecheck/test/audit/pgtap/`phase6_db_upgrade_proof`/e2e (incl. the 10× held-cart stress) all `success`; `deploy` and every live-migration job `skipped`. P0's #35 disposition is closed. |
| Latest baseline migration | `0043_phase65_fixed_point_sale_ack.sql` |
| Database upgrade groups | foundation, hardening, phase65, batcha, batchb |
| Client local database version | Dexie version 4 in `packages/sync/src/db.ts` |
| Toolchain declared by repo | Node >=24; pnpm 11.25.0; Supabase CLI 2.116.0 in CI |
| Upload baseline | No repository ZIP supplied for this planning task |

Refresh these facts before implementing. A newer main does not mean restart the plan: compare the delta, update the source register, allocate unused migration numbers and mark already-satisfied packets with evidence. Never overwrite another contributor's files. Do not reset a dirty checkout.

### 0.3 What “complete” means

An own-shop build is complete only after code, CI, hosted and portable restore drills, actual device tests, cutover, and 30 days of real use satisfy the original definition of done. “Code complete”, “ready for shop rehearsal”, “production accepted” and “Phase 8 accepted” are different states. Record each separately.

Two irreducible external inputs remain: a real legacy export for mapping and actual operator/provider evidence. A model must not invent either. It can finish the surrounding architecture and fixtures while those inputs are pending. Gates are dependencies, not unexpected implementation dead ends.

### 0.4 Execution protocol for every packet

1. Fetch main; record exact SHA; inspect worktree status and repository instructions. Read this packet, its prerequisites, source functions and existing tests.
2. Create one branch and draft PR per packet. Tests belong with the implementation in that PR. A packet may have a small migration plus its adapter/UI when that is necessary for a usable, testable change. Do not merge unrelated packets.
3. For defect fixes, write the meaningful failing reproduction first. For new features, assert the required behavior before implementing; do not claim a missing-function failure proves the business logic.
4. Do not edit applied migrations. Write a new migration, update generated database types, extend guarded upgrade proof, exports and security tests in the same packet.
5. Implement against exact source signatures. Copy the latest effective function body, including wrappers, before narrowly changing it. An earlier migration is not authoritative merely because it originally created the name.
6. Run the targeted tests, then all required CI. Obtain independent review and two complete green validation runs at the unchanged candidate SHA. Fixes reset that evidence requirement.
7. Merge only under the established authorization and branch protection. Check the resulting main run; production deploy and live migration jobs must remain skipped on PR/push validation.
8. Append a handover with SHA, packet, files, tests, known limits, next packet and human gates. Never claim a skipped job passed.

A blocked packet gets a named issue, exact failed assertion, attempted safe resolution, owner and unblock criterion. Continue independent authorized packets. Do not bypass a constraint to make a test green.

---

## 1. Source register: real objects and files

Paths are relative to the repository root at the baseline above. Proposed additions are labelled NEW throughout this document.

| Concern | Actual source to open | Important dependency |
|---|---|---|
| Money and quantity | `packages/core/src/fixedPoint.ts` | `parseRupeesToPaise`, `parseQuantityMicros`, `quantityTimesPaise`, `multiplyPaiseByRatio`; non-negative inputs, safe-number boundary |
| Payment schema/guards | `supabase/migrations/0023_phase4_sales_payments.sql` | payments, payment_allocations, deferred allocation sum, void_payment |
| Payment RPC wrapper | `0026_phase4_idempotency_locking.sql` | record_customer_payment delegates to private phase4_record_customer_payment_unlocked |
| Allocation validator | `0036_phase65_returns.sql` | Latest phase4_validate_allocation rejects every direction other than in |
| Return posting wrapper | `0043_phase65_fixed_point_sale_ack.sql` | post_return delegates to phase65_post_return_unlocked, whose body originated in 0036 |
| Refund void guard | `0037_phase65_offline_returns.sql` | phase65_refund_payment_void_guard locks affected sales; preserve refund ceiling |
| Sale posting | `0043…sql` wrapper; `0039_phase65_negative_stock_override.sql` private body | phase4_post_sale_unlocked performs totals, stock and number generation |
| Purchase posting | `0043…sql` wrapper and phase65_post_purchase_unlocked | Do not replace the wrapper with an older bare function |
| Purchase void | `0017_master_data_purchases.sql`, plus later triggers | void_purchase; inspect return/financial restrictions before replacing |
| Shop access | `0017_master_data_purchases.sql` | phase3_assert_shop validates tenant and current_shop_ids, owner/manager exception |
| RLS hardening | `0034_phase6_integrity_hardening.sql`, `0041_phase65_sync_cost_confidentiality.sql` | Purchase reads and cost-price sync visibility |
| Invariant RPC | `0039_phase65_negative_stock_override.sql` | Latest check_invariants; preserve negative-stock policy semantics |
| Stock projection | `0042_phase65_negative_stock_recovery.sql` | Latest apply_stock_movement; preserve recovery from negative stock |
| Ledgers and current outstanding | `0036_phase65_returns.sql` | get_party_ledger is tenant-wide, no shop output; customer_invoice_outstanding is current-state |
| Reports | `0040_phase65_missing_reports.sql`, `packages/adapters/src/reports.ts` | get_item_sales_report, get_customer_aging_report |
| Settings | `0038_phase65_shop_settings.sql`, `0039…sql`, `packages/adapters/src/shopSettings.ts` | Latest update_shop_settings has nine arguments |
| Legacy import | `0027_phase4_legacy_import.sql`, `packages/core/src/legacyDsbImport.ts` | Empty-shop bridge only; float conversion, defaults, skipped rows and clamped negative stock must not become cutover policy |
| Financial local state | `packages/sync/src/db.ts`, `types.ts`, `outbox.ts`, `offlineSale.ts`, `offlineReturn.ts` | Existing retry/outbox semantics must be preserved or explicitly migrated |
| Sync transport | `apps/admin/src/lib/offlineSync.ts`, `packages/adapters/src/sync.ts` | Batch B authoritative sale acknowledgment and intent fingerprint |
| UI | `apps/admin/src/App.tsx`, `screens/*`, `lib/paths.ts`, `HealthPanel.tsx` | Preact; stable DOM identity matters for typed input |
| Error handling | `packages/adapters/src/errors.ts` | Existing generic offline text incorrectly implies all operations are queued |
| Exports | `.github/workflows/phase6-json-export.yml`, `0035…sql`, `0036…sql`, core archive builder | Nightly all-tenant export is v3; on-demand returns-aware export is v4; these are different contracts |
| Upgrade control | `supabase/phase6-upgrade-manifest.txt`, `scripts/inspect-phase6-upgrade-state.sh`, `scripts/apply-phase6-upgrade.sh` | Full reset does not prove a staged live upgrade |
| Restore | `scripts/restore-public-to-docker.sh`, `restore-to-local-supabase.sh`, `phase6-financial-restore-fixture.sql` | Existing fixture uses privileged insertion; add realistic RPC fixtures as a separate proof |
| CI | `.github/workflows/ci.yml` | Existing lint/typecheck/test/pgTAP/upgrade/E2E/audit/build gates and attended operation dispatch |

Inspect with `rg`, not guessed filenames. To find the effective definition, search all later migrations for both `create or replace` and `alter function … rename`. For security, inspect every granted callable wrapper, not only private bodies.

### 1.1 Confirmed defects and omissions that drive this design

- Outgoing supplier allocations are rejected by the latest allocation trigger and flagged by paymentDirectionViolations.
- payments_read/payment_allocations_read are tenant-wide. Restricting only a screen is insufficient.
- get_party_ledger cannot be filtered into a shop-specific running balance because it does not expose shop identity.
- Allocation rows have created_at but no business-effective date or voided_at. Payment date alone cannot date a later allocation.
- The old customer-payment private body returns an existing ID without comparing the payload. Its wrapper adds locking, not payload equality.
- The current schema has no opening-balance settlement mechanism.
- Nightly JSON lacks returns while on-demand export already includes them; syncIdempotencyKeys and stockCountLines already exist in nightly export and must not be duplicated.
- New table/view grants cannot rely on migration-role default privileges.
- Current retry state and master plan UNKNOWN wording are not identical. Reconcile this explicitly; do not create a second sender for existing outbox entries.
- A subset of function-name/body signals is not a complete migration integrity proof.

---

## 2. Decisions fixed by this blueprint

These are engineering defaults to adopt with the plan, not claims that Apd already approved changed business policy.

| Topic | Decision and boundary |
|---|---|
| Supplier post/allocate | POST_PURCHASES: owner/manager; online only |
| Supplier void | VOID_SALES: owner only; existing permission reused to avoid needless role proliferation |
| Supplier advances | Allowed; explicit later allocation; no automatic guessing of bills |
| Cross-shop payments | Forbidden in v1; payment, target bill/opening and actor access must share shop and account |
| Amounts | Positive integer paise magnitudes; direction supplies cash sign; signed openings use signed integer paise |
| Financial request ledger | NEW financial_requests table with normalized request and result; keep existing sync_idempotency_keys untouched for legacy sync compatibility |
| Idempotency namespace | Public operation + client UUID; internal child IDs include operation and target, never just array ordinal |
| Unknown outcomes | Persist immutable attempt, reconcile by ID, then exact retry only; never create a new request ID merely because of timeout |
| Historical reports | Restated business-date reports: currently voided documents are excluded at all dates; allocation effective dates prevent later allocation from appearing earlier |
| Original “as known then” books | Archived signed/checksummed daily report snapshots, not reconstruction from restated reports; no claim of full bitemporal accounting |
| Opening imports | Opening stock + account balances at cutover, archived legacy detail; no synthetic historical purchases that add stock a second time |
| Opening settlement | Explicit payment-settlement rows; negative opening credits may be applied to new documents via explicit non-cash credit applications |
| FY numbering | New numbers use configured FY and document-type series; historical numbers untouched; settings freeze once first FY number is issued |
| Fiscal month change | Allowed before first FY-numbered document only; subsequent change requires a separately designed migration, never a casual settings toggle |
| Existing transactions | Keep existing HTTP/RPC signatures compatible during rolling release; add versioned endpoints where semantics change |
| Phase 8 fulfillment | Orders are stock reservations, not sales; one finalized sale at collection/delivery, atomically linked to the order |
| Phase 8 payment | Cash/UPI/card/bank tender recorded at fulfillment; no customer online payment gateway in Phase 8 |
| Phase 9 payment | Razorpay is for SaaS subscriptions, separate from shop sales/payments |
| Storefront writes | Public gateway validates/rate-limits; internal order RPC is not executable directly by anon. Record this security refinement to master §8 |
| Hindi | Machine draft with visible review status; money behavior never depends on translation |
| Accessibility | Add pinned @axe-core/playwright for automated checks plus manual keyboard/print review; a tool does not replace these |
| FIFO | Explicit v1 waiver remains; show cost_last valuation as approximate, not historical FIFO profit |

Amend the master plan to record: purchase/payment parity replaces impossible “50 old sales invoices” evidence; restated-report semantics; request-ledger/UNKNOWN compatibility; gateway-only order mutations; opening settlement schema; FY setting freeze. Preserve original human gates and the own-shop-first priority guard.

---

## 3. Architecture and invariants

### 3.1 Dependency layers

UI → typed adapters → permitted RPCs → immutable financial rows / append-only stock movements. Reports read canonical event sources. Local Dexie stores offline billing state and separate durable online attempts. An online-only attempt store is not an offline posting queue. Provider names remain in adapters or infrastructure services.

Keep shared admin components under `apps/admin/src/components` and print code in admin/core as currently accepted. Do not create packages/ui or packages/print solely to match the old illustrative tree. NEW storefront/superadmin apps are separate builds in Phase 8. Keep the admin bundle under its existing production-equivalent budget.

### 3.2 Essential invariants

Let active mean POSTED/FINALIZED, not deleted, and with active parent where applicable. All sums are scoped by tenant, shop and account.

1. Purchase due = bill total − active purchase returns − active cash allocations − active opening-credit applications. Display allocatable due as max(due,0). Negative due after a legitimate post-payment return is supplier credit, not corruption.
2. Customer invoice due = invoice total − active sale returns − incoming receipt allocations + outgoing refunds tied to that invoice − opening-credit applications. Keep the existing merchandise/extra-charge refund rules.
3. Payment used = bill/invoice allocations + opening settlements. Used ≤ payment amount; every allocation has the matching account, shop, direction and active payment.
4. Positive opening remaining = opening amount − active payment settlements. Negative opening credit remaining = abs(opening) − active cash settlements − active non-cash credit applications. Each remaining magnitude ≥0.
5. Supplier ledger balance = signed opening + purchases − purchase returns − outgoing party payments + incoming party payments. Positive means we owe supplier.
6. Customer ledger balance = signed opening + sales − sale returns − incoming customer payments + outgoing customer payments. Positive means customer owes us.
7. Opening-credit application moves credit between open items. It does not add a second ledger cash/debit/credit entry.
8. Stock on_hand = sum(stock_movements.qty_base). reserved = sum(active reservation quantities). available = on_hand − reserved. Storefront reservations never use negative-stock override.
9. Every finalized financial request has one immutable normalized request and result. Same operation/key + changed payload rejects; exact retry returns the committed result even after the document was subsequently voided, with current document status shown separately.
10. No cashier/anonymous surface leaks supplier costs, allocations, request payloads, backup internals or private contacts.
11. Every newly introduced source of balance/stock participates in export, restore proof and invariant coverage.
12. Number uniqueness is database enforced. Voided numbers are never reused. Failed transactions may roll back a transactional counter; never promise universal gaplessness across imports/admin actions.

### 3.3 Numeric and time contract

- Existing app safe-number boundary is 9,007,199,254,740,991. New APIs reject unsafe individual money inputs before Number conversion. Validate sums with BigInt, then range-check; do not sum safe numbers into an unsafe total.
- New report/export transport uses decimal text for potentially unbounded aggregate amounts. Retain old numeric endpoints until callers migrate; do not silently return rounded JSON numbers. New UI formatters accept integer text or safe integer numbers.
- Quantity input is canonical decimal text with at most six fractional places. Conversion products must fit numeric(18,6) exactly; reject unrepresentable products rather than silently rounding stock. Extend tests around existing paths before tightening them.
- Use explicit shop business dates, server-derived defaults, UTC timestamps for recorded times, and shop timezone only for converting timestamps to business dates. Do not derive a business date with browser UTC substring.
- Every new effective allocation date must be ≥ payment date and ≥ target document/opening date. For later allocation the default is today's server shop date. v1 UI does not backdate later allocations; an explicit owner-only backdate endpoint can be added later, not improvised.
- Reports before migration's trustworthy allocation-history boundary carry `historyCompleteness: inferred` and a visible explanation. Do not fabricate precise historical allocations from created_at.
- Reports are restated: later voids may change earlier results. Export saved close-of-day snapshots if the user needs the actual earlier published result.

### 3.4 Locking discipline

Use transaction-scoped advisory locks, never session locks for money. Define NEW private `dsb_lock_shop_finance(tenant,shop)` using a stable prefixed hash. In packet C0b (§6.3a), every financial writer that can touch payment/allocation/return/void/opening relationships takes that lock **before** document/payment/stock row locks. This intentionally serializes money changes within one shop; different shops remain independent.

**Benchmark threshold, defined before testing, not after:** workload = `post_sale` with 3 lines + 1 payment, the shape already exercised by `phase6-performance.yml`; concurrency = 20 simultaneous sessions against one shop; pass condition = p95 `post_sale` latency at 20 concurrent sessions does not regress more than 15% versus the pre-C0b baseline measured on the same runner class. If the regression exceeds 15%, C0b does not merge on schedule; it becomes a named blocked packet (§0.1, stop conditions) with the measured numbers recorded, and the fallback below is designed and proven — not assumed — before retrying.

**Open item, must be resolved before C0b implementation starts:** the 15% relative-regression gate above has no absolute ceiling. A relative gate alone lets p95 drift upward across repeated small "compliant" regressions, or lets a genuinely slow absolute number pass merely because the pre-C0b baseline was already slow on a noisy runner. Before C0b work begins, record on the pre-C0b baseline run: the actual measured p95 in milliseconds, and a proposed absolute ceiling (e.g. "p95 ≤ Nms regardless of relative delta") with the reasoning for that number tied to real shop usage (till throughput at peak, not a guess). Both the relative and absolute conditions must pass together; do not substitute one for the other without user sign-off.

**Fallback is a candidate, not a proven replacement.** Per-account (per-bill, per-payment) row locking is the only fallback worth designing, but it is not automatically safe merely because C1's allocation trigger uses `FOR UPDATE` on individual rows. The relationships that cross entities — `release_supplier_allocation` touching both a payment and a bill; §15.4's credit capacity spanning `purchase_returns` + `payment_allocations` + `supplier_credit_receipts` for one bill; F2's combined budget spanning `payment_allocations` and `opening_payment_settlements` on one payment; `phase65_refund_payment_void_guard`'s existing multi-row sale lock — all need one proven global acquisition order before per-account locking can replace the shop-wide lock. A fallback packet must enumerate every such cross-entity relationship, define one acquisition order across all of them, and pass its own concurrency proof (C1's C27–C30 vectors plus the cross-entity cases above) before it substitutes for C0b. Do not adopt it on the strength of C1's per-row locks alone.

Acquire in this order: validated tenant/shop identity → shop finance advisory lock → from F1, issuer-registration lock for numbering/series mutations → operation/request advisory lock → account/document/payment rows in deterministic UUID order as required by the operation → stock rows in item UUID order → insert derived children. Never acquire the shop lock in a trigger after another operation can already hold conflicting rows; wrappers acquire it before calling existing private bodies. Private internal helpers are not granted to clients.

Covered writers: post_sale, record_customer_payment, post_purchase, post_return, void_sale, void_payment, void_purchase, void_return, and the existing sync wrappers through these entry points; add supplier/opening/order fulfillment entry points later. Expense/count writers join this protocol when they acquire stock or affected finance records; enumerate actual call graph. Master-data writers that do not share these rows do not need serialization.

Read a target's shop without locking, validate actor access, take the shop lock, then re-read/lock the target and revalidate. Never trust the first unlocked read as an authorization or status decision. Security-definer functions must not expose existence across tenants.

This is a deliberate correctness tradeoff for a single-shop system. Concurrency tests must verify no cross-tenant blocking and acceptable per-shop performance; optimize only with a separately proven lock graph. **If C0b is ever rolled back, roll back with a forward migration that restores the prior unlocked wrapper behaviour while preserving every `financial_requests` row and every table C0a and later packets added — never a reversal of financial schema.** This is the same forward-only discipline already binding on `0001`–`0043`; C0b does not get an exception because it is new.

---

## 4. Packet schedule and migration allocation

Migration numbers below are reserved proposals only for baseline ending at 0043. At adoption, allocate the next unused numbers atomically in the plan; keep packet IDs stable if numbers shift. Each migration packet is independently upgradeable and has its own group. Never publish D1 and D2 as half of one unverifiable group.

| Packet | Deliverable | Planned migration/group | Prerequisite |
|---|---|---|---|
| P0 | Baseline, #35 disposition, specification amendment, evidence ledger | none | current repo |
| P1 | Upgrade coverage and exact migration receipts | 0044 / upgrade_receipts | P0 |
| P2 | Item-wise net sales correction (§9.1) | 0045 / item_sales_fix | P1 |
| C0a | Request ledger + temporal allocation metadata (additive, no lock change) | 0046 / finance_requests | P2 |
| C0b | Finance-lock wrappers over existing writers (§3.4) | 0047 / finance_locking | C0a; own benchmark gate |
| C1 | Supplier payment/allocate/void + RLS + invariants + SQL tests | 0048 / supplier_payments | C0b |
| C2 | Durable attempt store, adapters, supplier screen | none | C1 |
| C3 | Existing customer-payment retry and UNKNOWN compatibility | 0049 / customer_requests | C2 |
| D1 | Dated allocations and shop ledgers/aging (§9.2–9.3; item-sales already done in P2) | 0050 / reports_v2 | C3 |
| D2 | Settings guards, profile snapshots, printing | 0051 / settings_v2 | D1 |
| D3 | Complete export manifests and JSON restore | 0052 / export_v5 | D2 |
| D4 | Health telemetry, dynamic invariants and readiness panel | 0053 / health_v2 | D3 |
| E0 | i18n/error infrastructure | none | C2; before broad UI edits |
| E1 | Screen translations, permission-driven navigation/dashboard | none | D4,E0 |
| E2 | Async states, accessibility, theme, keyboard/print parity | none | E1 |
| E3 | Automated full shop rehearsal and regression/performance | none | E2 |
| F0 | Real export inventory, canonical mapping, signed opening manifest | none | can start after P0 |
| F1 | FY numbering, immutable profile/number snapshots | 0054 / numbering_v2 | E3 |
| F2 | Opening accounts, settlements and credit applications | 0055 / opening_accounts | F1 |
| F3 | Strict importer/dry-run/apply, import identity map | 0056 / cutover_import | F2; mapping needs F0 |
| F4 | Disposable rehearsals, parity and recovery evidence | none | F3 |
| L/H | Attended migration/deploy and human gates | no new schema | exact release passing |
| F5 | Freeze, final import, cutover, 30-day observation | none | F4 + H gates |
| G0 | Phase 8 release baseline/permissions/gateway contracts | 0057 / storefront_config | F5 own-shop acceptance |
| G1 | Public catalog, safe assets and gateway | none | G0 |
| G2 | Orders, reservations, expiry and mutations | 0058 / orders_v1 | G1 |
| G3 | Fulfillment-to-sale integration and cancellation | 0059 / order_fulfillment | G2 |
| G4 | Storefront and admin Orders UI | none | G3 |
| G5 | Per-shop configuration, deployment matrix and superadmin | operator 0001 / deployment_health | G4 |
| G6 | Security/load/restore and first friend acceptance | none | G5 |
| S0 | Paying-shop decision, provider and legal facts | none | G6 + paying shop |
| S1 | Tenant onboarding, multi-shop, staff permissions | 0060 / saas_access | S0 |
| S2 | Plans/entitlements/subscription events/webhook inbox | 0061 / saas_billing | S1 |
| S3 | Billing integration, support and portability tools | none | S2 |
| S4 | Migration rehearsal, 14-day external trial, release | none | S3 |

**P2 is deliberately early and stands alone.** The bug it fixes (§9.1: `get_item_sales_report`'s sold side ignores header-discount allocation, so a fully-returned discounted invoice reports nonzero net sales) depends on nothing in C0–C3 — only on `phase65_sale_line_cap`, already in `0036`. Leaving it behind the seven-packet supplier-payment chain would mean every discounted invoice with a return keeps reporting a wrong figure for weeks of unrelated work. D1 keeps the dated-allocation and shop-ledger halves of the original design, which genuinely need C0a's `effective_date` column; it does not redo item-sales.

**C0 is split because it bundled two different risk profiles into one revertible unit.** C0a (request ledger, temporal columns) is additive and near-zero-risk. C0b (shop-wide advisory lock over `post_sale` and every other financial writer) changes the concurrency behaviour of live billing before the feature that motivates it — supplier payments — exists. C0b has its own migration group, its own benchmark gate (§3.4), and its own forward-restore path so a regression in C0b does not force reverting the request ledger that C1–C3 depend on.

P1/C0a are intentionally separated: P1 introduces guarded migration receipts; C0a introduces financial request storage. Every packet also updates documentation and tests within its own scope. F0 has no dependency on UI completion: request the export early, then continue other work.

### 4.1 Mandatory packet evidence

Maintain `docs/BUILD_EXECUTION_LEDGER.md` with packet state (`NOT_STARTED`, `IN_PROGRESS`, `CODE_REVIEW`, `CI_PASSED`, `HUMAN_PENDING`, `ACCEPTED`, `BLOCKED`), branch/head, changed migration hashes, test names/counts, two CI run IDs, reviewer, rollout requirement, remaining gate and next step. This is a status ledger, not a manually asserted green badge.

### 4.2 Packet 0.5 amendment (recorded 2026-09-26, in P1's PR)

The dependency-graph reconciliation required by this section produced real corrections to the table
above, recorded in full in `docs/BUILD_EXECUTION_LEDGER.md`'s "Packet 0.5" section (not duplicated
here to avoid the two documents drifting apart). Two items affect this plan directly, not just the
ledger's tracking columns:

- **G1**'s `public_catalog` schema (§17) has no migration allocated in Appendix C1. Its SQL foundation
  (projection/grants/RLS tests) is assigned to G0's `0057_storefront_configuration.sql` instead; G1
  keeps only API/cache/asset work and integration tests.
- **S3**'s support-ticket persistence (§18) has no baseline tables and no S3 migration. That schema
  foundation and its operator-read policy are assigned to S2's `0061_saas_billing.sql` instead; S3
  implements the service/UI and isolation tests against it.

The G/S coding-decoupling amendment (user decision, 2026-09-26) is also recorded in that same ledger
section, per this section's instruction to record it here rather than as a separate document.

---

## 5. P0–P1: establish a safe execution base

### P0 — Baseline and repository instructions

Files: `CLAUDE.md`, `docs/HANDOVER.md`, `DSB_PRO_BUILD_PLAN.md`, NEW `docs/BUILD_EXECUTION_LEDGER.md`, this blueprint under `docs/COMPLETE_REMAINING_BUILD_PLAN.md`.

- Recheck PR #35 exact head, independent review and complete CI. The body’s run summaries are evidence pointers, not a substitute for checking statuses. Its merge is a prerequisite decision, not part of generating this plan.
- Remove stale claims that #17 remains unmerged and that main only ever advances by a historical phase fast-forward. State the actual protected-PR policy; never rewrite history to satisfy stale text.
- Adopt §2 amendments explicitly. Clarify that a packet is the atomic PR unit; its tests are not a second packet.
- Build a source manifest: effective function name/signature, defining migration, wrappers, client callers, grants, relevant tests. Record SHA-256 hashes of migrations 0001–0043.
- Record human gates as pending unless actual evidence is available. Do not turn remembered shop claims into signed evidence.

Acceptance: baseline SHA verified; #35 disposition recorded; source paths exist; locked master requirements map to a packet or explicit waiver; no deployment.

### P1 — Guarded upgrade receipts and staging proof

NEW migration `0044_upgrade_receipts.sql`; NEW `scripts/verify-migration-manifest.mjs`; modify existing upgrade inspector/apply scripts, manifest, CI staged-proof job; NEW `supabase/tests/*upgrade_receipts.sql`.

Create server-only `app_migration_receipts(version text primary key, checksum_sha256 text not null, applied_at timestamptz not null default now(), applied_by text not null default current_user)`. This is an explicit global control-table standard-column exception, like schema_meta. Deny anon/authenticated access. Include it in operator backup/export, not ordinary cashier data.

Mechanism:

1. Preserve the existing fail-closed classifier for 0030–0043. Append zeroes for new groups to **every** supported legacy state, not just the latest one.
2. In the apply script, validate manifest order, path uniqueness, group membership, checksums and preceding-state compatibility before running SQL. Do not log connection strings.
3. The runner reads migration bytes, computes SHA-256, opens one SQL transaction per explicitly selected group, applies its files, then inserts receipts with parameterized values before COMMIT. Use the existing `psql --single-transaction` approach plus a generated properly quoted receipt SQL file, or a Node pg transaction runner; choose Node pg here to avoid shell SQL quoting hazards. Keep the old shell command as a wrapper with unchanged invocation syntax.
4. Migration 0044 creates the table. Runner records its receipt after that statement in the same transaction. Later migration SQL does not hash itself and does not invent checksums.
5. Fresh `supabase db reset` creates the schema but does not run this custom receipt writer. Add an explicit **disposable-target only** baseline-receipt bootstrap in the CI harness after reset. Production cannot use this bypass. On an existing live schema without receipts, require the legacy classifier plus exact schema/permission verification before initializing only legacy baseline receipts through an attended command.
6. Receipts prove applied bytes, not absence of later manual schema tampering. Also verify expected columns, constraints, functions and grants; detect drift rather than accepting a function merely because its name exists.
7. Old migration body fingerprints can become obsolete when later migrations intentionally replace those functions. Classifier must select expected definitions by highest complete receipt, retain prior-state checks for prior states, and never require both obsolete and replacement bodies simultaneously.
8. Extend live job preflight, job outputs, steps, all-group handling, verify blocks and operation descriptions in the same PR. Generic ordered manifest iteration replaces accumulating hand-coded omissions, with explicit allowed group registry.

Proof matrix: empty reset; baseline Phase 5; every supported legacy prefix; each new packet prefix; rerun completed group is no-op only after matching receipt/schema; partial group; out-of-order object; changed historical checksum; deliberately missing grant; failure halfway rolls back schema and receipt; rollback then successful retry. Unknown state refuses without mutation. Both Docker Postgres and local Supabase paths must remain supported.

Never automatically “repair” live schema based on a failed fingerprint. Report exact drift and prepare a reviewed forward repair.

---

## 5a. P2: item-wise net sales correction (migration `0045 / item_sales_fix`)

Moved here from the original D1 draft (§9.1) because it has no dependency on C0a's `effective_date` column, C0b's locking, or any Batch C work — only on `phase65_sale_line_cap`, already present in `0036`. It fixes a live bug (every discounted invoice with a return reports the wrong net-sales figure) and should not wait behind seven unrelated packets.

Copy latest `get_item_sales_report` body from `0040` into a forward migration. Sold CTE sums existing `phase65_sale_line_cap(sii.id)` for net merchandise. Keep `line_total_paise` gross column semantics explicitly "after line discounts, before remaining invoice-level allocation"; do not inaccurately label it pre-all-discounts gross. Returned CTE uses stored return amount. Full outer item join ensures a return-only period appears. Exclude extra charges from merchandise net; show extra charges separately when reconciling to invoice totals.

Tests: 10000 merchandise with 1000 header discount fully returned nets 0; line discount plus header discount; three lines with rounding residual; return in later reporting period; return-only period; extra charges remain; voided return; different shops. Derive expected values independently from test fixtures, not by calling the same SQL helper in the test expectation.

Evidence, review and merge gate: identical to every other packet in this plan (§0.4) — draft PR, independent review, two unchanged-head green runs, post-merge push verified. No exception for being small.

---

## 6. C0a: financial request and date foundations (additive, migration `0046 / finance_requests`)

C0a is additive only: a new table, new columns with a backward-compatible default, and helper functions nothing yet calls with lock-changing effect. It carries none of C0b's concurrency risk and is independently revertible by a forward migration that drops the new objects — but only while nothing outside this packet depends on them yet. Once C0b, C1, or any later packet reads `financial_requests`, `effective_date`, or `shop_financial_history`, dropping them is no longer a safe revert: a forward-restore at that point must preserve those tables and columns (per §3.4's C0b restore rule) rather than remove them, even though C0a itself remains additive.

### 6.1 Schema

NEW `financial_requests` stores only completed operations. Columns: standard id/tenant/shop/created_by/created_at/updated_at/deleted_at/client_id; `operation text not null`; `request jsonb not null`; `result jsonb not null`; `request_version integer not null default 1`. Constraints: unique(tenant_id,operation,client_id), unique(tenant_id,id), composite shop FK; request/result must be JSON objects; client_id length 1–128 and operation from the versioned operation allowlist. No tenant-wide unique(client_id): operation is deliberately part of the namespace. Internal child-table IDs remain globally namespaced as specified below.

No client SELECT/INSERT/UPDATE/DELETE. RLS enabled, no browser policies. Add updated_at, audit and immutable triggers; backup_ro conditional SELECT. No pending row is committed: request/result and business mutations commit together, so server crashes cannot strand a durable IN_PROGRESS marker.

NEW private helpers:

- `dsb_lock_shop_finance(uuid,uuid) returns void`.
- `dsb_lock_request(uuid,text,text) returns void`.
- `dsb_assert_safe_paise(bigint,boolean default false) returns void`, immutable, non-negative or signed according to argument, bounded for input compatibility.
- `dsb_normalize_allocations(jsonb,text) returns jsonb`: validates array/object/key allowlist, UUID targets, positive integer-text amounts and ≤200 allocations; sorts by canonical UUID; duplicate target rejected; stores amounts as decimal strings. Second argument names the supported target field, restricted to an internal allowlist.
- `dsb_request_result(uuid,uuid,text,text,jsonb) returns jsonb`: private, lookup exact normalized payload, raise mismatch or return stored result; caller already holds locks and checked permissions.

Public NEW `get_financial_request(p_shop_id uuid,p_operation text,p_client_id text) returns jsonb`: operation-specific read permission, shop assertion and request lock; return `{state:'COMMITTED', result, currentStatus}` or `{state:'NOT_FOUND'}`. Do not expose request payload or other users' financial details to unauthorized roles. NOT_FOUND is not proof that an earlier network call can never commit; it permits only an exact replay of that same attempt. Retry authorization is rechecked.

### 6.2 Allocation metadata and current callers

Add to payment_allocations: `effective_date date`, `effective_date_source text` (`EXPLICIT`, `LEGACY_INFERRED`), `voided_at timestamptz`. Backfill existing rows with greatest(payment.business_date,target.business_date, local date of pa.created_at) and LEGACY_INFERRED. Record min trustworthy date per shop in NEW `shop_financial_history` (standard fields; one row per tenant/shop). The backfill is conservative inference, not recovery of actual historical intent.

Then enforce non-null effective_date. BEFORE INSERT trigger fills an omitted date for compatible callers as greatest(payment date,target date), marks EXPLICIT for new immediate allocations, validates date constraints and same shop/account. Later-allocation RPC must pass the current shop business date explicitly. BEFORE UPDATE stamp voided_at on first POSTED→VOID; preserve all immutable identity/amount/effective fields and preserve existing sale refund safeguards. Baseline already-VOID rows have unknown historical void time; restated reports do not invent one.

Keep customer_invoice_outstanding current-state semantics initially. New as-of functions consume effective_date in D1. Add tests for existing post_sale/record_customer_payment calls that omit the new field.

---

## 6a. C0b: finance-lock wrappers (migration `0047 / finance_locking`, own benchmark gate)

C0b is scheduled and reviewed as its own packet, separate from C0a, precisely because it changes the concurrency behaviour of every financial writer including the `post_sale` hot path — before the feature that motivates it (supplier payments) exists. Do not start C0b until C0a is merged and its two green runs are recorded; do not merge C0b until the §3.4 benchmark threshold passes on the exact candidate SHA. A benchmark failure makes C0b a named blocked packet per §0.1 — see §3.4 for the fallback requirement, which is a design-and-prove task, not a same-day substitution.

### 6a.1 Wrapper hardening without weakening existing bodies

Wrap the public writers enumerated in §3.4 with shop-first lock and existing permission checks, preserving signatures. Revoke execution on renamed helper bodies from PUBLIC, anon and authenticated; query actual privileges after migration. Calls originating in existing sync wrappers must reach the locked public entry point. No call may jump directly to an unlocked body.

Existing exact-retry behavior is preserved until C3 adds payload checking. Do not retrofit a guessed fingerprint onto previously stored payments. New finance requests only acquire the operation lock after the shop lock. Request lookup does not acquire any document/stock locks.

For purchase void: if active allocations exist, refuse with `purchase has active allocations; void or release allocations first`. This is a clearer safe v1 policy than silently leaving allocations on a voided bill. Add explicit owner-only allocation release in C1. Existing posted purchase-return guards remain enforced.

Tests: permissions with auth hook disabled; all wrappers acquire correct shop lock; unauthorized internal helper execution denied; concurrent return/payment/void cannot commit inconsistent amounts; temporal fields populated; imported/inferred dates labelled; changed fields on allocation void rejected; **the §3.4 benchmark, run and recorded on the exact candidate SHA, not on an earlier or later commit.**

---

## 7. C1: supplier payments and allocation integrity

### 7.1 SQL objects and API contracts

Modify latest `phase4_validate_allocation` direction-aware. Preserve SALE return/refund calculations. New PURCHASE branch requires active party payment, direction out, active bill with non-null party, identical tenant/shop/party, and amount ≤ current allocatable bill balance. Explicitly reject deleted records. Acquire payment/document locks under the shop finance lock. Never add a blanket invariant that total allocated must remain ≤ bill net after later returns.

NEW security-invoker `purchase_bill_outstanding` includes tenant_id, shop_id, party_id, purchase_bill_id, bill_no, business_date, total_paise, returned_paise, allocated_paise, net_outstanding_paise and outstanding_paise. Explicit revoke then authenticated SELECT; underlying RLS still applies. Later F2 extends its calculation for credit applications.

Public functions (new signatures, do not copy the superseded plan's signatures):

```sql
record_supplier_payment(p_shop_id uuid,p_party_id uuid,p_business_date date,
 p_amount_paise bigint,p_mode text,p_reference text,p_allocations jsonb,p_client_id text)
 returns uuid;
allocate_supplier_payment(p_payment_id uuid,p_allocations jsonb,p_client_id text)
 returns jsonb;
void_supplier_payment(p_payment_id uuid,p_reason text,p_client_id text) returns uuid;
release_supplier_allocation(p_allocation_id uuid,p_reason text,p_client_id text) returns uuid;
get_supplier_outstanding(p_shop_id uuid) returns jsonb;
get_party_ledger_v2(p_shop_id uuid,p_party_id uuid,p_from date,p_to date) returns jsonb;
```

Request schema: allocations use `{purchase_bill_id: UUID, amount_paise: decimal_integer_string}`. The adapter converts safe integer input to strings. A payment amount is a bigint RPC argument, validated at server. Empty allocation array means advance. Null allocations is invalid. Payment mode is cash/upi/card/bank/other. Business date supplied by UI; null defaults on first execution only, and that resolved date is stored in result while the normalized request retains the explicit `null` default intent so exact retries across midnight match.

NEW requests use operation names `supplier.record.v1`, `supplier.allocate.v1`, `supplier.void.v1`, `supplier.release.v1`. Payment client_id is `supplier.record.v1:<request UUID>`. Allocation child ID is `<operation>:<request UUID>:bill:<canonical bill UUID>`; opening targets later get `:opening:<UUID>`. Validate maximum child length against actual column type. Never use unscoped request ordinal.

### 7.2 Exact record algorithm

1. Reject malformed client UUID/amount/mode/allocations with stable error code; validate actor POST_PURCHASES and shop membership; normalize payload.
2. Take shop finance lock, then request lock. Read financial_requests. Identical request returns its result.paymentId; different request raises `DSB_PAYLOAD_MISMATCH` without writes.
3. Validate active party, server/default date not later than today in the shop timezone, and reference length ≤200. Restrict new payments to dates not before the agreed cutover date when the shop is live; legacy imports have their separate endpoint. Existing historical documents remain readable.
4. Sort and lock target bills by UUID. Validate all targets, amounts and matching shop/party before inserting payment. Sum in numeric or bigint with overflow handling; total allocations ≤ payment.
5. Insert POSTED party/out payment. Insert allocations with deterministic IDs and effective_date=max(payment date,bill date); reject future target dates relative to payment if policy would create a future allocation—default v1 policy requires bill date ≤ payment date for immediate allocation.
6. Recompute/validate payment budget, bill balances and relevant invariants; insert completed request/result in same transaction. Return payment ID.
7. Do not catch arbitrary unique_violation and return any payment with the same client_id. Only the explicit request match is a valid replay.

### 7.3 Later allocation/release/void

Later allocation: resolve payment shop, actor, locks; exact-request check; payment must be POSTED party/out, date ≤ today's shop date; sort targets and validate same shop/account; effective_date=today; lock payment, ensure existing used budget + new ≤ amount; insert allocations; write result `{paymentId,allocationIds,effectiveDate}`. F2 extends used budget to opening settlements.

Release: owner only; reason 1–500 characters; POSTED allocation must be PURCHASE. Under lock mark it VOID and stamp time; it releases payment capacity and restores bill due. Release is a correction, so restated past reports also exclude it. It does not reverse cash. UI says “Remove bill matching”, not “Refund payment”.

Void: owner only; reason required; void active allocations first, later opening settlements too, then payment. Append audit reason via request data/result or explicit audit metadata; do not overwrite posted reference. Already VOID returns same ID if request is an exact replay or a new authorized no-op void request with its own recorded result. Supplier payments must not bypass generic void_payment through another granted path: generic void_payment delegates to supplier-aware logic or explicitly refuses supplier rows. No duplicate cash reversal row; status changes drive ledgers.

Purchase return after full payment leaves negative net due and supplier credit. Do not auto-create cash received from supplier. v1 records that credit in ledger; actual reimbursement is an explicit, owner-authorized party/in payment endpoint in F2, linked to supported credit source. Before F2 the UI shows credit awaiting reconciliation, not a fabricated advance.

### 7.4 Visibility and report reconciliation

payments SELECT: tenant AND accessible shop AND (non-party OR POST_PURCHASES OR VIEW_REPORTS). payment_allocations SELECT: corresponding payment/bill access; prevent PURCHASE allocation leakage through a join or embedded PostgREST select. Use a stable, side-effect-free private shop-access predicate rather than a throwing assertion in row policy. Maintain existing customer/cashier workflow permissions.

Triage every security-definer reader of payments/allocations, audit_log and request data, including sync/returns/export/health/reconciliation. Document function→permission→returned fields. Do not grant cashiers VIEW_REPORTS to make a dashboard work.

get_supplier_outstanding returns integer-text totals and separate fields: grossOpenBills, remainingPositiveOpenings (F2), unallocatedCashAdvances, remainingOpeningCredits (F2), returnCredits, netLedgerBalance. Do not label clamped bill due as the net amount owed. D1 gives shop/date-consistent details. Tenant-wide old ledger remains available only for its original role and explicitly labelled all shops.

### 7.5 Required tests (SQL + real two-connection concurrency)

C01 partial 100000/40000 →60000; C02 exact; C03 multiple bills sorted; C04 over bill; C05 over payment; C06 duplicate normalized UUID; C07 empty advance; C08 later allocation; C09 other party; C10 other shop same tenant; C11 other tenant; C12 null/deleted/void bill; C13 return before payment; C14 return after full payment negative credit; C15 payment void; C16 release matching without cash reversal; C17 exact replay/changed payload; C18 same request UUID across record/allocate without child collision; C19 cashier direct reads/RPC/joins; C20 manager post but not void; C21 accountant read but not post; C22 customer refund allocations still rejected; C23 report and day-book conservation; C24 zero/negative/unsafe/overflow amounts; C25 invalid JSON/object/UUID; C26 rollback leaves no request row; C27 two payments each 60000 against 100000 exactly one succeeds; C28 two allocations on one advance cannot exceed its budget; C29 reversed bill order never deadlocks; C30 allocation vs void/return has an allowed serial result; C31 new allocation on future-dated bill rejected; C32 deleted party cannot receive new payment but historical rows remain readable.

Run concurrency on real PostgreSQL with two connections and a bounded lock timeout. A single in-process database connection is not concurrency proof.

## 8. C2–C3: durable payment UX and customer compatibility

### C2 — Attempt store, adapter and supplier screen

NEW `packages/sync/src/financialAttempts.ts` and tests; extend Dexie to version 5 with `financialAttempts:'&id,[shopId+operation],state,createdAt'`. Identity isolation follows existing database naming: tenant/user/device, with shop in each record. Upgrade old version-4 databases without deleting outbox, held carts, offline sales or return blocks. Add attempt records to local snapshots, with an explicit “online requests awaiting confirmation” category.

Attempt fields: id UUID, operation, shopId, accountId, immutable normalized payload, state, createdAt, lastAttemptAt, committedResult nullable, errorCode nullable. States:

| State | Meaning | Permitted action |
|---|---|---|
| DRAFT | Editable, never submitted | edit/cancel |
| READY | Frozen payload durably saved | submit |
| SENDING | Request dispatched | wait; do not edit |
| UNKNOWN | Timeout, connection loss, malformed acknowledgment, restart during SENDING | reconcile same ID |
| COMMITTED | Validated server result | show receipt/history; start new draft with new UUID |
| REJECTED | Definitive rollback/rejection for this attempt | show reason; copy to new editable draft with new UUID |

Persist READY before fetch. Failure to persist prevents sending. Startup maps SENDING→UNKNOWN, not a fresh draft. A UI double-click uses one persisted ID and one in-flight promise. Do not rely on `navigator.onLine`: disable when known offline, but handle failures when it says online.

UNKNOWN reconciliation: query by ID; COMMITTED → validate result and refresh; NOT_FOUND → permit exact retry; denied/auth expired → preserve UNKNOWN and ask authorized operator to reconcile. A later permission error does not prove an earlier attempt failed. A safe exact replay may be automatic only after reconciliation and under bounded backoff; never change payload or request ID. This interpretation satisfies the master unknown-outcome rule without duplicating its financial event.

NEW adapter `packages/adapters/src/supplierPayments.ts`: typed record/allocate/void/release, list bills by shop+party, list payments by shop+party, request lookup, shop ledger. Preserve structured error codes instead of converting all errors to strings at the transport boundary. Validate response UUIDs, integer-text totals and operation ID before acknowledging.

NEW `SuppliersScreen.tsx`, route in paths/App. Blocks: summary; party selector; open bills; record payment; unallocated advances; payment history; selected shop ledger. Owner-only void/release controls; accountant read-only; cashier blocked by route and server. Changing party/shop with a draft offers save/discard; UNKNOWN attempts remain tied to original identity. Returning to screen surfaces unresolved attempts before another payment to that account, with a clear recovery action.

Labels distinguish “Record payment already made” from initiating a bank transfer: this app records money movement; it does not actually send money. Confirmation shows payee, date, mode, total, bill allocation and remaining advance. This prevents a user interpreting a record retry as another bank transfer.

E2E: partial bill + advance, allocate remaining, release matching, void; permissions; same supplier two shops; response lost after commit; offline before dispatch; refresh after dispatch; another tab; switch user; auth expiry; invalid acknowledgment. Confirm database row counts and ledger totals, not just success toast text.

### C3 — Existing customer path and UNKNOWN alignment

Files: latest customer wrapper/private body definitions, NEW migration, `packages/adapters/src/sales.ts`, existing outbox/transport tests. Add versioned `record_customer_payment_v2` using the same normalized request/result model and dated allocations; POST_SALES, same customer/shop, incoming only. Add `allocate_customer_payment_v2` for previously unallocated receipts; effective date today. Existing immediate-sale tenders continue through post_sale.

Keep old endpoint signature for rolling compatibility. For newly submitted calls to that endpoint after the migration, route through the new implementation with operation `customer.record.legacy-v1` and normalized old payload. For a truly pre-migration payment with no stored request, return only through a documented legacy-reconciliation branch after comparing all reconstructible fields and allocation identity; any ambiguity raises `DSB_LEGACY_REQUEST_UNVERIFIABLE` and requires read-only status reconciliation. Never pretend an inferred payload is an exact historical fingerprint. Do not duplicate a historical receipt to resolve this warning.

Audit existing post_sale/post_purchase direct-online idempotency as well: the sync sale wrapper has intent fingerprints, but bare private posting bodies may only match an ID. Add versioned request-aware wrappers for direct callers in this packet; preserve old offline replay paths and their Batch B fingerprint checks. A compatibility fixture from the baseline is mandatory.

For existing outbox `pending/sending/retry`, add explicit unknown outcome metadata and reconcile-by-client-ID adapters for sale/return before retry. Do not make a second queue. Persist target/fingerprint and maintain chronological outbox blocking where already required. `pendingReturnVoid` must continue blocking sales and new returns until server confirmation. No local stock release on an unverified response.

Compatibility tests: baseline offline sale → upgrade → sync; baseline pending return/void → upgrade; same ID changed customer/payment/allocations rejected for new requests; exact retry after return/void; no cashier supplier visibility through generic lookup; permission revoked after earlier unknown commit; current shop-day reconciliation still matches. All existing sale-ack, rounding, hold-label and refund tests remain green.

---

## 9. D1: dated allocations and shop ledgers (item-sales fixed earlier, in P2 — see §5a)

D1 no longer contains the item-sales fix. That correction has no dependency on C0a's `effective_date` column or on any C1–C3 work, so it moved to standalone packet P2 (§5a), scheduled immediately after P1. This section covers only §9.2–9.4, which genuinely depend on C0a.

### 9.2 Temporal outstanding contract

NEW private SQL functions `customer_outstanding_as_of(shop,date)` and `supplier_outstanding_as_of(shop,date)` return open-item details including document ID, account ID, business_date, signed due, clamped due, historyCompleteness. Permission belongs in their public report wrappers; revoke private helpers from all browser roles.

For as-of D:

- Include active source documents with business_date≤D.
- Include active returns with business_date≤D and active source document.
- Include active payments with business_date≤D, but only allocations with effective_date≤D.
- Include linked customer refunds with business_date≤D.
- After F2, include opening rows with as_of_date≤D, settlements and credit applications with effective_date≤D.
- Apply current VOID exclusion at every D, explicitly restated. Do not use `voided_at>D` to partly implement incompatible semantics.
- Reject null/invalid date bounds and unauthorized shops. Future-dated documents excluded. `as_of=today` equals current view only if fixtures contain no future-effective events; otherwise compare both using the same cutoff, not an invalid universal equality assertion.

Aging buckets by age of source document: 0 days, 1–30, 31–60, 61–90, >90. Existing `not_due_paise` wire name can remain for compatibility, but UI label “0 days” because there is no due-date/credit-terms model. Negative balances and advances appear separately, never disappear inside clamped debt buckets. New JSON v2 includes detail rows, totals, credits/advances, net ledger balance, date, shop and restatement/history labels.

NEW `get_customer_aging_report_v2(shop,date)` and `get_supplier_aging_report_v2(shop,date)`. Keep old customer signature; delegate legacy columns from new result during transition. Never change an existing RETURNS TABLE shape in place without deliberate drop/recreate/grant/caller migration.

### 9.3 Shop ledgers and accounting bridge

NEW `get_customer_ledger_v2` and `get_party_ledger_v2`: permission+shop assertion; compute cumulative balance from all eligible entries through p_to within that shop, then filter displayed rows by p_from. Return openingBeforeRange, entries and closingBalance. Sorting tie-break: business_date, created_at, event-type stable rank, UUID; never nondeterministic tied rows.

Account bridge must reconcile:

`sum(signed invoice dues) + sum(signed remaining openings) − unassigned customer incoming cash + unassigned customer outgoing cash = customer ledger balance`. Assigned cash includes invoice allocations, opening settlements and invoice-linked refunds already incorporated in signed due; do not count a linked refund again as unassigned. For suppliers, use signed bill dues (including linked supplier credit receipts) + signed remaining openings − unassigned party outgoing cash + unassigned party incoming cash. A cash amount is assigned exactly once in its applicable source family. Generate the bridge from canonical source rows, not a fragile shortcut. Supplier bridge mirrors the appropriate cash signs. Document the derivation and assert it on fixtures with returns-after-payment, advances, release and void.

Do not assume sum(max(invoiceDue,0)) equals ledger balance; credits and unallocated payments make that false. Show gross receivables/payables, credits and net position as separate figures.

### 9.4 Required tests and performance

Payment Jan 1 / bill Jan 1 / later allocation Feb 1: report Jan 15 keeps bill due and advance separate. Report Feb 1 reflects allocation, net account balance unchanged. Void February transaction restates earlier results per label. Return/refund later than report date excluded. Same account two shops isolated. Payment before bill date rejected for immediate allocation; later allocation date obeys both dates. Legacy inferred allocation date carries flag. Large report sums return exact decimal strings. Query indexes use tenant/shop/account/date and allocation document/date/status; EXPLAIN on 100k invoices must avoid a helper call per row that creates quadratic scans.

---

## 10. D2: settings and receipts

Migration changes latest nine-argument update_shop_settings while keeping compatibility. Lock shop row before comparing policy fields. Validate timezone with `pg_timezone_names`; trim and store canonical accepted input. Manager may edit allowed profile fields, but only owner changes allow_negative_stock. Reject unrecognized printer width. Fiscal month remains frozen until F1 supplies its guarded implementation.

Settings UI uses adapter types already mapped to camelCase (`tenantId`, `printerWidth`, etc.). Provide a supported timezone list without assuming every browser implements Intl.supportedValuesOf. Validate on server even if select is constrained. Disable owner-only fields using a capability helper; do not trust a disabled HTML input.

Receipt correctness has two parts:

1. NEW `ReceiptHeader.tsx` and shared print layout consume shop name/address/GSTIN, actual printer width, doc number, original finalized date and provisional status. Print 58/80mm content with explicit margins, no dark background, no browser navigation, no truncated totals. A4 remains supported. Do not claim a 58mm paper has 58mm printable width; allow a tested content margin profile.
2. NEW `document_profile_snapshots` (standard columns, tenant/shop FK, document kind+ID unique) stores issuer name/address/GSTIN and numbering display for new finalized sales/returns. Write it transactionally through posting wrappers; current print preferences can choose width, but historical issuer identity is immutable. Existing records without snapshots show “Reprint uses current shop profile” until an owner-reviewed baseline snapshot is recorded; never fabricate historical identity.

Cashier may read profile snapshots for sales they can already read, never private supplier documents. Snapshot capture must work through direct and offline sync posting. Offline provisional receipt uses cached shop profile with provisional label; after confirmation it uses server snapshot. Cache is scoped tenant/user/shop and cleared or isolated on identity change. Failure to load profile must show an explicit incomplete receipt, not silently “DSB Store”.

Tests: manager name update allowed/negative-stock toggle denied; invalid timezone rejects without partial update; racing manager/owner policy update cannot override; print under Hindi/English/dark; long names/addresses; receipt after shop rename keeps recorded issuer; offline upgrade receipt corrected from authoritative acknowledgment. Physical printer test stays human evidence.

---

## 11. D3: export completeness and portable restore

### 11.1 Versioned manifest

NEW `scripts/export-tables.json` is the reviewed source map, with entry `{table,key,scope,primaryKey,columns,generatedColumns,restoreOrder,policy}`. Enumerate every public base table, including control tables without tenant_id. Each is either exported in an appropriate profile or explicitly excluded with reason and reconstruction method. Do not export views as independent facts.

Profiles: operator disaster recovery (all tenants, server-only, encrypted); authorized tenant/shop business export; device offline billing snapshot (subset, labelled clearly). Membership/auth/key material is not blindly copied into ordinary user exports. Public dump + separate auth dump remain the full DR authority. Device billing snapshot is not full accounting history.

Replace hand-maintained nightly SQL with a generator reading the manifest. Query in one consistent transaction/snapshot; deterministic table/row ordering. Large exports stream to disk, not one unbounded JS object. Add all new tables in the same packet as their creation. `syncIdempotencyKeys` and `stockCountLines` were already present; returns were missing. Preserve existing names where possible.

Envelope v5: formatVersion, exportKind, sourceSchemaVersion, appCommit, exportedAtUTC, scope, tableSchemaManifestHash, tables and verification manifest. Do not confuse format version with database schema negotiation version. Support legacy v3/v4 readers through explicit adapters, never by guessing absent financial fields are zero. F2 and Phase 8 bump format only when contract changes, updating reader matrices.

### 11.2 Export coverage and restore design

NEW `scripts/test-export-coverage.mjs`: compare manifest with pg_catalog base tables and actual columns, keys and generated fields. Fail on unclassified table/column or unknown mapping. Test permission differences across profiles. Include references to off-database attachments with checksum, provider/path and missing-asset status; database JSON alone does not back up image bytes.

NEW `scripts/restore-business-json.mjs` is an operator CLI for **empty disposable targets only** by default. Production replacement is not an in-app one-click operation. Validate file checksum/schema, permitted versions and a hard target identity allowlist. Begin transaction; load parent before child; omit generated columns; preserve immutable row data. Disable user triggers only in this privileged clean-target restore transaction when necessary to avoid double-posting stock/audit, then restore normal trigger state before commit and validate all FKs/invariants. PostgreSQL constraints, ownership and role setup are verified after restore; never use “disable triggers” as application logic.

For Supabase target, restore/map auth identities before FK-dependent business rows, using the existing auth recovery path. Portable Postgres target uses the existing auth bootstrap stubs and is labelled a data portability proof, not a working hosted login proof. Preserve timestamps, UUIDs, doc sequences, request payload/results and allocation effective dates.

### 11.3 Proof stronger than row counts

Create non-empty fixtures through real RPCs for sales, returns, suppliers, openings, advances, allocation release/void and later orders. Export → fresh target → compare canonical row hashes excluding only documented environment-specific values. Compare totals by tenant/shop/day/account, ledger balances, stock projection, reservations, next-number continuation, request results and attachment hashes. Run check_invariants; replay selected request IDs and prove no extra payment/sale/stock movement. Exact content comparison detects corruption that row counts cannot.

Also prove unknown format refuses before writes; one corrupt amount fails hash; missing request table fails coverage; wrong tenant target refuses; halfway restore rollback; duplicate import refuses; repeated import does not silently append. Keep evidence with input hash and target ID. Existing privileged fixture is retained for its original purpose but does not substitute for RPC-generated realistic fixtures.

UI export ZIP must still contain usable JSON/CSV/PDF artifacts. CSV cells beginning `=`, `+`, `-`, `@` in free-text columns require safe spreadsheet export handling; numeric fields remain typed values, not corrupt text. Open exported files outside the app as human gate.

---

## 12. D4: health, alerts and operating status

NEW `health_checks` server-written table: standard id/tenant/shop where appropriate, checked_at, check_kind, status (`OK`,`WARNING`,`ERROR`,`UNKNOWN`), payload jsonb, source_run_id unique within check_kind, app_commit. Account-sensitive payloads report aggregate counts only to reporting roles. Cashiers get a separate minimal readiness RPC with allowed-to-bill flags and owner-contact instruction; no financial totals or backup credentials.

Keep check_invariants backward-compatible top-level `ok` and numeric fields. NEW versioned health response describes checks as `{code,value,severity,messageKey}`; UI renders all received codes, including unfamiliar ones with readable fallback. Unknown boolean fields must not be incorrectly interpreted as numeric violations. Preserve the distinction between allowed negative-stock warnings and actual policy violations.

Nightly job runs invariants through a dedicated service/operator path with explicit tenant/shop loop; an unauthenticated service-role call to a user-context RPC must not accidentally get an empty tenant and green result. Write success/failure freshness evidence. A failed job or stale check is UNKNOWN/ERROR, never stale green. Schedules need monitoring; creating a cron line is not proof it ran.

Readiness panel: DB reachability, sync state, oldest pending/unknown attempt, conflicts, backup age and both verified destinations, last restore drill, app/schema compatibility, attachment backup status, storage warning if measurable. Tenant-private data stays owner/manager/accountant as existing permissions allow. Cached readiness has checked-at timestamp.

Invariant failure blocks relevant risky posting only when policy explicitly defines the blocking condition; it must not make offline billing depend on a live health RPC. Schema below minimum blocks sync with update instructions and retains outbox. Backups overdue alerts owner; it does not destroy billing availability. No false “saved locally” text for online-only payments.

Tests: newly added invariant visible; malformed payload; stale timestamp; failed scheduled write; no-tenant service call refuses; cashier safe summary; owner detailed summary; restore evidence survives export; denied health RPC does not crash login or POS.

## 13. E0–E3: complete the shop UI without weakening billing

### E0 — Localization and error contracts

Files: replace `lib/i18n.ts` with `lib/i18n/index.ts`, `en.ts`, `hi.ts`; update LanguageToggle; extend adapter errors; NEW ErrorNotice and attempt-aware messages.

Typed dot-path keys from English object; Hindi uses recursive string-shape mapping, not literal English string types. Compile-time key parity, runtime placeholder parity, no empty translations. Interpolation escapes through JSX text. Locale observable must trigger every subscribed screen; localStorage alone does not rerender Preact. Preserve `dsb-pro-locale` preference compatibility. Group by common/nav/pos/returns/suppliers/customers/inventory/reports/settings/sync/team/devices/auth/errors.

Error categories: validation, permission, offline-not-sent, queued-offline, unknown-outcome, auth-expired, conflict, invariant, server. Classify using structured SQL code/details and known HTTP transport conditions; preserve original diagnostic safely. A network exception after dispatch is UNKNOWN, not “not saved”. Queued text is permitted only after Dexie transaction succeeds. Auth-expired keeps drafts and pending attempts. Unknown/unmapped server errors get a safe actionable message and correlation ID without PII.

Migrate new C/D screens to this infrastructure first; E1 then covers the remainder. New C2 screens may ship with the existing t() infrastructure temporarily, but must add keys in both languages in their own PR. Do not require importing a future uncreated module.

### E1 — Screen coverage, navigation and dashboard

Translate every user-visible string in actual screen inventory, including dialogs, placeholders, empty states, aria-labels, errors mapped from stable codes and print labels. Backend raw unknown messages remain diagnostic, not a substitute for translated UI. Hindi review remains open until a speaker checks shop terms; machine draft is not signed off automatically.

NEW capability helper derives UI visibility from effective permissions. Backend permission checks remain authority. Cashier navigation: Home, Sales, Returns, More→Customers/Sync; Inventory only if an explicitly permitted read-only view exists. Report roles see suppliers/reports; owner sees team/admin actions as permitted. Keyboard shortcuts cannot bypass route guards. Mobile bottom nav: Home, Sales, Returns, Stock, More; Phase 8 replaces the agreed slot with Orders only after Orders exists, moving Returns into quick actions/More. Desktop retains efficient keyboard navigation.

Dashboard role-specific. Owner/report roles: day book, net sales, receipts, purchases, payments out, low stock, sync/health. Cashier: POS launch, their permitted sales/reconciliation view and sync status; no private purchase cards. Use correct server shop date; no report RPC calls merely hidden by CSS.

### E2 — Async state, accessibility, theme and print

NEW AsyncState component represents loading/empty/error/ready plus explicitly labelled cached data. Keep dirty form state independent of fetched rows. Request cancellation or generation IDs prevent stale responses overwriting a newer shop/account selection. Stable keys for dynamic siblings and row identities; don't use array index as key for editable lines. Preserve #35 same-input-node regression.

Theme System/Light/Dark; persist preference; force print light colors. Label every form input, visible focus, no focus traps, 44px important touch targets, keyboard dialogs with focus restoration, aria-live success and role=alert errors. Add pinned axe-core Playwright dependency; require no serious/critical accessibility violations on core flows and manually check printer/keyboard behavior.

Translations and theme must not alter paise parsing, date interpretation, serialized requests, stable test IDs or stock quantities. Locale formatting is display only. `toFixed` is allowed only for already-safe numeric display, never to produce financial input.

### E3 — Full rehearsal and integration gate

NEW `apps/admin/e2e/shop-rehearsal.spec.ts`, golden fixture JSON, `docs/DRY_RUN_CHECKLIST.md`. Build fixtures independent of production. Exercise 5 items, three units, two suppliers, two customers, multiple tenders, 20 sale lines, header+line discounts, fractional quantities, held cart, offline restart, returns in each valid disposition, prior-day returns, credit customer settlement, supplier partial/advance/later allocation/release/void, expenses and physical count.

Compute expected totals with independent integer reference vectors, not app report helpers. Verify invoice/return documents, payment modes, account ledgers, day book, GST merchandise reconciliation, stock movements/projection and every invariant. Compare counts and values after refresh/restart and in exported artifacts.

Full test suite commands follow current repo scripts: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, local Supabase reset/test, existing concurrency scripts, `pnpm --filter @dsb-pro/admin run e2e`, production-env build and existing bundle/installability scripts. See §21 for exact execution boundaries. Full E2E is not the 10× stress target; retain the targeted pos-cart repeat and add targeted unknown-payment/order stress only where a concrete race warrants it.

Performance: existing 10k item/100k invoice/three-device profile, <300ms billing search and <60s full pull under declared conditions. Record hardware, dataset, network shaping and sample distribution. New online-only finance serialization must not regress ordinary billing materially. Bundle measured with production environment and no secrets in output. Run all gates twice unchanged head.

---

## 14. F0–F1: legacy evidence and fiscal numbering

### F0 — Obtain and inventory real legacy export early

Input: one full old-DSB export from Apd, original file bytes and SHA-256, export timestamp/timezone, date coverage, whether stock is current or opening, and the authoritative supplier/customer balance report or independently confirmed balances. Old DSB was used for purchases and payments, not sales invoices; do not demand nonexistent sales history.

NEW `docs/LEGACY_DATA_INVENTORY.md` records field names/types, entity counts, duplicates, signs, unit conventions, IDs, deleted/void behavior, missing relationships, file version and attachments. Real customer data and exports must not enter a public repository or ordinary CI artifacts. Store sensitive fixtures privately; create anonymized synthetic structurally faithful fixtures for repo tests.

Mapping contract is versioned by source format plus content hash. If source values disagree with computed purchase−payment balances, preserve both and require an explicit reconciliation decision; never select whichever makes the test pass. Empty/missing money is an error unless the source specification proves a zero default. Duplicate IDs, bad unit factors, invalid dates and unexplained negative stock are blocking errors, not warnings that skip rows.

If export is not yet available, implement canonical importer contract and synthetic tests. Mark source adapter and real parity BLOCKED_EXTERNAL_INPUT. Do not guess root field names beyond the already-known v3 bridge. Ask once for the export while proceeding with independent work.

### F1 — Numbering contract

NEW private immutable `dsb_fiscal_year_label(p_date date,p_start_month integer) returns text`. It reads no tables. NEW stable `dsb_shop_fiscal_year(shop,date)` validates access in public caller and reads shop setting. Pure reference implementation is in Appendix A.

NEW number allocator `dsb_next_fiscal_doc_no(p_shop_id uuid,p_doc_type text,p_business_date date) returns table(doc_seq bigint,doc_no text,fy_label text)`, internal only. Allowed doc types SALE, SALE_RETURN, PURCHASE_RETURN; own purchase supplier bill_no is never overwritten. Series keys are document type + FY (e.g. `SALE:2026-27`), not user-changeable prefix. For calendar-year start January use label `2026` rather than misleading `2026-27`; other starts span years.

Number format: `<document prefix>/<FY start year YYYY>/<sequence padded to at least six digits>`, default `INV/2026/000001` (15 characters). Store/report the full FY label separately. Enforce an ASCII alphanumeric prefix of 1–3 characters and a final number length ≤16; reject before posting if the sequence would exceed the limit. Never silently truncate. Warn the owner well before sequence capacity is exhausted; adopting a replacement series requires an explicit reviewed numbering amendment. The prior `INV/2026-27/000123` example is 18 characters and is deliberately rejected. **Do not use fixed-width lpad that truncates a seven-digit sequence.** Use `lpad(seq::text,greatest(6,length(seq::text)),'0')`. Initial sale prefix is shop invoice_prefix (non-empty fallback INV), initial return prefixes SR/PR; the registered per-shop series map below becomes authoritative and settings updates keep invoice_prefix compatible. Validate prefix length/characters and prohibit ambiguity; document unique constraints are the final authority. CBIC describes a maximum 16-character tax-invoice serial in its official Rule 46 guidance (source in §22). This is one formatting rule, not a claim of complete GST invoice compliance; the full receipt profile still needs the applicable pre-live check.

Add NEW `document_number_registry` (standard columns, document_kind/source ID, issuer_scope, fy_label, doc_no) with unique(tenant_id,issuer_scope,fy_label,doc_no). For a registered shop issuer_scope is its normalized GSTIN; for an unregistered shop it is a reviewed business issuer identity, not an arbitrary per-device value. Every new sale/return issuance registers in the same transaction. Source validation proves the document belongs to tenant/shop. Shared-registration shops require distinct configured prefixes/series or a shared allocator; choose distinct prefixes in v1, including shop-specific return prefixes in NEW `shop_document_series` (standard columns, doc_type, prefix, unique tenant/shop/doc_type). Seed own-shop SALE=INV, SALE_RETURN=SR, PURCHASE_RETURN=PR only after checking collisions. Add a registration-scoped lock after the shop finance lock and before the request lock for series configuration/issuance; F1 updates the public issuance wrappers to take it before entering the existing request-locked posting body. Insert the registry row after the actual document row exists, in the same transaction while the issuer lock remains held; database registry uniqueness remains final defense. Changing a shop profile/GSTIN after numbering requires owner review and an explicit new issuer scope; it cannot retroactively rewrite previous registry rows. Backfill historical registry entries only after collision inventory; mark unresolved legacy conflicts and block enabling affected new series, rather than renumbering old documents. Cross-deployment uniqueness for one registered business must be addressed in its deployment configuration; separate databases cannot enforce a shared unique constraint.

Settings fiscal month freezes permanently after first FY issuance in that shop. Prefix changes do not reset sequence; new numbers use new prefix, prior snapshots remain. Hold shop finance lock and shop row while checking settings/allocating, so settings cannot race posting. Keep old next_doc_no for legacy callers where necessary, revoke unnecessary direct public allocation rights after caller audit. A user-callable allocator that consumes numbers without a document is not needed.

Modify the effective sale private body and effective return body only at number/date assignment. Read latest definitions including 0039 and 0043 wrappers. Do not rewrite money, refund or stock logic. Snapshot fiscal label/numbering scheme on documents or profile snapshot atomically; keep old rows labelled legacy. For polymorphic document_profile_snapshots, a validation trigger must prove that the referenced sale/return exists in the same tenant/shop and kind; a generic UUID column is not itself a source FK. Request replay returns original number before any new allocation, including across FY boundaries or settings changes.

Tests: Mar31/Apr1, Dec31/Jan1 with January start, leap day, every start month, shop timezone around midnight, backdated transaction to valid FY, null date resolves once, same request across midnight/FY, 50 parallel sales, rollback counter behavior, void never reuses number, prefix edit, same-registration shops attempting duplicate series/numbers, sequence 999999→1000000, invalid prefix/month, offline provisional→official acknowledgment, restored sequence continues above maximum used. “No duplicate committed number” is the acceptance rule; do not assert no gaps under every operational circumstance.

---

## 15. F2: opening balances and settlement design

This section replaces the prior unallocated-payment shortcut. Use a generic account table to avoid duplicating the same logic inconsistently for customers and suppliers.

### 15.1 Tables and constraints

NEW `account_openings`: standard columns; account_kind (`CUSTOMER`,`SUPPLIER`), customer_id nullable, party_id nullable, as_of_date, amount_paise bigint nonzero, status POSTED/VOID, source (`LEGACY_IMPORT`,`MANUAL`), source_hash nullable, source_ref text, voided_at, reason. Exactly one account FK populated consistent with kind; tenant-composite customer/party/shop FKs; unique(tenant,id), unique(tenant,client_id). Partial unique indexes `(tenant,shop,customer_id) WHERE status='POSTED' AND account_kind='CUSTOMER'` and equivalent party index. This permits corrected replacement after an opening is voided; it does not allow duplicate active opening debt.

NEW `opening_payment_settlements`: standard columns; opening_id, payment_id, amount_paise positive, effective_date, status POSTED/VOID, voided_at. Composite tenant FKs, unique request child client_id. No direct browser writes. Trigger checks same tenant/shop/account, payment direction as below, active sources, date bounds and budget.

NEW `opening_credit_applications`: standard columns; opening_id (negative only), doc_type SALE/PURCHASE, sale_invoice_id or purchase_bill_id exactly one, amount_paise positive, effective_date, status POSTED/VOID, voided_at. Same identity/date validation, active source/target, document due and opening-credit budget. Non-cash: no payments or stock rows created.

NEW `supplier_credit_receipts`: standard columns; purchase_bill_id, incoming party payment_id, amount_paise positive, business_date, status POSTED/VOID, voided_at. This records actual supplier reimbursement of credit created by returns after payment. See §15.4 for its capacity rule. It is distinct from an opening credit settlement.

All tables: immutable economic columns; POSTED→VOID only through RPC; updated_at and audit; RLS SELECT by account visibility and shop; authenticated SELECT only where the UI needs it, otherwise RPC; no insert/update/delete browser grants. Extend backup/export/manifests/types/restore before this packet is accepted.

### 15.2 Cash signs and capacities

| Account / opening sign | Meaning | Cash settlement payment |
|---|---|---|
| Supplier positive | We owe supplier | party/out |
| Supplier negative | Supplier owes us | party/in |
| Customer positive | Customer owes us | customer/in |
| Customer negative | We owe customer | customer/out, explicitly linked to opening settlement |

A cash settlement consumes both the payment's unallocated capacity and the opening's remaining magnitude. A customer/out opening reimbursement is not a sale return refund: identify it through settlement linkage and do not fabricate source_sale_return_id. Tighten new direction invariants so such outflows are permitted only with a valid opening-credit settlement; existing sale refund linkage remains valid.

Payment budget used is the sum across payment_allocations and opening_payment_settlements. supplier_credit_receipts consume the full corresponding incoming payment and cannot be reused for opening settlement. New combined-budget constraint triggers run after changes to either table; they lock the payment row under the shop lock and check the combined total. Redefine phase4_check_payment_sum to use the combined helper so existing endpoints cannot bypass the new budget.

Opening positive capacity: amount − POSTED settlements. Negative capacity: abs(amount) − POSTED settlements − POSTED credit applications. Reject overuse; return net remaining as integer text. Credit application reduces document outstanding but does not change the signed ledger balance. Reporting includes remaining negative opening credit separately.

### 15.3 RPCs and workflows

```sql
record_account_opening(p_shop_id uuid,p_account_kind text,p_account_id uuid,
 p_as_of_date date,p_amount_paise bigint,p_reason text,p_client_id text) returns uuid;
settle_opening_from_payment(p_opening_id uuid,p_payment_id uuid,
 p_amount_paise bigint,p_client_id text) returns uuid;
record_opening_cash_settlement(p_opening_id uuid,p_amount_paise bigint,
 p_business_date date,p_mode text,p_reference text,p_client_id text) returns jsonb;
apply_opening_credit(p_opening_id uuid,p_doc_type text,p_doc_id uuid,
 p_amount_paise bigint,p_client_id text) returns uuid;
void_opening_application(p_application_id uuid,p_reason text,p_client_id text) returns uuid;
void_account_opening(p_opening_id uuid,p_reason text,p_client_id text) returns uuid;
```

Owner records/voids openings. Positive supplier settlement can be posted by POST_PURCHASES; positive customer settlement by POST_SALES. Any cash reimbursement of a negative opening and any credit application/void requires owner (VOID_SALES) in v1. Future delegation can use new permissions with tests. All mutating endpoints use financial_requests and shop-first lock.

`record_opening_cash_settlement` atomically creates the correct payment and its settlement. `settle_opening_from_payment` can use a matching existing advance; effective_date=today; never before source dates. Customer incoming advance already allocated to an invoice has no remaining capacity for opening debt. UI offers explicit amount/target, not invisible automatic assignment.

Void payment cascades its settlement statuses, restoring opening capacity, in the same transaction. Void source opening refuses while active settlements or credit applications remain. Void a target sale/purchase first reverses its opening-credit applications (no cash), then executes existing document void rules. Preserve refund-protection rules: if a return has paid cash using receipts affected by the void, the existing guard still blocks it. A deleted/moved customer/party cannot orphan an opening.

### 15.4 Supplier return-credit reimbursement

NEW `record_supplier_credit_receipt(p_shop_id,p_purchase_bill_id,p_amount_paise,p_business_date,p_mode,p_reference,p_client_id) returns uuid`, owner-only. At the shop lock, compute bill credit from posted returns and outgoing allocations, subtract prior active incoming reimbursements. Amount ≤ credit. Create party/in payment and supplier_credit_receipts row atomically. Bill signed due now adds these reimbursements: original total − returns − outgoing allocations + incoming reimbursements − opening-credit applications.

Prevent invalidating a reimbursed credit: release/void of an outgoing payment allocation or void of a purchase return is rejected if the recomputed bill credit capacity would become negative after existing reimbursements. User voids the incoming reimbursement first if that cash record was itself erroneous. Do not record a cash reversal that did not happen. Test every ordering, including partial reimbursement and return void.

A supplier credit due to a negative opening uses opening_payment_settlements, not supplier_credit_receipts. Distinct source linkage avoids spending one credit twice. For customer return-credit behavior, retain the existing cash-refund/balance-credit policy and tests; do not change it merely to make this model symmetrical.

### 15.5 Integration and acceptance vectors

Update customer_ledger/customer_balances compatibility views or their versioned replacements so all customer-balance consumers—including CustomersScreen, reconciliation and exports—include openings. Update party ledger, supplier outstanding, both aging paths, payment remaining-capacity UI, account bridge and invariant RPC. Enumerate every old raw sum in source; missing one consumer is a packet failure.

Test vectors in paise:

- Supplier opening +100000; outgoing payment 40000 allocated to opening → remaining opening 60000, ledger 60000, unallocated payment 0.
- Same payment cannot also allocate 40000 to a bill. Void payment → opening 100000 and ledger 100000.
- Supplier opening −50000; new bill 80000; apply opening credit 30000 → bill due 50000, opening credit left 20000, net ledger 30000. No cash movement.
- Customer opening −50000; cash refund 20000 → remaining credit 30000 and ledger −30000; no sale return fabricated.
- Void opening with active application fails; void application then opening succeeds; replacement active opening allowed without deleting the old one.
- Bill 100000 paid 100000 then return 30000 → supplier credit 30000; incoming reimbursement 20000 → residual credit 10000 and ledger −10000. A second reimbursement 20000 fails.
- Two concurrent settlements of 60000 against opening 100000 → one succeeds. Two concurrent target applications cannot overspend credit. Different shop/account/tenant rejected.
- As-of before settlement/application excludes it; restated void behavior labelled; all source sums exact; export→restore→same-request retry cannot duplicate.

---

## 16. F3–F5: strict import, rehearsal and cutover

### 16.1 Canonical import contract

NEW `packages/core/src/legacyImportV2.ts`, `legacyImportV2.test.ts`; NEW `packages/adapters/src/legacyImportV2.ts`; NEW `scripts/legacy-dry-run-diff.mjs`; new migration with `import_batches`, `import_identity_map` and canonical apply RPC. Existing v3 bridge remains for historical test/rehearsal compatibility, not production cutover.

Canonical envelope:

```ts
type CanonicalImport = {
  formatVersion: 1;
  sourceSystem: 'old-dsb';
  sourceSha256: string;
  sourceExportedAt: string;
  cutoverBusinessDate: string;
  shopId: string;
  items: Array<{
    sourceId: string; name: string; unit1: string;
    unit2: string | null; unit3: string | null;
    conv1: string | null; conv2: string | null;
    stockBase: string; costLastPaise: string | null;
    prices: Array<{kind:'retail'|'wholesale';unitLevel:1|2|3;paise:string}>;
  }>;
  parties: Array<{sourceId:string;name:string;phone:string|null;address:string|null;gstin:string|null}>;
  customers: Array<{sourceId:string;name:string;phone:string|null;address:string|null;gstin:string|null}>;
  openings: Array<{kind:'SUPPLIER'|'CUSTOMER';sourceAccountId:string;amountPaise:string}>;
};
```

Include other master fields needed by actual source mapping (SKU, tax/HSN, barcodes, active status) in a versioned schema amendment before applying real data. All field additions are validated; no arbitrary JSON passthrough. Money signed integer strings, quantities nonnegative fixed-point strings. A signed opening parser handles minus explicitly; never feed a negative string to the existing non-negative parseRupeesToPaise and silently clamp it.

Validation returns errors/warnings per source ID plus counts/sums and a deterministic normalized plan hash. No writes on upload or preview. Unknown source version blocks. Mapping must explain units and rounding: fractional rupees convert with fixed-point half-up; representationally missing source precision is recorded, not recreated. Duplicate names do not imply same account; stable IDs or a reviewed mapping resolve them.

### 16.2 Import identity and apply

import_batches stores standard tenant/shop fields, source hash, canonical plan hash, mapping version, status COMPLETED/VOID (or a separately staged state only if explicitly needed), result counts/checksums and request ID. import_identity_map records batch/source-system/entity/source ID→target ID with tenant/shop and uniqueness; source ID alone is not globally unique. Insert IDs deterministically from an approved mapping or persist generated IDs in transaction; comparing clean-target results may use logical source IDs instead of expecting random UUID equality.

Public `preview_legacy_import_v2(shop,plan)` owner-only read-only validates against current target and returns preview+planHash+targetStateHash. Public `apply_legacy_import_v2(shop,plan,expectedPlanHash,expectedTargetStateHash,clientId)` owner-only, takes shop lock, exact request check, validates target still matches preview, then imports masters, prices, opening stock once, openings, identity map and completed result atomically. Source hashes and idempotency protect repeat uploads under changed client IDs; same source+plan returns prior result, different plan for same completed source rejects for explicit reconciliation.

Default target is a fresh dedicated production shop/tenant with no business activity; rehearsal data belongs in a separate project and is never deleted from production by this importer. Tenant-shared masters complicate multi-shop imports: v1 own-shop cutover requires a fresh tenant; S4 handles later tenant consolidation. Enforce that assumption, not just “shop has no purchases”.

Do not import historical purchase bills into the opening-stock target. Archive them for reference and parity evidence. If later full-history import is requested, it is a separate mode with zero duplicate opening effects and its own plan. Import cost_last explicitly when trustworthy; absence is visible “valuation unavailable”, never invented zero-cost profit. For initial prices set valid effective dates from source/cutover policy, preserving no-overlap constraints.

Unexplained negative legacy stock blocks. Apd may approve a counted opening stock with a documented difference; importer records that reviewed adjustment, not an automatic clamp. Unexplained balance differences likewise block.

Large payloads: benchmark realistic source size before production. Default limit 10,000 items and a bounded serialized payload tested on target. If it exceeds request/transaction limits, implement an owner-only staging batch with chunk hashes and **one atomic validated finalization**; incomplete chunks never become sellable stock. Do not replace atomicity with partial committed business rows. Mapping inspection determines whether this extra transport packet is necessary; define it as F3-L with identical canonical contract.

### 16.3 Dry-run and acceptance report

Report counts, price/stock quantities, per-account signed openings, total amounts, missing assets, ignored fields, duplicate IDs, date errors, invalid units, unapplied rows, exact differences and approved explanations. Explanations contain source ID, field, old/new value, reason and reviewer—not a wildcard “accepted differences”. Sensitive report stays private.

Two proofs are different and both required:

1. Reproducibility: same source + mapping against two equivalent clean targets yields identical normalized semantic diff, excluding target-generated IDs/timestamps explicitly.
2. Idempotency: same input applied twice to the **same target**, including changed transport request ID, creates no extra master, stock, opening or financial effect.

Inject failure after prices and before openings: transaction rolls back all. Change target after preview: stale target hash blocks. Lost response after apply: reconcile batch/request ID. Export/restore imported target and compare logical IDs, balances and stock. Source raw bytes+mapping+plan+diff have SHA-256 recorded in cutover evidence.

### 16.4 Human rehearsal and final freeze

Do one week parallel purchase/payment entry on a **rehearsal deployment** while old DSB remains authoritative; reconcile physical stock and account balances. Run one complete real shop day including synthetic-golden sales where old DSB has no sales comparator. Exercise actual device offline restart and actual printer.

Final cutover uses a fresh production target and a fresh full export after freeze, not a guessed delta applied to the rehearsal database. This deliberately avoids deduplicating parallel-entered transactions. Preserve the rehearsal as evidence; clearly distinguish its URL/icon/banner. Archive old DSB export and make old app read-only operationally. Drain or quarantine every rehearsal offline queue; never point its existing IndexedDB identity at the production tenant.

Sequence: freeze old writes → final export/hash → canonical preview/diff approval → backup target/auth → atomic import → verify stock/openings/numbering/profile → production deploy points to correct tenant → one controlled transaction/reconciliation → first backup verified by restore → switch authority. Every step names who, timestamp, project ID, app SHA and expected totals. Do not let both systems accept authoritative transactions after switch.

Rollback before first production business transaction: keep production closed, restore old authority and discard/quarantine failed new target through an attended operation. After first production transaction: no blind restore to pre-import snapshot; freeze both systems, export the delta and prepare a reviewed reconciliation/fail-forward plan. Preserve every financial document and its audit trail.

Own-shop completion: 30 days monitored, zero app-caused corrections, three copies, both restore targets proven, fallback exercises complete, exported files opened independently and signed runbook. A defect reopens the relevant gate rather than erasing the observation history.

## 17. G0–G6: Phase 8 storefront, orders and friend deployments

Do not start production Phase 8 work before own-shop acceptance. This is a complete design contract for that later phase, not authorization to distract from billing now.

### G0 — Configuration, roles and threat boundaries

NEW `storefront_settings`: standard columns, unique tenant/shop, enabled false default, public_slug globally unique within deployment, display_name, public_contact, pickup instructions, reservation_minutes (default 30, bounded 5–120), max_lines (50), max_qty_base_per_line decimal, order_hours, cancellation policy. Public data is an explicit projection; never expose shops.settings or tenant row wholesale. Owner manages settings; dedicated permissions MANAGE_ORDERS (owner/manager/cashier) and MANAGE_STOREFRONT (owner/manager) added via permissions/role_permissions with SQL tests. Accountant read-only order summary if VIEW_REPORTS.

NEW public gateway service under `services/storefront-gateway/`, standard fetch interface and adapters; deployable to the chosen existing infrastructure with a provider-specific thin binding. Baseline default is Cloudflare Worker. It holds server-only credentials; no service key in static config. Its API is a narrow allowlist, not arbitrary SQL/RPC proxy. If direct Supabase service-role RPC is used, the gateway code never accepts an RPC name or tenant from the client; it resolves slug→shop server-side and calls only the order functions. Service-role compromise is documented as privileged; secrets isolated/rotatable.

Public request caps: JSON body ≤64 KiB, ≤50 lines, text fields bounded, canonical quantity/UUID validation, no client prices, discount or tenant authority. Rate limit per deployment+shop+hashed network identity with bounded retention using a strongly consistent provider primitive, not per-isolate memory. Default proposal: 10 new orders per 10 minutes per source and 60 per shop per hour, configurable after a real usage test. Idempotent status reconciliation must remain available under its own lower-cost quota. Add anti-automation challenge when abuse is detected; fail closed for new order creation if abuse protection is unavailable, but keep catalog read available. Recheck provider service/cost limits when implementing, not from stale master-plan quotas.

Orders collect minimum customer contact for pickup/delivery; Phase 8 defaults pickup only to avoid unspecified delivery fees. Add a delivery mode only with explicit server-priced fee and shop policy. No OTP is falsely implied by accepting a phone number. Do not auto-merge order contact into an existing customer credit account by phone alone.

### G1 — Catalog and safe public assets

NEW `public_catalog` view with `security_barrier=true`, explicit column list, public-enabled shop/item filter; view owned by a controlled trusted owner. Anon SELECT only on this projection; base private tables remain denied. Do **not** set security_invoker=true and then grant anon private base tables to make it work. View output: shop slug, item public ID, name, category label, permitted unit options, retail price integer text, public image URL, in_stock boolean; never exact cost, supplier, purchase, phone or internal stock history. No wholesale/cost_last price path.

Pricing uses the same effective retail precedence as phase4_current_price for selected unit/shop; missing price hides buying option. Expose availability as approximate; actual stock check is in order transaction. Cursor-paginated search/category API; fixed page size ≤100; parameterized queries and bounded search term. Images published as sanitized public derivatives, not a signed URL to an arbitrary private bill-image path. Public image path generation cannot traverse tenant prefixes.

Public caching is keyed by deployment+shop+locale+query. No private response cached with public headers. Short TTL and invalidation on relevant catalog changes; displayed stock can be stale, transaction remains authoritative. Offline catalog may be browseable, but order submit requires connection and never promises reservation while offline.

Security tests: anon direct base tables/functions denied; catalog columns introspected exact allowlist; disabled store hidden; tenant A slug cannot retrieve B private IDs; category/image metadata cannot expose cost; SQL injection and path traversal; error body redacted; no owner credentials in bundles/source maps.

### G2 — Order/reservation model and placement

NEW tables, all standard fields with tenant/shop composite FKs and explicit grants:

- `shop_customers`: order-contact identity only, id, name, normalized phone, optional address; private. Separate from credit-account customers until staff explicitly links through a validated workflow.
- `orders`: public_ref non-sequential random identifier, customer contact FK, status, total_paise, quote_version integer, quote_snapshot jsonb schema-validated, customer_accepted_quote_version, revision bigint not null default 1, reservation_expires_at, cancellation_reason, sale_invoice_id nullable unique per tenant, request_uuid, token_digest, submitted_at, confirmed_at, delivered_at. Money/lines immutable after placement except explicit versioned re-quote before fulfillment; audit changes.
- `order_items`: order FK, line_no, item_id, item/unit/conversion/tax/name/price snapshots, qty/base_qty, line_total_paise; unique(order,line_no); positive quantities and non-negative integer amounts.
- `order_events`: append-only transition, actor, event_time, reason, prior/new status, quote version, client_id. No mutable history.
- `stock_reservations`: order/order_item FK, item, qty_base positive, reserved_at, expires_at, released_at nullable, release_reason (`CANCELLED`,`EXPIRED`,`FULFILLED`), unique active reservation per order_item; no direct client writes.

Initial state NEW; permitted transitions NEW→CONFIRMED→PREPARING→READY→DELIVERED; NEW/CONFIRMED/PREPARING/READY→CANCELLED. Expiry cancels with reason EXPIRED. DELIVERED/CANCELLED terminal; post-delivery correction uses sale return or invoice void workflow, never “cancel order” that refunds nothing. A status request uses an order revision for optimistic concurrency, rejects stale transitions, and replays exact request result idempotently.

Internal `place_order(p_shop_id,p_contact jsonb,p_lines jsonb,p_client_id uuid,p_token_digest text) returns jsonb`, executable only by gateway service, resolves tenant from shop, validates enabled policy, takes shop finance lock then operation lock. Public browser generates 32 random bytes for a receipt token before submission, persists it with request UUID, sends it over HTTPS; gateway hashes it and database stores digest only. Token is not in logs or query strings. Client-supplied digest alone is not authentication: later status calls must present the original token to gateway. Exact lost-response retry returns same order bound to same digest; changed token/payload rejects.

Placement steps: validate input → idempotent lookup → load active catalog item/unit/current server price → aggregate required base quantity by item → lock stock rows sorted UUID → verify available≥required regardless of allow_negative_stock → insert order/items/contact/reservations → increase reserved by exact quantities → record event and request result → commit. No stock_movements or sales/payments at placement. A transaction failure leaves no reservation or orphan order.

Projection uses private reservation trigger/helper under row locks; never lets UI update stock_current. Define active reservation as released_at IS NULL, even if expires_at is past, until the release transaction runs. This avoids an invariant that changes simply because wall-clock time passed. Expired-but-unreleased is a separate freshness warning; placement can synchronously release expired orders under the shop lock before checking availability.

**Required stock-trigger change:** baseline 0042 permits a SALE below reserved when negative-stock override is on. Once reservations exist this can consume customer-reserved stock. New trigger must reject any decrease below reserved when reserved>0, even for an override sale; permit SALE-only negative-stock override only when reserved=0. Preserve positive recovery behavior from 0042. Tests must exercise this exact case.

Expiry worker: scheduled at least once a minute where supported, plus lazy cleanup on order mutation; process bounded batches of one shop at a time, shop finance lock first, then orders sorted UUID, then stock rows sorted UUID. Recheck state/expiry under lock, release once, mark cancelled and append event. If scheduler is down, reservations stay safe but stock may appear unavailable; alert stale expiry and allow owner-run cleanup. No double decrement.

### G3 — Fulfillment, price drift and stock conversion

Public staff RPC `fulfill_order(order_id,accepted_quote_version,p_payments jsonb,p_client_id)` requires MANAGE_ORDERS and POST_SALES; takes shop finance/request lock before order/stock locks. Only READY order with active reservation and accepted current quote can fulfill. Expired orders must be explicitly re-ordered/re-reserved; no resurrection by changing status alone.

Use existing post_sale as the only sale money/stock writer. In one transaction: release this order's reservations with reason FULFILLED, call post_sale with server-built item/unit/qty and tender data, compare the resulting immutable sale line-by-line and total with the customer-accepted order quote, link sale to order, mark DELIVERED and record event/request result. Any price/unit mismatch raises `DSB_ORDER_REQUOTE_REQUIRED`, rolling back reservation release, sale, payments and numbering together. Do not accept client unit prices or hide a price difference in a discount.

Re-quote workflow: before fulfillment, server recomputes quote, increments quote_version and records change; staff obtains customer's approval and records who/when/how. Keep original and new quote snapshots in events. If unit conversion/base quantity changes, atomically release/rebuild reservation under stock locks and recheck stock; otherwise refuse re-quote for discontinued unit and request a new order. Confirmation of a quote is not payment. Plain status transition cannot mark DELIVERED without linked finalized sale.

If anonymous order has no explicitly linked customer account, fulfill as fully paid walk-in. Credit sale requires staff explicitly selecting/validating an existing/new customer through normal authorization and approval, not an inferred phone match. Avoid recording paid twice: order tender does not become a payments row before fulfillment in Phase 8.

Fulfillment exact replay returns original sale even if order later has a post-sale return. Different key after order delivered returns already fulfilled result with no new sale, while incompatible payload requires review. Payment response lost follows the same durable attempt protocol.

Reservation invariants: sum active by item equals reserved; active only for nonterminal orders; fulfilled order has one linked finalized or subsequently voided sale with explicit correction marker; cancellation never creates stock movement; exactly one reservation release per row. A sale void after delivery does not automatically re-open/re-reserve the order; order shows sale voided and staff resolves through a new order if needed.

### G4 — Storefront/admin screens

NEW `apps/storefront` Vite/Preact app; adapters isolate gateway. Screens catalog, search/category, item unit selection, cart, checkout/contact, submitted/unknown/status. Server quote dominates; show stock/price changed clearly. Cart local-only until submit; request UUID/token persisted before send; secure token storage scoped deployment/shop. Status token submitted in HTTPS POST body or Authorization header, no URL/analytics/referrer leakage. User-initiated WhatsApp share contains public order reference and shop contact, never private receipt token or customer address by default. No automated message sending feature assumed.

NEW admin OrdersScreen with filters NEW/CONFIRMED/PREPARING/READY/completed/cancelled, age/expiry, permitted transition controls and fulfillment tender dialog. Realtime update is convenience; polling cursor fallback and manual refresh are supported. Do not render private contact in a public status response; status gives only customer-safe order items/total/status/estimated pickup if configured. Route permissions tested directly.

E2E: two tabs last unit; POS racing order; duplicate order submit; lost response; price changed before fulfillment; partial tender fails walk-in; expire vs fulfill; cancel vs fulfill; quote acceptance; discontinued item; anonymous token guessing; replay with wrong token; malicious price; request size/rate limits; staff role restrictions; offline storefront cannot claim successful reservation; remaining admin offline behavior unchanged.

### G5 — Per-shop deployment and superadmin

NEW runtime config schema `config/env.<deployment>.json`: public project endpoint/anon key, deployment ID, expected tenant/shop IDs or selection policy, gateway URL, app release, storage adapter mode. No passwords/service-role key. Validate config before auth/sync; display explicit wrong-target error; never fall back silently to Apd's shop. Include deployment ID in local database/config identity to prevent two projects with reused IDs sharing cached data. Migrate old own-shop identity carefully without dropping pending operations.

`infra/deploy-tenant.md` sequence: friend owns account/project → invited operator access → separate environments/secrets → migrations from verified SHA → owner onboarding → backups/key custody → config/build → primary/mirror → auth/offline/print/security/restore smoke → handover. Do not promise current provider quotas/prices from old notes; verify account limits during setup. Default dry-run generates config/checklist, no live provisioning until authorized.

NEW `apps/superadmin`: authenticated operator dashboard for deployments, version, schema, latest backup/restore, last health and contact escalation. It must not contain a list of service-role keys or fetch friend databases with browser service credentials. Each deployment pushes a signed minimal health envelope to a small operator service; dashboard reads the operator service with operator authorization. Envelope includes deployment ID, nonce, timestamp, app/schema versions, freshness/health counts; no invoice/customer payloads. Verify signature, replay window and secret rotation. Separate operator roles from tenant owners.

NEW `deployment_health_runs` in the operator control database (not automatically mixed into each shop DB); operator migration 0001 applies to the chosen control target only and is explicitly marked in manifests. The migration registry must distinguish application and operator targets. Do not run control-only tables blindly against every tenant deployment. A simple file/config registry is sufficient for static deployment metadata; health rows are persisted separately.

Backups run per deployment using isolated secrets/config, explicit project ID and destination prefix. Failure of one does not stop reporting others. Restore drill proves project A backup cannot be restored into B by an accidental default. Config checksum and release manifest travel with backup, without secrets.

### G6 — Phase 8 acceptance

Anonymous security suite complete; order price/stock/concurrency tests; restore with active and fulfilled orders; expiry worker demonstrated; cashier POS offline still works; gateway downtime leaves POS independent; rate limiter tested across two worker instances; primary/mirror verified; friend setup measured under one hour after accounts/credentials are ready, excluding provider approval waits; actual friend backup and restore verified; user handover accepted. No claim that a green storefront page means an order system is safe.

---

## 18. S0–S4: conditional Phase 9 SaaS

This is the final optional stage in the original master plan. It is not required to declare Apd's own shop accepted. Do not enable paid billing without an actual paying shop, account access and explicit release authorization.

### S0 — Commercial/source facts gate

Inputs: actual merchant account/test credentials, chosen plan names/prices/currency/tax treatment, trial duration (default original 14 days), cancellation/refund policy, business identity/support contact, current provider limits, privacy/ToS requirements. These cannot be invented by an implementing model. Produce versioned config and a policy checklist with owners. Build/test plumbing in sandbox while commercial fields are pending; live payment collection remains disabled.

Obtain current official Razorpay API/webhook docs and verify account capabilities; SDK method names/versions must be checked at implementation time. Do not embed stale external API code from this plan as if immutable. Separate SaaS merchant funds and shop customer payment records.

### S1 — Tenant onboarding, multi-shop and permissions

Expand onboarding wizard: verified auth→create tenant→shop/profile/timezone/FY→invite staff→import/first purchase→test sale→backup/key custody. Each step resumable/idempotent; no provisioned half-tenant on timeout. Preserve current auth hook table fallback and one/multi-membership rules; inspect actual baseline membership constraints before changing. If users can join multiple tenants, current_tenant must come from a validated selected membership, never unverified client headers/claims.

Add server-managed `tenant_permission_overrides` only if staff-specific gating is required: tenant,user,permission,allow/deny, standard audit; effective permission uses membership status + role grants + reviewed override precedence. Owner cannot remove the last active owner. New/updated RPC and RLS call effective permission consistently; do not implement per-screen-only security.

Multi-shop UI: explicit current shop, per-shop sequences/settings/reports, shared tenant masters, shop-specific stock/prices/payments/openings. Transfers are not currently designed: add no stock transfer button or cross-shop payment as a shortcut; if required by paying shop, create explicit paired-transfer document packet with separate acceptance before enabling it. Reports may aggregate authorized shops, but exports and writes always have explicit scope.

Prove tenant selector cache isolation, membership revoke while offline, access-token refresh, old clients/schema block, accountant allowed shop reads and denied others, owner recovery, no role escalation. Model B infrastructure upgrade is an attended operation, not a schema code side effect.

### S2 — Billing data and entitlement contracts

NEW tables: `billing_plans` (versioned plan code/currency/integer amount/provider plan ID; private administrative writes); `tenant_subscriptions` (tenant, provider customer/subscription IDs unique, normalized state, current_period_end, trial_end, cancellation state, last provider sync); `billing_events` immutable verified event facts; `webhook_inbox` immutable event ID/raw hash/received time and bounded encrypted/redacted payload policy; separate `webhook_processing_attempts` append-only result/retry history; `tenant_entitlements` projection with revision and source-event/reference. Payment secrets never in tenant exports.

Normalized subscription states: TRIAL, ACTIVE, PAST_DUE, CANCEL_AT_PERIOD_END, CANCELLED, SUSPENDED. Define access policy as data: default preserves reading/export/recovery and existing financial records during billing issues; no destructive lockout. New billing/optional SaaS features may be gated after explicit grace rules. Core offline queues must remain recoverable—never erase customer data for nonpayment.

Provider events are unordered and duplicated. Unique provider event ID prevents repeated side effects; verify signature against **raw bytes** before JSON parsing, bounded size and valid key rotation. Preserve old verification secret for provider retry window through secret manager, not repo. Record event, acknowledge after durable acceptance, process idempotently. A stale event cannot overwrite a newer authoritative subscription period/state merely because its HTTP delivery was later; reconcile ambiguous ordering via authenticated provider lookup and store that fact. Never trust browser “payment successful” callback as payment authority.

Mutating SaaS RPCs are server-only except authenticated owner requests to initiate checkout/cancel/status. Webhook handlers cannot accept tenant ID as authority; map verified provider subscription/customer IDs to tenant. All table RLS tested with two tenants; operator service permission separated from tenant permissions. Budget/plan entitlements enforced at server mutation entry points with explicit response codes and usable UI, not bypassable by direct RPC.

### S3 — Billing UX, support and tenant portability

Owner billing screen: plan, price/currency, renewal/cancellation, trial/grace dates, verified payment state, invoice/receipt links from trusted backend. Sandbox/live prominently separate. Initiate subscription on server with operation idempotency; unknown checkout result reconciles, never creates second subscription by refresh. No secret keys in browser.

Support inbox: authenticated tenant request, category, message, attachments with scope/size scan controls, status/history; operator read permission only; no automatic full database dump attached. PII scrubbed from Sentry/logs. Support access to customer data is explicit, scoped and audited; dashboard does not impersonate any tenant silently.

Provide tenant export/cancellation and tested provider-independent restore. Model A→B migration: freeze source tenant, full export/auth mapping, preflight ID/slug/email collisions, explicit mapping, transaction/staged validated import, sequence/stock/account comparisons, config switch and recoverable source archive. No coalescing users by matching email without a validated auth identity migration. Keep tenant IDs stable where possible; rewrite every FK/asset prefix/request namespace consistently if remapping is necessary.

### S4 — External trial and release

Run billing test mode matrix: valid/invalid signature; duplicate/out-of-order webhook; timeout/retry; cancellation at period end; renewal failure/recovery; browser tampering; wrong tenant; rotating secrets; processing crash; provider down; user returns from checkout before webhook; trial expires while device offline. Financial shop data remains unchanged throughout SaaS subscription events.

14-day external shop trial without operator editing their business data; support through intended UI; two unchanged-head full CI runs; security review; actual backup+restore; lawful reviewed live billing disclosures/policies and account readiness; explicit live enable. Track errors/retention/support burden and provider costs. Feature flags roll out to a test tenant first; flags may disable new features but never bypass financial invariants.

## 19. Security, migrations and recoverability cross-check

### 19.1 Every schema packet checklist

- New source table has constraints, tenant-composite FKs, explicit grants/revokes, RLS, identity/status immutability, server timestamp and audit behavior. Nullable actor on service-generated events has an explicit service actor identifier in audit metadata; never invent an auth user.
- Public helper function EXECUTE default is revoked explicitly from PUBLIC, anon and authenticated unless intended. Security-definer functions set search_path and qualify sensitive objects. No untrusted dynamic SQL identifiers.
- Shop/tenant/account match enforced server-side, including child rows and release/void paths. A UUID FK alone does not prove same shop.
- New money path has independent expected-value tests, idempotency mismatch tests, two-connection races, lost-response test, permissions and export/restore replay proof.
- Latest function definitions and wrapper graph are documented. Existing negative-stock recovery, refund ceiling, pending-return-void block and fixed-point rules remain.
- Upgrade from each supported prior group, reset from empty, partial-state refusal and rollback proven. Types/adapters/schema negotiation remain compatible.
- Manifest, schema receipt, exact schema/grant assertions and target class (shop app vs operator control) updated together.
- Operator backup role can read new tables without new write rights. Public/user export scopes appropriate.

### 19.2 Schema compatibility and service worker rollout

Do not bump min_supported merely because an additive table exists. For incompatible changes, first ship a compatible server that accepts old and new contracts, then new app, then measure/drain old outboxes before raising minimum. SYNC_SCHEMA_VERSION in client and server negotiation must agree; versioned RPCs avoid breaking old payloads. A forced update never clears pending financial entries.

Service worker update: prompt to reload when drafts safely persisted; do not replace active billing screen mid-entry. Version comes from one build manifest with commit/tag/cache key. Primary and mirror have identical intended app version/config identity. Rollback to previous static build only if server still supports it; otherwise fix forward. No down migration of financial records.

### 19.3 Regression inventory that cannot disappear

Keep: half-up `0.145 ×100 =15` and `₹1.005=101 paise`; fixed-point sale acknowledgment; held input same-node sentinel; partial-return cash≤received; return-only day report; GST full return nets merchandise; pendingReturnVoid blocks sale and return; cashier cost sync purge; negative-stock incremental recovery; no stale stock-count overwrite; no extra reservation consumption; all existing cross-tenant tests. An implementing model must link these exact existing test names from source in P0, not replace them with weaker new snapshots.

---

## 20. Attended rollout and human gates

### 20.1 Release manifest

Before asking to run live operations, prepare the concrete release manifest: main SHA, reviewed PRs, migration groups/checksums, supported starting DB states, current app/server compatibility, complete CI IDs, latest backup verification, disposable upgrade/restore results, expected live verification output and rollback/fix-forward choice. This makes approval reviewable. No surprise “need permission” in the middle of a half-prepared rollout.

L1 migration: verify actual target/project, authorized SHA, preflight state and backup copies; dispatch existing CI operation `phase6_db_upgrade` only after its extended group runner is ready. Database first. Unknown state refuses. Verify actual new objects/constraints/grants, receipts and correctly scoped invariants; record before/after. Do not treat matching function names as sufficient.

L2 app deploy: separate dispatch `deploy_production` at compatible SHA after L1 success. Check primary/mirror versions, config, login, read-only smoke, update behavior. Do not post a fake “test sale” into real books without an explicit controlled test/correction procedure.

L3 observation: compare health, errors, unknown attempts, backups and reconciliation. A new error suspends the affected workflow; retain unaffected safe billing when possible. Never force-clear queues.

### 20.2 Human evidence matrix

| Gate | Evidence | Can code alone satisfy it? |
|---|---|---|
| H1 | One week real purchases/payments on rehearsal deployment; physical stock and supplier balances compared | No |
| H2 | One full shop day: every payment mode, expenses, returns, customer/supplier balances, stock and close reconciled | No |
| H3 | Actual shop device offline/restart/network loss and recovery, no lost/duplicate entry | No |
| H4 | Hosted restore + portable Postgres restore, auth recovered from paper key, RPO≤24h/RTO≤2h measured | No |
| H5 | Printer receipt readable at actual width; business identity/GST profile validated for shop use | No |
| H6 | Final legacy diff accepted; cutover freeze/authority switch signed | No |
| H7 | 30-day own-shop observation, zero app-caused corrections and required backups/fallbacks | No |
| H8 | First friend deployment, private data isolation and its own backup/restore | No |
| H9 | Paying external shop 14-day trial without operator data edits | No |

H1–H5 may run on rehearsal before final F3 source mapping is finished, but F4 must repeat the integration checks with the finalized importer/opening/numbering release. A gate's evidence is tied to a release; changing the implicated money logic requires rerunning the affected evidence, not reusing an unrelated older screenshot.

Fallback exercises: primary→mirror; database restore to clean hosted target; auth recovery; storage R2 switch/back on preview; polling with realtime unavailable; one-hour backend outage with offline billing; device snapshot export/open; encrypted backup decryption using each independent custody copy. Evidence records observed behavior and elapsed time; no provider SLA claim inferred from one drill.

---

## 21. Commands, CI and implementing-model handoff

### 21.1 Read-only starting commands

```bash
git status --short
git fetch origin main
git rev-parse origin/main
git log -1 --format=fuller origin/main
rg --files -g 'AGENTS.md' -g 'CLAUDE.md' -g '*PLAN*.md'
rg -n 'create (or replace )?function|alter function.*rename' supabase/migrations
```

Use an isolated worktree/branch from verified main if there are user changes. Never run reset/clean to make it “fresh”. `git fetch` ref configuration may not update a guessed local origin branch; inspect FETCH_HEAD and explicit refs. Do not expose credentials from git config/remotes in logs.

### 21.2 Local validation on disposable services only

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm exec supabase start
pnpm exec supabase db reset --local
pnpm exec supabase test db
DEV_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm gen:types
pnpm typecheck
pnpm --filter @dsb-pro/admin run build
node scripts/check-bundle-size.mjs
node scripts/check-installable.mjs
pnpm --filter @dsb-pro/admin exec playwright install chromium
pnpm --filter @dsb-pro/admin run e2e
```

The explicit DEV_DB_URL above is the standard disposable local endpoint; verify the actual local port before using it. The generator writes `packages/db/src/types.ts`, not the stale master-plan `packages/db/types.ts` path. Read the current CI/local config for required local environment variables; populate only with disposable credentials. Build gates must also run production-equivalent public environment, without leaking secrets. Do not blindly use these reset commands on a linked/live project. Never pass a live DB URL to a concurrency/fixture script.

Existing scripts: `test-invite-concurrency.mjs`, `test-sale-concurrency.mjs`, `test-stock-recovery-concurrency.mjs`, `test-fixed-point-parity.mjs`. Read their required environment names before running. Add packet-specific scripts beside them; wire into CI so a manually run script cannot be forgotten. Add storefront/superadmin/gateway typechecks/build/tests once created; root build currently builds admin only and must deliberately expand in G4/G5.

### 21.3 Per-PR review text

```text
Packet / purpose:
Baseline main SHA and candidate SHA:
Invariant and failure scenario:
Latest SQL bodies/wrappers inspected:
Files and migration group/checksum:
Behavior changed and compatibility:
Permissions / tenant / shop scope:
Unknown outcome / offline impact:
Regression tests and independent expected values:
Staged upgrade / rollback / restore evidence:
Two complete CI runs at unchanged head:
Human gates still pending:
Live operations required (not performed):
Next packet:
```

Do not paste secrets or production customer data. Cite runnable test names, results and run IDs rather than “all good”. State if tests were not run because tooling is unavailable; hosted CI can supply the missing evidence but a local mock cannot be called equivalent.

### 21.4 Start-of-session prompt

```text
Implement exactly packet <ID> from docs/COMPLETE_REMAINING_BUILD_PLAN.md.
Verify current main and dependencies first; read actual SQL bodies and callers.
Work on a draft branch/PR; no live migration/deploy or unauthorized merge.
Keep financial requests, stock and balances idempotent and immutable.
Write the meaningful failing/regression tests, implement, then run required validation.
Keep the existing return/refund/offline/rounding tests intact.
Update generated types, export coverage, guarded upgrade proof and handover when affected.
If actual source contradicts a premise, record the exact conflict; do not invent a workaround.
Finish with exact SHA/test evidence, remaining human gates and the next packet.
```

---

## 22. Source references and evidence limits

Repository sources, fixed at the reviewed SHA:

- [Original locked master plan](https://github.com/dashsuperbazar-del/dsb-pro/blob/cc9c64c463526e84210df520ee534847465ae1f6/DSB_PRO_BUILD_PLAN.md)
- [Previous remaining plan](https://github.com/dashsuperbazar-del/dsb-pro/blob/01a66bf5273127cd754f0788ed7baf59e0346938/docs/REMAINING_BUILD_PLAN.md)
- [Returns/allocation/ledger definitions](https://github.com/dashsuperbazar-del/dsb-pro/blob/cc9c64c463526e84210df520ee534847465ae1f6/supabase/migrations/0036_phase65_returns.sql)
- [Latest invariant/settings/sale body](https://github.com/dashsuperbazar-del/dsb-pro/blob/cc9c64c463526e84210df520ee534847465ae1f6/supabase/migrations/0039_phase65_negative_stock_override.sql)
- [Latest stock movement trigger](https://github.com/dashsuperbazar-del/dsb-pro/blob/cc9c64c463526e84210df520ee534847465ae1f6/supabase/migrations/0042_phase65_negative_stock_recovery.sql)
- [Fixed-point and posting wrappers](https://github.com/dashsuperbazar-del/dsb-pro/blob/cc9c64c463526e84210df520ee534847465ae1f6/supabase/migrations/0043_phase65_fixed_point_sale_ack.sql)
- [PR #35](https://github.com/dashsuperbazar-del/dsb-pro/pull/35)

Primary external references checked for this design:

- [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html): consistent lock acquisition order and transaction-scoped advisory locks underpin §3.4.
- [PostgreSQL 17 CREATE VIEW](https://www.postgresql.org/docs/17/sql-createview.html): invoker views require underlying permissions; public catalog and private invoker views have deliberately different designs.
- [Razorpay webhook validation](https://razorpay.com/docs/webhooks/validate-test/): raw request signature validation and duplicate-event handling. Recheck live API contract at S0.
- [CBIC official sectoral FAQ](https://cbic-gst.gov.in/sectoral-faq.html): Rule 46 invoice serial guidance supports the bounded numbering design. It does not settle the shop's complete applicable GST receipt obligations.

No live database schema, production backups or shop records were inspected for this planning deliverable. Repository state is verified; production readiness is not inferred from it. CI history was not rerun as part of writing this document. The reference helper verification below is isolated and does not constitute implementation testing of future packets.


## Appendix A — Executable reference helpers

These are complete pure reference implementations, included to remove ambiguity around signs, canonical allocations, safe integers and numbering. They are not a full application migration or a substitute for the packet implementation/tests. The JavaScript is valid ESM for Node 24; add TypeScript types when integrating with the repository, preserving behavior. Do not add a second money engine: reuse existing fixedPoint helpers and put only the missing signed/aggregate support into core.

### A1. JavaScript reference

```javascript
// Pure reference code. No network, database or financial side effects.
export const MAX_SAFE_PAISE = 9007199254740991n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function integerPaise(value, {signed=false, positive=false}={}) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('unsafe paise');
  if (!['number','string','bigint'].includes(typeof value)) throw new Error('invalid paise type');
  const s = String(value);
  if (!(signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(s)) throw new Error('integer paise required');
  const n = BigInt(s);
  if (n > MAX_SAFE_PAISE || n < -MAX_SAFE_PAISE || (positive && n <= 0n)) throw new Error('paise out of range');
  return n;
}
export function signedRupeesToPaise(text) {
  if (typeof text !== 'string') throw new Error('rupee input must be text');
  const s=text.trim();
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(s)) throw new Error('plain decimal required');
  const negative=s.startsWith('-');
  const [whole,fraction='']=(negative?s.slice(1):s).split('.');
  const micros=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
  const magnitude=micros/10000n+(micros%10000n>=5000n?1n:0n);
  return integerPaise(negative?-magnitude:magnitude,{signed:true}).toString();
}
export function formatPaise(text) {
  // Display supports exact aggregate integer strings beyond JS safe-number range.
  if(typeof text==='number'&&!Number.isSafeInteger(text))throw new Error('unsafe display number');
  const s=String(text);
  if(!/^-?(0|[1-9][0-9]*)$/.test(s))throw new Error('integer paise required');
  const n=BigInt(s), a=n<0n?-n:n;
  return `${n<0n?'-':''}₹${a/100n}.${String(a%100n).padStart(2,'0')}`;
}
export function normalizeAllocations(input, targetKey='purchase_bill_id') {
  if (!['purchase_bill_id','sale_invoice_id','opening_id'].includes(targetKey)) throw new Error('unsupported target');
  if(!Array.isArray(input)||input.length>200)throw new Error('invalid allocations array');
  const seen=new Set();
  const out=input.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('allocation object required');
    if(Object.keys(row).length!==2||!Object.hasOwn(row,targetKey)||!Object.hasOwn(row,'amount_paise'))throw new Error('allocation keys');
    if(typeof row[targetKey]!=='string'||!UUID.test(row[targetKey]))throw new Error('invalid target UUID');
    const id=row[targetKey].toLowerCase();
    if(seen.has(id))throw new Error('duplicate target');
    seen.add(id);
    return {[targetKey]:id,amount_paise:integerPaise(row.amount_paise,{positive:true}).toString()};
  });
  out.sort((a,b)=>a[targetKey]<b[targetKey]?-1:a[targetKey]>b[targetKey]?1:0);
  return out;
}
export function allocationSum(rows) {
  const total=rows.reduce((s,r)=>s+integerPaise(r.amount_paise,{positive:true}),0n);
  if(total>MAX_SAFE_PAISE)throw new Error('allocation sum out of range');
  return total.toString();
}
export function fiscalYear(date,startMonth) {
  if(!Number.isInteger(startMonth)||startMonth<1||startMonth>12)throw new Error('invalid FY month');
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('ISO date required');
  const d=new Date(date+'T00:00:00.000Z');
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==date)throw new Error('invalid date');
  const y=Number(date.slice(0,4)),m=Number(date.slice(5,7));
  if(y<1000||y>9998)throw new Error('year out of supported range');
  const startYear=y-(m<startMonth?1:0);
  return {startYear,label:startMonth===1?String(startYear):`${startYear}-${String((startYear+1)%100).padStart(2,'0')}`};
}
export function fiscalDocNo(prefix,date,startMonth,sequence) {
  if(typeof prefix!=='string'||!/^[A-Za-z0-9]{1,3}$/.test(prefix))throw new Error('invalid prefix');
  if(typeof sequence==='number'&&!Number.isSafeInteger(sequence))throw new Error('unsafe sequence');
  if(!/^[1-9][0-9]*$/.test(String(sequence)))throw new Error('invalid sequence');
  const seq=String(sequence).padStart(6,'0');
  const out=`${prefix}/${fiscalYear(date,startMonth).startYear}/${seq}`;
  if(out.length>16)throw new Error('document number capacity exceeded');
  return out;
}
export function paymentRemaining(amount,allocations,openingSettlements=[]) {
  const a=integerPaise(amount,{positive:true});
  const used=[...allocations,...openingSettlements].reduce((s,x)=>s+integerPaise(x,{positive:true}),0n);
  if(used>a)throw new Error('payment overspent');
  return (a-used).toString();
}
export function openingRemaining(amount,paymentSettlements=[],creditApplications=[]) {
  const a=integerPaise(amount,{signed:true});
  if(a===0n)throw new Error('zero opening');
  if(a>0n&&creditApplications.length)throw new Error('positive opening cannot fund credit application');
  const used=[...paymentSettlements,...creditApplications].reduce((s,x)=>s+integerPaise(x,{positive:true}),0n);
  const magnitude=a<0n?-a:a;
  if(used>magnitude)throw new Error('opening overspent');
  return ((a<0n?-1n:1n)*(magnitude-used)).toString();
}
```

### A2. PostgreSQL reference

These helpers were compiled/executed in isolated embedded PostgreSQL. Explicitly revoke anon/authenticated as well when integrating into the real migration, because existing grants/default privileges may differ. Privileged public wrappers call the helpers as their owner. The code does not include app permissions because it is pure, non-public logic.

```sql
-- Isolated SQL reference helpers, not a full application migration.
create or replace function public.dsb_fiscal_year_label(p_date date,p_start_month integer)
returns text language plpgsql immutable set search_path=public as $$
declare y integer; m integer; fy integer;
begin
 if p_date is null or p_start_month is null or p_start_month not between 1 and 12 then
   raise exception 'invalid fiscal year input';
 end if;
 y:=extract(year from p_date)::integer; m:=extract(month from p_date)::integer;
 if y not between 1000 and 9998 then raise exception 'year out of supported range'; end if;
 fy:=y-case when m<p_start_month then 1 else 0 end;
 if p_start_month=1 then return fy::text; end if;
 return fy::text||'-'||lpad(((fy+1)%100)::text,2,'0');
end $$;
revoke all on function public.dsb_fiscal_year_label(date,integer) from public;

create or replace function public.dsb_normalize_allocations(p_input jsonb,p_target_key text)
returns jsonb language plpgsql immutable set search_path=public as $$
declare e jsonb; target uuid; amount_text text; seen uuid[]:='{}'; result jsonb:='[]';
begin
 if p_target_key is null or p_target_key not in ('purchase_bill_id','sale_invoice_id','opening_id') then
   raise exception 'unsupported allocation target';
 end if;
 if p_input is null or jsonb_typeof(p_input)<>'array' then raise exception 'allocations must be an array'; end if;
 if jsonb_array_length(p_input)>200 then raise exception 'too many allocations'; end if;
 for e in select value from jsonb_array_elements(p_input) loop
   if jsonb_typeof(e)<>'object' then raise exception 'allocation object required'; end if;
   if not (e ? p_target_key) or not (e ? 'amount_paise')
     or (select count(*) from jsonb_object_keys(e))<>2 then raise exception 'invalid allocation keys'; end if;
   if jsonb_typeof(e->p_target_key)<>'string'
     or coalesce(e->>p_target_key,'') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
     raise exception 'invalid target UUID';
   end if;
   target:=(e->>p_target_key)::uuid;
   if target=any(seen) then raise exception 'duplicate allocation target'; end if;
   seen:=array_append(seen,target);
   amount_text:=e->>'amount_paise';
   if amount_text is null or amount_text !~ '^[1-9][0-9]{0,15}$' then raise exception 'positive integer paise required'; end if;
   if amount_text::bigint>9007199254740991 then raise exception 'paise out of range'; end if;
   result:=result||jsonb_build_array(jsonb_build_object(p_target_key,target::text,'amount_paise',amount_text));
 end loop;
 return coalesce((select jsonb_agg(value order by (value->>p_target_key)::uuid)
                  from jsonb_array_elements(result)),'[]'::jsonb);
end $$;
revoke all on function public.dsb_normalize_allocations(jsonb,text) from public;
```

### A3. Durable client attempt control flow

This is an algorithmic contract, not pasted production TypeScript. Implement with the existing Dexie/runtime adapters and test all transitions; do not write a detached second outbox.

```text
submit(draft):
  validate and normalize draft
  persist immutable READY attempt with UUID (transaction must succeed)
  mark SENDING durably
  call versioned RPC with that attempt UUID and payload
  if a valid matching committed result arrives: persist COMMITTED
  if a definite first-attempt rollback arrives: persist REJECTED
  otherwise: persist UNKNOWN, retain payload and UUID

recover(attempt):
  SENDING after restart becomes UNKNOWN
  if UNKNOWN:
    result = permitted lookup(shop, operation, UUID)
    COMMITTED => verify identity/result and acknowledge
    NOT_FOUND => exact same UUID/payload may retry
    denied/unreachable/malformed => retain UNKNOWN
  never edit an UNKNOWN attempt or assign it a replacement UUID
  never infer NOT_SAVED merely from timeout or a later permission error
```

### A4. Transaction reference for new RPCs

```text
BEGIN (one RPC transaction)
  check current membership + operation permission + shop scope
  normalize request; validate canonical keys/types/bounds
  take shop finance lock
  take operation/request lock
  if completed financial_requests row exists:
    payload equality required; return its result
  lock/re-read affected active source rows in declared order
  verify tenant/shop/account, dates, amounts, capacity and status
  write immutable parent and deterministic child rows
  write audit/stock through existing sanctioned paths
  verify affected invariants
  insert completed request + result
COMMIT
```

No network call, email, bank transfer or webhook dispatch occurs inside this transaction. Future outbound effects use a transactional event/outbox with their own idempotency. Supplier-payment screens record payments; they do not execute a transfer.

---

## Appendix B — Final design audit and requirement coverage

### B1. Corrections found while writing/rechecking this version

| Issue in prior design or initial draft | Resolution in this file |
|---|---|
| Supplier cross-shop allocation | Server identity match + shop-scoped adapters + C10 test |
| Later allocation rewrites past debt buckets | effective_date, source-date bounds, inferred history flag |
| Opening payment also reused for bill | Explicit settlement table and shared payment budget |
| Lost response followed by edited retry | Durable immutable UNKNOWN attempt and reconcile-first flow |
| Record/allocate child ID collision | Operation/request/target namespace |
| Tenant ledger compared to shop summary | New shop-scoped ledger computed before running balance |
| Unique opening includes voided records | Partial active-opening unique indexes |
| Restore validates counts only | Canonical content, totals, invariants and retry replay |
| D1/D2 share incomplete migration group | Each schema packet independently recognized/upgraded |
| View grants implicitly assumed | Explicit grants plus underlying RLS checks |
| FY helper reads shop but called immutable | Pure date+month helper; separate stable shop lookup |
| Reproducibility called idempotency | Separate clean-target and same-target proofs |
| `INV/2026-27/000123` too long | `INV/2026/000001` + 16-character bound, full FY stored separately |
| lpad truncates long sequence | Minimum-width padding, no truncation, capacity check |
| Supplier negative opening/return credit cannot settle | Explicit incoming reimbursement and credit-source linkage |
| Negative stock override can consume order reservations | Phase 8 reserved>0 hard guard; preserve positive recovery |
| Offline snapshot called complete accounting backup | Profiles clearly separate subset vs full business/DR |
| Export coverage overlooks control tables | Every base table classified; auth/assets separate |
| Assumed generated-types path | Actual script writes packages/db/src/types.ts |
| Phase 9 and original 30-day definition omitted | Conditional SaaS packets and own-shop observation retained |

### B2. Original master requirement mapping

| Master requirement | Remaining treatment |
|---|---|
| Export JSON/CSV/PDF and portability | D3, F4, G6, S3 |
| Financial immutability and audit | C0–C3, F2, G2/G3 |
| Stock movement truth/projection | Existing foundation preserved; E3/F3/G2/G3 tests |
| Three copies + tested restore | D3/D4, H4, F5, G5/G6 |
| Multi-device/offline/UNKNOWN | C2/C3, E3, H3, rollout compatibility |
| Permission/RLS/cost privacy | C1, all schema packets, G1/G6, S1/S4 |
| Units/pricing golden parity | Existing fixed-point tests + E3 + actual legacy F0/F4 |
| Returns before shop-day gate | Existing returns preserved; E3/H2 |
| Supplier payments and balances | C1/C2/D1/F2 |
| Settings/timezone/negative stock | D2/F1 |
| i18n/dark/mobile/accessibility | E0–E2 |
| FY numbering | F1 |
| Import and cutover | F0/F2–F5 |
| FIFO cost layers | Explicit v1 waiver, approximate valuation label |
| Storefront/orders/reservations | G0–G4 |
| Friend deployments/superadmin | G5/G6 |
| SaaS only with paying shop | S0–S4 conditional |
| Every layer fallback | H4/fallback exercise inventory |
| No production changes from ordinary CI | P1, every packet gate, L1/L2 |

### B3. Verification actually performed for this document

- Fetched current main and prior plan branch; recorded exact commit IDs.
- Read the master plan, prior plan, relevant migration definitions/wrappers, finance adapters, local database/outbox, UI routes, importer, export workflow and upgrade scripts.
- Rechecked the three originally reported supplier defects against actual SQL.
- Cross-checked packet prerequisites, migration numbering, current/proposed source distinction and external-input gates. Automated checks also verified all numbered section references, code-fence balance and exact equality of embedded code with tested helper files.
- Executed **475 isolated checks** covering reference JS/SQL fiscal-year agreement, date boundaries, numbering length/sequence behavior, signed paise rounding, canonical allocations, duplicate/malformed inputs, safe integer bounds, combined payment/opening capacity and example balance conservation. Result: PASS.
- These checks used Node 24 and embedded PostgreSQL for pure helpers. They do not prove PostgreSQL multi-connection races, RLS, full migrations, app rendering, production schema or future implementation behavior.
- **These 475 checks are reference-helper verification for this planning document only. They ran against snippets in this document, not against the repository's schema, and they satisfy no repository gate.** They must not be cited, quoted, or referenced as evidence toward any packet's §0.4 tests, any `docs/BUILD_EXECUTION_LEDGER.md` entry, any CI status, or any merge/release decision. Every packet's evidence comes only from tests executed in this repository, on the repository's exact candidate SHA, per §0.4 and §4.1 — no exceptions, no partial credit for this appendix's checks. An implementer or reviewer who sees "475 checks passed" cited toward a packet's acceptance should treat that as a defect in the citation, not evidence.
- No repository implementation, merge, deploy or live migration was performed for this planning task.

### B4. Approval/readiness statement

The blueprint is ready for detailed independent review and sequential implementation after adoption. Complete production acceptance remains dependent on implemented packets passing their stated tests, real legacy mapping, human shop/recovery evidence and attended rollout. No step permits an implementing model to invent missing business data, skip a failed invariant or label an untested feature complete.

## Appendix C — Exact file allocation and endpoint completion map

### C1. Migration and SQL-test filenames

Use these names if 0044 remains the next unused app migration. If another PR consumes a number, update this table and the packet registry together before creating files. SQL test file numbers are independent from migration numbers; descriptive `remaining_*` names avoid collisions with the baseline's numbered test suite.

| Packet | Migration file | SQL test file |
|---|---|---|
| P1 | supabase/migrations/0044_upgrade_receipts.sql | supabase/tests/remaining_p1_upgrade_receipts.sql |
| P2 | supabase/migrations/0045_item_sales_fix.sql | supabase/tests/remaining_p2_item_sales_fix.sql |
| C0a | supabase/migrations/0046_finance_requests.sql | supabase/tests/remaining_c0a_finance_requests.sql |
| C0b | supabase/migrations/0047_finance_locking.sql | supabase/tests/remaining_c0b_finance_locking.sql |
| C1 | supabase/migrations/0048_supplier_payments.sql | supabase/tests/remaining_c1_supplier_payments.sql |
| C3 | supabase/migrations/0049_customer_request_compatibility.sql | supabase/tests/remaining_c3_customer_requests.sql |
| D1 | supabase/migrations/0050_temporal_reports_v2.sql | supabase/tests/remaining_d1_reports.sql |
| D2 | supabase/migrations/0051_settings_and_receipt_profiles.sql | supabase/tests/remaining_d2_settings_receipts.sql |
| D3 | supabase/migrations/0052_export_v5.sql | supabase/tests/remaining_d3_export_scope.sql |
| D4 | supabase/migrations/0053_health_checks_v2.sql | supabase/tests/remaining_d4_health.sql |
| F1 | supabase/migrations/0054_fiscal_numbering.sql | supabase/tests/remaining_f1_numbering.sql |
| F2 | supabase/migrations/0055_account_openings_settlements.sql | supabase/tests/remaining_f2_openings.sql |
| F3 | supabase/migrations/0056_strict_cutover_import.sql | supabase/tests/remaining_f3_import.sql |
| G0 | supabase/migrations/0057_storefront_configuration.sql | supabase/tests/remaining_g0_storefront_config.sql |
| G2 | supabase/migrations/0058_orders_reservations.sql | supabase/tests/remaining_g2_orders.sql |
| G3 | supabase/migrations/0059_order_fulfillment.sql | supabase/tests/remaining_g3_fulfillment.sql |
| G5 | services/operator-control/migrations/0001_deployment_health.sql | services/operator-control/tests/deployment_health.sql |
| S1 | supabase/migrations/0060_saas_access.sql | supabase/tests/remaining_s1_saas_access.sql |
| S2 | supabase/migrations/0061_saas_billing.sql | supabase/tests/remaining_s2_saas_billing.sql |

G5 is deliberately **not** an app migration. Operator control has its own migration ledger/bootstrap and explicit schema/role tests; it does not assume tenants/shops from the business database. Its deployment registry and health tables are global operator-control exceptions to app tenant columns, use deployment_id, and are readable only by authenticated authorized operators. Do not reserve an unused app migration simply to maintain a visual numbering sequence.

G1 and S3 have no rows above: per the §4.2 Packet 0.5 amendment, `public_catalog`'s schema foundation lives in G0's `0057_storefront_configuration.sql` and support-ticket persistence lives in S2's `0061_saas_billing.sql`. Neither gets its own migration number.

### C2. Remaining endpoint contracts

All new RPCs use named arguments, SQL type declarations, structured error details and operation-specific permissions. Dates and amounts follow §3.3. All mutating calls have client_id except internal scheduled batch operations whose deterministic batch/event key supplies idempotency.

| Endpoint | Arguments / result | Permission and behavior |
|---|---|---|
| record_supplier_credit_receipt | (p_shop_id uuid,p_purchase_bill_id uuid,p_amount_paise bigint,p_business_date date,p_mode text,p_reference text,p_client_id text) → uuid | owner; §15.4 |
| void_supplier_credit_receipt | (p_receipt_id uuid,p_reason text,p_client_id text) → uuid | owner; void linked incoming payment and receipt atomically |
| void_opening_settlement | (p_settlement_id uuid,p_reason text,p_client_id text) → uuid | owner; release settlement only; cash payment remains posted/unallocated unless separate payment void is requested |
| get_open_account_items_v2 | (p_shop_id uuid,p_account_kind text,p_account_id uuid,p_as_of date) → jsonb | account-specific read permission; signed document/opening/advance details |
| transition_order | (p_order_id uuid,p_expected_revision bigint,p_target_status text,p_reason text,p_client_id text) → jsonb | MANAGE_ORDERS; cannot directly set DELIVERED |
| requote_order | (p_order_id uuid,p_expected_revision bigint,p_client_id text) → jsonb | MANAGE_ORDERS; server prices and atomic reservation quantity reconciliation |
| accept_order_quote | (p_order_id uuid,p_quote_version integer,p_acceptance_method text,p_client_id text) → jsonb | staff records customer consent; retain evidence method/time, not a fabricated customer auth identity |
| fulfill_order | (p_order_id uuid,p_accepted_quote_version integer,p_payments jsonb,p_client_id text) → jsonb | MANAGE_ORDERS + POST_SALES; returns saleId/docNo/orderStatus |
| expire_shop_orders | (p_shop_id uuid,p_limit integer) → jsonb | internal service/owner maintenance; limit 1–100; use server time |
| get_public_order_status | gateway (shopSlug,requestId,receiptToken) → safe json | verify token digest; no direct public SELECT on orders/contact |
| update_storefront_settings | (p_shop_id uuid,p_settings jsonb,p_client_id text) → jsonb | MANAGE_STOREFRONT; schema/field allowlist |
| start_subscription_checkout | authenticated server API(planCode,clientId) → checkout/status | tenant owner, tenant resolved from authenticated membership |
| request_subscription_cancel | authenticated server API(subscriptionId,atPeriodEnd,clientId) → status | owner; provider result reconciled, no browser authority |
| get_billing_status | authenticated server API() → safe billing state | owner; accountant only if separately granted billing-read |
| receive_billing_webhook | server HTTP(raw body,signature,event ID) → acknowledgment | verified provider; never browser JWT authority |
| submit_support_request | authenticated server API(category,message,attachmentRefs,clientId) → ticket | current tenant membership; validated attachment scope |

Critical refinements when implementing F2:

- Extend both SALE and PURCHASE branches of phase4_validate_allocation to subtract active opening-credit applications. Updating only the report view leaves allocation overpayment possible.
- Extend generic payment void, supplier void, sale/purchase void and return void call graph for opening settlements and supplier-credit receipt guards. An older granted endpoint cannot bypass the new relationship budget.
- Releasing a settlement on a negative-opening reimbursement leaves a real outgoing/incoming payment without its required credit source. Therefore `void_opening_settlement` is permitted alone only for positive-opening settlements backed by ordinary customer-in or party-out advances. For negative-opening settlements use an owner RPC that voids both the linked reimbursement payment and settlement, or reassigns it to a valid source atomically with explicit confirmation. No orphan refund is permitted.
- Date validation applies to new returns too: business_date cannot precede source invoice/bill business_date; refund date equals its return date. Preserve exact legacy replay first; flag pre-existing contradictory dates in history completeness rather than mutating past documents.

### C3. Packet closure checklist for the implementing model

For each packet, produce a completed instance of this checklist, not a generic claim:

1. Named prerequisites accepted at their exact SHAs.
2. Existing source functions/callers compared against this contract.
3. New functions and table constraints implemented, no TODO body or placeholder authorization.
4. Every user path—including error, UNKNOWN and retry—has adapter and screen behavior where applicable.
5. Named required tests implemented with independent expected values and real concurrency where required.
6. Existing regression inventory remains in place.
7. New exports, restore, health and generated types integrated.
8. Staged upgrade and starting-state refusal tested.
9. Independent review plus two complete unchanged-head CI runs.
10. Human/live gate status recorded accurately and next packet identified.

### C4. Error and request normalization registry

Create `docs/API_CONTRACTS.md` in C0 and extend it with each packet. A row names operation string, RPC signature, normalized payload schema, permission, result schema, error codes and maximum sizes. Freeze the versioned normalization before any production request is stored. Supplier operations are named in §7; use analogous explicit names (`customer.record.v2`, `customer.allocate.v2`, `opening.record.v1`, `opening.settle.v1`, `opening.cash.v1`, `opening.apply.v1`, `supplier.credit-receipt.v1`, `order.place.v1`, `order.fulfill.v1`) for the defined endpoints. Assign and test a distinct registered operation for each remaining mutation; no generic caller-controlled operation string reaches a privileged executor.

Normalize UUIDs to lowercase, references with one documented trim/null rule, allocations sorted by target UUID and amounts to canonical integer strings. Do not normalize the business distinction between omitted/default date intent and a user-chosen explicit date; store resolved date in result. JSON object key order is immaterial in jsonb equality; array order is normalized only for sets such as allocations, never for ordered invoice lines. Reject unknown payload keys so misspelled fields cannot disappear silently. Limit request IDs/references/arrays before expensive work.

Use PostgreSQL exception SQLSTATE P0001 with structured JSON DETAIL containing a stable code, or a consistently documented custom SQLSTATE family; choose P0001+DETAIL here. Required new detail codes: DSB_VALIDATION, DSB_NOT_PERMITTED, DSB_SHOP_MISMATCH, DSB_ACCOUNT_MISMATCH, DSB_PAYLOAD_MISMATCH, DSB_DOCUMENT_UNAVAILABLE, DSB_ALLOCATION_EXCEEDS_DOCUMENT, DSB_PAYMENT_BUDGET_EXCEEDED, DSB_OPENING_BUDGET_EXCEEDED, DSB_SOURCE_CREDIT_REQUIRED, DSB_STALE_PREVIEW, DSB_LEGACY_REQUEST_UNVERIFIABLE, DSB_ORDER_REQUOTE_REQUIRED, DSB_STALE_ORDER_REVISION, DSB_SCHEMA_UPDATE_REQUIRED. Preserve legacy message compatibility where existing callers/tests depend on it. New adapters parse DETAIL defensively and retain transport uncertainty separately from business rejection.
