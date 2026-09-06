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

## Manual step needed: enable the Phase 1 access-token hook

`custom_access_token_hook()` (0011_access_token_hook.sql) is deployed but not yet
wired to Auth — this is a one-time, per-project Dashboard action:
1. Supabase Dashboard → Authentication → Hooks.
2. Under "Custom Access Token", enable it and select `public.custom_access_token_hook`.
3. Save.

Until this is done, every session runs the table-fallback path (proven equivalent
by pgTAP — see 0005_claims_resolver.sql's test, which asserts both paths give
identical results). Enabling the hook is a performance optimization (one fewer
table lookup per request), not a correctness requirement.

## Phase 1 — Tenancy, auth, RLS (complete)

- Tables: `permissions`/`role_permissions` (global catalog), `tenants`, `shops`,
  `tenant_users` (unique per user — one tenant per login in this app),
  `invites`, `devices`, `audit_log`, `doc_sequences`.
- `current_membership()`/`current_tenant_id()`/`current_role()`/`current_shop_ids()`/
  `has_perm()`: JWT custom-claim resolution (`tenant_id`/`app_role`/`shop_ids`) with a
  `tenant_users` table fallback when the claim is absent — proven equivalent by pgTAP,
  not assumed.
- RPCs: `create_tenant`, `create_invite`, `revoke_invite`, `accept_invite`,
  `set_user_role`, `register_device`, `revoke_device`, `next_doc_no`. All
  `security definer`; `tenant_users`/`invites` have no direct client
  insert/update grant at all — these RPCs are the only way in.
- Generic `audit_row_change()` trigger on every Phase 1 table; later phases attach
  the same trigger rather than writing per-feature audit code.
- `custom_access_token_hook()` deployed; enabling it in the Dashboard is a manual,
  one-time step (see Phase 1's migration comments) — not required for correctness,
  since the table-fallback path is proven equivalent.

**Gate status — verified fresh, not assumed:**
- pgTAP 100%: all 10 test files (`0003_permissions.sql` through `0012_explicit_revokes.sql`,
  12 migrations total counting `0001`/`0002` from Phase 0) run directly against `dsb-pro-dev`
  via `psql "service=dsbprodev"`, in order. Every file printed `plan(N)` then exactly N `ok`
  lines and `ROLLBACK` — zero `not ok` lines anywhere. Per-file counts: `0003`=7, `0004`=9,
  `0005`=8, `0006`=8, `0007`=17, `0008`=6, `0009`=5, `0010`=4, `0011`=3, `0012`=9 → 76/76
  assertions passed. Full raw psql output is captured in this task's SDD report
  (`.superpowers/sdd/2026-09-06-phase-1-tenancy-auth-rls/task-11-report.md`).
- CI green: pushed `worktree-phase-1-tenancy-auth-rls` (already tracked by open PR
  [#1](https://github.com/dashsuperbazar-del/dsb-pro/pull/1)); triggered run
  [34026201421](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/34026201421)
  completed `success` in 2m49s — `pgtap` job (Docker-backed, fresh `supabase db reset` +
  `supabase test db`) passed in 2m23s, along with `test`, `lint`, `typecheck`, `build`
  (`deploy` correctly skipped — not on `main`). This independently re-proves Step 1's result
  against a genuinely fresh Postgres instance, closing the gap Task 10 fixed (see "Real bugs
  found" below).
- Two tenants isolated / cashier cannot escalate / hook-disabled fallback proven:
  see `supabase/tests/0006_tenancy_rls.sql`, `0007_tenant_lifecycle_rpcs.sql`,
  `0005_claims_resolver.sql`.

## Real bugs found and fixed this phase (worth knowing before later phases touch this infrastructure)

- **`auto_expose_new_tables` (`supabase/config.toml`) defaults to `true` when commented out**, and a fresh `supabase db reset` — exactly what CI's `pgtap` job runs — auto-grants full CRUD to `anon`/`authenticated`/`service_role` on every new table. This silently undid several tables' "no grant statement means no access" design (`permissions`, `role_permissions`, `doc_sequences`, and the anon-denial half of `tenants`/`shops`/`tenant_users`/`invites`/`devices`/`audit_log`) — invisible against the long-lived `dsb-pro-dev` project (which isn't affected), only caught once CI ran against a genuinely fresh instance. Fixed by Task 10: explicit `revoke all ... from anon, authenticated` on every affected table (portable, works regardless of this config) plus flipping the config to explicit `false` so future fresh resets don't reintroduce it for new tables. **Any future phase's migration that creates a table meant to have less-than-full anon/authenticated access must include its own explicit grants/revokes — never rely on the absence of a grant statement alone**, even though `auto_expose_new_tables` is now `false`.

## Known Phase 1-only simplifications, to revisit later

- Device revocation (`devices.revoked_at`) is audit-only — nothing yet checks it
  against incoming requests. Enforcement arrives with Phase 5's sync layer, which
  is the first thing to carry a per-request device identity.
- `next_doc_no()`'s row-lock correctness is proven sequentially, not under true
  concurrent load — that test lands in Phase 4/5 once real document series exist.
- `login/signup/invite/device` UI is a separate follow-up spec — this phase only
  closes the backend half of the gate.

**Next:** Phase 1's UI follow-up spec, then Phase 2 — Core library
(`DSB_PRO_BUILD_PLAN.md` v1.5 §13).
