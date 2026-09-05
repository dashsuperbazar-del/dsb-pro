# Phase 0 — Foundations + Backup Pipeline — Design

Status: approved by user, ready for implementation planning.
Source of truth this design implements: `DSB_PRO_BUILD_PLAN.md` v1.5, §3, §4, §6, §13 (Phase 0).
Architecture is locked per §17 — this document is an implementation design against that plan, not a
revision of it.

## 1. Scope

Phase 0 deliverables per the build plan: repo + scaffold, CI, two hosting mirrors serving the same
build, a Supabase dev project with a working migrations pipeline, Sentry, a nightly backup workflow
landing an encrypted dump in two destinations, and a `backup_runs` health signal.

Phase 0 gate (unchanged from the plan): CI green; two hosting mirrors serve the same build; a backup
file lands encrypted in 2 destinations; `restore.md` draft exists.

## 2. Starting state (verified)

- Git repo initialized locally, no commits yet. Remote: `https://github.com/dashsuperbazar-del/dsb-pro.git`.
- Node v24.20.0, pnpm 11.25.0 available locally.
- Accounts confirmed ready: GitHub (repo + remote), Cloudflare, Supabase, Backblaze B2 (bucket `APD-BB`,
  created with Object Lock enabled — confirmed), Cloudflare R2, Sentry (project created, DSN in hand).

## 3. Repo scaffold & layout

```
dsb-pro/
  package.json              # root: private, packageManager: pnpm@11.25.0
  pnpm-workspace.yaml        # packages: apps/*, packages/*
  tsconfig.base.json         # shared strict TS config, apps/packages extend it
  .gitignore, .npmrc
  apps/
    admin/                   # real Vite + TS + Preact app — placeholder screen + backup health panel
      package.json, vite.config.ts (base: './'), src/main.tsx, index.html
  packages/
    core/                    # real package: toRupeeString(paise) + one vitest test
      package.json, src/paise.ts, src/paise.test.ts
    db/                      # generated-only: packages/db/types.ts (supabase gen types output)
      package.json
  supabase/
    migrations/0001_init.sql # schema_meta + backup_runs (see §5)
    tests/                   # pgTAP: RLS-denial + singleton-constraint assertions
  infra/
    backup.yml               # nightly workflow (see §6)
    restore.md                # draft, untested (see §8)
  .github/workflows/
    ci.yml                   # lint → tsc → vitest → pgTAP → build → deploy
  docs/
    HANDOVER.md               # started this phase, appended to at end of every session
```

`apps/storefront`, `apps/superadmin`, `packages/adapters`, `packages/sync`, `packages/ui`,
`packages/print` are **not** created as empty placeholder directories — git cannot track empty
directories, so each gets its first `package.json` when its own phase starts, per §4 of the plan.

## 4. CI pipeline (`.github/workflows/ci.yml`)

One workflow, triggered on push/PR to `main`, jobs run in order so deploy is blocked on any red:

1. **lint** — ESLint across `apps/*`, `packages/*`.
2. **tsc** — `tsc -b` project-references build, no emit.
3. **vitest** — `packages/core` tests, coverage reported (the 95% gate starts mattering once real
   logic lands in Phase 2).
4. **pgTAP** — `supabase start` (local Docker Postgres via Supabase CLI) → `supabase db reset`
   (applies `0001_init.sql`) → `pg_prove` against `supabase/tests/`. Fully ephemeral — never touches
   the real dev project.
5. **build** — `pnpm --filter admin build` → `apps/admin/dist`, built with `base: './'` so the same
   artifact works at any path depth.
6. **deploy** — only on push to `main`, only if 1–5 passed:
   - Cloudflare Pages: `wrangler pages deploy apps/admin/dist`.
   - GitHub Pages: `actions/upload-pages-artifact` + `actions/deploy-pages` on the same `dist`.

Both mirrors deploy the identical build artifact — no separate build per target.

## 5. Supabase migrations pipeline

`supabase/migrations/0001_init.sql` creates two control tables:

- **`schema_meta`** — singleton row (`current_version`, `min_supported_version`), read by clients at
  sync start (§9 of the plan).
- **`backup_runs`** — `id, started_at, finished_at, status[running|success|failed], dump_size_bytes,
  sha256, destinations jsonb, app_version, schema_version, manifest jsonb, error, created_at`. RLS
  enabled, no policies (default-deny) — only the service-role key, used solely by the backup workflow
  and never shipped to a browser, can read/write it.

**Approved exception to CLAUDE.md's "standard columns on every table" rule:** these two are
control/infra tables, not tenant data. They are never synced to Dexie, never tenant-scoped (backups
are per-Supabase-project, not per-tenant), and nothing client-originated is ever inserted into them —
so they carry `id` + real timestamps only, skipping `tenant_id`, `shop_id`, `client_id`, `deleted_at`,
and the trigger-maintained `updated_at` convention. The rule's intent (sync safety, tenant isolation,
idempotency) doesn't apply to server-only control tables.

**pgTAP for Phase 0** is real, not a placeholder: it asserts `backup_runs` denies `anon`/`authenticated`
SELECT, and `schema_meta` enforces its singleton-row constraint.

**Migrations mechanics:** CI applies migrations only to the ephemeral local Postgres. Pushing them to
the real dev project is a manual step (`supabase link --project-ref <ref>` then `supabase db push`,
run locally) — not automated in CI, to keep blast radius on the shared dev DB small while the pipeline
is new.

`packages/db/types.ts` is added beyond §4's tree to give `supabase gen types typescript --local`
(referenced in CLAUDE.md's commands) somewhere to write; regenerated via a root `pnpm gen:types`
script and checked in.

## 6. Sentry

`apps/admin` initializes `@sentry/browser` (no Preact-specific SDK needed) from
`import.meta.env.VITE_SENTRY_DSN`. Not secret, but not hardcoded either — it goes into GitHub Actions
**Variables** (not Secrets) and the Cloudflare Pages project's environment variables, with a
placeholder in a committed `.env.example`.

## 7. Backup pipeline (`.github/workflows/backup.yml`)

(Corrected during implementation: GitHub Actions only recognizes workflow files under `.github/workflows/` — `infra/backup.yml`, as originally written here and in the build plan's §4 repo-layout diagram, would never actually run. The build plan itself is locked per §17 and is left as-is; this is the one place in this session's own working docs worth correcting.)

Triggered on `schedule: '30 20 * * *'` (02:00 IST) plus `workflow_dispatch` for manual test runs:

1. Insert a `backup_runs` row (`status='running'`, `started_at=now()`) via the service-role key
   *first* — a runner crash mid-job still leaves a visible "stuck running" row instead of silence.
2. `pg_dump --format=custom` against the dev project, connecting as the SELECT-only `backup_ro` role.
3. `age -r <AGE_PUBLIC_KEY>` encrypts the dump; sha256 checksum computed.
4. Upload to **Backblaze B2** (`APD-BB`, primary, Object Lock enabled) via `rclone`, then
   **Cloudflare R2** (secondary) via `rclone`.
5. **Verify each destination** by re-downloading and comparing checksums — not just trusting "upload
   succeeded," since a truncated/corrupted upload that reports success is exactly the silent-corruption
   failure mode this project is designed against.
6. Update the `backup_runs` row: `status='success'`, `finished_at`, size, checksum, `destinations`,
   and a manifest (per-table row counts — trivial today against the empty dev DB, same code path
   Phase 6 needs for real data).
7. Any failure at any step → row updated to `status='failed'` with the error (best-effort, so a
   logging failure doesn't mask the real one) → job exits non-zero → red in Actions.

**Risks flagged and resolved:**

- **Backup role password never committed.** The `backup_ro` Postgres role is created/password-set
  out-of-band (Supabase SQL editor, or a one-off local `psql` command reading the password from the
  shell) — never inside a migration file. Only the resulting connection string becomes a GH Actions
  secret.
- **B2 Object Lock must be set at bucket creation** — confirmed already true for `APD-BB`.
- **Retention pruning (30 daily / 12 monthly / yearly) is out of scope for Phase 0.** Objects are
  date-stamped (`backup-YYYY-MM-DD.pgcustom.age`) so the convention exists; the pruning logic itself
  is a Phase 6 concern, once real data and real quota pressure exist.

`age` being asymmetric means CI only ever needs the **public** key (safe as a plain repo variable) to
encrypt. The private key never touches GitHub Actions — it stays exactly where §18 Q4 of the plan puts
it (physical custody, drilled in Phase 6).

## 8. Health visibility & `restore.md`

**`backup_runs` health panel scope for Phase 0:** the full §6 health card (DB · Sync · Backup ·
Storage · Invariants · Version/Schema · Outbox · Conflicts) can't exist yet — most of those have
nothing to report on before later phases. Phase 0 ships one small panel on `apps/admin`'s placeholder
screen: latest `backup_runs` row (via a read-only RPC/view, not raw table access, since RLS
default-denies), showing status/timestamp/destinations. The rest of the health card accretes as each
later phase gives it something real to show.

**`restore.md`** ships as a draft only, explicitly marked untested: fresh Supabase project → apply
migrations → `pg_restore` the latest dump (after `age -d` with the private key) → point a preview
build at it → spot-check. Headed **"NOT YET DRILLED — first drill is a Phase 6 gate"** so an
unexecuted checklist is never mistaken for a proven recovery path.

## 9. Operator setup checklist (accounts/secrets needed before `main` goes green end-to-end)

| What | Where it's obtained | GH Actions setting |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Custom Token, `Account \| Cloudflare Pages \| Edit` | Secret |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Overview (sidebar), or `wrangler whoami` | Secret |
| Cloudflare Pages project | Dashboard → Workers & Pages → Create → Pages → Direct Upload (not Git-connected) | — |
| GitHub Pages source | Repo Settings → Pages → Source: GitHub Actions | — |
| `backup_ro` DB connection string | Created out-of-band against the dev Supabase project (never in a migration file) | Secret |
| `AGE_PUBLIC_KEY` | Generated once locally (`age-keygen`); private key kept per §18 Q4 physical custody | Variable (not secret) |
| B2 app key (`APD-BB`) | Backblaze B2 dashboard | Secret |
| R2 access key | Cloudflare dashboard → R2 → Manage API Tokens | Secret |
| Supabase service-role key | Supabase dashboard → Project Settings → API | Secret |
| `VITE_SENTRY_DSN` | Already in hand from Sentry project setup | Variable (not secret) + Cloudflare Pages env var |

## 10. Phase 0 verification (how the gate is actually checked, not claimed)

- CI run on `main` shows all jobs green — link/log pasted, not "✓."
- Both mirror URLs (`*.pages.dev` and the GitHub Pages URL) return 200 and render the same placeholder
  screen with a matching build/version string.
- `backup_runs` has a `status='success'` row with both destinations verified, and the object is
  confirmed listed in both the B2 and R2 buckets directly (not only trusted from the workflow log).
- pgTAP output shows the RLS-denial and singleton-constraint assertions passing.

## 11. Explicitly deferred (not Phase 0)

- Full multi-metric health card (Sync/Storage/Invariants panels) — accretes with later phases.
- Automated migration push to the dev project from CI — stays a manual, deliberate step for now.
- Backup retention/pruning lifecycle — Phase 6, once real data exists.
- Restore drill execution — Phase 6 gate; Phase 0 only ships the documented, untested procedure.
