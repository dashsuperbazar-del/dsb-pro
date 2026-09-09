# Restore procedure

**Phase 6 design: two-layer DR.** Business data remains a provider-portable `public` PostgreSQL dump. Supabase Auth is protected by a separate encrypted artifact and is restored only into a fresh Supabase/GoTrue-compatible target. This avoids coupling the portable business-data backup to Supabase internals.

## Restore into fresh Supabase
1. Create an empty drill project and apply every migration in order.
2. Download the matching encrypted public dump and auth artifact from a checksum-verified destination.
3. Recreate the age private key from the physical recovery copy; decrypt both artifacts locally.
4. Restore the public custom-format dump with Postgres 17 `pg_restore`.
5. Restore the auth data artifact into the fresh Supabase project using an owner connection. Auth import is a separate step because it is provider-specific.
6. Point a preview deployment at the drill project.
7. Run pgTAP/Playwright plus `select check_invariants();`.
8. Compare sale invoice count/sum, payment count/sum, purchase count/sum and stock-movement count with the backup manifest.
9. Measure RPO from source backup timestamp to drill point and RTO from drill start until preview passes.

## Restore into local Docker Postgres
1. Start Postgres 17.
2. Apply the public migrations.
3. Restore only the decrypted public business-data dump.
4. Run invariant/report checks. Auth is deliberately excluded from this provider-independence drill.

## Required evidence
- SHA-256 before/after download.
- B2 and R2 object names.
- Exact source and target row-count/totals manifest.
- `check_invariants()` result.
- Playwright result for fresh Supabase.
- RPO and RTO.
- Confirmation that the paper/private key, not a CI secret, decrypted the drill backup.

A restore is not considered proven until these artifacts are captured in the Phase 6 handover.
