# Phase 1 — Tenancy, Auth, RLS — Design

Status: approved by user, ready for implementation planning.
Source of truth this design implements: `DSB_PRO_BUILD_PLAN.md` v1.5, §2, §7.1, §7.4, §8, §13 (Phase 1).
Architecture is locked per §17 — this document is an implementation design against that plan, not a
revision of it.

## 1. Scope

This spec covers the **backend** half of Phase 1 only: schema, RLS, RPCs, the access-token hook, the
audit trigger, and the pgTAP suite that proves the phase gate. `login/signup/invite/device` **UI** is
explicitly deferred to a separate follow-up spec — the build plan's Phase 1 description lists UI as a
deliverable, but the actual gate (below) tests only backend properties, so this spec fully closes the
gate on its own.

Phase 1 gate (unchanged from the plan): pgTAP 100%; two tenants provably isolated; cashier cannot
escalate; auth works with hook disabled (fallback proven).

## 2. Starting state (verified)

- Working from `main` (commit `4b0670d`), which carries all of Phase 0's completed work: repo
  scaffold, CI, two hosting mirrors, `schema_meta`/`backup_runs` (`0001_init.sql`,
  `0002_backup_status_rpc.sql`), Sentry, the nightly backup workflow, `infra/restore.md` draft.
- This session's original worktree directory was found empty and unregistered (broken); work
  proceeds from a fresh worktree (`worktree-phase-1-tenancy-auth-rls`) branched from `main`.
- No tenancy/auth tables exist yet — Phase 1 is greenfield for everything in this spec.

## 3. Architecture overview

One migration set (`0003`–`0005`, continuing Phase 0's numbering) introduces tenancy/auth/permission
tables, a claims-resolution layer, RPCs for tenant/invite/device lifecycle, a generic audit trigger,
and the pgTAP suite. Every tenant-data table follows §2's standard columns and Phase 0's established
grant convention (explicit `SELECT` grants to `anon`/`authenticated`, since default privileges depend
on which role applies the migration).

The access-token hook function ships as SQL in this phase; pointing Supabase Auth at it via the
Dashboard (Authentication → Hooks) is a manual, per-project step this design does not depend on for
its gate — the gate explicitly proves the table-fallback path works with the hook **off**.

## 4. Data model

**`0003_permissions.sql`** — global lookup tables, not tenant data (same "approved exception" as Phase
0's `schema_meta`: no `tenant_id`/`client_id`/sync columns, since these are reference rows shared by
every tenant, never synced, never client-inserted):
- `permissions (code text primary key, description text)`
- `role_permissions (role text, code text references permissions, primary key (role, code))`
- Seeded with the codes this phase needs: `MANAGE_TENANT_USERS`, `MANAGE_INVITES`, `MANAGE_DEVICES`,
  `VIEW_AUDIT_LOG` — granted to `owner` (all four) and `manager` (`MANAGE_DEVICES` only), per §8's role
  sketch. Later phases add rows for new codes, never new columns or policy code.

**`0004_tenancy.sql`** — the §7.1 tables, full standard columns (`id`, `created_by`, `created_at`,
`updated_at bigint`, `deleted_at bigint`, `client_id`) plus their own fields:
- `tenants (name, slug unique, plan, status, gstin, address, settings jsonb)` — root of tenancy; every
  other table's `tenant_id` FKs here.
- `shops (tenant_id, name, code, address, invoice_prefix, is_default)`.
- `tenant_users (tenant_id, user_id references auth.users, role, shop_ids uuid[], status)` —
  **`unique(user_id)`**: a person belongs to exactly one tenant. Nothing in the plan describes
  cross-tenant membership for a single login (Model A is one Supabase project per shop; Model B in
  Phase 9 is still one company per user), so this is enforced rather than left ambiguous.
- `invites (tenant_id, role, shop_ids, token unique, expires_at, accepted_at, revoked_at)` —
  shareable-code style: the owner shares the token manually (WhatsApp, in person); no dependency on
  Supabase's email sending or its rate limits.
- `devices (tenant_id, user_id, device_id, last_seen, app_version, revoked_at)` — keeps `revoked_at` as
  its dedicated lifecycle column rather than also adding `deleted_at` (the two would mean the same
  thing here). This table's one intentional deviation from "every table gets `deleted_at`", documented
  inline in the migration the same way Phase 0 documented its own exceptions.

**`0005_audit_and_sequences.sql`**:
- `audit_log (tenant_id, user_id, device_id, table_name, row_id, action, before jsonb, after jsonb,
  created_at)` — insert-only, populated exclusively by the trigger in §6; `device_id` is nullable in
  this phase since there's no per-request device context yet (that arrives with Phase 5's sync layer).
- `doc_sequences (tenant_id, shop_id, series text, next_no bigint)` + `next_doc_no()` RPC — generic and
  tested now even though no real document series exists until Phase 4.

All tenant-data tables: RLS enabled, default-deny (no blanket policies), explicit grants, then the
narrow policies in §5.

## 5. Access control layer

- **`current_membership()`** — `STABLE` function returning `(tenant_id, role, shop_ids)`. Tries
  `auth.jwt()`'s custom claims first; if the `tenant_id` claim is absent (hook disabled, or a token
  minted before the user had a tenant), falls back to one `tenant_users` lookup by `auth.uid()`.
  `current_tenant_id()`, `current_role()`, `current_shop_ids()` are thin wrappers that destructure its
  result, so every policy reads identity resolved the same single way — one table hit per statement on
  the fallback path instead of up to three, and no risk of `tenant_id`/`role`/`shop_ids` coming from
  three independent lookups that could theoretically disagree.
- **`has_perm(code text)`** — `STABLE`, checks `role_permissions` for `(current_role(), code)`. Every
  policy gating a privileged action calls this instead of comparing role strings directly, per §8.
- **RLS pattern per table:**
  - `tenants`, `shops`, `tenant_users`, `devices`, `audit_log`: `SELECT` scoped to
    `tenant_id = current_tenant_id()`.
  - `tenant_users`: **no direct client `INSERT`/`UPDATE` grants at all.** Membership is only created by
    `create_tenant()`/`accept_invite()`, and role/status changes only by `set_user_role()` — all
    `SECURITY DEFINER`, all checking `has_perm('MANAGE_TENANT_USERS')`, and `set_user_role()` explicitly
    rejects a caller targeting their own row. This is what makes "cashier cannot escalate" airtight:
    there is no code path other than these RPCs, and the RPCs check permission and block
    self-escalation.
  - `invites`: `INSERT`/revoke only via `create_invite()`/`revoke_invite()` (`has_perm('MANAGE_INVITES')`).
    `accept_invite(token)` is callable by any authenticated user; it validates the token (unexpired,
    unused, unrevoked) and fails cleanly if the caller already has a `tenant_users` row.
  - `devices`: self-service `INSERT` policy (`user_id = auth.uid() AND tenant_id = current_tenant_id()`)
    — registering your own device needs no RPC. Revoking needs `has_perm('MANAGE_DEVICES')` or revoking
    your own device. `revoked_at` is audit-only in this phase: nothing yet checks it against incoming
    requests, since there is no per-request device identity in the JWT/session until Phase 5's sync
    layer sends one — revocation becomes real enforcement then.
  - `audit_log`: `SELECT` gated by `has_perm('VIEW_AUDIT_LOG')`; no client `INSERT`/`UPDATE`/`DELETE`
    grants — only the trigger function writes it.
  - `doc_sequences`: no client grants at all; only `next_doc_no()` touches it.

**Access-token hook:** `public.custom_access_token_hook(event jsonb) returns jsonb` (Supabase's
required signature) looks up the caller's `tenant_users` row and injects `tenant_id`/`role`/`shop_ids`
into `event.claims`; a user with no tenant yet gets no claim added, so tenant-scoped queries correctly
return 0 rows until `create_tenant()`/`accept_invite()` runs (§8's "fresh user has no tenant" rule). The
migration grants `EXECUTE` to `supabase_auth_admin` (required for hooks); pointing Auth at this function
in the Dashboard is the one manual step, handed to the user as an explicit instruction rather than
something this design depends on for its own verification.

## 6. RPCs and audit trigger

All RPCs `SECURITY DEFINER`, `SET search_path = public`, recomputing/validating everything server-side
per §2.

- **`create_tenant(name, slug, shop_name, client_id)`** — for a signed-up user with no `tenant_users`
  row yet. Creates `tenants` + one default `shops` row + a `tenant_users` row for the caller with
  `role = 'owner'`. Idempotent by `client_id`. Fails if the caller already belongs to a tenant.
- **`accept_invite(token, client_id)`** — validates the invite, creates the caller's `tenant_users` row
  with the invite's `role`/`shop_ids`, marks the invite `accepted_at`. Fails if already a member of a
  tenant, or the token is invalid/expired/revoked.
- **`create_invite(role, shop_ids)`** / **`revoke_invite(id)`** — owner-only
  (`has_perm('MANAGE_INVITES')`), generate/kill a shareable token.
- **`set_user_role(user_id, role)`** — owner-only, blocks self-targeting.
- **`register_device(device_id, app_version)`** — upsert by `(tenant_id, user_id, device_id)`, bumps
  `last_seen`. **`revoke_device(id)`** — self or `has_perm('MANAGE_DEVICES')`.
- **`next_doc_no(shop_id, series)`** — atomic upsert-and-increment on `doc_sequences` under row lock
  (`SELECT ... FOR UPDATE`); generic and pgTAP-tested now even with no real series yet.

**Audit trigger:** one reusable `audit_row_change()` trigger function (`SECURITY DEFINER`), attached
`AFTER INSERT OR UPDATE OR DELETE` to `tenants`, `shops`, `tenant_users`, `invites`, `devices`. Captures
`tenant_id`, acting `user_id` (`auth.uid()`), `table_name`, `row_id`, `action`, `before`/`after` as
`jsonb`. New tables in later phases attach the same trigger — no per-feature audit code to remember.

## 7. Testing (pgTAP) — how this proves the Phase 1 gate

Test files land alongside the migrations (`0003`–`0005`, mirroring Phase 0's per-migration pairing).
Two techniques carry the whole suite:

- **Simulated identity:** each test sets `role authenticated` and `set_config('request.jwt.claims',
  ..., true)` to act as a specific user/tenant/role — no real Supabase Auth session needed, matching
  Phase 0's local-Postgres pgTAP approach.
- **Claim vs. fallback, same assertions twice:** every isolation/escalation test runs first with a
  simulated JWT claim present (hook-enabled path), then again with the claim cleared and only a
  `tenant_users` row backing the user (hook-disabled path). Identical pass results on both runs is the
  "auth works with hook disabled" gate criterion — proven, not assumed.

Concrete assertions:
- **Two tenants isolated:** seed tenant A + tenant B, each with an owner and a cashier; as A's cashier,
  `SELECT` on every Phase 1 table returns only A's rows, never B's — run under both claim and fallback
  paths.
- **Cashier cannot escalate:** as A's cashier, calls to `set_user_role()`, `create_invite()`,
  `revoke_device()` (on someone else's device) all fail with permission denied; a raw
  `UPDATE`/`INSERT` attempt against `tenant_users` fails since no such grant exists.
- **`create_tenant()`/`accept_invite()`:** correct row creation, `client_id` idempotency (a retried call
  produces no duplicate), one-tenant-per-user rejection (a second `create_tenant()`/`accept_invite()`
  call fails).
- **Audit trigger:** an insert/update/delete on `tenant_users`/`devices`/etc. produces exactly one
  matching `audit_log` row with correct `before`/`after`.
- **`next_doc_no()`:** sequential calls never repeat or skip, and the row lock is present. True
  concurrent-race proof is out of scope here — §12 places that guarantee under later concurrency/chaos
  testing once real document series exist (Phase 4/5), not Phase 1's pgTAP.

## 8. Phase 1 verification (how the gate is actually checked, not claimed)

- pgTAP output shows every assertion above passing, both the claim path and the fallback path, pasted
  in full — not "✓."
- A manual smoke check (direct RPC calls, e.g. via `psql` or the Supabase SQL editor) confirms
  `create_tenant()` → `accept_invite()` → cross-tenant isolation end-to-end against the real
  `dsb-pro-dev` project, the same "verified fresh, not assumed" standard Phase 0 held itself to.

## 9. Explicitly deferred (not Phase 1)

- `login/signup/invite/device` UI — separate follow-up spec once this backend is solid.
- Device-revocation enforcement — `devices.revoked_at` is tracked and audited, but nothing checks it
  against incoming requests until Phase 5's sync layer carries a per-request device identity.
- True concurrent-race testing for `next_doc_no()` — Phase 4/5, once real invoice/purchase numbering
  is live and there's something real to race against.
- Fine-grained per-feature permission codes beyond this phase's four (`VIEW_COST` and friends) — added
  as rows to `permissions`/`role_permissions` whenever the feature that needs them ships, never as
  schema changes.
