# DSB Pro — STATE (read this instead of HANDOVER.md)

Process + order: `docs/SINGLE_BUILDER_PLAN.md` v2.0. Design/invariants: `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1.
Always verify the SHA below with `git log origin/main -1` before trusting it.

## Current

- 19 Oct branch claude/bill-extras (migration 0064, group `billextras`, base main `5e4dbc9` = #115; server + adapters only, card UI is a follow-up packet; NOT applied live — the live preflight will list `itemindex` (0063, if still pending) AND `billextras`). New RPC `post_purchase_v2(shop, client_id uuid, bill jsonb)`; v1 `post_purchase` untouched so billdocs/partymerge/c3b anchors stay valid. Fields: payment type credit|cash|upi (owner 19 Oct: no cheque; legacy import is master-data only, legacy reconciliation keeps cheque→bank), notes (trimmed, ≤500), per-line `discount_bp`/`gst_bp`, named charges (`purchase_bill_charges`, sum = extra_charges_paise by deferred constraint trigger), ≤10 images (`purchase_bill_images`, first is also bill_image_path; old bills keep bill_image_path). Line total = round_half_up(qty·price·(1−d)·(1+g)) once per line in pure integer arithmetic (SQL div((2N+D),2D), D=10^14; core mirrors with BigInt; golden tests vs old calcItemRow incl. demo seed BILL-1003 and large quantities); server recomputes and refuses any differing line/bill total (DSB_TOTAL_MISMATCH; totals required). A cash/UPI bill posts the bill AND a full supplier payment (record_supplier_payment, mode = type, allocated to the bill) in one transaction; replay via financial_requests 'purchase.post.v2' returns the same bill+payment ids; payment request id = md5(bill id). Decisions: a paid bill needs a supplier and cannot be future-dated; a zero-total paid bill posts no payment; `void_paid_purchase` (owner, as supplier-payment voids are owner-only) voids payment + bill atomically, v1 void keeps refusing allocated bills; a GST-added line stores its GST as tax_rate_bp_snapshot (GST summary stays right); backup references include image rows; export adds purchaseCharges/purchaseImages (optional keys); new tables' RLS uses c1_shop_visible; get_financial_request reads 'purchase.post.v2'/'purchase.void_paid.v1'. Decision (GST): blank = `gstBp: null` (price as entered, GST-inclusive at the item's master rate, snapshot = master rate); a number = that % ADDED on top, explicit 0 = "0% added" (snapshot 0). The adapter type requires `gstBp: number | null` and refuses ''/fractions; the UI packet must send null for a blank field. Decision (paid status): UI shows paid/unpaid from `getPurchaseExtras().settlement` (purchase_bill_outstanding: allocations + returns), never from payment_type. Adapter: DSB_PAYLOAD_MISMATCH on v2 is a FINAL refusal (id belongs to another purchase; message names the existing bill), not unknown→resend; a refused retry is decided by the stored answer. Purchase bill rounding (old DSB Math.round on the bill total) left as-is pending the owner.
- Risks (billextras, silent first): double auto-payment on retry (request ledger + derived payment id); bill without payment (one transaction); cash flag hiding a balance (none: balances only from ledgers); float/paise drift (exact numeric, golden test); GST at a wrong rate (snapshot = line GST); charges ≠ header (deferred trigger); stranded payment on void (atomic void); extra images treated as unused uploads (backup refs). Accepted: a v1 retry reusing a v2 bill's client id is acknowledged without comparing the new fields (no money created). Separately voiding the auto payment (owner) leaves the bill honestly unpaid in the ledger.
- 19 Oct branch claude/pbi-item-index (migration 0063, group `itemindex`, base main `94ff36e` = #113): read indexes `(tenant_id, shop_id, item_id, created_at desc)` on purchase_bill_items (price history), sale_invoice_items and sale_return_items (I08 demand chart filters shop+item+created_at, newest first). Plain CREATE INDEX (CONCURRENTLY impossible in the transactional runner; brief write lock on 3 tables). Classifier anchors = exact `pg_indexes.indexdef` of all 3 (same name with another definition is refused as drift), receipt checksum, after partymerge. No data/money/RLS change; types unchanged. NOT applied live: live needs explicit approval (preflight should list only `itemindex`).
- 19 Oct branch claude/bill-sale-prices (UI only, no migration; base main `5e4dbc9` = #115): bill card shows the item's conversion read-only ("1 ctn = 12 pcs") and old DSB's optional "Sale prices" box (owner/manager = MANAGE_MASTER_DATA): retail (prefilled) + wholesale "₹X for N" per chosen unit; current wholesale is only a hint, never a value (a typed qty never divides it; qty without a typed price blocks Post). Decisions: X/N must be whole paise else refused; ₹0 refused; text inputs so bad typing is a problem, not blank; unchanged/blank write nothing; different prices for one item+kind+unit on two cards block Post; box opens on the smallest unit with a retail price; current prices re-read after every price write. Plan stored per user+shop+bill+window (`dsb-bill-sale-prices:<user>:<shop>:<bill>:<window>`, never in the request) before sending; a send not stored removes only its own window's plan; a bill the DB refuses removes every stored plan of that bill (user+shop). Written via set_item_price one call each AFTER the bill confirms, id `bill-price:<bill>:<itemId>:<kind>:<level>:<paise>` (set_item_price dedupes by id whatever the price); a bill confirming >24 h after the prices were entered writes none by itself. Alerts (Retry/Discard, age, current price): failed write = "Bill saved…"; found after reload = "check the bill, then Retry or Discard" (bill state unknown); >24 h old or item gone/not permitted = Discard only. Discard is per plan + write. Accepted: a manual Retry overwrites a newer price.
- 19 Oct branch claude/card-new-item (UI only, no migration/RPC/money change; base main `643b196`): P03 "+ Create '<name>'" inside a bill card when no item has that name (case/space-insensitive). Inline form → same `createItem` adapter + shared field mapping (lib/newItem.ts, also used by Add item). Decisions: one clientId per open form so a retry after a lost answer cannot create a second item (unique client_id); that refusal is recovered by `findItemByClientId` (new adapter, tenant-scoped RLS items read) and selected as a success, else "Could not confirm the new item…"; a found item with other units is reported ("Saved earlier as: …"), never selected; after a sent-and-failed attempt the form is read-only until Cancel (new clientId); one create per name at a time across cards; a late create on a locked bill only reports. Both forms share labels (level 1 = BIG unit), trimming and plain unit rules (unit2 needs conv1 > 0, unit3 needs unit2 + conv2 > 0); a failed create re-reads the list so the name guard catches an item that was saved; offline says "not created" (items do not queue); a card-side exact-name guard refuses a duplicate (the DB itself allows duplicate names). Never created at Post; an uncreated name keeps the card blocking Post.
- 19 Oct branch claude/bill-entry-cards (UI only, no migration, no money change; base main `1ee18e6` = N08/N09 #112): purchase bill editor rebuilt as old-DSB item cards (lib/billCards.ts, components/PurchaseBillCards.tsx). Lines derive from cards with the old add-line rules; golden test proves the posted payload is identical to the old editor and to an old-format draft. Drafts gain optional `cards` (old drafts restore as cards). Decisions: blank cards are skipped; a started but incomplete card blocks posting with "Item n: …"; Repeat in the editor copies items only (as old DSB); purchases show round-off ₹0.00 (Pro does not round purchase bills). Resuming an old-format draft now posts its half-typed line as a card (visible and editable before posting). Review fixes: only the Post button posts (Enter moves to the next field); a scan/voice result on a filled card opens a new card; a change of item or unit clears qty/cost.
- 18 October: main `daecce3` = #92–#108. LIVE: DB through 0062 (`partymerge`, run 39115935115, user approved) and production deployed at `daecce3` (run 39117013742). Device checks (camera, voice, speed, supplier merge) pending with the user. Shop how-to: docs/SHOP_START.md.
- Measured SP0 mobile revisit p50 (main → SP2): Suppliers 957→179 ms, Customers 896→126 ms. Plan: docs/LIFETIME_PLAN.md.
- Decision 18 Oct (user): no old-DSB import and no parallel run (confirms 2 Oct decision; LIFETIME_PLAN F0 dropped).
- Decision 18 Oct (user) I11 party merge: keep both suppliers' data; identical records may be listed for cleanup. Built as #108 (0062 `partymerge`): rows re-attributed unchanged, duplicate archived, `party_merges` records moves; refused if both have a POSTED opening in one shop; post_purchase retry accepts merged supplier (`dsb_party_canonical`); billdocs classifier also accepts the 0062 post_purchase body. Suppliers only (old DSB had no customer merge).
- Follow-ups: PR + CI (PR run + validate on unchanged head) and live apply of 0063 `itemindex`; I08 demand chart; R03 cash/bank split; SP3 cold-start speed. SP4 (branch claude/sp4-cold-start, no migration): route snapshots also persist to IndexedDB (`dsb-pro-route-snapshots`, display only, per user+shop, 12 h, 1 MB/row, 4 MB total, only the signed-in user; user change wipes other users, sign-out wipes all; writes refused unless still that user; peek limited to the active shop; shops leaving membership and 401/403 refreshes drop copies). Accepted limitation: snapshot age/expiry use the device clock (skew can show a wrong age).
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

- Current builder runtime has Node 24.19.0/pnpm 11.25.0; Docker/local Chromium unavailable. Full database/browser/SP0 measurements run in disposable CI; no local browser timing claim.
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
