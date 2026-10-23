# Offline purchases — plan (22 Oct 2026)

Owner request: "record purchases while offline, everything syncs back to the cloud when back online".
Packet: UI + sync + adapters only. **No migration** — `post_purchase_v2` (0064) already replays an exact
same-id request with its stored answer (bill + payment ids) and `get_financial_request('purchase.post.v2')`
reads that answer, which is all an outbox needs.

## How it works today (studied)

- Sales: `queueOfflineSale` writes the record + an `outbox` row (`kind financial-rpc`, monotonic
  `sequence`, client id unique) in one Dexie transaction; `processOutbox` (apps/admin `lib/offlineSync.ts`)
  sends strictly in sequence order, one at a time; unknown outcome → `retry` with backoff (the queue stays
  blocked behind it, and pulls wait), definitive refusal → `REJECTED` + local conflict + server conflict
  record; restart turns `sending` into `retry` (`recoverInterruptedOutbox`).
- Purchases: online only. `addPurchase` stores the request as a pending intent (localStorage) before
  sending, freezes the form on an unknown outcome and retries the same id/payload; `postPurchaseV2Outcome`
  decides committed / rejected / unknown and, on a refused retry, reads the stored answer. Photos are
  uploaded to an immutable path `tenant/shop/<bill client id>/<id>` before posting (upload of identical
  bytes is idempotent); the server checks the objects exist.

## Silent data-corruption risks first (and guards)

1. **Double bill / double payment on resend** (offline queue + reload + two tabs + online retry). Guard:
   one client id per queued bill, outbox `&clientId` unique, the exact frozen request is resent
   (`post_purchase_v2` replays it), a retry (`attempts > 1`) that is refused is decided by the stored answer
   (`isRetry` lookup) — a refusal after a committed first send becomes SYNCED, never REJECTED. Cash/UPI
   payment is inside the same request (no second write).
2. **Bill lost on refusal** (archived supplier, changed units, permission, mismatch). Guard: REJECTED is a
   visible record with reason, local + server conflict row, and the full form snapshot is kept; "Correct
   this bill" turns it into a normal draft. Never deleted automatically.
3. **Bill silently changed at sync** (totals/round-off recomputed differently). Guard: totals are computed
   once by core `purchaseBillTotals` into the frozen request; the server refuses a mismatch
   (`DSB_TOTAL_MISMATCH` → REJECTED, visible); the ack must echo the same total and round-off.
4. **Photo attached to the wrong bill or lost**. Guard: photo paths carry the bill's client id; bytes stay
   in the device store until the bill is SYNCED; uploads are verified by sha256 and re-upload of identical
   bytes is idempotent; missing bytes are decided by the stored answer (committed → SYNCED, not found →
   REJECTED "photo missing", unreachable → retry).
5. **Offline sale counting stock from a bill that is later refused**. Guard (decided, conservative): an
   unsynced purchase does NOT add to the device's sellable stock; it shows as "+qty — not synced" in the
   pending list. Offline sales keep the existing stock policy; server order follows the outbox sequence,
   so a purchase queued before a sale is posted before it.
6. **Unknown item at sync** (item created offline). Guard: new items cannot be created offline (refused
   with a message); every line references an item already on the server.
7. **Bill edit / void / supplier payment posting twice or out of order**. Guard: online only.
8. **Corrected bill posted twice**. Guard: a correction of a plain refusal keeps the same client id (nothing
   was committed under it); after `DSB_PAYLOAD_MISMATCH` (id belongs to another bill) it gets a new id and
   drops the photos (their paths belong to the old id). The duplicate-bill warning runs again on post.

## Decisions

- Allowed offline: new purchase bills, Credit, and Cash/UPI paid in full (payment in the same idempotent
  request), with existing items, named charges, discounts/GST, notes, bill photos.
- Online only (clear message): bill edit, void, supplier payments, creating a new item, sale-price box
  (writes happen after the bill confirms; kept online), retrying an unconfirmed online post.
- Offline saving is for owner/manager (the roles that post purchases and keep drafts/photos).
- Queue: the same outbox (`target post_purchase_v2`) ordered with offline sales; new Dexie table
  `offlinePurchases` (version 6, additive). Photos upload just before the bill posts at sync (paths must
  exist server side); bytes removed after SYNCED.
- Duplicate check offline: loaded bills + the saved Purchases list copy + this device's queued bills.
- Opening Purchases offline after a restart: catalog from the device sync cache, suppliers from a device
  copy saved on the last online load, business date from the sync cache. If none is available the screen
  says so and nothing is posted.
- Multi-device: each device queues its own bills under distinct ids; the server serializes; no LWW.
- Pending list in the purchase view: QUEUED "Saved on this device — will sync", REJECTED with reason,
  "Correct this bill" and "Dismiss", SYNCED (last 24 h).

## Tests

Unit (packages/sync): queue → outbox row in sequence with sales; replay of same id returns the existing
record; complete is idempotent; reject keeps the record + conflict. Admin unit: processOutbox purchase
branch (committed / rejected / unknown / retry lookup, photo upload once). Playwright: offline credit +
cash bills, reload offline, reconnect → exactly one bill each on the server, stock and supplier balance,
photo uploaded once; a refused bill shows REJECTED with "Correct this bill".
