# Phase 6 closure record

Date: 2026-09-11  
Branch: `phase-6-ledgers-reports-dr`

## Automated closure scope

The Phase 6 implementation now provides:

- permission-enforced reports, serialized stock counts, retry-safe expenses, and ledger/projection invariants;
- a one-click device ZIP containing the portable JSON export, every exported array as CSV, and one PDF per invoice;
- a separate offline billing-continuity snapshot for catalog, stock, queued sales and conflicts;
- nightly encrypted PostgreSQL and Auth artifacts in B2 and R2, read-back checksum verification, a comprehensive encrypted JSON export, and per-tenant invariant checks recorded in the manifest;
- portable PostgreSQL recovery with live financial parity plus a synthetic non-zero financial-history round-trip;
- disposable Supabase public/Auth recovery with real password login and tenant RLS proof;
- the 10,000-item throttled-network performance gate; and
- an R2 preview deployment, authenticated image operations, Supabase switch-back, and exact restoration of the previous Cloudflare binding configuration.

The last pre-closure baseline, `4daf48ab9690a9753862bd98709d5ffb44e02984`, passed all four Phase 6 workflows. The closure commit must pass the same exact-head workflows before it is considered an automated pass.

## Human evidence still required for formal GO

These steps require physical custody, a fresh hosted project, or actual shop operations. Automation must not mark them complete:

| Evidence | Pass record required |
|---|---|
| Fresh hosted Supabase restore | Drill project reference, public/Auth restore logs, real login, RLS, invariants, financial parity, and preview E2E |
| Paper-key recovery | Custodian, date, backup object, checksum, successful decrypt, and confirmation temporary key material was destroyed |
| Measured recovery objectives | Backup timestamp, incident start, service-ready time, measured RPO (≤24h), measured RTO (≤2h) |
| Shop data verification | Required Phase 3 purchase/stock physical checks and Phase 4 full-day POS reconciliation |

Phase 6 remains **NOT GO** until the closure commit is green and every applicable human evidence row is recorded as passed. Phase 7 migration/cut-over work must not begin before that decision.

## Drill record template

```text
Date/time (UTC):
Operator and witness:
Source backup object + SHA-256:
Fresh hosted project reference:
Public restore: PASS/FAIL
Auth restore + real login: PASS/FAIL
Tenant RLS: PASS/FAIL
Invariant result:
Financial manifest parity:
Preview E2E:
Paper-only key decrypt: PASS/FAIL
Temporary key destroyed: YES/NO
Measured RPO:
Measured RTO:
Phase 3 physical purchase/stock evidence:
Phase 4 full-day POS reconciliation evidence:
Final decision: GO/NOT GO
```
