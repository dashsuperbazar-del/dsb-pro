# DSB Pro — STATE (read this first; the full history is in docs/STATE_HISTORY.md)

Process: `docs/SINGLE_BUILDER_PLAN.md` v2.0. Design/invariants: `docs/COMPLETE_REMAINING_BUILD_PLAN.md` v1.1.
Never trust a SHA written here: check `git log origin/main -1`. Keep this file under 120 lines; put detail in PRs.

## Live (9 Nov 2026)

- Database: every migration through **0082** applied live (each preflight showed only the expected group).
  0083 `orderadjust` is in PR #177 (apply after merge; preflight must show only `needs_orderadjust`).
- Apps (Cloudflare Pages, deployed by `ci.yml` operation `deploy_production` from main):
  - Shop app (staff): https://dsb-pro.pages.dev/ (GitHub Pages fallback https://dashsuperbazar-del.github.io/dsb-pro/)
  - Public shop: https://dsb-shop.pages.dev/?shop=<slug> (project `dsb-shop`, `apps/storefront`)
  - Public item photos: `apps/admin/functions/api/shop-image.js` (served only for published items)

## What exists (short map)

- Admin app `apps/admin` (Preact PWA): POS, purchases (fast bill, batch, quick bill, photos, edit/void), inventory,
  suppliers/customers ledgers + statements, returns, expenses, reports (day book, FIFO profit, GST), sync review,
  offline sales/purchases/new items/bill edits/supplier payments, audit log, team/devices, settings, online shop
  settings, online orders.
- Packages: `core` (money/units, integer paise), `adapters` (all Supabase calls), `sync` (Dexie outbox), `db` (types).
- Storefront `apps/storefront` (~14 KB gz): shelves, photos, basket, pickup/delivery + slots, Pay by UPI link,
  confirmation, step tracking, shareable tracking link (#/t/REF.TOKEN), find my order, my orders, order again.
- Orders: NEW → CONFIRMED → PREPARING → READY → (OUT_FOR_DELIVERY) → DELIVERED via `fulfil_order` (one normal
  sale through `post_sale`), or CANCELLED. Stock is HELD (stock_current.reserved) from placement; holds expire
  after the shop's minutes (not while out for delivery).

## Decisions that must not be undone silently

- Money is integer paise; ledgers are immutable; corrections are new rows/voids; no client DELETE.
- The server prices every online order and every hand-over; a price/GST difference at hand-over is refused
  (DSB_ORDER_REQUOTE_REQUIRED), never hidden as a discount. Order line changes may only REDUCE (0083).
- POLICY (SF2, 8 Nov): a POS sale never takes stock held for an online order, even with negative stock
  allowed (supersedes the 0030 "no hidden exception" test). Owner was asked; no answer yet — keep unless told.
- Stock counts keep the 0042 rule (cannot go below what is held).
- Online payment: free UPI deep link only (owner, 9 Nov); staff verify in their UPI app before hand-over as UPI.
- Customer messages: one-tap WhatsApp from the staff phone (owner, 9 Nov); no Business API / SMS.
- Item photos are public only for published items; the tracking link shows order/status, never contact data.
- Bundle gates (`scripts/check-bundle-size.mjs`): initial ≤ 220 KiB gz (was 260; Inventory/Suppliers moved to the
  on-demand `workScreens` chunk), total ≤ 330 KiB. Rare screens live in `rareScreens`.
- Old DSB is retired: no legacy import, no shadow run.

## How to add a migration (cheapest path)

1. Failing pgTAP test in `supabase/tests/remaining_<name>.sql`, then `supabase/migrations/00NN_<name>.sql`.
2. `scripts/add-upgrade-group.py ...` (see its header) wires manifest, ALLOWED_GROUPS, GROUP_ORDER, apply wrapper,
   inspector probe, CI proof + live apply. Every anchor must require its objects to exist.
3. If it adds a table: add it to `phase6_export_tenant` (re-issue the whole function), to
   `supabase/tests/remaining_d3a_export_coverage.sql` and to `scripts/export-tables.json` (restore map).
4. Re-issuing an order function: copy the latest body from its newest migration and change only what you must.
   Avoid `case … end` inside an `if` condition (the Supabase CLI statement splitter cuts there).
5. Regenerate `packages/db/src/types.ts` ONLY from a running local DB (an empty file was pushed once).
6. Before pushing: `FORMAT_BASE=$(git merge-base origin/main HEAD) node scripts/check-format.mjs`, lint,
   typecheck, touched unit tests, the new pgTAP file; CI runs the rest.

## CI notes

- Infra flakes seen: busy Supabase ports, registry "Rate exceeded", GitHub 504 on action downloads.
  `scripts/supabase-start-retry.sh` (PR #176) retries start/pulls; re-run failed jobs once for a 504.
- `phase6-performance.yml` (opt-in perf workflow, not a merge gate) failed on main since 4 Nov on a missing
  Customers link; fixed by SF5 (More → Customers).
- Local `pnpm test db` reports "receipt for 0044" failing: CI-only bootstrap, not a defect.

## Open (owner)

- Answer the POS-vs-held-stock policy question.
- Open the shop: Online shop settings → publish items → tick open; set UPI ID; shop page details.
- Real-phone checks: speed of first open, offline sale/purchase, camera/photo upload, printer, an online order
  end-to-end (place → alert → confirm → pack → ready → hand over), shared tracking link on another phone.
- Settings: shop name still "Dsb"; check Settings → Backup.

## Not built (by choice)

Payment gateway auto-confirmation, WhatsApp Business API / SMS, delivery distance zones, other-shop
deployments/superadmin/SaaS, two-column desktop POS, link-preview image for the shop.
