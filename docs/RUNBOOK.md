# DSB Pro Runbook

## Backup verification
Nightly business-data backups are PostgreSQL custom-format dumps of schema `public`, encrypted with age, uploaded to B2 and R2, then checksum-read back. The backup manifest must include financial row counts/totals. A second encrypted artifact covers Supabase Auth separately; never treat the public dump alone as full-account recovery.

## Restore — fresh Supabase
1. Create an empty drill project.
2. Apply repository migrations in order.
3. Decrypt and restore the latest public business-data dump.
4. Restore the separately encrypted Auth data artifact using the documented Phase 6 auth recovery procedure.
5. Point a preview build at the drill project.
6. Run Playwright and `check_invariants()`.
7. Compare counts and financial totals with the backup manifest.
8. Record RPO and RTO.

## Restore — local Docker Postgres
Use Postgres 17. Apply public migrations, restore only the portable public dump, and run SQL invariants. Auth is intentionally not part of this provider-independence target.

## Key recovery from paper
The age private key is never stored in CI. Semi-annual drill requires locating the physical/paper recovery copy, recreating the key file offline, decrypting one B2/R2 backup, verifying SHA-256, and destroying the temporary key file after the drill.

## Supabase down
Keep billing from the installed PWA. Offline invoices remain provisional until sync. Do not clear browser/site data. When backend returns, use Sync & offline to confirm outbox=0 and resolve conflicts.

## Revoke device
Settings → Devices → revoke. Revoked device IDs cannot silently re-register.

## Storage provider switch
Item-image storage must stay behind the storage adapter. Phase 6 gate requires preview deployment using R2, then switching back, with image read/write verification in both directions.

## Hosting mirror switch
Cloudflare Pages is primary; GitHub Pages is fallback. Verify the fallback deep-link route and current app version before directing staff to it.

## Rotate anon key
Rotate in Supabase, update GitHub deployment secret, redeploy preview first, verify login/RLS, then production.

## Rotate backup credentials
Update B2/R2 and database backup secrets, manually dispatch nightly backup, verify both remote checksums and the backup_runs success row before revoking the prior credential.

## Semi-annual drill
Fresh Supabase restore + local Postgres restore + physical-key recovery + auth restore + invariant suite + preview E2E + RPO/RTO measurement. Any failed element keeps DR health red.
