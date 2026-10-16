# Profit report (FIFO)

Decision (user, 16 Oct 2026): cost method is **FIFO**, as in old DSB.

Migration `0060_profit_report.sql`, group `profit`, function `get_profit_report(shop, from, to)`. Read-only. Roles with
`VIEW_REPORTS` (owner, manager, accountant); cashiers are refused by the server, not just hidden.

## How the number is built

- FIFO is simulated per (shop, item) **in time order** over the whole history up to the period end, because earlier sales use
  up the oldest cost layers. A sale can only take layers dated on or before it. Only sale lines dated inside the period are
  reported.
- **Cost layers:** purchase lines of POSTED bills (net of the bill discount, plus the bill's extra charges / freight, both spread over the lines by value) and positive stock adjustments (opening stock,
  count gains), whose cost is unknown. **Consumption:** sale lines of FINALIZED invoices (cost of goods sold); negative
  adjustments and purchase returns use up layers but are not cost of goods sold.
- **Known cost:** units matched to a purchase layer. **Estimated cost:** units with no layer available at that time (sold before the purchase's date, or stock that
  predates the system), costed at the latest purchase unit cost seen before the sale, else the item's first purchase cost,
  and shown separately.
  **Unknown cost:** no purchase at all; the revenue is reported apart and is **not** in profit or margin.
- **Revenue** is the invoice allocation the item-sales report uses (after discounts; extra charges and round-off excluded).
  GST printed on bills is inside it. Returns reduce revenue on the return's date.
- **Returns to sellable stock** credit the original sale line's cost pro rata (the returned units do not re-enter the queue, so a
  later sale may be costed from a newer batch). Other dispositions keep the cost (a loss).
- Voided bills and invoices are ignored as if they never happened. Money comes back as text paise.

## Why this can be trusted

Hand-computed pgTAP (48 assertions): two layers, three sales, a sale that outruns the stock, a voided sale, a voided purchase
dated before the first layer (mutation-checked: without the void the figures change), a pro-rata return credit
(9600 × 2 / 9 = 2133), an unknown-cost item and the refund of one (no phantom loss), a sale dated before its purchase
(estimated, layer untouched), freight in unit cost, revenue equal to the item-sales report on a discounted invoice, a later period that must honour earlier consumption, margin in basis points, and
cashier / accountant / backwards-period handling.

## Known limits

- Backdated sales entered after go-live can only use layers dated on or before them; stock that existed before the system was
  loaded as an adjustment dated today therefore shows as ESTIMATED for those sales, not known.
- Units sold out of opening stock count as ESTIMATED once the item has any purchase, and as UNKNOWN only when it has none.
- Cost is the purchase bill as entered; revenue includes the GST printed on sale bills. If purchase GST is entered differently
  the margin is skewed.
- Per-line cost rounds the running exact cost, so lines add up to the exact cost within half a paisa.

- It is a report, not a ledger: it never changes stock, money or any row.
- Revenue includes GST (a GST-registered shop's margin is overstated by the tax share).
- Measured on a local Postgres 16 with 10k items, 100k sale lines and 50k purchase layers: 0.55 s for a day, 0.6 s for a
  month, 1.6 s for a full year (Supabase's default limit is 8 s). Not yet measured on the CI database or a phone.
- Adjustment dates use the shop's timezone; ordering inside one invoice follows line number.
- Not yet validated against real shop data or old DSB output; do that on a real month before relying on it.
