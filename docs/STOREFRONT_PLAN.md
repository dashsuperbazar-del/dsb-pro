# DSB Pro — online storefront build plan (own shop)

Date: 4 Nov 2026. Base: main `0af4b73`. Design contract: `docs/COMPLETE_REMAINING_BUILD_PLAN.md` §17 (G0–G6);
this file fixes scope, order, migration numbers and decisions for the OWN shop only. Old DSB features: parity
rows G01–G09.

## 1. Scope

In: customers browse the shop's items on a public page, add to cart, place a pickup (optionally delivery) order;
the shop sees orders in the admin app, moves them NEW → CONFIRMED → PREPARING → READY → DELIVERED or CANCELLED,
and fulfils an order into a normal sale. Old DSB G01–G09 covered.

Out (later, only on request): friend-shop deployments and superadmin (§17 G5), SaaS billing (§18), online
payment (UPI collect/gateway), OTP login, automatic WhatsApp/SMS sending. Orders are paid at pickup/delivery
through the existing POS tender, so the storefront never handles money.

## 2. Packets (one PR each; migrations applied live one group at a time after preflight)

| #   | Packet                         | Migration            | What                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SF0 | Settings + publish items       | 0077 `storefront`    | `storefront_settings` (off by default, slug, display name, contact, pickup note, order hours, reservation minutes 5–120, max lines 50, delivery on/off + server-set fee, minimum order, free-delivery threshold); per-item `published`, category, short description. Permissions MANAGE_STOREFRONT (owner/manager), MANAGE_ORDERS (owner/manager/cashier). Admin Settings → Online shop + bulk publish in Inventory (G09) |
| SF1 | Public catalog + gateway       | 0078 `publiccatalog` | `public_catalog` security-barrier view (exact column allowlist: name, category, units, retail price, public image, in-stock yes/no; never cost/supplier/stock numbers); Cloudflare Pages Function gateway `/api/shop/*` (already on Cloudflare): slug→shop server-side, body ≤64 KiB, rate limit, no client prices. Public item images as sanitised copies                                                                |
| SF2 | Orders + reservations          | 0079 `orders`        | `shop_customers`, `orders`, `order_items`, `order_events` (append-only), `stock_reservations`; `place_order` (gateway-only, idempotent, server prices, locks stock, reserves, never posts stock movements); expiry worker; stock trigger change so a POS sale can never eat reserved stock                                                                                                                                |
| SF3 | Fulfil into a sale             | 0080 `orderfulfil`   | `fulfill_order` → existing `post_sale` only (the single money/stock writer); price drift ⇒ `DSB_ORDER_REQUOTE_REQUIRED` and a recorded re-quote; cancel releases reservation, never a stock movement                                                                                                                                                                                                                      |
| SF4 | Storefront app + Orders screen | none                 | `apps/storefront` (Preact, separate small bundle): shelves/search/category, item detail, cart kept on the phone, checkout (name/phone/address, honeypot), confirmation + status page, "my previous orders" on that phone, order again (G01–G06). Admin Orders screen with filters, badge, transitions, fulfil dialog, stock warnings, share status on WhatsApp (G07–G08)                                                  |
| SF5 | Acceptance                     | none                 | Anonymous security suite, concurrency e2e (two customers last unit, POS racing an order, duplicate submit, lost response, expire vs fulfil), restore with open orders, gateway down ⇒ POS unaffected                                                                                                                                                                                                                      |

## 3. Silent data-corruption and security risks (guard before code)

1. **Reserved stock eaten by a POS sale** (biggest money risk): today a negative-stock override can sell below
   what is reserved. SF2 changes the stock trigger so a sale can never take stock below the reserved amount, and
   adds a test for exactly that case. POS offline sales still queue; the server refuses only what would break a
   reservation, with a clear message.
2. **Public data leak:** anon reads only the catalog view; every base table stays denied; tests check the exact
   column list, a disabled shop is hidden, and shop A's slug cannot reach shop B.
3. **Price tampering:** the client never sends prices; the server prices every line at order time and again at
   fulfilment; any difference needs a recorded re-quote, never a hidden discount.
4. **Double sale / double stock:** order placement and fulfilment are idempotent (request id + token digest);
   fulfilment goes through `post_sale` only, in one transaction with the reservation release.
5. **Phone ≠ customer account:** an order contact is never merged into a credit customer by phone; credit only
   when staff explicitly picks a customer.
6. **Spam orders:** rate limit (default 10 orders / 10 min per source, 60 / hour per shop), honeypot, size caps;
   reservations expire (default 30 min) so spam cannot lock stock for long.

## 4. Order of work and cost

SF0 → SF1 → SF2 → SF3 → SF4 → SF5, one PR per packet, reviewer sub-agent on SF1–SF3 (security/money). About
4 migrations and 6 PRs. SF2 and SF3 are the heavy ones (stock trigger + concurrency tests).

## 5. Owner decisions (8 Nov 2026)

1. Start now (before the clean shop week). Accepted risk: orders run on a system not yet proven in daily use.
2. Pickup and delivery like old DSB (fee, minimum order, free-delivery threshold, time slots).
3. Separate subdomain for the public shop (separate Cloudflare Pages project + DNS record in SF4).
