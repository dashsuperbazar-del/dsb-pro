# Phase Audit TODO

Running verification checklist. Keep this file open through Phase 7; close items only with
direct repository/CI/database evidence.

Last refreshed: 2026-09-09

## Blocking before another phase is closed

- [ ] **Phase 5 chaos gate is green on the exact Phase 5 head.**
  Required scenario: start billing online, lose connectivity, finalize locally, restart the
  app while offline, remain offline for the logical one-hour outage window, reconnect, drain
  the ordered outbox, and prove exactly-once official invoices plus correct ending stock.
  As of this refresh, Phase 5 CI remains red on the offline-restart Playwright path.

- [ ] **Phase 5 exact-head concurrency/idempotency gate stays green.**
  Two devices must not oversell shared stock; exact `client_id` retries must converge;
  divergent retries under the same `client_id` must fail; official document numbers must
  remain unique.

- [x] **Missing Phase 2 / Phase 3 / Phase 3-hotfix HANDOVER history has been reconstructed
  on a docs-only branch.**
  This remains operationally incomplete until that docs PR is merged into `main`.

- [ ] **Phase 5 HANDOVER reflects the actual branch, not only change-set 5.1.**
  It must document Dexie persistence, offline sale queue/finalization, server pull/push,
  provisional/official numbering, price-drift protection, device revocation, conflict tray,
  realtime-to-polling fallback, PWA shell, cashier policy and the final chaos evidence.

- [ ] **Guarded live Phase 5 database migration passes after a verified encrypted backup.**
  Before applying migration 0029: encrypted backup must be checksum-verified in both B2 and
  R2. After migration: verify RLS/grants, authenticated-only sync RPCs, revoked-device
  enforcement and `backup_ro` read access to the new Phase 5 tables.

## Deferred but still mandatory

- [ ] **Phase 2 real-invoice reconciliation after Phase 7.**
  Per `docs/PHASE2_GATE_DECISION.md`, run at least 50 real invoices through the parity
  harness with zero-paise maximum delta. The waiver changes timing only.

## Verified clean during the Phase audit

- [x] No direct client DELETE grants found in the audited application schema.
- [x] Tenant/RLS boundaries and standard server-owned row metadata are present through the
  audited Phase 5 schema.
- [x] `stock_movements` is the stock ledger; `stock_current` is a projection.
- [x] Financial line/detail rows audited are protected from client-side mutation semantics.
- [x] No adapter-boundary leak or unescaped-HTML path was found in the audit scope.
- [x] PR #4, #5, #6 and Phase 4 PR #7 have genuine green CI evidence.

## Scope note

The VERIFY pass that created this checklist did not independently re-derive every Phase 4/5
payment/sync formula line-by-line or rerun every suite locally. Final phase closure must use
the repository's exact-head automated evidence plus live database/preview evidence rather
than treating this checklist as a substitute for those gates.
