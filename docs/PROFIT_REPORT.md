# Profit report (FIFO)

Decision (user, 16 Oct 2026): cost method is **FIFO**, as in old DSB.

Migration `0060_profit_report.sql`, group `profit`, function `get_profit_report(shop, from, to)`. Read-only. Roles with
`VIEW_REPORTS` (owner, manager, accountant); cashiers are refused by the server, not just hidden.

## How the number is built

- FIFO runs per (shop, item) over the **whole** history up to the period end, because earlier sales use up the oldest cost
  layers. Only sale lines dated inside the period are reported.
- **Cost layers:** purchase lines of POSTED bills (net of the bill discount) and positive stock adjustments (opening stock,
  count gains), whose cost is unknown. **Consumption:** sale lines of FINALIZED invoices (cost of goods sold); negative
  adjustments and purchase returns use up layers but are not cost of goods sold.
- **Known cost:** units matched to a purchase layer. **Estimated cost:** units with no layer left (sold before the purchase was
  entered, or stock that predates the system), costed at the item's latest purchase unit cost and shown separately.
  **Unknown cost:** no purchase at all; the revenue is reported apart and is **not** in profit or margin.
- **Revenue** is the invoice allocation the item-sales report uses (after discounts; extra charges and round-off excluded).
  GST printed on bills is inside it. Returns reduce revenue on the return's date.
- **Returns to sellable stock** credit the original sale line's cost pro rata (the returned units do not re-enter the queue, so a
  later sale may be costed from a newer batch). Other dispositions keep the cost (a loss).
- Voided bills and invoices are ignored as if they never happened. Money comes back as text paise.

## Why this can be trusted

Hand-computed pgTAP (27 assertions): two layers, three sales, a sale that outruns the stock, a voided sale, a voided purchase
dated before the first layer (mutation-checked: without the void the figures change), a pro-rata return credit
(9600 × 2 / 9 = 2133), an unknown-cost item, a later period that must honour earlier consumption, margin in basis points, and
cashier / accountant / backwards-period handling.

## Known limits

- It is a report, not a ledger: it never changes stock, money or any row.
- Revenue includes GST (a GST-registered shop's margin is overstated by the tax share).
- Very large histories are computed on demand; the 10k-item / 100k-invoice profile has not been measured for this report.
- Not yet validated against real shop data or old DSB output; do that on a real month before relying on it.
