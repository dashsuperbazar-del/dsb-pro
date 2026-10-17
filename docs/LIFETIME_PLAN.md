# DSB Pro lifetime plan (17 October 2026)

Question from the owner: old DSB is self-tested and fast; DSB Pro lags and its design differs. Can every DSB
design, feature and the same speed be brought into DSB Pro, so DSB Pro is usable for a lifetime?

## 1. Why the two apps feel different (evidence)

Old DSB = `dashsuperbazar-del/DSB` @ `62e3c30` (owner-confirmed shop baseline): one 588 KB `index.html`.

| Area | Old DSB | DSB Pro | Consequence |
| --- | --- | --- | --- |
| Reads | All data in memory from `localStorage`; every screen renders instantly | Most screens fetch from the server on every visit | DSB feels instant; Pro waits on the network (SP0: Inventory revisit p50 21.4 s → 4.9 s after SP1a, mobile-synthetic CI profile) |
| Sync | `select=*` of whole tables + `merge-duplicates` upsert (last writer wins); purge-on-absence | Server RPCs, idempotent requests, immutable ledgers, outbox | DSB: two devices or a late sync can silently overwrite or purge money records. Pro: never |
| Stock/balances | Mutable fields (`it.stock += …`) edited in place | Derived from immutable movements/ledgers | DSB numbers drift with no audit trail; Pro reconciles |
| Delete | Hard `DELETE` on server + local recycle bin | Void/reverse, never delete | DSB history can be lost; Pro keeps it |
| Growth | localStorage quota (~5–10 MB per origin); full-table pull grows every year | Server pagination; device holds only the working set | DSB will hit the quota or get slower each year — the gap Pro was built to close |
| Security | Single anon key, client-trusted | RLS per tenant/shop/role, server-checked permissions | Cashier/phone loss risks in DSB |

Conclusion: DSB's speed comes from local-first reads, not from anything Pro cannot do. DSB's weaknesses
(LWW money merge, mutable stock, hard deletes, quota) are structural and cannot be fixed inside DSB's
design without rebuilding it — which is what Pro is.

## 2. Recommendation for the shop today

- Keep old DSB as the ONLY system that records the shop's money and stock until DSB Pro passes the
  cutover gate in §5. Do not record the same day in both apps (double entry, no reconciliation path).
- Do not keep extending old DSB: every year of data makes its quota and full-sync problem worse. Export a
  JSON backup weekly (Settings → backup) until cutover.
- Move to DSB Pro only on dated evidence from the shop phone, not on CI numbers.

## 3. Target architecture (Pro keeps its guarantees, gains DSB's speed)

1. **Local-first reads (stale-while-revalidate).** Every route renders immediately from a device snapshot
   (memory → IndexedDB), labelled with its age, then refreshes in the background. Snapshots are display
   data only.
2. **Server-confirmed writes.** Money/stock writes stay idempotent RPCs with the existing outbox and
   locked-retry. A money action (payment allocation, return payout) always re-reads fresh data first.
3. **Retained screens.** Five persistent tabs that stay mounted (DSB `showPage`), so switching tabs costs
   nothing and half-entered work is never lost.
4. **One request per screen.** Replace per-widget waterfalls with one read RPC per screen.
5. **Bounded device data.** Working set only (catalog, open bills, recent months), paged history, quota
   meter; the server keeps everything forever.
6. **Lifetime operations.** Forward-only migrations with receipts (in place), encrypted backups and restore
   drills (in place), business JSON export/restore (in place), device replacement by sign-in.

## 4. Build order (one packet per PR; each closes with tests, review, CI)

| # | Packet | Parity rows | Gate |
| --- | --- | --- | --- |
| SP2 | Instant route render: SWR snapshot cache for Home, Inventory, Purchases, Suppliers, Customers, Reports | N02 | SP0 revisit p50 ≤ 300 ms (mobile-synthetic) |
| SP3 | Retained tab shell (5 tabs kept mounted, dirty guards) | N01, N08, C05 | no data loss on tab switch (e2e) |
| SP4 | Per-screen read RPCs (migration) + IndexedDB persistence for cold start | N02 | cold cached reload ≤ 1.5 s |
| F1 | Party merge, edit/delete from detail (archive), unit learning | I11, I13, I14 | pgTAP + e2e |
| F2 | Bulk supplier payments; recent sort/status filters; day book cash/bank | S05, N06, R03 | ledger reconciliation tests |
| F3 | Excel entry sheet import/export; bill image peek; multiple photos | P10, P12, P13 | import never posts; drafts only |
| F4 | Price/demand charts; voice entry; image share of bills/statements | I08, C06, S08, C10 | device check |
| F0 | Import the shop's old DSB data (needs the owner's export file) | — | counts and balances reconcile to DSB exactly |
| CUT | Parallel week, then cutover | — | §5 |

Already shipped this week: C12 statement, N04 search, N07 attention tile, P04 line-total cost, P09 batch
drafts, S06 payment schedule, I09 camera scan (pending merge, device-unverified), P06 quick bill (pending).

## 5. Cutover gate (all dated evidence from the shop)

1. Speed on the shop phone: tab switch feels instant; POS add-item ≤ 150 ms; cold start ≤ 3 s.
2. F0 import: item, party, customer counts and every balance equal old DSB's on the same date.
3. One parallel week: Pro totals reconcile with DSB daily (sales, purchases, payments, stock).
4. Offline/restart/reconnect test, restore drill, receipt print width, WhatsApp share, per-role checks.
Until all four pass, H-gates stay NOT GO and old DSB stays the system of record.
