# DSB Pro — Handover Log

## Phase 0 — Foundations + backup pipeline (complete)

- Repo scaffolded: pnpm workspace, `apps/admin` (Vite+Preact+TS), `packages/core`
  (`toRupeeString`), `packages/db` (hand-written types, pending `gen:types` unblock — see
  Known Phase 0-only simplifications).
- CI (`.github/workflows/ci.yml`): lint → typecheck → test → pgTAP → build → deploy,
  gated so deploy only runs on `main` after everything else is green.
- Two hosting mirrors live and serving the identical build: Cloudflare Pages
  (`dsb-pro.pages.dev`) and GitHub Pages (`dashsuperbazar-del.github.io/dsb-pro`) — verified
  by matching `<title>` and identical hashed asset filename, not just both returning 200.
- Supabase dev project (`dsb-pro-dev`): `schema_meta` + `backup_runs` control tables
  (RLS default-deny, explicit SELECT grants so RLS is the actual barrier regardless of which
  role applies the migration), `get_latest_backup_status()` narrow RPC, pgTAP asserting both.
- Sentry wired into `apps/admin`; verified via a direct envelope POST to the real DSN (event
  accepted, 200) since no browser automation was available this session to click the in-app
  test button.
- Nightly backup workflow (`.github/workflows/backup.yml`): dumps the dev DB (schema
  `public`) via the official `postgres:17` Docker image, encrypts with `age` (recipient
  pinned against a hardcoded expected key), uploads to Backblaze B2 (`APD-BB`, Object Lock)
  + Cloudflare R2 (`apd-dsb`), verifies each upload by re-download checksum, records every
  run in `backup_runs` with a `manifest` (including `scope: "public"` as a visible tripwire
  for when that stops being sufficient).
- `infra/restore.md` drafted, explicitly marked undrilled — first real drill is a Phase 6
  gate. Includes notes on the Session-pooler/IPv4 requirement and `backup_ro`'s actual grants
  discovered this phase.

**Gate status — all four verified fresh, not assumed:**
- CI green on `main`: [run 33981770799](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/33981770799) — lint/typecheck/test/pgtap/build/deploy all succeeded.
- Both mirrors return 200 with matching `<title>DSB Pro Admin</title>` and identical asset hash `index-w0dZ6AR-.js`.
- `backup_runs` shows a `status='success'` row with both destinations `verified:true`; independently confirmed via `rclone lsl` that the matching object exists in both `b2:APD-BB` and `r2:apd-dsb`.
- pgTAP: all 6 assertions across both test files pass, both in CI's ephemeral Postgres and re-verified directly against `dsb-pro-dev`.

## Known Phase 0-only simplifications, to revisit later

- Health panel talks to PostgREST directly via `fetch` (no `packages/adapters` yet — that
  lands when Phase 1+ actually needs a swappable DB layer).
- `app_version` in `backup_runs` is the git SHA, not a formal `APP_VERSION` build pipeline
  (§2's versioning rule) — no real app version exists to track yet.
- Migrations are pushed to the dev project manually (direct `psql`, not `supabase db push`
  from CI) — this machine can't run Docker/WSL2 (3.5GB RAM), so local iteration against
  `dsb-pro-dev` substitutes for the local Supabase stack the plan originally specified. CI's
  own pgTAP job is unaffected and uses the ephemeral local Postgres exactly as designed.
- `packages/db/src/types.ts` is hand-written, not generated: `supabase gen types --db-url`
  still requires Docker even in remote mode (`LegacyContainerRuntimeNotFoundError`), and the
  `--project-id` alternative needs an account-wide Supabase personal access token the user
  preferred not to issue. `pnpm gen:types` (`scripts/gen-types.mjs`) is ready to regenerate
  this file for real the moment either becomes available.
- `pg_dump` scoped to schema `public` only — `backup_ro` has no grants on `auth`/`realtime`/
  `storage`, and Phase 0 has nothing real in them yet. Widening this (and `backup_ro`'s
  grants) is a deliberate Phase 1+ decision once there's real auth data to protect, not
  something to default into.
- `backup_ro` holds `BYPASSRLS` (granted directly, out-of-band, not via migration — like its
  creation) so `pg_dump` can produce a complete backup regardless of RLS policies meant to
  restrict application access, not backups.

## Real bugs found and fixed this phase (worth knowing before Phase 1 touches this infrastructure)

- **RLS/grants discovery:** this Supabase project's default table privileges for
  `anon`/`authenticated` depend on which role applies the migration — `supabase_admin`
  (Supabase's own tooling) gets permissive defaults (RLS is the real barrier); a direct
  `postgres` connection does not. Every table's migration should grant `SELECT` to
  `anon`/`authenticated` explicitly rather than relying on ambient defaults, regardless of
  who ends up applying it.
- **GitHub Actions runners have no outbound IPv6**, and Supabase's direct-connection hostname
  is IPv6-only. Any future workflow connecting directly to Postgres needs the Session pooler
  (`aws-0-<region>.pooler.supabase.com`, username `<role>.<project-ref>`), not the direct
  connection string shown by default in the dashboard.
- **`pg_dump`'s version must be ≥ the server's** — Ubuntu's default client lagged the dev
  project's Postgres 17.6. Running `pg_dump` inside the matching official Postgres Docker
  image sidesteps apt/package-version fragility entirely.
- **GitHub Actions expressions (`${{ }}`) are spliced into `run:` scripts before bash parses
  them** — a value containing quotes (or, apparently, even an *empty* `${{ }}` used as prose
  in a comment) breaks the script in ways that are easy to miss. Prefer a step's `env:` block
  and bash `$VAR` expansion for any value that isn't a known-safe fixed charset.
- Full details of every fix and the reasoning behind each are in this plan's SDD ledger
  (`.superpowers/sdd/2026-09-04-phase-0-foundations/progress.md`) if a deeper account is
  ever needed.

**Next:** Phase 1 — Tenancy, auth, RLS (`DSB_PRO_BUILD_PLAN.md` v1.5 §13).
