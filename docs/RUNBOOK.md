# DSB Pro Runbook

## Backup verification
Nightly business-data backups are PostgreSQL custom-format dumps of schema `public`, encrypted with age, uploaded to B2 and R2, then checksum-read back. The backup manifest must include financial row counts/totals. A second encrypted artifact covers Supabase Auth separately; never treat the public dump alone as full-account recovery.

## Restore — fresh Supabase
Start the RTO clock immediately before step 1. Use a disposable hosted project, never the production project.

1. Create an empty drill project and record its reference in `docs/PHASE6_CLOSURE.md`'s drill template.
2. Apply repository migrations in order.
3. Decrypt and restore the latest public business-data dump.
4. Restore the separately encrypted Auth data artifact using the documented Phase 6 auth recovery procedure.
5. Point a preview build at the drill project.
6. Run Playwright and `check_invariants()`.
7. Compare counts and financial totals with the backup manifest.
8. Record RPO as `restore-ready time − newest restored business record time` and RTO as `preview service-ready time − drill start time`. The targets are RPO ≤24h and RTO ≤2h.
9. Delete the disposable hosted project only after retaining the logs and completed drill record.

## Restore — local Docker Postgres
Use Postgres 17. The `phase6_portable_restore` CI job restores the current public dump, checks live financial parity, then adds a synthetic non-zero sale, payment, purchase, expense and stock history, dumps it, restores it again, and requires every fixture record. Auth is intentionally handled by the separate disposable-Supabase recovery gate.

## Key recovery from paper
The age private key is never stored in CI. With a witness, locate one physical/paper recovery copy, recreate the key file on an offline device, fetch a named B2/R2 backup, verify its recorded SHA-256, decrypt it using only the recovered key, inspect the archive, then securely destroy the temporary key file. Record custodian, witness, object name, checksum, result and destruction confirmation in the closure drill record. Never photograph or commit the key.

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


## Suspend / restore a user
1. Use the owner-only Users screen to set the tenant membership status to suspended; do not delete the Auth user or membership row.
2. Verify the affected account can no longer access tenant data or privileged RPCs.
3. To restore access, set the membership back to active and require a fresh sign-in so claims/session state is refreshed.
4. If compromise is suspected, revoke all registered devices for that user before restoring access.

## Rotate backup-role database password
1. Create a new strong password for the SELECT-only `backup_ro` database role using an owner/admin connection.
2. Update only the GitHub `BACKUP_RO_DATABASE_URL` secret to use the new credential.
3. Manually run the nightly backup workflow and verify: public dump succeeds, both remote checksum reads succeed, and the `backup_runs` row is `success`.
4. Run the Phase 6 portable PostgreSQL restore/parity gate against the new credential.
5. Only after those checks pass, invalidate the old backup-role password.
6. Never widen `backup_ro` privileges to INSERT/UPDATE/DELETE to make a backup job pass.

## Supabase free tier discontinued / provider exit
1. Keep the installed PWA in offline billing mode; do not clear IndexedDB/site data.
2. Obtain the newest checksum-verified encrypted public backup plus the matching Auth artifact from B2 or R2.
3. Recover the age private key from the physical recovery copy and decrypt offline.
4. Bring up a Supabase/GoTrue-compatible self-hosted target using the documented supported PostgreSQL version.
5. Apply repository migrations, restore the public dump, then restore Auth separately into the compatible Auth schema.
6. Point a branch preview at the replacement backend and run pgTAP, Playwright, `check_invariants()`, and financial manifest parity.
7. Switch production configuration only after the preview is green and queued offline work has been reconciled by client ID.
8. Keep the old provider untouched until the replacement has completed one verified backup cycle.

## Semi-annual drill
Fresh Supabase restore + local Postgres restore + physical-key recovery + auth restore + invariant suite + preview E2E + RPO/RTO measurement. Any failed element keeps DR health red.

Use the checklist and evidence template in `docs/PHASE6_CLOSURE.md`. A CI pass cannot substitute for the hosted-project, physical-key, or shop-floor evidence.
