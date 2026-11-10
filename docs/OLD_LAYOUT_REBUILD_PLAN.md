# Old-DSB layout rebuild plan (v1, 10 Nov 2026)

Owner decision: keep the old DSB layouts almost everywhere; Pro keeps its logic (ledgers, sync, RPCs).
Reference: `/home/user/dashsuperbazar-del/dsb/index.html` (read-only) + owner screenshots of 9 Nov.

## Rules for every packet

- Layout/CSS and component structure only. No money logic, no RPC change unless the packet says so.
- Keep existing `data-testid`s, labels and roles where possible: e2e and unit tests lock behaviour. A changed
  label means the test changes in the same PR, never a skipped test.
- Side-by-side screenshots (old vs new, 390x844) attached to each PR before merge.
- One packet = one PR = live on its own, so the owner checks it on the phone before the next starts.
- Bundle gates stay (initial <= 220 KiB gz, total <= 330). Contrast gate stays.
- Bottom-sticky bars are not used inside forms (old DSB: Save at the end of the sheet).

## Packets (in order)

| #   | Packet                          | What changes                                                                                                                                                                                                                                                                                         | Migration                                            |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| L1  | Shell + shared pieces           | Bottom nav Home/Bills/Sales/Ledger/Orders (More moves to the header gear); compact white header with shop name, date, sync state, refresh, Payment; shared `Sheet` (slide-up, drag bar, X), `StatTile`, `DocCard` (party, no., date, amount, status badge), underline `Tabs`, outlined icon buttons  | no                                                   |
| L2  | Home                            | 6 tiles (total outstanding, this month bills, parties, bills today, cash in hand, bank balance), New Bill / Walk-in sale / Tools, Day Book + Profit buttons, Recent bills cards, Top outstanding with age badge + Pay, This month by party                                                           | maybe (cash/bank tile needs a read RPC if none fits) |
| L3  | New purchase bill sheet         | One slide-up sheet: party chips (all parties, owed ones marked, most-used first), date + payment type, Camera/Gallery, notes, yellow Quick bill box, item rows (old row layout: base qty/unit, secondary unit, rate/total, GST/discount, sale prices box), charges, discount, total, Save at the end | no                                                   |
| L4  | Bills list + bill detail sheet  | Search, status tabs (All/Credit/Partial/Paid/Cash/Quick), date range, Recent; cards; detail as a sheet with Pay / Edit / Share / Print / New bill for this party                                                                                                                                     | no                                                   |
| L5  | Sales                           | Tiles (sales, FIFO profit, receivable, month), tabs Invoices/Counter/Customers/Ledger, invoice cards, invoice sheet (Record payment, Edit, Share, Text, Print, Return), Customer / Walk-in / Counter buttons opening the existing POS flow in a sheet                                                | no                                                   |
| L6  | Ledger + party sheet            | Ledger/Parties tabs, Today/Week/Month/All, Paid out/Received/Both, outstanding summary with Pay now; party sheet with full bill ledger, Record payment, New bill for this party, Share statement / PDF / Text                                                                                        | no                                                   |
| L7  | Orders, Stock, Day book, Profit | Same card/tab/sheet language; Orders tab New/Active/Done/All                                                                                                                                                                                                                                         | no                                                   |

## Features old DSB has that Pro lacks (found 10 Nov by comparing function lists)

| Gap                                                                             | Plan                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Restore an archived supplier/customer (old: recycle bin)                        | F1: `restore_party` RPC + list, like 0084 for items                                   |
| Backup reminder                                                                 | F2: Home notice when the last export is older than 7 days (Settings -> Backup exists) |
| Cash in hand / bank balance on Home                                             | part of L2                                                                            |
| "New bill for this party" from the party sheet and bill detail                  | part of L4/L6                                                                         |
| Bulk category / bulk publish in the online shop item list                       | F3                                                                                    |
| Payment preview: which bills a payment will settle (oldest first) before saving | F4, display only                                                                      |
| Voice entry for a bill                                                          | check what exists first; port only if the owner uses it                               |

Already in Pro (no work): quick bill, batch bills, bill photos, duplicate-bill check, price history, demand
chart, stock adjust, returns, expenses, day book, FIFO profit, statements, WhatsApp share, CSV export, audit log,
global search, barcode scan, party merge, item archive/restore, online orders, undo for payments (void).

## Improvements beyond old DSB (keep)

Offline outbox with sync review, immutable ledgers, held stock for online orders, roles/devices, unpaid-age
badge and oldest-unpaid sort, duplicate party warning, keyboard mode (bars step aside while typing).

## Risks

- InventoryScreen.tsx is ~3,500 lines and carries most purchase tests: L3 restructures markup around the same
  state and handlers; it does not rewrite them.
- e2e specs click the current nav and sticky bars: L1 and L3 update those specs in the same PR.
- Old DSB showed every party as a chip; with 100+ parties that is slow to scan: chips show the 40 most-used,
  the search box finds the rest.
