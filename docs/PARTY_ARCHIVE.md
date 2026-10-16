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

Known limits: a bill posted by a crafted API call for an already-archived supplier is not blocked (the UI cannot select it);
an archived customer keeps its name reserved (unique name). Items remain visible to owners/managers after an archive through
the same FOR ALL pattern (`items_write`); no screen archives items today.

Upgrade: group `partyarchive` (classifier fields `partyarchive_state`, `needs_partyarchive`; six all-or-nothing anchors).
Proof: pgTAP `remaining_party_archive.sql` (31 assertions) and the CI step "Prove guarded party archive upgrade".
