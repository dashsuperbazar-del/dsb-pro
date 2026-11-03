# DSB Pro — remaining build plan v3 (parity + speed)

Date: 3 Nov 2026. Base: main `a9fa065` (#166). Source of the gap list: `docs/DSB_PARITY.md` (20 Oct),
re-checked against main for this plan. Process stays `docs/SINGLE_BUILDER_PLAN.md` v2.0; invariants stay
`docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1. This file only fixes WHAT is left and the ORDER.

## 1. What is already closed since the parity file

Global search (N04, Search screen), duplicate-bill check beyond 1,000 bills (P08, 0075), batch drafts
(P09), multi-photo bills (P12), supplier merge (I11), FIFO profit (R04), audit log screen exists (R12,
needs a per-record timeline only), offline sales/purchases/new items/edit-void/supplier payments, design
D1–D9. Changed-by-design rows (I05, P15, C09, R08, R11, R13) are NOT gaps: no recycle bin, no silent edit.

## 2. Speed: why old DSB felt instant and Pro does not

Old DSB: one page, every tab rendered once from local memory and kept hidden; switching = show/hide.
Pro today: each route unmounts on leave and re-reads on enter. Snapshots (SP2/SP4) cover only Purchases,
Suppliers, Customers, Inventory, Home tiles. Rare screens load a chunk on first visit.

| Packet | Change (UI only, no migration)                                                                                      | Target (SP0 mobile-like profile)          |
| ------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| SPD1   | Keep-alive for the 5 bottom tabs: mount once, hide with `hidden`, refresh in background on show                     | warm tab switch p95 ≤ 150 ms              |
| SPD2   | Route snapshots for Sales history, Reports, Expenses, Returns, Audit log, Settings, Sync                            | revisit shows data ≤ 300 ms, cold ≤ 1.5 s |
| SPD3   | Idle prefetch of the `rareScreens` chunk after first paint; data prefetch on bottom-nav `pointerdown`               | first visit to a rare screen ≤ 500 ms     |
| SPD4   | Inventory/stock list from the local Dexie catalog first, network delta by `updated_at` (no full 1,000-row re-pages) | Inventory p50 ≤ 500 ms (was 21 s at 10k)  |
| SPD5   | Re-run SP0 baseline + add the numbers to `SPEED_BASELINE.md`; real phone first-open timing from the owner           | evidence, not claims                      |

Safety rule for all SPD packets: snapshots and kept-alive screens are DISPLAY only. Any action that
moves money or stock (post, pay, void, return, stock adjust) still reads fresh server data first, exactly
as today. Kept-alive tabs must drop state on sign-out, user switch and shop switch (same rule as
routeSnapshot). Bundle gates stay: initial ≤ 260 KiB gz, total ≤ 300 KiB (total is at ~96%: SPD packets
must not add libraries; new feature screens go in lazy chunks).

## 3. Parity packets, in build order (re-verified against code 3 Nov)

Already in main, removed from the plan: share as image (ShareImageButton: invoice, statements, bill),
price history + demand charts (PriceHistory, DemandChart), credit limit fields + POS warning, customer
notes/GSTIN (PartyEditor), low-stock and payment-due Home tiles (AttentionTile), photo zoom viewer,
CSV exports on statements/reports. C11 dropped: old DSB also printed with current settings.

| #   | Packet                       | Rows     | Migration | What                                                                                  |
| --- | ---------------------------- | -------- | --------- | ------------------------------------------------------------------------------------- |
| A   | Speed + batch keyboard       | N02, K02 | no        | Sales history snapshot, idle prefetch of rare screens, Enter-to-next in batch entry   |
| B   | Shop phone/footer + pay day  | R07, I10 | yes (one) | shops.phone, shops.receipt_footer on receipts; supplier payment day (1–31) + due tile |
| C   | Backup reminder              | R09      | no        | Settings/Home nudge when the last backup is older than 1 day                          |
| D   | Price anomaly warning at POS | C04      | no        | Warn (never block) when a sale price is below last purchase cost per unit             |
| E   | Item stock timeline          | I07      | no        | Item detail: read-only movement list from the existing stock movement read            |

SPD1 (keep-alive tabs) is NOT built: POS and Purchases read URL parameters and document-level keys on
mount; hidden-but-mounted copies would fire keys and keep stale edit state. Snapshots give the same
instant revisit without that risk. SPD4 already done (Inventory reads the local catalog first).

## 4. Silent data-corruption risks to guard (before crashes)

- SPD1/SPD2: a kept-alive or snapshot screen showing another shop's or user's figures → wipe on
  sign-out/user/shop change; e2e for each switch.
- Packet 2: changing units/conversions on an item that has stock or bills would rewrite history → server
  refuses; UI disables with the reason.
- Packet 4/5: credit limit must never block a server-confirmed sale offline or change balances; it is a
  warning only.
- Packet 7: receipts must render from the stored snapshot, never current settings.
- Packet 8: day-book totals must equal ledger sums; any mismatch is a test failure, not a rounding.

## 5. Least-token-burn rules (how I build)

1. I build every packet myself; no builder agents. One fresh reviewer sub-agent only for packets 4, 5,
   7, 8 (money/schema). UI-only packets get my own adversarial re-read.
2. Read only the files the packet touches (`grep -n` then `sed -n` ranges); never whole large files.
3. Local checks: changed-file prettier + eslint, typecheck, the touched unit tests, the touched e2e
   spec. The full suites run once, in CI.
4. One PR per packet, pushed once after local checks; CI gate per v2.0 §4; merge + deploy without asking
   (standing instruction) when green.
5. Packets 2+3, 6+9 and 10 can share a PR when they touch disjoint files.
6. STATE.md: one folded line per packet, ≤ 120 lines.

## 6. Owner-only items (cannot be built)

Real-phone checks after each deploy (camera, share, printer, offline sale/purchase), first-open timing
numbers, Settings → Backup check, shop name fix ("Dsb"), and a clean shop week for the H-gates.
