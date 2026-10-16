# Supplier and customer edit / archive

**Edit** (PR #80, no migration): owners and managers correct name, phone, GSTIN, address (customers also credit limit and
notes) from the Suppliers and Customers screens. Master data only; the audit trigger records old and new values. Concurrent
edits are last-writer-wins; no money moves.

**Archive** (migration `0059_party_archive.sql`, group `partyarchive`):

- `archive_party(uuid)` / `archive_customer(uuid)` (owner, manager): soft archive (`deleted_at`), audited, idempotent.
- A party with **any** purchase bill, sale invoice, payment, return or opening balance (including voided ones) is refused with
  `DSB_PARTY_HAS_HISTORY`: a ledger row never loses its owner. Only unused parties (typos, duplicates) can be archived.
  The check runs under a row lock on the party, which also serialises with a bill or payment being posted for it.
- `archive_master('parties', …)` now refuses (it had no history check). Clients can no longer write `deleted_at`,
  `tenant_id`, `client_id` of parties/customers directly (column grants).
- `parties_write` (FOR ALL) is split into insert/update policies; it let owners and managers keep seeing archived suppliers
  (RLS policies are OR-ed), which would have made archive invisible to them. Archived suppliers/customers are now hidden
  by the read policy alone and cannot be edited.
- **Security fix:** cashiers held `MANAGE_CUSTOMERS`, so a cashier could rewrite any customer (credit limit, notes) and
  archive it through the API. They can still create customers at the till; updates now need `MANAGE_MASTER_DATA`.

- **Archive vs posting race (found in review, closed):** the posting functions test "party is live" with a plain SELECT and
  take the FK lock only at INSERT, so an archive could slip in between. A `dsb_live_party_guard` BEFORE INSERT trigger on
  purchase_bills, purchase_returns, sale_invoices, sale_returns, payments and account_openings locks the party row
  `FOR KEY SHARE` and refuses an archived party (`DSB_PARTY_ARCHIVED`). Verified with two concurrent sessions in both orders:
  a bill in flight makes the archive refuse; an archive in flight makes the bill refuse.
- **Names:** the customer-name unique constraint is replaced by a partial unique index on live rows, so an archived (invisible,
  unrestorable) customer no longer reserves its name.

Known limits: a pre-existing archived party that already has history (possible only if someone called the old unguarded
`archive_master`) would now refuse new documents such as a void's reversal rows; the legacy one-time DSB import guard only
checks live rows. Items remain visible to owners/managers after an archive through
the same FOR ALL pattern (`items_write`); no screen archives items today.

Upgrade: group `partyarchive` (classifier fields `partyarchive_state`, `needs_partyarchive`; eight all-or-nothing anchors).
Proof: pgTAP `remaining_party_archive.sql` (39 assertions) and the CI step "Prove guarded party archive upgrade".
