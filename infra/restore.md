# Restore procedure

**Status: NOT YET DRILLED — first drill is a Phase 6 gate (DSB_PRO_BUILD_PLAN.md v1.5 §13).**
This is the documented procedure only. Do not treat it as proven until it has actually been
run end-to-end and the result compared against production, per the Phase 6 gate.

## Restore into a fresh Supabase project

1. Create a new Supabase project (or reuse an empty one reserved for drills).
2. `supabase link --project-ref <new-project-ref>`
3. `supabase db push` — applies every migration in `supabase/migrations/` in order.
4. Fetch the latest encrypted dump from Backblaze B2 (primary, bucket `APD-BB`) or Cloudflare
   R2 (secondary, bucket `apd-dsb`):
   `rclone copy b2:APD-BB/<backup-file> .` (or `rclone copy r2:apd-dsb/<backup-file> .`)
5. Decrypt with the `age` private key (kept per §18 Q4 physical custody, never in this repo
   or in GitHub Actions):
   `age -d -i <private-key-file> -o dump.pgcustom <backup-file>`
6. Restore: `pg_restore --clean --if-exists -d "<new-project-connection-string>" dump.pgcustom`
   — use the new project's **Session pooler** connection string if restoring from a network
   without outbound IPv6 (the direct connection is IPv6-only; see `docs/HANDOVER.md` for why
   this matters for automation, though a one-off manual restore from a machine with IPv6 can
   use the direct connection instead).
7. Point a preview deployment at the new project's URL/anon key.
8. Compare row counts and, once real financial data exists, invoice/payment totals against
   the manifest recorded in the corresponding `backup_runs` row (`select manifest from
   backup_runs where sha256 = '<the checksum of the dump you restored>';`). Note the
   manifest's `scope` field — Phase 0's dumps are scoped to schema `public` only; once
   `auth`/`storage` schemas carry real data, confirm the manifest's scope still matches what
   was actually restored.

## Restore into local Docker Postgres (provider-independence proof)

1. `docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=postgres postgres:17` — match the major
   version to the source project's (`select version();` on the source, or check the most
   recent `backup_runs.app_version`/manifest) to avoid `pg_restore`'s own version checks.
2. Apply migrations directly: `psql postgresql://postgres:postgres@localhost:5433/postgres -f supabase/migrations/0001_init.sql -f supabase/migrations/0002_backup_status_rpc.sql`
3. Decrypt and restore the same dump as above, pointed at `localhost:5433`.
4. Confirm the restored data matches step 8 above.

## Notes from Phase 0's own setup, relevant to a real drill

- The backup pipeline dumps via `backup_ro`, a role with `BYPASSRLS` and `SELECT` on schema
  `public` only (see `docs/HANDOVER.md`) — restoring doesn't need this role at all;
  `pg_restore` runs as the target project's owner/superuser connection.
- `backup_runs` rows carry `destinations: [{"name":"b2","verified":true},{"name":"r2","verified":true}]`
  confirming which of the two copies were checksum-verified at backup time — both should
  normally agree, but if only one destination shows `verified:true` for the run you're
  restoring, prefer that one.
- Dumps are `--format=custom`, schema `public` only (Phase 0 scope) — `pg_restore` needs no
  special flags beyond `--clean --if-exists` for a clean re-apply onto a freshly-migrated
  (not merely empty) database.

## Open items for the Phase 6 drill

- Exact RTO/RPO measured, not assumed (target: RPO ≤ 24h, RTO ≤ 2h per §6).
- Key-recovery-from-paper drill: decrypt using only the physical private-key copy.
- `auth.users` export/import test (bcrypt hashes are portable; verify in practice) — requires
  widening `backup_ro`'s grants to the `auth` schema first, a deliberate decision deferred
  from Phase 0 (see `docs/HANDOVER.md`).
- Confirm `pg_restore` version compatibility across the Postgres major-version gap that
  motivated running `pg_dump` via Docker in Phase 0 (Ubuntu's default client vs. the dev
  project's version) — the same mismatch could recur on the restore side.
