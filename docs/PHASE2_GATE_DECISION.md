# Phase 2 Gate Decision — Core Library

Date: 2026-09-08

## Decision

Phase 2's original locked gate requires 50 real historical DSB invoices to match DSB Pro totals to the paisa. The historical 50-invoice dataset is not available in the repository, uploaded DSB source, or accessible file library, so that literal historical-data check cannot currently be executed.

Apd explicitly authorized a temporary evidence substitution on 2026-09-08: Phase 2 may close using the implemented golden/core tests plus the screenshot-backed 50-case synthetic stress suite, while the original 50-real-invoice reconciliation is **deferred until after Phase 7**.

This is a waiver of timing/evidence availability only. It does not redefine synthetic invoices as historical invoices and does not delete the original acceptance criterion.

## Replacement Phase 2 evidence

- Core library ports units, pricing, totals, discounts, extra charges and legacy `calcBigEquiv` behavior.
- Canonical DSB Pro money calculations use integer paise; GST/tax metadata is informational and is not reapplied to all-inclusive prices.
- Historical DSB reconciliation logic remains isolated from the canonical DSB Pro totals path.
- A parity harness remains in the repository and requires at least 50 supplied records and zero-paisa mismatch when real invoices become available.
- 50 deterministic synthetic invoice cases use only item-master values visibly captured from the user's real DSB application screenshots.
- The suite is balanced 25 retail / 25 wholesale and covers every valid unit tier available in the admitted items, fractional and integer quantities, discounts, extra charges and tax metadata.
- Items with missing retail/wholesale pricing or incomplete conversion data were excluded rather than guessed.

## Deferred post-Phase-7 verification

After Phase 7 migration/cut-over, retain or create at least 50 real invoices suitable for DSB-vs-DSB-Pro reconciliation and run them through the existing parity harness.

The deferred gate passes only when:

1. at least 50 real invoices are supplied;
2. all 50+ invoice totals match the expected DSB totals exactly;
3. maximum absolute delta is 0 paise; and
4. any mismatch is investigated and fixed rather than weakening the test.

If this deferred real-invoice validation fails, it becomes a blocking financial-reconciliation defect and must be resolved before migration/cut-over is treated as fully reconciled.

## Phase 2 close condition

With this explicitly authorized waiver, Phase 2 may be considered complete when the Phase 2 branch's final CI is green. The PR must still not be merged into `main` without explicit merge authorization.
