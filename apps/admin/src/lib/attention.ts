import type { LowStockRow, SupplierOutstandingRow } from '@dsb-pro/adapters';

// Pure summaries for the Home "needs attention" tile. Figures come from the server reports; nothing
// is recomputed from ledgers here. Supplier amounts stay integer text (BigInt sum), never Number.
export function summarizeLowStock(rows: LowStockRow[]) {
  const worst = [...rows].sort((a, b) => b.shortfall - a.shortfall).slice(0, 3);
  return { count: rows.length, worst };
}
export function summarizeSuppliers(rows: SupplierOutstandingRow[]) {
  let owed = 0n;
  let owedCount = 0;
  let stranded = 0;
  for (const r of rows) {
    const net = BigInt(r.netLedgerBalance);
    if (net > 0n) {
      owed += net;
      owedCount++;
    }
    if (r.strandedAllocationsOnVoidBills > 0) stranded++;
  }
  return { owedCount, owedPaise: owed.toString(), strandedSuppliers: stranded };
}
