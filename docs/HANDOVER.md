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
  (for `e5ae004`, the last migration-touching commit) completed `success` in 2m49s —
  `pgtap` job (Docker-backed, fresh `supabase db reset` + `supabase test db`) passed in
  2m23s, along with `test`, `lint`, `typecheck`, `build` (`deploy` correctly skipped — not
  on `main`). This independently re-proves Step 1's result against a genuinely fresh
  Postgres instance, closing the gap Task 10 fixed (see "Real bugs found" below). The
  follow-up docs-only push (this commit) triggered run
  [34026415368](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/34026415368),
  also `success` (2m52s) after two automatic reruns of its `pgtap` job — both earlier
  attempts failed at the `supabase/setup-cli@v1` step with `rate limit exceeded` resolving
  the CLI's `latest` release, an unrelated GitHub API rate-limit flake on the Actions
  runner, not a test or migration failure (it never reached `supabase db reset`/`test db`).
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
- **Role/status changes have different latency depending on whether the access-token
  hook is enabled, and this wasn't spelled out above.** `current_membership()`'s
  table-fallback path filters `tenant_users.status = 'active'` on every call, so
  `set_user_role()` and disabling a user's `status` take effect on that user's very
  next request via the fallback path. But the JWT-claim path (once the hook from
  "Manual step needed" above is enabled in the Dashboard) cannot check `status` at
  all — it isn't a JWT claim — so a user whose role changed or whose status was
  disabled keeps acting under their OLD `app_role`/`tenant_id` claim, and keeps
  passing RLS checks as if still active, until their access token naturally expires
  and is reissued (Supabase's default access-token lifetime, typically up to one
  hour). The "performance optimization, not a correctness requirement" framing
  above is accurate for the Phase 1 gate (both paths were proven equivalent at
  read time), but it does not mean the two paths behave identically once role/
  status actually changes mid-session. The upcoming UI follow-up spec should not
  assume a revoked/demoted user is locked out immediately once the hook is live —
  either surface this latency to operators, or add a real revocation mechanism
  (e.g. a forced re-auth / token-refresh trigger) before relying on "disable this
  user" as an instant control.

**Next:** Phase 1's UI follow-up spec, then Phase 2 — Core library
(`DSB_PRO_BUILD_PLAN.md` v1.5 §13).

## Login/signup/invite/device UI (complete)

- `packages/adapters` created: `AuthAdapter` (`auth.ts`), tenancy RPCs (`tenancy.ts`), device
  RPCs (`devices.ts`) — the first real implementation of `DSB_PRO_BUILD_PLAN.md` §4's adapter
  layer. No provider name appears in `apps/admin` outside Phase 0's pre-existing HealthPanel.
- `packages/core` gained `hasPerm()` (mirrors `role_permissions`), `makeTenantSlug()`,
  `passwordStrength()`.
- One new migration: `0014_device_label.sql` (`devices.label` + `set_device_label()` RPC) —
  Phase 1 shipped devices with no name column; this UI needed one.
- `apps/admin` screens: Login, Signup, no-tenant landing (create shop / join code), join-invite
  deep link (`/join/:token`), email-verification reminder banner (soft gate, dismissible),
  Team (invite create/share/revoke, member role change), Devices (self-service rename/revoke +
  owner/manager all-devices view).
- Playwright bootstrapped for the first time (`apps/admin/playwright.config.ts`,
  `apps/admin/e2e/`, 6 spec files, 12 tests) with a new CI `e2e` job, run against a disposable
  `supabase start` instance — never against `dsb-pro-dev`.

### Gate status

- **Local full-suite run, this task (2026-09-07):** `pnpm lint` clean, `pnpm typecheck` clean,
  `pnpm test` 47/47 (`packages/core` 17, `packages/adapters` 30), `pnpm --filter
  @dsb-pro/admin run build` succeeds, `pnpm --filter @dsb-pro/admin run e2e` 9/12 (3 known
  failures, see below — not code bugs). Migration `0014_device_label.sql`'s pgTAP file
  re-run directly against `dsb-pro-dev` (transaction-wrapped, rolled back — a safe way to
  re-verify DDL that isn't itself idempotent): 6/6 `ok`, matching Task 1's original
  application exactly; a separate read-only `\d devices` / `\df set_device_label` check
  confirms the column and function are live on `dsb-pro-dev`.
- **CI: pending controller push/PR.** This task's dispatch was explicitly scoped to stop
  short of `git push`/`gh pr create` — that is the controller's job, done separately after
  confirmation. Until that push happens and the Actions run is inspected, CI's `e2e` job
  (fresh local Docker-based `supabase start` instance, matching the declared
  `supabase/config.toml`) has **not** been confirmed green for this plan — it is expected to
  be, since it doesn't share `dsb-pro-dev`'s config drift or rate-limit state (see below), but
  "expected" is not "verified." Whoever does the push should confirm `lint`, `typecheck`,
  `test`, `pgtap`, `e2e`, and `build` are all green on the resulting PR before treating this
  phase as closed, and update this entry with the run link once done.
- **Full raw command output for every check above is in this task's SDD report**
  (`.superpowers/sdd/2026-09-06-login-signup-invite-device-ui/task-13-report.md`).

### Architectural regression, deliberately accepted: `apps/admin/vite.config.ts`'s `base`

**`base` changed from Phase 0's `'./'` to `'/'`, and this breaks the GitHub Pages fallback
mirror that Phase 0's gate established as a requirement.** `/join/:token` (a spec-required
shareable deep link, `DSB_PRO_BUILD_PLAN.md` §5) needs absolute asset paths to load correctly
on a fresh, direct navigation — a relative base resolves `./assets/...` against the URL's last
path segment, so loading `/join/abc123` directly 404s on `/join/assets/...` instead of finding
`/assets/...`. Absolute `base: '/'` is also the *correct* long-term choice, since the real
deployment is at a domain root (`dsbpro.in`) — but Cloudflare Pages (primary,
`dsb-pro.pages.dev`, root-served) and GitHub Pages (secondary,
`dashsuperbazar-del.github.io/dsb-pro`, served from a `/dsb-pro/` **subpath**) need different
`base` values to both work, and this plan's build only produces one artifact. With `base: '/'`,
GH Pages' copy now requests assets from the Pages *domain* root instead of its repo subpath and
404s.

The user was explicitly asked and chose: **keep `base: '/'`, accept that GitHub Pages breaks
for now** (Cloudflare Pages, the primary mirror, is unaffected), and fix it properly later —
either a second build with a different `base` for the GH Pages target, or dropping GH Pages
entirely once a real domain is live. This is a real, known regression against Phase 0's
"two hosting mirrors serving an identical build" gate, not an oversight — flagging it here
prominently so a future phase doesn't rediscover it as a mystery 404. The full reasoning is
also inlined as a comment directly above `base: '/'` in `apps/admin/vite.config.ts`.

### Environment / test caveats: `dsb-pro-dev` config drift and rate-limiting

`dsb-pro-dev` (the hosted Supabase dev project used for local manual verification throughout
this plan, same as every phase before it) has **real config drift from `supabase/config.toml`'s
declared settings**: the dashboard's "Confirm email" (`mailer_autoconfirm: false`, i.e.
confirmation *required*) does not match the repo's declared `enable_confirmations = false`
(confirmation disabled) for local/CI. This means a real signup against `dsb-pro-dev` never
yields an immediate session — the account is created but stays in a pending-confirmation state
— unlike CI's fresh local instance, which matches the declared config and gets a session
immediately. Combined with this session's cumulative test-signup traffic against the same
project across Tasks 1-13, `dsb-pro-dev` also hit Supabase's real signup rate-limiting.

As a direct result, **3 e2e specs are permanently expected to fail when run locally against
`dsb-pro-dev`** — confirmed failing consistently, including in this task's own final run:
- `auth.spec.ts` › "signup then login with the same credentials"
- `invite-join.spec.ts` › "create your shop takes an owner straight into the app"
- `invite-join.spec.ts` › "visiting a join link while signed out routes through signup first, then joins"

These are **not code bugs** — they're a documented environment limitation of verifying against
a long-lived, drifted, rate-limited hosted project rather than a fresh instance. CI's `e2e` job
runs against a disposable `supabase start` instance built from the declared config every time,
so it does not share either problem and is the authoritative gate for these three specs (see
"pending controller push/PR" above — this still needs to actually go green on CI once pushed).

Anyone continuing this work locally needs their **own** `apps/admin/.env`
(`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`) pointed at `dsb-pro-dev` or a local Supabase
instance to run e2e at all — it's gitignored and was never committed. CI needs none of this; it
provisions its own fresh instance per run.

### A pattern worth naming: this plan's own text had an unusual number of real bugs

Across nearly every task in this plan, implementation surfaced **genuine defects in the plan's
own verbatim brief text** — not implementer mistakes, but things the brief specified that were
simply wrong and had to be caught and fixed during execution or review:
- Task 2/5: an arithmetic error undercounting expected test totals in the brief (harmless —
  just a wrong number to check output against).
- Task 3: a missing test-environment config, caught when the package's own test suite couldn't
  run as specified.
- Task 4: a mismatched mock call in a test the brief specified verbatim.
- Task 5: a broken mock chain in a brief-specified test.
- Task 8: two real bugs in the brief's own routing/build-config assumptions —
  `path="/*"` never matches anything in `preact-router` v4 (needs the library's actual
  catch-all mechanism, the `default` prop, instead); and an unused import that fails the build
  outright under this project's `noUnusedLocals`, not just lint.
- Task 9: a component-nesting mistake in the brief that silently dropped the invite token on
  the signup happy path — caught before it shipped.
- Task 11 (Team screen) was the most involved: **three separate rejection rounds** in formal
  review. Two were test-only workarounds sent back for real component fixes — a `PendingInvites`
  refresh bug, and a genuine bug where `JoinInviteScreen` would re-attempt `acceptInvite` on an
  already-used single-use token after its own post-accept page reload, showing a freshly-joined
  user a scary "invalid invite" error instead of just letting them in. The third round caught a
  real Rules-of-Hooks violation, fixed afterward.
- Task 13 (this task): the first full-workspace `pnpm lint`/`pnpm typecheck` run since Phase
  0's baseline (Tasks 1-12 each verified their own package/screen in isolation, never the whole
  workspace together) surfaced a `packages/adapters` devDependency gap (`vite` needed for
  `vite/client` types, only ever declared in `apps/admin`), a mistyped Vitest mock that
  undercounted a test's real call arity, and a handful of `eslint`-only issues (`any`,
  unused vars, `let` vs `const`) in e2e spec files that no earlier task's per-task checks
  happened to run. Fixed directly in a preceding commit on this branch — no production
  behavior changed by any of these fixes.

This reflects on **this plan's own authorship quality**, not on execution quality — future
readers should know this particular plan required unusually heavy scrutiny at nearly every
step, and treat its literal text as a starting point to verify against the real codebase, not
as ground truth to transcribe.

**Known simplifications, carried forward honestly rather than silently assumed away:**
- Device revocation (self or by an owner/manager) still has no real enforcement against an
  already-revoked device continuing to make requests — Phase 5's sync layer is still where
  that lands. The one exception: revoking your OWN other device also calls
  `supabase.auth.signOut({scope:'others'})`, which Supabase Auth does enforce immediately.
  Revoking someone ELSE's device only removes it from the list — the Devices screen says so.
- No deactivate/reactivate/remove exists for a `tenant_users` row — only role change
  (`set_user_role`). Dropped from this plan's Team screen scope rather than adding a new RPC
  for it; add one when it's actually needed.
- Role changes take effect on the affected user's next request via the table-fallback path,
  or up to ~1 hour (JWT lifetime) if the access-token hook is enabled and they're already
  signed in. The Team screen's copy says this; nothing was built to make it instant.
- Dark mode and Hindi strings (`DSB_PRO_BUILD_PLAN.md` §10) are not in this plan — every
  screen is literal English JSX text with no theming, matching Phase 0's own placeholder
  screen. Deferred to whichever later phase first needs i18n/theming broadly enough to be
  worth building once instead of screen-by-screen.
- Multi-shop picker, TOTP (two-factor), and a Dexie purge on device revocation are all
  explicitly out of scope per the spec itself, not gaps discovered during this plan — noted
  here so a later phase doesn't mistake their absence for an oversight.
- "Forgot password?" is not wired to any UI. `resetPasswordForEmail()` exists in
  `packages/adapters` and is unit-tested, but no screen calls it, even though spec §3 calls
  for it. A plan-authoring gap (no task in this plan's text ever asked for it), not something
  deferred deliberately.
- Team members are identified by raw user ID, not name/email — `tenant_users` has no email
  column, so a real fix needs a new backend view/RPC exposing member email/name, which is
  beyond this plan's declared scope (Task 1's migration was the only backend addition this
  plan made). The Team screen currently shows `{userId} — {status}`.
- `useSession()` is called independently by `App`, `TeamScreen`, `DevicesScreen`, and
  `JoinInviteScreen`, each running its own `getSession()`/`registerCurrentDevice()`/
  `getCurrentMembership()` round trip and `onAuthStateChange` subscription. `register_device()`
  is idempotent so this doesn't corrupt anything, just duplicates work — a shared session
  context/provider would remove the duplication, deferred as an efficiency improvement, not a
  correctness fix.
- Adapter functions cast RPC/table results with `as {...}` throughout, with no runtime shape
  validation — a known characteristic of this adapter layer (also the underlying reason
  Critical Fix 1 of the final-review fix wave went undetected as long as it did: an incorrect
  assumption about an error shape wasn't caught by any type check). Worth keeping in mind if
  `dsb-pro-dev`'s schema or Supabase's client behavior ever drifts from what the adapters
  assume.
- `App.tsx`'s inline `component={() => <Home session={session} />}` creates a new component
  identity on every render, so `preact-router` remounts (rather than updates) the `Home`
  subtree on every session-state change — including `VerificationBanner`, whose
  `dismissed`/`sent` state resets as a result. A dismissed banner can silently reappear.
  Low-impact today, worth hoisting `Home` out of the inline arrow in a later pass.

**Next:** Phase 2 — Core library (`DSB_PRO_BUILD_PLAN.md` v1.5 §13), once the controller's
push/PR confirms CI green end-to-end for this plan.

## Phase 1 final gate — 2026-09-08

This section supersedes the stale/pending caveats in the earlier UI-follow-up notes above.
Those notes are retained as execution history, but they are no longer the current state.

- PR #3 (`fix/phase1-e2e-join-signed-out-state`) completed the Phase 1 hardening/UI follow-up.
  The last code commit before this handover update was `fea5dc5ef6b29db833fe0827b8d5f5a61a289a82`.
- CI run [#91 / 34204679361](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/34204679361)
  completed `success` on that code head: lint, typecheck, unit tests, pgTAP, Playwright E2E,
  and build all passed. The PR deploy job remained correctly skipped because deployment only
  runs from `main`.
- The pgTAP job runs from a fresh local Supabase reset and also executes a two-connection
  concurrency proof for invite redemption. Both passed, proving the `accept_invite()` row lock
  enforces single-use under concurrent redemption rather than only sequential tests.
- The strict Phase 1 database gate remains satisfied: two-tenant isolation, cashier privilege
  boundaries, and hook-disabled table fallback are covered by the pgTAP suite. Privileged
  lifecycle operations are `SECURITY DEFINER` RPCs with fixed `search_path`, explicit
  EXECUTE grants/revokes, and no direct client DELETE path.
- Invite acceptance, auth/session races, signup → sign-out → login, signed-out invite join,
  invalid invite behavior, device/team flows, and owner member lifecycle are covered by the
  Playwright suite. The final Team lifecycle test exercises role change → disable → reactivate
  → remove through the actual SPA Team navigation.
- Password-reset UI is now wired to `resetPasswordForEmail()` and uses privacy-safe feedback.
- Team member administration is now backed by migration `0016_team_member_lifecycle.sql`:
  owner-only member listing exposes email/display name, and owner-only status/remove RPCs
  support disable/reactivate/soft-remove while preventing owner self-disable/removal.
- The earlier GitHub Pages regression is fixed. Vite's base is deployment-configurable;
  Cloudflare Pages builds at `/`, GitHub Pages builds at `/dsb-pro/`, app routes/invite links
  are base-aware, and the GitHub Pages artifact gets `404.html` copied from `index.html` so
  direct SPA deep links such as `/dsb-pro/join/:token` can boot. CI structurally validates the
  subpath asset references and 404 fallback on every PR build.
- Production deployment no longer reuses a generic CI artifact. On `main`, CI rebuilds with
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, fails fast when either value is missing,
  then builds a separate GitHub Pages fallback artifact with the correct base path.
- Repository code search found no `service_role` use in application code during the final
  audit. Frontend configuration continues to use only the public Supabase URL/anon key.
- Remaining known items are intentionally later-phase work, not Phase 1 blockers: device
  revocation enforcement needs Phase 5 per-request device identity; restore/fallback drills
  are Phase 6 gates; enabling the custom access-token hook is optional/performance-only and
  the hook-disabled fallback remains the Phase 1 correctness path.
- PR #3 is intentionally **not merged**. Merge/main deployment requires explicit authorization;
  Phase 1 implementation and pre-merge verification are complete on the PR branch.

**Next:** once PR #3 merge is explicitly authorized, merge/deploy it; Phase 2 is Core library
(`DSB_PRO_BUILD_PLAN.md` v1.5 §13).

## Phase 5 — Offline-first sync (in progress)

### Change-set 5.1 — sync invariants foundation

- Started from exact Phase 4 head `da092983906bd6b6e97914821919a3ada837242f` on branch `phase-5-offline-sync`; Phase 4 PR #7 remains unmerged.
- Added `packages/sync` as a pure TypeScript policy layer before any IndexedDB/Dexie or UI wiring.
- Locked the silent-corruption rules Phase 5 must preserve:
  - pull cursors are composite `(updated_at, id)`, so rows sharing one server timestamp cannot be skipped;
  - mutable master data uses whole-row server-clock LWW only — field-wise union is forbidden;
  - tombstones are sticky during normal pull, so a seen delete cannot be resurrected by a later live snapshot;
  - financial events are append-only and idempotent by `client_id`; an exact retry deduplicates, but divergent data under the same `client_id` throws instead of overwriting;
  - the outbox is strictly ordered and a retry in backoff cannot be overtaken;
  - provisional document numbers use the required `T-<device>-<n>` identity.
- No database schema or production runtime path changed in this change-set, so no SQL migration was required. Dexie persistence, server pull/push adapters, device-revocation enforcement, conflict tray, realtime→polling fallback and the chaos suite remain subsequent Phase 5 change-sets.
- The unresolved owner policy “cashiers may finalize offline vs draft-only offline” is intentionally not guessed here; this foundation supports either policy without changing data semantics.
