# DSB Pro — Single-Builder Plan v2.0 (supersedes the dual-builder protocol and the packet order of COMPLETE_REMAINING_BUILD_PLAN v1.1)

**Date:** 2026-09-29 · **Repo state checked:** `main` = `81ac0d1` (P0 + P1 merged, migrations 0001–0044)
**Put this file at:** `docs/SINGLE_BUILDER_PLAN.md`. The v1.1 plan stays as the *design reference* (schemas, invariants, test lists). This file decides *order, scope and process*.

---

## 0. Why this replaces the old order

| Finding (verified in repo) | Consequence |
|---|---|
| No supplier-payment RPC exists (payments are customer/refund only). No supplier ledger screen. | The app cannot do the core job of old DSB: pay a party and see their balance. |
| Expense entry lives inside the Reports screen; no stock-adjust screen; no dedicated purchase-bill screen. | Daily entry is awkward vs old DSB. |
| v1.1 order puts locking benchmarks, health panels, export v5, Hindi dictionaries, a11y and theme **before** the app is usable (E3 → F1). | Months of work before daily use; real bugs found late. |
| P1 took 7 review rounds; ledger row still says CI_PASSED though it is merged. | Dual-builder relay costs ~2× sessions and the user's time; docs drift. |
| Screens are written as 600–1150-character single lines (PosScreen 25 KB in 250 lines). | Diffs are unreviewable by anyone, human or AI. |
| `packages/db/src/types.ts` not regenerated since 2026-09-10. | RPC calls are typed against a stale schema. |
| HANDOVER 1,334 lines + plan 1,434 lines read every session. | Pure token drain. |

---

## 1. Milestones

| Milestone | Goal | Exit gate |
|---|---|---|
| **M1 — Daily-usable** | Everything old DSB does day-to-day: items/stock, purchase bills, supplier (party) ledger + payments, sales/POS, customer ledger + receipts, expenses, stock adjust, returns, day book, backup. Old data imported. | 7-day **shadow run**: same entries in old DSB and DSB Pro; balances and stock match (covers H1, H2, H3). |
| **M2 — Hardened + cutover** | Health/readiness, export v5, receipt snapshots, i18n/a11y, cutover | H4, H5, H6, H7 |
| **M3 — Storefront + SaaS (parallel to M2)** | G0–G6, S1–S4 | H8, H9; no public launch before H7 |

---

## 2. M1 packet order (strict)

Each row = one PR. Migration numbers re-checked against `main` before use.

| # | Packet | Content | Mig | Model |
|---|---|---|---|---|
| 1 | **M0 Hygiene** | Prettier-format `apps/**` (zero logic change, proven by typecheck + unit + e2e unchanged); regenerate `packages/db` types; create `docs/STATE.md` (≤120 lines: current SHA, last packet, next packet, open risks); fix P0/P1 ledger rows to MERGED; adopt CI policy §4. | — | Sonnet |
| 2 | **P2** Item-sales discount fix | As v1.1. | 0045 | Sonnet |
| 3 | **C0 (merged C0a+C0b)** Request ledger + shop finance lock | `financial_requests` with payload-hash compare; `dsb_lock_shop_finance` wrapped around every money writer (list them by querying `pg_proc`, test each). Allocation `effective_date`/`voided_at`. **Gate:** existing pgTAP/e2e green + a 5-session concurrency test proving no double-allocation. The 20-session p95 benchmark is dropped for M1 (one shop, 1–3 devices); re-evaluate at S1. | 0046 | Opus |
| 4 | **C1** Supplier payments | record / allocate / release / void, advances, direction-aware validator, invariants 3–4 of v1.1 §3.2. | 0047 | Opus |
| 5 | **C2** Parties screen | Supplier list with balance, ledger (opening → purchases → returns → payments), "Record payment made", allocate to bills, purchase-bill entry moved to its own screen with bill image. Dexie `financialAttempts` (UNKNOWN state). | — | Sonnet |
| 6 | **C3** Customer receipts v2 | `record_customer_payment_v2`/`allocate_…_v2`, outbox UNKNOWN reconciliation; Customers screen gets "Receive payment" + ledger. | 0048 | Opus |
| 7 | **U1 Daily-entry UX** | Expenses screen (out of Reports), Stock-adjust screen, Day book home tile, bottom nav on mobile, number-pad-friendly inputs, bill-level discount parity check vs old DSB. English only. | — | Sonnet |
| 8 | **F0** Legacy inventory | Needs one old-DSB JSON export from the user (see §5). Mapping contract + anonymized fixtures. | — | Sonnet |
| 9 | **F1+F2** Numbering + openings | Fiscal-year series; `account_openings` and settlements for party/customer opening balances and opening stock. | 0049–0050 | Opus |
| 10 | **F3** Importer | Preview → diff → atomic apply; blocks on unexplained negatives/mismatch. | 0051 | Opus |
| 11 | **D1-lite** Aging + dated ledgers | As-of outstanding and aging for suppliers and customers. | 0052 | Sonnet |
| 12 | **R1 Shadow-run kit** | A one-page "compare" report: per-party balance, per-item stock, day totals, exportable as CSV to tick against old DSB. | — | Sonnet |

**M1 gate:** user runs both apps for 7 days, taps the compare report daily; zero unexplained differences. Estimated **12–16 sessions** [Guessing].

**Moved out of M1 → M2:** D2 (receipt snapshots), D3 (export v5), D4 (health v2), E0/E1 (Hindi, full i18n, role nav), E2 (theme, a11y, axe), E3 (perf rehearsal), F4/F5 (formal rehearsal + cutover), P1 follow-ups 1–5, C0 benchmark.

---

## 3. Single-builder protocol (replaces §9 dual-builder)

Per packet, in one session where possible:

1. Read `docs/STATE.md` and only the v1.1 sections for this packet. Do **not** read HANDOVER.md.
2. Write failing tests (pgTAP for DB, Vitest for core, Playwright for screen flows).
3. Migration → adapters → UI. Money in paise, no client DELETE, RLS + pgTAP per new table.
4. Local: `pnpm lint && pnpm typecheck && pnpm test` + pgTAP.
5. **Independent review:** spawn one fresh sub-agent with no build context, give it only the diff + v1.1 invariants for this packet; it returns BLOCKER/MAJOR/MINOR. Fix BLOCKER/MAJOR. Max 2 rounds. Replaces the GPT relay.
6. Push PR; one green CI run on final head (§4).
7. Post to user a **5-line summary**: what changed, what you can now do in the app, risk, migration yes/no, "reply `merge` to proceed".
8. After merge: update `docs/STATE.md` + ledger row in the next PR.

**Optional GPT check** (user pastes only if they want): for C0, C1, F2, F3 — paste the PR link to GPT with "review for money/data-loss bugs only". Not a gate.

**Stop and ask the user only for:** merge approval, live migration/deploy approval, the legacy export, a money/data-loss trade-off with no safe default. Everything else: builder decides and records the decision in STATE.md.

---

## 4. CI policy

- One green run of the full workflow on the unchanged final head = gate for UI/no-migration packets.
- Migration packets: PR run + `workflow_dispatch operation=validate` (upgrade proof), as today.
- Squash-merge ratified as permanent.

---

## 5. What the user does (total)

1. Once, now: export old DSB data (Settings → Backup/Export → JSON) and upload it to the session when F0 starts.
2. Per packet: read the 5-line summary, reply `merge` (or click Merge on GitHub).
3. At M1: run the 7-day shadow run; report any mismatch line from the compare report.
4. Approve live migrations when asked (one word).

---

## 6. Rules kept unchanged from master plan

Integer paise; immutable financial rows (void + reissue); stock only via movements; append-only financial events idempotent by `client_id`; UNKNOWN-outcome reconciliation; no client DELETE; RLS on every table; never edit applied migrations; no invented legacy format; H-gates need dated user evidence.
