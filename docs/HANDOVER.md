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

## Phase 2 final gate — 2026-09-08

- PR #4 (`Phase 2: core library parity`) merged to `main` on 2026-09-08.
- Core money/unit logic is centralized in `packages/core`: unit conversions, price-tier
  semantics, discounts, extra charges and deterministic invoice totals use integer paise.
- Legacy DSB reconciliation remains isolated from canonical DSB Pro totals.
- The original Phase 2 acceptance gate requiring at least 50 real historical DSB invoices
  could not be executed because that historical invoice dataset does not exist. The owner
  explicitly authorized the documented evidence substitution in
  `docs/PHASE2_GATE_DECISION.md`: golden/core tests plus 50 deterministic synthetic cases
  close Phase 2 for now, while the original 50-real-invoice zero-paise reconciliation remains
  deferred until after Phase 7.
- This is a timing/evidence waiver only. A later mismatch in the deferred real-invoice run is
  still a blocking financial-reconciliation defect; the criterion was not deleted or weakened.

## Phase 3 final gate — 2026-09-08

- PR #5 (`Phase 3: master data and purchases`) merged to `main` on 2026-09-08.
- Master data, supplier/purchase flows, unit-aware stock posting, price history and inventory
  UI were added through server-authoritative RPCs and the adapter boundary.
- `stock_movements` remains the stock ledger; `stock_current` is a projection rather than
  an independently mutable source of truth.
- Financial/detail rows are protected by immutability rules and tenant/RLS boundaries; client
  roles do not receive a direct DELETE path.
- PR #6 (`Phase 3 hotfix: correct unit-tier stock semantics`) merged the same day. It fixed
  unit-tier stock conversion so quantity is projected in the item's base/smallest configured
  unit consistently instead of mixing display-tier quantities with ledger quantities.
- The hotfix is part of the Phase 3 accepted state and must be treated as part of the Phase 3
  baseline by every later phase.

## Phase 4 / Phase 5 status — 2026-09-09

- Phase 4 PR #7 (`Phase 4: POS, customers and payments`) is still a draft and intentionally
  unmerged. Its exact accepted technical head is
  `da092983906bd6b6e97914821919a3ada837242f`; push CI #249 and PR CI #250 both passed.
- The real legacy opening import succeeded against the user's actual DSB backup: 276 items,
  38 suppliers, 1 non-walk-in customer and 265 positive stock balances. Old DSB was not used
  as the shop's operational invoicing system, so a same-day old-DSB invoice-parity gate is
  not a meaningful available evidence source.
- Phase 5 PR #9 is stacked on Phase 4 and remains a draft. Do not merge either PR or advance
  to Phase 6 merely because individual implementation pieces are present: Phase 5 closes only
  when the locked offline chaos/concurrency gates and the guarded live migration/preview gate
  are green on one exact head.

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


### Phase 5 implementation status — 2026-09-09

This section supersedes the narrow change-set 5.1 description above. That entry is retained as
history; the Phase 5 branch now contains the full offline-sync implementation and is waiting
only on its locked exact-head gates.

Implemented:

- **Durable local store:** `packages/sync` now uses Dexie/IndexedDB for mirrored items,
  barcodes, prices, customers, stock, metadata/cursors, local reservations, queued sales,
  outbox operations and conflicts. Interrupted `sending` rows are recovered to retry state
  after restart rather than silently discarded.
- **Pull/cursor contract:** server pull uses a composite `(updated_at,id)` cursor so rows
  sharing one server timestamp cannot be skipped. Master-data merge is whole-row/server-clock
  only; field-wise union is forbidden. Tombstones remain sticky during normal pull so a stale
  snapshot cannot resurrect a known deletion.
- **Offline sales:** POS writes the sale to the durable local outbox before it can be treated
  as queued. It snapshots item/unit/price data, reserves cached stock locally and assigns a
  provisional `T-<device>-<n>` number. Walk-in payment completeness and cached-stock checks
  run locally; the server still revalidates authority, stock and price before official
  posting.
- **Exactly-once financial semantics:** Phase 5 carries `client_id` through the outbox and
  server RPC. Exact unknown-outcome retries converge. Divergent retries under the same
  `client_id` are rejected by a persisted request fingerprint instead of overwriting the
  first financial event. The Phase 5 fingerprint creation is transaction-serialized so two
  simultaneous exact retries cannot race each other.
- **Price-drift protection:** an offline sale carries its expected unit-price snapshot to the
  server. A new first-time push is rejected for review if the authoritative current price no
  longer matches; an exact retry of an already-accepted request still converges even if the
  price changes later.
- **Unknown-outcome safety:** transport/server/response-shape failures keep the financial
  outbox row retryable. If the server commits a sale but the subsequent local IndexedDB
  acknowledgement fails, the row is retained for an idempotent retry rather than being
  misclassified as a business rejection.
- **Device enforcement:** sync pull/push requires a registered active device. Revoked devices
  are rejected on the next sync request, and the same revoked browser identity cannot silently
  re-register itself. The application surfaces revoked-device access as an explicit gate.
- **Cashier policy:** owner/manager offline billing is supported. Cashier offline finalization
  defaults to disabled and is owner-configurable. A restricted cashier may still finalize an
  online sale only after a healthy server sync check; network presence alone is not treated as
  proof of server availability.
- **Conflict handling:** rejected financial mutations remain in a local review tray and can
  also be recorded in a server-side shop-wide conflict table. Owners/managers can see and mark
  server conflicts reviewed without mutating the underlying financial event.
- **Sync transport:** realtime database notifications are used as wake-ups, with a 30-second
  polling fallback and manual retry/sync controls. The Sync & Offline screen exposes outbox,
  queued-sale and conflict counts, last clean sync and device/server clock drift.
- **Offline app shell:** a versioned service worker precaches the built SPA shell/assets and
  caches successfully visited SPA routes. Offline navigation first uses the exact cached route
  and then the cached root shell, allowing the app to restart without the network after at
  least one successful online load.
- **Receipts:** queued offline sales can print an explicitly provisional receipt. It is
  labeled pending sync and is not represented as an official invoice until the server returns
  an official document number.
- **Database migration:** `0029_phase5_sync.sql` adds device cursors/schema version/last-sync,
  sync conflicts, request fingerprints and the device-aware Phase 5 pull/ack/post-sale RPCs.
  Direct authenticated writes to sync-ledger tables are not granted; application mutation
  goes through the fixed-search-path RPCs. The live `backup_ro` role is conditionally granted
  SELECT on the new Phase 5 tables so the existing nightly public-schema dump remains complete.
- **Guarded live upgrade:** the Phase 5 push workflow refuses a partial/unexpected live schema,
  creates an encrypted Postgres-17 pre-migration dump, verifies checksums in both B2 and R2,
  applies migration 0029 atomically, verifies RLS/grants/RPC privileges and backup-role access,
  then deploys a Cloudflare Pages branch preview.

Locked Phase 5 evidence:

- pgTAP covers the Phase 5 schema/RLS/RPC/device/policy/idempotency/price-drift behaviors on a
  fresh local Supabase reset.
- The two-device concurrency script races stock from separate registered device identities,
  proves no oversell, exact retry convergence, divergent retry rejection and unique official
  document numbers.
- Playwright includes the required chaos path: start online, queue after network loss, print
  provisional receipt, restart the app offline, keep queued work through the logical one-hour
  outage, reconnect, drain the ordered outbox and prove final invoice count/totals/stock.

**Gate remains open until one exact Phase 5 head has all CI jobs green and the guarded live
migration + preview jobs also pass on that same push. Do not merge PR #9 or start Phase 6
before that evidence exists.**


## Phase 6 closure status — 2026-09-11

This section supersedes the historical Phase 5 gate wording above for the current Phase 6 branch.

- The pre-closure Phase 6 baseline `4daf48ab9690a9753862bd98709d5ffb44e02984` passed main CI, the unchanged 10,000-item performance gate, disposable Supabase public/Auth recovery, and the R2→Supabase preview switch-back drill.
- The closure pass adds the full device backup ZIP (JSON + all CSV tables + invoice PDFs), complete scheduled JSON export coverage, nightly tenant-invariant proof, and a non-zero financial restore round-trip.
- The exact closure head must pass all four workflows before automated closure is accepted.
- Formal Phase 6 remains **NOT GO** until the fresh hosted-Supabase restore, paper-only encryption-key recovery, measured RPO/RTO, and applicable real-shop verification are recorded using `docs/PHASE6_CLOSURE.md`.
- Do not merge or begin Phase 7 migration/cut-over until that final GO decision is recorded.

## Phase 6 main-branch CI continuity — 2026-09-12

- Verified the exact Phase 6 head before this change-set as
  `e77f09e6d7e7c10dd7fad9cda847f50958eb44cc`. Its CI, 10,000-item performance,
  disposable Supabase public/Auth recovery, and R2 switch-back workflows all passed.
- Verified the phase stack is linear: `main` is 260 commits behind Phase 6 and has no
  divergent commits. This fact does not close any human gate or authorize a merge.
- Corrected a disaster-recovery continuity gap: the live-schema/backup/portable-restore
  proofs in `ci.yml` can now run on a weekly default-branch schedule or manual dispatch,
  while retaining the existing Phase 6 branch-push gate.
- Added weekly default-branch schedules to the production-scale performance, disposable
  Supabase public/Auth recovery, and R2 switch-back workflows. The already scheduled
  enhanced PostgreSQL/Auth backup and human-readable JSON export will also become active
  only after their workflow files reach the default branch.
- The currently scheduled workflow on `main` is still the older public-schema-only backup.
  Its successful upload/checksum does not prove the uploaded encrypted artifact decrypts or
  restores, and it does not include the separate Auth artifact. Do not describe that nightly
  run as the complete Phase 6 backup until the enhanced workflow reaches `main` and a
  paper-key restore has passed.
- No application code, database schema, live database, production deployment, PR state, or
  branch ref changed in this change-set. Phase 6 remains **NOT GO**, and no merge or Phase 7
  work is authorized by this CI-only change.

## Pre-consolidation hardening — 2026-09-13

Work done on `phase-6-ledgers-reports-dr` to make the fast-forward of `main` safe. `main` is
untouched and still at `2c043f5`. No application money path, SQL migration or financial RPC was
changed by any commit in this section.

- **Phase 2 / Phase 3 / Phase 3-hotfix handover history restored** (`bcf2327`). PR #10 carried
  this content but branched from `main`, so its two commits sit outside this branch's ancestry;
  merging that PR would make the lines diverge and destroy the fast-forward. The content was
  cherry-picked here instead and **PR #10 is to be closed unmerged**. Sections are placed
  chronologically ahead of the Phase 5 and Phase 6 entries; nothing already present was removed.
- **Money-path e2e defect** (`0ae30fe`). `pos.spec.ts` ("posts stock then finalizes a paid sale")
  failed on two of three runs, including on a docs-only commit — which rules out any code change
  as the trigger. All nine mapped `<option>` lists in the admin screens rendered without a `key`,
  inside controlled `<select>` elements on screens that re-render frequently. Keys were added.
  **This is a plausible explanation, not a proven one**: keys stop a controlled select reverting
  mid-interaction, but the failure is equally consistent with the newly created item never
  reaching the list. Three consecutive green runs since do not settle it — the spec passed one run
  in three before.
- **Failures are now diagnosable** (`96f4fe0`). Playwright retains a trace and screenshot on
  failure and CI uploads them. `retries` stays explicitly `0`, with a comment: converting an
  intermittent money-path defect into a green run by re-running it is not acceptable here.
- **The weekly DR cron no longer migrates the live database** (`4363ab8`). The 2026-09-12 change
  correctly added weekly schedules so the Phase 6 proofs survive consolidation, but
  `phase6_backup_proof` and `phase6_portable_restore` both declared `needs: [phase6_db_upgrade]`,
  so the schedule also fired a live-schema migration applier against the production financial
  database every Sunday, unattended. `phase6_db_upgrade` no longer runs on `schedule`; it still
  runs on a branch push and on manual dispatch.
- **DR proofs now require a successful build** (`3608cfe`). A failed `build` leaves the upgrade
  job *skipped* rather than failed, and the first version of the condition accepted a skipped
  upgrade — so the proofs could run off the back of a red pipeline.
- **A live-DB-free stability gate** (`3608cfe`, made reachable by `7a67cf6`).
  `.github/workflows/e2e-stability.yml` repeats the money path (default 10x) against a throwaway
  local Supabase and fails on any single failure. It uses no live-database secrets: re-dispatching
  the main CI workflow to gather samples would also fire `phase6_db_upgrade` against production.
  GitHub honours `workflow_dispatch`/`schedule` only from the default branch, so a path-scoped
  push trigger keeps it usable before consolidation.
- **Governing documents corrected before consolidation, not after.** `CLAUDE.md` said "Current
  phase: 1" while three phases were merged and three more were green. The build plan is now v1.6:
  v1.5 plus a new §19 that schedules returns into a new Phase 6.5, waives FIFO cost layers for v1
  in writing, assigns `stock_reservations` to Phase 8, records four accepted layout deviations,
  and states that §8's header requirements are unachievable on the GitHub Pages mirror.

**Known constraint for anyone working from this machine:** `git push` cannot complete here — the
pack path is killed at 3.5 GB RAM. Every commit above was created through the GitHub Git Data API,
refusing to update the ref unless the resulting tree SHA matched the locally reviewed commit
exactly. Pushing workflow files needs a token with `workflow` scope.

**Next:** consolidate `main` by fast-forward once the stability gate is green, then Phase 6.5.
Keep the phase branches until `main` CI, both deployments, the first public+Auth nightly backup,
the first nightly JSON export and one scheduled DR proof have all passed.

## Consolidation — main fast-forwarded to Phase 6, 2026-09-13

`main` moved from `2c043f5` to `5d2f3cf1163bf089f8d886748ebde692e25aa5eb` by fast-forward, 269
commits, authorized explicitly after two rounds of independent review. The ref was advanced with
`force:false`, so a non-fast-forward would have been refused rather than silently rewriting `main`.

**This is consolidation, not phase acceptance.** Phases 4, 5 and 6 remain formally NOT GO. Their
gates need real-shop and recovery evidence, not more code:
- Phase 3 — one week of real purchases, stock matching a physical count.
- Phase 4 — one real shop day reconciling to old DSB. Additionally blocked by plan §19: a shop day
  that cannot take a customer return is not a valid gate, and returns arrive in Phase 6.5.
- Phase 5 — two physical devices, one offline for an hour mid-day, no duplicate document numbers.
- Phase 6 — fresh hosted Supabase restore, paper-only key recovery, measured RPO/RTO.

**Pull requests.** #7 auto-closed as merged because its commits became reachable from `main`; a
comment records that this is commit reachability, not gate acceptance. #9 was closed unmerged with
the same note (it targeted the Phase 4 branch, so it did not auto-close). #10 was closed unmerged
by design — its two commits were authored from `main`, sat outside the Phase 6 ancestry, and
merging it would have destroyed the fast-forward topology; its content reached `main` via `bcf2327`.

**All phase branches are deliberately retained** as rollback and reference points:
`phase-2-core-library`, `phase-3-master-data-purchases`, `phase-4-pos-customers-payments`,
`phase-5-offline-sync`, `phase-6-ledgers-reports-dr`, plus the two `fix/*` branches and
`docs/phase-audit-handover`. Do not delete any of them until the five post-merge checks below have
all passed.

**`main` is now protected**: force pushes and deletions blocked; `lint`, `typecheck`, `test`,
`pgtap`, `e2e` and `build` required; **`enforce_admins` is true**. Reviews are deliberately not
required — on a one-person project that would block all work.

`enforce_admins` was initially set to `false`, reasoning that a solo operator must not be locked
out during an incident. That was wrong, and it is worth recording why. The repository is operated
through an **admin token**, so with admin enforcement off the protection did not constrain the most
likely source of an accidental push to `main` — automation holding that token. The lock-out concern
is already answered without the bypass: an administrator can deliberately change the rule, which is
a visible, auditable act, instead of having silent bypass available on every push.

**Post-merge verification — superseded by the 2026-09-14 entry below. Original list:**
- [x] `main` CI green at `5d2f3cf`, attempt 1, including `deploy`.
- [x] Both hosting mirrors serving the new build. Note that Phase 0's "identical asset hash"
      criterion is **obsolete**: since Phase 1 the mirrors build with different Vite base paths, so
      their bundles legitimately differ. The criterion that applies now is base-path correctness —
      Cloudflare serves `/assets/index-D3OodvP3.js` (200), GitHub Pages serves
      `/dsb-pro/assets/index-B3YqrNG6.js` (200) — and the SPA deep-link fallback, verified by
      fetching `/dsb-pro/join/probe`: GitHub Pages returns HTTP 404 by design while serving the
      app shell from `404.html` with the same bundle, so the link boots. Cloudflare returns 200.
- [ ] First nightly backup containing **both** the public dump and the separate Auth artifact
      (`backup.yml`, 02:00 IST). This is the gap consolidation existed to close: until this run
      succeeds, no backup contains a single user account.
- [ ] First nightly JSON export (`phase6-json-export.yml`, 02:30 IST).
- [ ] First scheduled DR proof (`ci.yml` weekly cron `0 22 * * 0` = Sunday 22:00 UTC =
      **Monday 03:30 IST**) — confirm `phase6_db_upgrade` is **skipped** and both proofs still run,
      which is the fix in `4363ab8`.

**How these three must be verified.** Read the job logs and the produced artifacts. A workflow that
started, or even reported success, is not evidence on its own: the backup check means confirming
both the public dump *and* the separate encrypted Auth artifact exist with verified checksums in
both destinations and a `backup_runs` row; the export check means confirming the JSON object was
written; the DR check means confirming `phase6_db_upgrade` shows *skipped* while both proofs show
*success*. Record the run IDs.

For reference, all schedules in UTC and IST: nightly backup `30 20 * * *` = 02:00 IST; nightly JSON
export `0 21 * * *` = 02:30 IST; weekly DR proof `0 22 * * 0` = Monday 03:30 IST; money-path
stability `0 19 * * 4` = Friday 00:30 IST.

**Next:** the deferred §8/§12 gates (Cloudflare `_headers`, `pnpm audit`, Lighthouse, 250KB bundle
ceiling), then Phase 6.5 per plan §19. Do not begin Phase 6.5 until the three checks above are
recorded.

## Post-merge evidence and the first scheduled night — 2026-09-14

All three scheduled workflows fired overnight. **Two passed; the backup failed and was fixed.**
Recorded here with run IDs because the previous entry's "2 of 5" is now stale and because the
failure matters: it proves the scheduled path was not clean on its first real execution.

| Check | Run | Result |
|---|---|---|
| `main` CI at `5d2f3cf` / `f718343` | — | pass, attempt 1, including `deploy` |
| Both hosting mirrors | — | pass (see the base-path note above) |
| Scheduled DR proof | [34791246319](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/34791246319) | **pass** |
| Nightly JSON export | [34788509202](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/34788509202) | **pass** |
| Nightly backup (scheduled) | [34787124875](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/34787124875) | **FAIL** |
| Nightly backup (after fix, dispatched) | [34794582477](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/34794582477) | **pass** |

**The DR fix proved itself.** On the first scheduled run, `phase6_db_upgrade` was **skipped** while
`phase6_backup_proof` and `phase6_portable_restore` both **passed** — exactly the behaviour
`4363ab8` and `3608cfe` were written for. No unattended migration touched the live database.

**The backup failure, and why it is worth remembering.** Both dumps were produced, encrypted,
uploaded to B2 and R2, and every checksum verified — and then the job died on the final
bookkeeping `UPDATE`:

```
ERROR:  invalid input syntax for type json
LINE 1: ...destinations='[{name:b2,verified:true},...
DETAIL: Token "name" is invalid.
```

The destinations array was written as a JSON literal inside a double-quoted `psql -c "..."`
string, so bash consumed the inner double quotes. That is the worst shape a backup failure can
take: **the artifacts were genuinely fine in both destinations, but there was no provable record**,
and the health card reads red while the data is safe. It is also the same class of defect Phase 0
already recorded — values spliced into a `run:` script before bash parses them — so the lesson had
been written down and then not applied. Fixed in `31e2bff` by building the array server-side with
`json_build_array` and passing every value as a psql variable through a quoted heredoc.
It was invisible until consolidation because scheduled workflows only run from the default branch,
so that file had never once executed.

**Status, stated precisely rather than rounded.** Four of the five checks are fully proven. The
fifth — a complete public+Auth nightly backup **on the scheduled path** — is proven only by a manual
dispatch; the scheduled path has never yet completed cleanly end to end. The next scheduled run
(`30 20 * * *`, which history shows actually fires around 22:30–22:55 UTC, i.e. roughly 04:00 IST,
about two hours after the nominal cron) is the one that closes it. Check that run before treating
this as settled.

**Known noise, not yet fixed:** every R2 upload logs `NotImplemented (501)` on attempt 1 and
succeeds on attempt 2 — both artifacts, both runs. rclone 1.60 attempts an S3 operation R2 does not
implement. It self-heals and read-back checksums pass, so it is cosmetic, but it sits on top of the
secondary backup destination and should not be read past indefinitely.

**Phase 6.5 does not begin until the scheduled backup closes.** An earlier draft of this entry
said it "may begin once the gates are green", which contradicted the line above recording the
scheduled backup as unproven, and contradicted the standing pass-before-proceed rule. The rule
holds: a check that is recorded is not the same as a check that has passed. Returns start after a
scheduled `Nightly backup` run completes with both artifacts and a `backup_runs` row.

## Phase 6.5 returns build — 2026-09-15

**The prerequisite closed before work began.** Scheduled backup run
[34908283606](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/34908283606) ran on
`2566c21` and completed the public dump, separate Auth dump, encryption, B2 and R2 uploads,
read-back checksums, and the `backup_runs` update. Post-consolidation evidence is therefore 5/5.
The R2 first-attempt `501` retry and the human paper-key recovery drill remain open.

Draft PR [#17](https://github.com/dashsuperbazar-del/dsb-pro/pull/17) implements returns on
`phase-6-5-returns`. It is deliberately **not merged** and does not close Phases 4, 5 or 6.

**Database and money model.** Migration `0036_phase65_returns.sql` adds the four immutable return
tables and `payments.direction` (`in`/`out`, positive magnitudes only). Sale refunds are outgoing
cash only up to receipts actually allocated/directly posted against that invoice; any remaining
return value credits the customer balance. Refund `client_id` is derived from the return
`client_id`, and one refund per return is enforced in the database. Voiding reverses both refund
and stock effects. Purchase returns credit the supplier ledger and remove stock unless the chosen
disposition is `RETURN_TO_SELLABLE`. Source sales and purchases cannot be voided while a posted
return exists.

**Consumers updated.** Customer balances/outstanding, party ledger, day book, GST summary, shop-day
reconciliation, legacy DSB comparison, tenant export and `check_invariants()` all understand return
documents and signed payment direction. A day with refunds exceeding receipts is represented as a
negative cash total, not rejected. The admin app has a return screen for sale/purchase source
selection, quantities, all four dispositions, posting, recent history and voiding; sale receipts
show refunds explicitly.

**Verification at exact remote head `96a6d88d5d20d38ec05c985fd46b1ee99f76e1fc`.** CI run
[34912286251](https://github.com/dashsuperbazar-del/dsb-pro/actions/runs/34912286251) passed on its
first attempt at that head: lint, real project-reference typecheck, 178 unit tests, audit, clean
database reset, all 28 pgTAP files / 402 assertions (60 new returns assertions), existing browser
tests, and both production-representative build gates. Earlier draft runs correctly failed: one
ambiguous SQL column, then a stale export-version assertion and a misleading purchase-void error;
all three were fixed rather than rerun unchanged.

**Open before merge/acceptance.** PR #17 still needs code review. Its browser money path now posts
a paid sale return through the UI and proves the cash refund and net day totals; real counter
behavior (receipt presentation, physical stock dispositions and cash handoff) remains part of the
Phase 4 shop-day evidence. Offline returns are not enabled: the UI
requires the server, so exactly-once replay is proven at the RPC/database layer but not yet through
the Phase 5 outbox.

## Phase 6.5 provisional offline returns — 2026-09-15

This supersedes the previous entry's online-only limitation. The user confirmed the refund policy:
cash up to receipts actually received against the invoice; remainder against balance. Offline UX
is accept-now/refund-pending: accept goods, note provisional credit, tell the customer cash is due
only after reconnect and server confirmation. No offline cash amount or confirmed balance split
is computed or displayed.

Migration 0037 adds device/schema/tenant/shop/permission guarded source replication (latest 100
posted source documents per type, no payments/allocations) and a sync wrapper around the same
atomic post_return/refund/idempotency path. Dexie version 2 preserves all existing stores and adds
return sources and durable return records. A persisted-first post_return outbox intent contains
only source/quantity/disposition, not financial decisions. Pending returns use a separate stock
overlay shared with offline sales; rejection removes the overlay and retains a conflict, never
deletes financial history. Unknown-outcome/backing-off operations block stock pulls until resolved
so a committed movement cannot be counted twice beneath its pending overlay. Restart recovers
sending entries with the original client ID. Confirmed returns can be voided online only; pending
returns cannot be cancelled while their server outcome is unknown. The continuity export includes
both new local stores (version 2).

Also corrected the unmerged 0036 allocation guard: cash refunded against an invoice does not consume
the retained goods' future payment capacity; posted purchase returns reduce payable document value.
New pgTAP coverage exercises a payment made after the offline snapshot, replay on another device,
one deterministic refund, stale quantity rejection, guarded replication and settlement after refund.
The browser money path now covers offline queue/reload, reversible stock overlay, deliberately lost
server acknowledgement, exactly-once reconnect/net cash totals and stale-replica rejection.
An isolated real-browser Dexie transaction test additionally covers mixed sale/return projections,
payload mismatch, duplicate acknowledgement, interrupted-send recovery, purchase dispositions,
forbidden roles and rollback. The server acknowledgement includes POSTED/VOID status: a replay
after a different device voids the return cannot authorize cash or resurrect a voided document.
Reconnect immediately retries durable work; an already-offline cycle does not attempt sends.
Database payment-void guards prohibit independently voiding a live refund and prohibit receipt
voids that would leave active cash refunds exceeding receipts. These serialize on the source
invoice lock used by post_return. void_return first marks its parent VOID, then reverses payment,
within the same atomic transaction; failure rolls everything back.

Local lint, real admin typecheck and all 190 unit tests pass (including malformed-confirmation
and wrong-shop source tests). Both configured mirror builds pass installability and the bundle
ceiling at approximately 127 KiB gzip / 250 KiB (51%). SQL/browser evidence must be read from
the new exact-head CI run before calling this change verified. No merge or phase acceptance is
authorized by this build; PR #17 remains draft and main is untouched. Human shop and paper-key
recovery gates remain open.
