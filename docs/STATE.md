# DSB Pro — STATE (read this instead of HANDOVER.md)

Process + order: `docs/SINGLE_BUILDER_PLAN.md` v2.0. Design/invariants: `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1.
Always verify the SHA below with `git log origin/main -1` before trusting it.

## Current

- 20 Oct branch claude/bill-repeat-guard (UI only, NO migration; base main `9d51dab` = #119): "↺ Repeat last bill" and tap-to-add re-check after the awaited `getPurchaseExtras` that shop, supplier, source bill and bill client id are unchanged and the editor is not locked/posting; otherwise nothing is copied and the screen says "Supplier changed — not copied." (or "The bill changed … — not copied."). Tests: supplier change while the extras read is pending (repeat + tap) adds no card; a new bill is refused, with "Another unconfirmed purchase is stored on this device…", when an old-version tab writes a v1 `dsb-pending-purchase:<shop>` intent after mount (guard already existed; test locks it). No PR yet.
- 20 Oct: main `9d51dab` = #119 (P05 bill-card-extras, UI only, NO migration) merged and LIVE. Contents: the purchase bill editor posts through `post_purchase_v2` (adapters `postPurchaseV2Outcome`, totals from core `purchaseBillTotals`). Added: payment type chips Credit (default)/Cash/UPI (no cheque) with "Paid in full ₹X now" + "Post and pay ₹X by Cash" before Post; notes ≤500 with counter; per item Discount % and GST % (lib/billExtras `parsePercentBp`, ≤2 decimals → basis points; GST blank → `gstBp: null` = rate includes GST, explicit 0 = "0% added", hint under the field; card shows "₹gross − d% discount + g% GST · Item total"); named extra charges rows (+ Add charge, ×, sum); up to 10 bill photos/PDFs, each through the existing private bill-document flow (IndexedDB bytes first, draft persisted, immutable path tenant/shop/bill clientId/file id, upload confirmed before Post; first = bill_image_path); totals block items/discount/charges/total before round off/"Round off +₹0.49"/bill total (old "₹0.00 (purchases are not rounded)" removed). Purchases detail: payment type, notes, charges, per-line discount/GST, every photo, paid badge ONLY from `getPurchaseExtras().settlement` (unreadable extras → no badge); Cash/UPI bill: owner "Void bill and its payment" (`voidPaidPurchaseOutcome`, reason required, one request id per bill kept and reason frozen after an unconfirmed answer), other roles told only the owner can. Decisions: a new bill is always v2; a pending v1 intent stored by the previous version is retried as v1 unchanged (`api: 'v2'` marker in the pending entry); DSB_PAYLOAD_MISMATCH is shown as a final refusal ("cannot be posted from this form"), identity not rotated; Cash/UPI needs a supplier and today-or-earlier date (checked before sending, server enforces too); Post disabled offline with a plain message (purchases stay online-only; draft keeps every new field); old drafts' single `extra` and v1/repeated bills' extra amount become one "Extra charges" row; repeat copies named charges and per-line discount/GST from `getPurchaseExtras` (repeat fails rather than silently dropping them); total-mode cost is the amount before discount/GST (old TOTAL COST); a different item clears discount/GST, a unit change keeps them; drafts add optional `paymentType`/`notes`/`charges`/`documents` (and keep `document` = first, `extra` = ''); the sale-prices plan still keys off the same bill client id. pgTAP (no SQL change): replayed completing purchase return returns same return + round-off; void completing return then re-complete takes the round-off once; rounded bill with named charges fully returned leaves exactly the charges outstanding. Classifier: `purchase_returns_round_off_paise_check` (`CHECK ((round_off_paise <= 50))`) added inside the existing billextras anchor 2 (still 6 anchors), CI tamper widens it to ≤100 and expects refusal; the live DB created that constraint in 0064 so its verdict stays `billextras_state=2` (verified on a local 0064 DB).
- Review fixes (bill-card-extras): "↺ Repeat last bill" and tap-to-add recent items now read `getPurchaseExtras` and copy discount/GST (copy nothing, with a message, if unreadable); drafts are written as `version: 2` (older app versions accept only 1, so they keep them unread instead of posting without charges/GST/payment type); v2 pending purchases live under `dsb-pending-purchase-v2:<shop>` (old readers only see `dsb-pending-purchase:<shop>`; this version reads both, v1 first, and a new bill waits for either); Total mode is labelled "Total before discount/GST ₹" with a warning when GST % is typed; unreadable settlement shows "Payment status unavailable".
- Silent-corruption risks (this packet) and guards: client/server total drift (only core totals, server refuses mismatch); blank GST sent as 0 (null kept end to end, tests); retry creating a second bill/payment (pending intent before send, same id + payload, v2 replay); charges lost on old drafts/repeats (converted to a named row); photo of another bill (draft check of path clientId); paid shown from payment type (settlement only).
- 20 Oct: main `24c7e31` = #118 (0064 billextras). LIVE: DB through 0064 (run 39373131879, includes 0063 `itemindex`). 0064 = `post_purchase_v2(shop, client_id, bill)`: payment type credit|cash|upi (cash/UPI posts bill + full supplier payment atomically, payment id md5(bill id), replay via financial_requests 'purchase.post.v2'), notes ≤500, per-line discount_bp/gst_bp (gst null = price as entered at the master rate), named charges (sum = extra_charges_paise, deferred trigger), ≤10 images, every v2 bill rounded to the rupee half up (round_off_paise −49..+50, immutable), `void_paid_purchase` (owner, atomic). Returns mirror sales 0053 (completing return reverses the round-off; extra charges stay with the shop). Known accepted difference: Pro rounds each line to paise then the bill; old DSB rounded float lines only at the bill (rarely ₹1 apart, golden test).
- 19 Oct UI packets merged before #118: bill entry cards (old-DSB item cards, golden payload), "+ Create '<name>'" inside a card (one clientId per form, `findItemByClientId` recovery), optional "Sale prices" box (owner/manager; plan stored per user+shop+bill+window before sending, written via set_item_price only after the bill confirms, ids `bill-price:<bill>:<item>:<kind>:<level>:<paise>`, Retry/Discard alerts, >24 h = no auto write).
- 18 October: main `daecce3` = #92–#108; production deployed at `daecce3` (run 39117013742). Device checks (camera, voice, speed, supplier merge) pending with the user. Shop how-to: docs/SHOP_START.md.
- Measured SP0 mobile revisit p50 (main → SP2): Suppliers 957→179 ms, Customers 896→126 ms. Plan: docs/LIFETIME_PLAN.md.
- Decision 18 Oct (user): no old-DSB import and no parallel run (confirms 2 Oct decision; LIFETIME_PLAN F0 dropped).
- Decision 18 Oct (user) I11 party merge: keep both suppliers' data; identical records may be listed for cleanup. Built as #108 (0062 `partymerge`): rows re-attributed unchanged, duplicate archived, `party_merges` records moves; refused if both have a POSTED opening in one shop; post_purchase retry accepts merged supplier (`dsb_party_canonical`); billdocs classifier also accepts the 0062 post_purchase body. Suppliers only (old DSB had no customer merge).
- Follow-ups: PR + one green full CI run for claude/bill-repeat-guard; device check of several bill photos and Cash/UPI posting; I08 demand chart; R03 cash/bank split; SP3 cold-start speed. SP4 (branch claude/sp4-cold-start, no migration): route snapshots also persist to IndexedDB (`dsb-pro-route-snapshots`, display only, per user+shop, 12 h, 1 MB/row, 4 MB total, only the signed-in user; user change wipes other users, sign-out wipes all; writes refused unless still that user; peek limited to the active shop; shops leaving membership and 401/403 refreshes drop copies). Accepted limitation: snapshot age/expiry use the device clock (skew can show a wrong age).
- Decisions 16 Oct: profit cost method = FIFO (user). Known/estimated/unknown cost kept separate; headline says "Profit on costed sales" when any is estimated/unknown; revenue includes GST. Archived suppliers/customers cannot receive new documents (trigger guard + partial unique name index) and can be archived only when they have no history (`DSB_PARTY_HAS_HISTORY`). `.prettierignore` now lists `packages/db/src/types.ts` (generated). A local Postgres harness used for SQL checks is scratch-only, not in the repo.
- Profit report is NOT validated against real shop data or old DSB figures (H-gate unchanged). Request-event loss on the throttled SP0 profile is unexplained (stale-request exclusion 60 s hides it).
- Release COMPLETE: inspection-only #859 found billdocs/0058 only; attended upgrade #860 verified encrypted B2/R2 backups, applied 0058 and required needs_upgrade=false; deploy #861 succeeded on this main. Cloudflare 9/9 and GitHub Pages 10/10 public files matched exact-run artifacts. No physical/shop acceptance implied.
- Codex builds; other AI verifies. V010 accepts the PX1/SP0 plan amendments and closes VF-014 deploy lag. User confirmed 15 October that old DSB repo commit `62e3c30e9ff573ccfaabe06ad6f49759b37a37be` is the final shop-used baseline (tree `9e2abf6e868a62be4be608115d7f1f56304d0cf2`).
- D3b #76 MERGED as ef880da: exact numeric JSON restore into empty same-schema target; endpoint guards, locked emptiness/full-row/FK/invariant/replay checks, six precision/target regressions and combined proof PASS. Hosted Auth/private bytes are separate; docs/BUSINESS_JSON_RESTORE.md.
- DW1 #70 merged after final-head CI #809 / run 38359193865 PASS: 320 unit tests, 55 browser tests passed + 1 scale-only skip, 20 held-cart repetitions passed. Home/Purchases/Sales/Ledger/More; purchase bills/detail, snapshot-safe repeat into fresh draft, supplier/recent item shortcuts, inline supplier creation, bill-to-payment/ledger, Full + Auto allocations. Included in verified production release #861; physical shop acceptance remains open.
- DW2a #71 including VF-016/017 MERGED as `7840cfb`; unchanged-head CI #834 / run 38522081829 PASS (332 app tests). User authorized merge; no independent approval claimed.
- DW2b #72 MERGED as a1a1751: private photo/PDF, durable draft/binary, immutable upload/retry, viewer; 0058 / billdocs. Exact-head CI #844 / 38539868090 and validate #845 / 38541928845 PASS at a661280 (342 app tests, 940 pgTAP, browser/upgrade/build). Separate inspection-only phase6_db_preflight reports every live pending group. 0058 applied live in #860; physical camera/device acceptance remains open. Contract: docs/BILL_DOCUMENTS.md.
- DW2c #73 MERGED as 1a9d094 after exact-head CI #848 / 38543056524 PASS at 510de2a. 342 app + 17 archive tests; 940 pgTAP; 55 browser passes + 1 scale skip, 20 held-cart repetitions; two-target snapshot-bound financial/Auth/private-byte recovery PASS. No migration or money-handler change. Hosted backup configuration, physical recovery and H3/shop acceptance remain open. Contract: docs/BILL_DOCUMENT_BACKUP.md.
- DW3 #74 MERGED as 183c2b6 after exact-head CI #851 / 38543991414 PASS at 5950a29: 355 app + 17 archive tests, 940 pgTAP; 56 browser passes + 1 scale skip, 20 repetitions; two recovery proofs/build. Exact server-ledger text/TXT/CSV and Pro A4/PDF statement output. No migration/money write; real share/printer acceptance open. Contract: docs/SUPPLIER_STATEMENTS.md.
- Decision 2026-10-02 (user): the return that completes a rounded bill also reverses its round-off; partial returns carry item value, capped so a bill's returns never exceed what was billed for its items (total - extra charges). Extra charges still stay with the shop.
- FIXED (S1, 2026-10-03): an online sale/return finalized while a background sync cycle was in flight joined that cycle, which had already read the outbox, so it showed "Saved locally" and posted only on the next cycle (held-cart repeat, runs 36909385562 and 758). One fresh cycle now runs if it is still QUEUED; a deterministic e2e holds the cycle's ack. Never a money risk (exactly-once outbox).
- V2 residual closed by V3: receipt/payment check+create+send is serialized per account across windows (Web Locks). Browsers without Web Locks keep the unserialized check.
- Rule (V2): persist every exact money/stock request BEFORE sending; only definitive DB rejection unlocks it. Use `rpcOutcome`/`*Outcome`, never `classifyError`, to decide outcomes.
- Decision 2026-10-02 (user): old DSB is retired; no legacy import, no shadow run. DSB Pro goes live with real data once daily-usable, then is patched in use. F0/F3 dropped; F1 (fiscal numbering) later.
- O1 design: one POSTED opening per account (signed paise; customer + = owes shop, supplier + = shop owes), owner only, void + re-enter to correct. Feeds customer_ledger, party ledger v2, supplier outstanding and both as-of aging reports (aged from as_of_date), export. DEFERRED to O2: allocating payments/credits against an opening — until then such cash shows as unassigned; net balance exact.
- O2 design (2026-10-02): separate `opening_settlements` (payment ↔ positive opening, owner only, void to
  correct) instead of editing the 5 live payment writers; a new BEFORE INSERT trigger on payment_allocations
  counts settlements so a payment is never assigned twice (DSB_ALLOCATION_EXCEEDS_PAYMENT); voiding a payment
  voids its settlements; a settled opening cannot be voided. Credit (negative) openings are not applied to
  bills (stay as credits in the net). Known gap: the supplier payment screen showed the pre-settlement
  unassigned amount; an allocation over it is refused by the trigger. Closed for suppliers by O3 (payment
  history counts settlements); the customer screen only allocates at receipt time, so no gap there.
- Decision 2026-10-02 (user): next 5 packets built/merged/deployed on green CI (O3, D2a, D2b, N1, V5 done; F1 deferred).
- M1 gate (daily-usable): O1 ✓ + H3 (user, offline→restart→reconnect, each entry once) + first clean
  real-data week (Compare page + invariants). Waiting on the user for H3 and the cutover date.
- V006 #75 MERGED as f1a550c after full CI #854 / 38545121484 PASS at c8ff907: 358 app + 17 archive tests, 940 pgTAP, 56 browser passes + 1 scale skip, 20 repetitions, both recovery proofs/build. Full preserves paid cash/advance; linked bill requires explicit cash. App/changed-file formatting enforced; root debt disclosed. No money RPC/migration change. Contract: docs/V006_REVIEW.md.

## Workflow (single builder)

failing tests → migration → adapters/UI → `pnpm lint && pnpm typecheck && pnpm test` (+pgTAP) →
fresh sub-agent review (BLOCKER/MAJOR fixed, max 2 rounds) → PR → CI → 5-line summary → user says `merge`.
CI gate: UI/no-migration packet = one green full run on final head. Migration packet = PR run +
`workflow_dispatch operation=validate`, both on the unchanged final head. Squash-merge is the ratified practice.
Ask the user only for: merge, live migration/deploy approval, money/data-loss trade-off.
Standing rule — User 19 Oct: merge and deploy on green CI without asking; live DB migrations still need explicit approval with the full preflight group list.
Before a live `phase6_db_upgrade`, list EVERY group the preflight will apply (it applies all pending groups).

## Local environment

- Cloud builder runtime: Node 22/24, pnpm 11.25.0; Docker (`nohup dockerd &`, `pnpm exec supabase start`) and Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`) work, so pgTAP and e2e run locally; no local timing claims. BUILD_EXECUTION_LEDGER.md has not been updated since #84; STATE.md is the record.
- After migrations reset DB and regenerate `packages/db/src/types.ts`; CI rejects stale types.
- `pnpm format:check`: all documented app files plus supported changed files; CI uses the PR base SHA. Unrelated root formatting debt is tracked separately.

## Open risks / debts

- D1-lite: old `get_customer_aging_report` (current-state balances labelled as-of) stays for compatibility but the
  UI no longer calls it. 100k-invoice EXPLAIN not done (one shop; revisit at S1). Cash counts as assigned only
  when allocated/linked to a document in the same as-of set, so stranded allocations show as unassigned cash.
- Watch: suppliers 'lost response' e2e failed again on main (run 36904189128, form never shown). Hypothesis:
  waitForOfflineRuntime timed out at 5 s under load; raised to 30 s in V3. Close after 5 clean main runs.
- Every new migration packet adds its own upgrade group (manifest, ALLOWED_GROUPS, GROUP_ORDER, apply wrapper,
  classifier state + CI proof/apply/verify) — P2 is the template; freeze its checksum in the manifest once merged.
- C0 lock protocol: every money writer is a wrapper (shop finance advisory lock) over a client-revoked
  `c0_*_body`. `phase5_sync_post_sale` is intentionally unwrapped (own key first, no cycle; keeps Batch B signal).
  New money writers MUST take `dsb_lock_shop_finance` first. Wrappers lock before the body's permission check
  (tenant member could serialize own shop; MINOR, not fixed).
- Pre-C0 `void_purchase` never checked allocations: live may hold VOID bills with POSTED allocations (stranded
  money). C1 reports them in `get_supplier_outstanding().strandedAllocationsOnVoidBills`; owner releases them
  via `release_supplier_allocation`. Check that field on live right after the `c1` apply.
- C1 tightens `payments`/`payment_allocations` read RLS: party (supplier) rows need POST_PURCHASES or VIEW_REPORTS,
  and rows are scoped to the caller's shops. Generic `void_payment` refuses party payments (use supplier void).
- FIXED LIVE (C2/0048, 2026-10-01): C1 `get_party_ledger_v2` fails through PostgREST (temp-table
  DELETE without WHERE blocked by safeupdate). Read-only; no money affected. pgTAP/psql cannot see safeupdate —
  every new SQL read path needs an e2e (PostgREST) call, not only pgTAP.
- C1 review MINORs (open): c1 classifier probes only 2 schema anchors; customer writers accept
  `supplier.`-prefixed client_ids (DoS-only squatting). C1 has no cutover-date floor on supplier allocations (add in F).
- Stranded allocations on VOID bills: not yet checked on live. After C2 deploys, the Suppliers summary shows ⚠ per
  supplier; owner releases each with a reason.
- Classifier c0 state 1 (schema without receipt) is a fresh-reset/bootstrap state; on a live DB it needs the
  attended baseline-receipt init (P1 debt #5), not `apply`.
- `AppDatabase` widens every RPC arg to `T|null` (generator limitation); names/types are checked, nullability is not.
- `bootstrap-disposable-receipts.mjs` writes receipts for every manifest entry, even groups not applied (P1 debt #4).
- Every gate H1–H9 from Phase 3 on is NOT GO; needs dated real-shop evidence. H3 needs an explicit
  offline→restart→reconnect device test. Returns/offline returns/Batch B are now live on the DB, so these matter.
- P1 deferred follow-ups 1–6 (see ledger P1 row) are moved to M2.

## Decisions log

- 2026-10-01: USER DECISION (B1) — item values stay in exact paise; the BILL total rounds to the nearest rupee
  (half-up, as old DSB) with a separate round-off amount. New packet R0 (migration). Old/queued sales stay exact.
- 2026-10-01: U1 daily-entry forms (expense, stock adjust, purchase) freeze the request after an unconfirmed
  attempt and only offer a same-id retry; start-over only on a definitive server answer.
- 2026-10-01: C3b scope. POS sales never call post_sale directly (outbox -> Batch B fingerprinted sync), so the only
  direct UI money writer was post_purchase: 0050 verifies every retry against the stored bill (PAYLOAD_MISMATCH on
  any difference; covers pre-0050 bills). Direct post_sale (API-only) and outbox UNKNOWN labels deferred: Batch B
  fingerprints already make sale/return replays exact. POS customer receipts stay on the request-recorded old
  endpoint (C3). Future migrations rewriting post_purchase must keep the 0050 marker text (c3b classifier signal).
- 2026-10-01: Old customer endpoint now rejects duplicate invoice targets and cross-shop invoices for NEW receipts
  (retries of recorded receipts still return them).
- 2026-10-01: C2 carries mig 0048 (ledger fix) so C3's planned customer-request migration becomes 0049 (unchanged).
- 2026-10-01: Offline snapshot schemaVersion 4 adds `financialAttempts` + `onlineRequestsAwaitingConfirmation`.
- 2026-10-01: C1 cutover-date restriction deferred (no cutover date defined); supplier read RLS tightened.
- 2026-09-30: GPT verification log V001 findings VF-001..004 accepted; fixed in PR #42 (VF-002 rated MINOR by builder).
- 2026-09-30: undici pinned `^7.29.1` via pnpm override (GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3).
- 2026-09-30: brace-expansion pinned `^5.0.11` via pnpm override (GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p).
- 2026-09-29: scheduled builder routine (every 6h, this session) builds packets up to PR; never merges.
- 2026-09-29: dual-builder (GPT+Claude) retired; sub-agent review replaces it. GPT optional for C0, C1, F2, F3.
- 2026-09-29: C0a+C0b merged into C0; 20-session benchmark dropped for M1.
