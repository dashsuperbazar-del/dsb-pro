# Phase 1 — Tenancy, Auth, RLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the backend half of Phase 1 — tenancy/permission schema, a claims resolver with JWT-claim + table fallback, RLS proving cross-tenant isolation, RPCs for the tenant/invite/device lifecycle, a generic audit trigger, and a pgTAP suite that proves the phase gate (pgTAP 100%; two tenants provably isolated; cashier cannot escalate; auth works with hook disabled).

**Architecture:** Nine numbered migrations (`0003`–`0011`) build up, in dependency order, from global permission data → raw tenancy tables → the claims resolver → RLS policies → lifecycle RPCs → audit trigger → doc sequences → the access-token hook. Every migration ships with its own pgTAP test file, applied and run directly against the `dsb-pro-dev` project (this machine has no Docker/WSL2, so `supabase start`/`db reset` aren't available locally — CI's ephemeral Postgres, via `supabase test db`, is the authoritative run; local iteration uses `PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev"` directly, exactly as Phase 0 ended up doing).

**Tech Stack:** Supabase Postgres 17, pgTAP, plpgsql, Supabase Auth Hooks (Custom Access Token).

**Spec:** `docs/superpowers/specs/2026-09-06-phase-1-tenancy-auth-rls-design.md`

## Global Constraints

- SQL migration before code; every schema change is a numbered file in `supabase/migrations/`, paired with a test file of the same number in `supabase/tests/`.
- Standard columns (`id`, `created_by`, `created_at`, `updated_at bigint`, `deleted_at bigint`, `client_id`) on every tenant-data table; deviations are documented inline in the migration, the same way Phase 0 documented `schema_meta`/`backup_runs`.
- `updated_at` is set by a DB trigger (server clock) — client never writes it.
- No client-side `DELETE` grants anywhere in this phase.
- Privileged ops go through `security definer` RPCs with `set search_path = public`, never raw client grants.
- RLS/RPCs check `has_perm('CODE')`, never a hard-coded role string.
- One tenant per user this phase: `tenant_users` carries `unique(user_id)`.
- Custom JWT claim keys are `tenant_id`, `app_role`, `shop_ids` — never `role` (PostgREST/Supabase reserve that name for the Postgres role itself).
- Every test file: `begin; create extension if not exists pgtap with schema extensions; select plan(N); ...; select * from finish(); rollback;` — matches Phase 0's existing test files exactly, and the `rollback` means no fixture ever needs manual cleanup.
- Local verification: `PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f <file>`. This machine has no Docker/WSL2, so a native `psql` client was installed (command-line tools only) and connects to `dsb-pro-dev` via a libpq service file (`service=dsbprodev`) that the user created directly — the real connection string is never typed into any command, dispatch prompt, or report. Every psql invocation in this plan uses this exact literal prefix (no shell variable ever carries the connection string). CI's `pnpm exec supabase test db` job (`.github/workflows/ci.yml`, job `pgtap`) is the authoritative, Docker-backed run and picks up every file in `supabase/tests/` automatically — no CI changes needed in this plan.

---

### Task 1: `permissions` / `role_permissions` catalog

**Files:**
- Create: `supabase/migrations/0003_permissions.sql`
- Create: `supabase/tests/0003_permissions.sql`

**Interfaces:**
- Produces: tables `permissions(code text pk, description text)`, `role_permissions(role text, code text, primary key(role, code))`, seeded with `MANAGE_TENANT_USERS`, `MANAGE_INVITES`, `MANAGE_DEVICES`, `VIEW_AUDIT_LOG` (all four for `owner`, `MANAGE_DEVICES` for `manager`). Consumed by Task 3's `has_perm()`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0003_permissions.sql`:
```sql
-- Phase 1 permission catalog. See docs/superpowers/specs/2026-09-06-phase-1-tenancy-auth-rls-design.md §4.
-- Global lookup tables, not tenant data: same approved exception as Phase 0's
-- schema_meta (0001_init.sql) — reference rows shared by every tenant, never
-- synced, never client-inserted, so they skip tenant_id/client_id/deleted_at/
-- updated_at entirely.

create table permissions (
  code text primary key,
  description text not null
);

create table role_permissions (
  role text not null,
  code text not null references permissions(code),
  primary key (role, code)
);

alter table permissions enable row level security;
alter table role_permissions enable row level security;
-- No grants, no policies: these are read only through has_perm()
-- (0005_claims_resolver.sql), which is security definer and needs no direct
-- grant on either table. Nothing else should read them.

insert into permissions (code, description) values
  ('MANAGE_TENANT_USERS', 'Add, remove, or change the role of a tenant member'),
  ('MANAGE_INVITES', 'Create or revoke tenant invites'),
  ('MANAGE_DEVICES', 'Revoke another user''s device'),
  ('VIEW_AUDIT_LOG', 'Read the tenant''s audit log');

insert into role_permissions (role, code) values
  ('owner', 'MANAGE_TENANT_USERS'),
  ('owner', 'MANAGE_INVITES'),
  ('owner', 'MANAGE_DEVICES'),
  ('owner', 'VIEW_AUDIT_LOG'),
  ('manager', 'MANAGE_DEVICES');
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0003_permissions.sql
```
Expected: `CREATE TABLE` x2, `INSERT 0 4`, `INSERT 0 5`, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0003_permissions.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select has_table('public', 'permissions', 'permissions table exists');
select has_table('public', 'role_permissions', 'role_permissions table exists');

select results_eq(
  $$ select count(*)::int from permissions $$,
  $$ values (4) $$,
  'four permission codes seeded'
);

select ok(
  exists(select 1 from role_permissions where role = 'owner' and code = 'MANAGE_TENANT_USERS'),
  'owner holds MANAGE_TENANT_USERS'
);
select ok(
  exists(select 1 from role_permissions where role = 'manager' and code = 'MANAGE_DEVICES'),
  'manager holds MANAGE_DEVICES'
);
select ok(
  not exists(select 1 from role_permissions where role = 'cashier'),
  'cashier holds no permissions this phase'
);

set role anon;
select is_empty($$ select * from permissions $$, 'anon cannot read permissions directly (no grant)');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 4: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0003_permissions.sql
```
Expected: `1..7`, all 7 lines `ok`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0003_permissions.sql supabase/tests/0003_permissions.sql
git commit -m "feat: permissions/role_permissions catalog, pgTAP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 2: Tenancy tables (`tenants`, `shops`, `tenant_users`, `invites`, `devices`)

**Files:**
- Create: `supabase/migrations/0004_tenancy.sql`
- Create: `supabase/tests/0004_tenancy.sql`

**Interfaces:**
- Consumes: nothing from Task 1 (independent tables), but `role_permissions` seed data is unused until Task 3.
- Produces: `set_updated_at()` trigger function (reused by every later table); tables `tenants`, `shops`, `tenant_users` (`unique(user_id)`), `invites`, `devices` — all RLS-enabled, `SELECT` granted to `authenticated` only, **no policies yet** (default-deny; Task 4 adds the policies). `tenant_users`/`invites` get no `INSERT`/`UPDATE` grant at all, ever, in this phase — only Task 5/6's RPCs write them.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0004_tenancy.sql`:
```sql
-- Phase 1 tenancy tables. See docs/superpowers/specs/2026-09-06-phase-1-tenancy-auth-rls-design.md §4.
-- Standard columns per CLAUDE.md/§2: id, created_by, created_at, updated_at
-- (bigint, trigger-set), deleted_at (bigint, unused until a future phase adds
-- soft-delete RPCs), client_id (idempotency).
-- RLS is enabled with grants but NO policies yet — that's the safe default-deny
-- state until 0006_tenancy_rls.sql adds real policies once the claims resolver
-- (0005) exists. This migration's own pgTAP proves that default-deny baseline.

create function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  return new;
end;
$$;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default 'free',
  status text not null default 'active' check (status in ('active', 'suspended')),
  gstin text,
  address text,
  settings jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at bigint not null default 0,
  deleted_at bigint,
  client_id text,
  unique (created_by, client_id)
);

create trigger tenants_set_updated_at before insert or update on tenants
  for each row execute function set_updated_at();

alter table tenants enable row level security;
grant select on tenants to authenticated;

create table shops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  code text,
  address text,
  invoice_prefix text,
  is_default boolean not null default false,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at bigint not null default 0,
  deleted_at bigint,
  client_id text,
  unique (tenant_id, client_id)
);

create trigger shops_set_updated_at before insert or update on shops
  for each row execute function set_updated_at();

alter table shops enable row level security;
grant select on shops to authenticated;

create table tenant_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner', 'manager', 'cashier', 'accountant')),
  shop_ids uuid[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at bigint not null default 0,
  deleted_at bigint,
  client_id text,
  unique (user_id),
  unique (tenant_id, client_id)
);

create trigger tenant_users_set_updated_at before insert or update on tenant_users
  for each row execute function set_updated_at();

alter table tenant_users enable row level security;
grant select on tenant_users to authenticated;
-- No insert/update/delete grants: membership is created/changed only by
-- create_tenant()/accept_invite()/set_user_role() (0007_tenant_lifecycle_rpcs.sql),
-- all security definer. This is what makes "cashier cannot escalate" airtight —
-- there is no other code path.

create table invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  role text not null check (role in ('owner', 'manager', 'cashier', 'accountant')),
  shop_ids uuid[] not null default '{}',
  token text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at bigint not null default 0,
  deleted_at bigint,
  client_id text,
  unique (tenant_id, client_id)
);

create trigger invites_set_updated_at before insert or update on invites
  for each row execute function set_updated_at();

alter table invites enable row level security;
grant select on invites to authenticated;
-- No insert/update grants: only create_invite()/revoke_invite()/accept_invite()
-- (0007_tenant_lifecycle_rpcs.sql) touch this table.

create table devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references auth.users(id),
  device_id text not null,
  last_seen timestamptz not null default now(),
  app_version text,
  revoked_at timestamptz,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at bigint not null default 0,
  client_id text,
  unique (tenant_id, user_id, device_id)
  -- Intentional deviation from "every table gets deleted_at": revoked_at already
  -- carries this table's one lifecycle transition; a second tombstone column
  -- would mean the same thing twice. See spec §4.
);

create trigger devices_set_updated_at before insert or update on devices
  for each row execute function set_updated_at();

alter table devices enable row level security;
grant select on devices to authenticated;
-- INSERT grant + self-service policy land in 0008_device_rpcs.sql, alongside
-- register_device()/revoke_device().
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0004_tenancy.sql
```
Expected: `CREATE FUNCTION`, then `CREATE TABLE`/`CREATE TRIGGER`/`ALTER TABLE`/`GRANT` for each of the 5 tables, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0004_tenancy.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Fixture as superuser (bypasses RLS/grants — no policies exist yet anyway).
insert into tenants (id, name, slug) values
  ('11111111-1111-1111-1111-111111111111', 'Test Co', 'test-co');

select ok(
  (select updated_at from tenants where id = '11111111-1111-1111-1111-111111111111') > 0,
  'tenants_set_updated_at trigger sets a nonzero updated_at on insert'
);

set role anon;
select is_empty($$ select * from tenants $$, 'anon cannot read tenants (no policy yet)');
select is_empty($$ select * from shops $$, 'anon cannot read shops (no policy yet)');
select is_empty($$ select * from tenant_users $$, 'anon cannot read tenant_users (no policy yet)');
select is_empty($$ select * from invites $$, 'anon cannot read invites (no policy yet)');
select is_empty($$ select * from devices $$, 'anon cannot read devices (no policy yet)');
reset role;

set role authenticated;
select is_empty($$ select * from tenants $$, 'authenticated cannot read tenants (no policy yet)');
select is_empty($$ select * from tenant_users $$, 'authenticated cannot read tenant_users (no policy yet)');
select is_empty($$ select * from devices $$, 'authenticated cannot read devices (no policy yet)');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 4: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0004_tenancy.sql
```
Expected: `1..9`, all 9 lines `ok`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_tenancy.sql supabase/tests/0004_tenancy.sql
git commit -m "feat: tenancy tables (tenants/shops/tenant_users/invites/devices), RLS default-deny, pgTAP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 3: Claims resolver (`current_membership`, `has_perm`)

**Files:**
- Create: `supabase/migrations/0005_claims_resolver.sql`
- Create: `supabase/tests/0005_claims_resolver.sql`

**Interfaces:**
- Consumes: `tenant_users` (Task 2), `role_permissions` (Task 1).
- Produces: `current_membership()` returning `table(tenant_id uuid, role text, shop_ids uuid[])`; `current_tenant_id()`, `current_role()`, `current_shop_ids()`, `has_perm(p_code text) returns boolean` — all `stable security definer`, `execute` granted to `authenticated`. Every later task's RLS policies and RPCs call these by name.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0005_claims_resolver.sql`:
```sql
-- Claims resolver: JWT custom claims first, tenant_users fallback second.
-- See docs/superpowers/specs/2026-09-06-phase-1-tenancy-auth-rls-design.md §5.
-- Custom claim keys used by the access-token hook (0011_access_token_hook.sql):
-- "tenant_id", "app_role", "shop_ids" — deliberately not "role", which
-- PostgREST/Supabase reserve for the Postgres role name (anon/authenticated/
-- service_role).
--
-- All five functions here are security definer so they can read tenant_users/
-- role_permissions regardless of the calling role's own grants on those tables
-- (neither table grants SELECT to anon/authenticated at all — see 0003, 0004).

create function current_membership()
returns table (tenant_id uuid, role text, shop_ids uuid[])
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claim_tenant_id uuid;
begin
  claim_tenant_id := nullif(auth.jwt() ->> 'tenant_id', '')::uuid;

  if claim_tenant_id is not null then
    return query
      select
        claim_tenant_id,
        auth.jwt() ->> 'app_role',
        coalesce(
          (select array_agg(elem::uuid) from jsonb_array_elements_text(auth.jwt() -> 'shop_ids') as elem),
          '{}'::uuid[]
        );
    return;
  end if;

  return query
    select tu.tenant_id, tu.role, tu.shop_ids
    from tenant_users tu
    where tu.user_id = auth.uid()
      and tu.status = 'active';
end;
$$;

create function current_tenant_id() returns uuid
language sql stable security definer set search_path = public
as $$ select tenant_id from current_membership() limit 1; $$;

create function current_role() returns text
language sql stable security definer set search_path = public
as $$ select role from current_membership() limit 1; $$;

create function current_shop_ids() returns uuid[]
language sql stable security definer set search_path = public
as $$ select shop_ids from current_membership() limit 1; $$;

create function has_perm(p_code text) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from role_permissions rp
    where rp.role = current_role() and rp.code = p_code
  );
$$;

revoke all on function current_membership() from public;
revoke all on function current_tenant_id() from public;
revoke all on function current_role() from public;
revoke all on function current_shop_ids() from public;
revoke all on function has_perm(text) from public;
grant execute on function current_membership() to authenticated;
grant execute on function current_tenant_id() to authenticated;
grant execute on function current_role() to authenticated;
grant execute on function current_shop_ids() to authenticated;
grant execute on function has_perm(text) to authenticated;
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0005_claims_resolver.sql
```
Expected: `CREATE FUNCTION` x5, `REVOKE`/`GRANT` lines, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0005_claims_resolver.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

-- Fixture as superuser (bypasses RLS — no policies target this yet).
insert into tenants (id, name, slug) values
  ('a0000000-0000-0000-0000-000000000001', 'Tenant A', 'tenant-a');
insert into tenant_users (id, tenant_id, user_id, role, shop_ids)
values (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000001',
  'cashier',
  array['d0000000-0000-0000-0000-000000000001']::uuid[]
);

-- Fallback path: authenticate via sub claim only, no tenant_id/app_role claim.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text,
  true);

select is(current_tenant_id(), 'a0000000-0000-0000-0000-000000000001'::uuid,
  'fallback: current_tenant_id() resolves via tenant_users when no claim present');
select is(current_role(), 'cashier',
  'fallback: current_role() resolves via tenant_users when no claim present');
select is(current_shop_ids(), array['d0000000-0000-0000-0000-000000000001']::uuid[],
  'fallback: current_shop_ids() resolves via tenant_users when no claim present');
select ok(has_perm('MANAGE_DEVICES') = false,
  'fallback: cashier has_perm(MANAGE_DEVICES) is false');
reset role;

-- Claim path: same user, but tenant_id/app_role/shop_ids now present as custom
-- claims — current_membership() must trust them without touching tenant_users.
-- Deliberately uses 'owner' here (the row underneath is 'cashier') to prove the
-- claim is what's trusted, not a silent re-derive from the table.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object(
    'sub', 'c0000000-0000-0000-0000-000000000001',
    'role', 'authenticated',
    'tenant_id', 'a0000000-0000-0000-0000-000000000001',
    'app_role', 'owner',
    'shop_ids', json_build_array('d0000000-0000-0000-0000-000000000001')
  )::text,
  true);

select is(current_tenant_id(), 'a0000000-0000-0000-0000-000000000001'::uuid,
  'claim path: current_tenant_id() resolves from JWT claim');
select is(current_role(), 'owner',
  'claim path: current_role() resolves from JWT claim, not the underlying cashier row');
select is(current_shop_ids(), array['d0000000-0000-0000-0000-000000000001']::uuid[],
  'claim path: current_shop_ids() resolves from JWT claim');
select ok(has_perm('MANAGE_DEVICES') = true,
  'claim path: owner has_perm(MANAGE_DEVICES) is true');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 4: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0005_claims_resolver.sql
```
Expected: `1..8`, all 8 lines `ok`. This is the test that directly proves the spec's "auth works with hook disabled" gate criterion — same assertions, both paths, identical results.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0005_claims_resolver.sql supabase/tests/0005_claims_resolver.sql
git commit -m "feat: current_membership()/has_perm() claim+fallback resolver, pgTAP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 4: Tenancy RLS policies — proves two-tenant isolation

**Files:**
- Create: `supabase/migrations/0006_tenancy_rls.sql`
- Create: `supabase/tests/0006_tenancy_rls.sql`

**Interfaces:**
- Consumes: `current_tenant_id()` (Task 3), tables from Task 2.
- Produces: `SELECT` policies on `tenants`, `shops`, `tenant_users`, `devices` scoped to `tenant_id = current_tenant_id()`. (`invites`' policy ships in Task 5, alongside its RPCs, since it needs `has_perm()` for a permission this table's RPCs also define; `audit_log` doesn't exist until Task 7.)

- [ ] **Step 1: Write the migration**

`supabase/migrations/0006_tenancy_rls.sql`:
```sql
-- Tenant-scoped SELECT policies, now that current_tenant_id() exists (0005).
-- See docs/superpowers/specs/2026-09-06-phase-1-tenancy-auth-rls-design.md §5.
-- Grants were already added in 0004_tenancy.sql; this migration adds the
-- policies that make them resolve to real rows instead of zero (0004's pgTAP
-- proved zero).

create policy tenants_select_own on tenants for select
  using (id = current_tenant_id());

create policy shops_select_own on shops for select
  using (tenant_id = current_tenant_id());

create policy tenant_users_select_own on tenant_users for select
  using (tenant_id = current_tenant_id());

create policy devices_select_own on devices for select
  using (tenant_id = current_tenant_id());
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0006_tenancy_rls.sql
```
Expected: `CREATE POLICY` x4, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0006_tenancy_rls.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

-- Two tenants, one cashier each.
insert into tenants (id, name, slug) values
  ('a0000000-0000-0000-0000-000000000001', 'Tenant A', 'tenant-a'),
  ('a0000000-0000-0000-0000-000000000002', 'Tenant B', 'tenant-b');
insert into shops (id, tenant_id, name) values
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'A Shop'),
  ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'B Shop');
insert into tenant_users (tenant_id, user_id, role, shop_ids) values
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'cashier', '{}'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'cashier', '{}');
insert into devices (tenant_id, user_id, device_id) values
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'device-a'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'device-b');

-- Fallback path: A's cashier, identified only by sub.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

select results_eq($$ select id from tenants order by id $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'fallback: A''s cashier sees only tenant A in tenants');
select results_eq($$ select id from shops order by id $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid) $$,
  'fallback: A''s cashier sees only A''s shop');
select results_eq($$ select tenant_id from tenant_users order by tenant_id $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'fallback: A''s cashier sees only A''s tenant_users row');
select results_eq($$ select device_id from devices order by device_id $$,
  $$ values ('device-a'::text) $$,
  'fallback: A''s cashier sees only A''s device');
reset role;

-- Claim path: same user, but now with a tenant_id/app_role claim present.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object(
    'sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'authenticated',
    'tenant_id', 'a0000000-0000-0000-0000-000000000001', 'app_role', 'cashier', 'shop_ids', '[]'
  )::text, true);

select results_eq($$ select id from tenants order by id $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'claim path: A''s cashier sees only tenant A in tenants');
select results_eq($$ select id from shops order by id $$,
  $$ values ('e0000000-0000-0000-0000-000000000001'::uuid) $$,
  'claim path: A''s cashier sees only A''s shop');
select results_eq($$ select tenant_id from tenant_users order by tenant_id $$,
  $$ values ('a0000000-0000-0000-0000-000000000001'::uuid) $$,
  'claim path: A''s cashier sees only A''s tenant_users row');
select results_eq($$ select device_id from devices order by device_id $$,
  $$ values ('device-a'::text) $$,
  'claim path: A''s cashier sees only A''s device');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 4: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0006_tenancy_rls.sql
```
Expected: `1..8`, all 8 lines `ok`. This is the test that directly proves the spec's "two tenants provably isolated" gate criterion.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0006_tenancy_rls.sql supabase/tests/0006_tenancy_rls.sql
git commit -m "feat: tenant-scoped SELECT RLS policies, two-tenant isolation pgTAP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 5: Tenant/invite lifecycle RPCs — proves cashier cannot escalate

**Files:**
- Create: `supabase/migrations/0007_tenant_lifecycle_rpcs.sql`
- Create: `supabase/tests/0007_tenant_lifecycle_rpcs.sql`

**Interfaces:**
- Consumes: `current_tenant_id()`/`has_perm()` (Task 3), tables from Task 2.
- Produces: `create_tenant(p_name text, p_slug text, p_shop_name text, p_client_id text) returns uuid`; `create_invite(p_role text, p_shop_ids uuid[]) returns table(id uuid, token text, expires_at timestamptz)`; `revoke_invite(p_id uuid) returns void`; `accept_invite(p_token text, p_client_id text) returns uuid`; `set_user_role(p_user_id uuid, p_role text) returns void`; `invites_select_own` RLS policy. All RPCs `execute` granted to `authenticated`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0007_tenant_lifecycle_rpcs.sql`:
```sql
-- Tenant/invite/membership lifecycle RPCs. See spec §6. All security definer,
-- all recompute/validate server-side per CLAUDE.md's "Privileged ops via
-- Postgres RPC" rule. tenant_users has no direct client insert/update grant at
-- all (0004) — these RPCs are the only way in.

create policy invites_select_own on invites for select
  using (tenant_id = current_tenant_id() and has_perm('MANAGE_INVITES'));

create function create_tenant(p_name text, p_slug text, p_shop_name text, p_client_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_tenant_id uuid;
  v_tenant_id uuid;
  v_shop_id uuid;
begin
  select t.id into v_existing_tenant_id
  from tenants t
  where t.created_by = auth.uid() and t.client_id = p_client_id;

  if v_existing_tenant_id is not null then
    return v_existing_tenant_id;
  end if;

  if exists (select 1 from tenant_users where user_id = auth.uid()) then
    raise exception 'user already belongs to a tenant';
  end if;

  insert into tenants (name, slug, client_id)
  values (p_name, p_slug, p_client_id)
  returning id into v_tenant_id;

  insert into shops (tenant_id, name, is_default)
  values (v_tenant_id, p_shop_name, true)
  returning id into v_shop_id;

  insert into tenant_users (tenant_id, user_id, role, shop_ids, status)
  values (v_tenant_id, auth.uid(), 'owner', array[v_shop_id], 'active');

  return v_tenant_id;
exception
  when unique_violation then
    select t.id into v_tenant_id
    from tenants t
    where t.created_by = auth.uid() and t.client_id = p_client_id;
    return v_tenant_id;
end;
$$;

revoke all on function create_tenant(text, text, text, text) from public;
grant execute on function create_tenant(text, text, text, text) to authenticated;

create function create_invite(p_role text, p_shop_ids uuid[])
returns table (id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
  v_id uuid;
  v_token text;
  v_expires_at timestamptz := now() + interval '7 days';
begin
  if v_tenant_id is null or not has_perm('MANAGE_INVITES') then
    raise exception 'not permitted';
  end if;

  v_token := encode(gen_random_bytes(16), 'hex');

  insert into invites (tenant_id, role, shop_ids, token, expires_at)
  values (v_tenant_id, p_role, p_shop_ids, v_token, v_expires_at)
  returning invites.id into v_id;

  return query select v_id, v_token, v_expires_at;
end;
$$;

revoke all on function create_invite(text, uuid[]) from public;
grant execute on function create_invite(text, uuid[]) to authenticated;

create function revoke_invite(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_tenant_id() is null or not has_perm('MANAGE_INVITES') then
    raise exception 'not permitted';
  end if;

  update invites set revoked_at = now()
  where id = p_id and tenant_id = current_tenant_id() and revoked_at is null and accepted_at is null;

  if not found then
    raise exception 'invite not found or already used/revoked';
  end if;
end;
$$;

revoke all on function revoke_invite(uuid) from public;
grant execute on function revoke_invite(uuid) to authenticated;

create function accept_invite(p_token text, p_client_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
begin
  if exists (select 1 from tenant_users where user_id = auth.uid()) then
    raise exception 'user already belongs to a tenant';
  end if;

  select * into v_invite from invites
  where token = p_token
    and revoked_at is null
    and accepted_at is null
    and expires_at > now();

  if not found then
    raise exception 'invite invalid, expired, or already used';
  end if;

  insert into tenant_users (tenant_id, user_id, role, shop_ids, status, client_id)
  values (v_invite.tenant_id, auth.uid(), v_invite.role, v_invite.shop_ids, 'active', p_client_id);

  update invites set accepted_at = now() where id = v_invite.id;

  return v_invite.tenant_id;
end;
$$;

revoke all on function accept_invite(text, text) from public;
grant execute on function accept_invite(text, text) to authenticated;

create function set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id = auth.uid() then
    raise exception 'cannot change your own role';
  end if;

  if current_tenant_id() is null or not has_perm('MANAGE_TENANT_USERS') then
    raise exception 'not permitted';
  end if;

  update tenant_users set role = p_role
  where user_id = p_user_id and tenant_id = current_tenant_id();

  if not found then
    raise exception 'user not found in this tenant';
  end if;
end;
$$;

revoke all on function set_user_role(uuid, text) from public;
grant execute on function set_user_role(uuid, text) to authenticated;
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0007_tenant_lifecycle_rpcs.sql
```
Expected: `CREATE POLICY`, `CREATE FUNCTION` x5, `REVOKE`/`GRANT` lines, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0007_tenant_lifecycle_rpcs.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- create_tenant(): fresh user with no tenant_users row.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);

select lives_ok(
  $$ select create_tenant('New Co', 'new-co', 'Main Shop', 'client-1') $$,
  'create_tenant() succeeds for a user with no tenant'
);
select ok(
  (select role from tenant_users where user_id = 'f0000000-0000-0000-0000-000000000001') = 'owner',
  'create_tenant() makes the caller owner'
);
select results_eq(
  $$ select create_tenant('New Co', 'new-co', 'Main Shop', 'client-1') $$,
  $$ select id from tenants where created_by = 'f0000000-0000-0000-0000-000000000001'::uuid $$,
  'create_tenant() retried with the same client_id returns the same tenant, no duplicate'
);
select throws_ok(
  $$ select create_tenant('Another Co', 'another-co', 'Shop', 'client-2') $$,
  null, 'user already belongs to a tenant',
  'create_tenant() rejects a user who already belongs to a tenant'
);
reset role;

-- Owner creates an invite for a cashier.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select token from create_invite('cashier', '{}') $$,
  'owner can create an invite'
);
reset role;

-- A second, unrelated user accepts it.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select accept_invite((select token from invites limit 1), 'client-3') $$,
  'accept_invite() succeeds with a valid token'
);
select ok(
  (select role from tenant_users where user_id = 'f0000000-0000-0000-0000-000000000002') = 'cashier',
  'accept_invite() grants the invite''s role'
);
select throws_ok(
  $$ select accept_invite((select token from invites limit 1), 'client-4') $$,
  null, 'invite invalid, expired, or already used',
  'accept_invite() rejects a token already used'
);
reset role;

-- Cashier cannot escalate: no direct grant, and set_user_role() blocked both ways.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ update tenant_users set role = 'owner' where user_id = 'f0000000-0000-0000-0000-000000000002' $$,
  '42501', null,
  'cashier cannot UPDATE tenant_users directly (no grant)'
);
select throws_ok(
  $$ select set_user_role('f0000000-0000-0000-0000-000000000002', 'owner') $$,
  null, 'cannot change your own role',
  'cashier cannot self-promote via set_user_role() (self-target blocked first)'
);
select throws_ok(
  $$ select set_user_role('f0000000-0000-0000-0000-000000000001', 'cashier') $$,
  null, 'not permitted',
  'cashier cannot demote the owner via set_user_role() (has_perm denies)'
);
select throws_ok(
  $$ select create_invite('owner', '{}') $$,
  null, 'not permitted',
  'cashier cannot create_invite() (has_perm denies)'
);
reset role;

-- Owner can change the cashier's role.
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select set_user_role('f0000000-0000-0000-0000-000000000002', 'manager') $$,
  'owner can change another member''s role'
);

-- revoke_invite(): owner creates a fresh invite, a cashier cannot revoke it,
-- the owner can, and the revoked token can no longer be accepted.
select lives_ok(
  $$ select token from create_invite('accountant', '{}') $$,
  'owner can create a second invite (to be revoked)'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select revoke_invite((select id from invites where role = 'accountant')) $$,
  null, 'not permitted',
  'cashier cannot revoke_invite() (has_perm denies)'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select revoke_invite((select id from invites where role = 'accountant')) $$,
  'owner can revoke_invite()'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select accept_invite((select token from invites where role = 'accountant'), 'client-5') $$,
  null, 'invite invalid, expired, or already used',
  'accept_invite() rejects a revoked token'
);
reset role;

select * from finish();
rollback;
```

- [ ] **Step 4: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0007_tenant_lifecycle_rpcs.sql
```
Expected: `1..17`, all 17 lines `ok`. This is the test that directly proves the spec's "cashier cannot escalate" gate criterion.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_tenant_lifecycle_rpcs.sql supabase/tests/0007_tenant_lifecycle_rpcs.sql
git commit -m "feat: create_tenant/accept_invite/create_invite/revoke_invite/set_user_role RPCs, pgTAP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 6: Device RPCs

**Files:**
- Create: `supabase/migrations/0008_device_rpcs.sql`
- Create: `supabase/tests/0008_device_rpcs.sql`

**Interfaces:**
- Consumes: `current_tenant_id()`/`has_perm()` (Task 3), `devices` table (Task 2).
- Produces: `register_device(p_device_id text, p_app_version text) returns uuid`; `revoke_device(p_id uuid) returns void`; `devices_insert_own` RLS policy + `INSERT` grant on `devices`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0008_device_rpcs.sql`:
```sql
-- Device registration/revocation. See spec §5-§6. revoked_at is audit-only this
-- phase — nothing yet checks it against incoming requests (no per-request
-- device identity until Phase 5's sync layer).

grant insert on devices to authenticated;

create policy devices_insert_own on devices for insert
  with check (user_id = auth.uid() and tenant_id = current_tenant_id());

create function register_device(p_device_id text, p_app_version text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
  v_id uuid;
begin
  if v_tenant_id is null then
    raise exception 'user has no tenant';
  end if;

  insert into devices (tenant_id, user_id, device_id, app_version, last_seen)
  values (v_tenant_id, auth.uid(), p_device_id, p_app_version, now())
  on conflict (tenant_id, user_id, device_id)
  do update set last_seen = now(), app_version = excluded.app_version
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function register_device(text, text) from public;
grant execute on function register_device(text, text) to authenticated;

create function revoke_device(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device devices%rowtype;
begin
  select * into v_device from devices
  where id = p_id and tenant_id = current_tenant_id();

  if not found then
    raise exception 'device not found';
  end if;

  if v_device.user_id <> auth.uid() and not has_perm('MANAGE_DEVICES') then
    raise exception 'not permitted';
  end if;

  update devices set revoked_at = now() where id = p_id;
end;
$$;

revoke all on function revoke_device(uuid) from public;
grant execute on function revoke_device(uuid) to authenticated;
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0008_device_rpcs.sql
```
Expected: `GRANT`, `CREATE POLICY`, `CREATE FUNCTION` x2, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0008_device_rpcs.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into tenants (id, name, slug) values ('a0000000-0000-0000-0000-000000000009', 'Tenant Z', 'tenant-z');
insert into tenant_users (tenant_id, user_id, role, shop_ids) values
  ('a0000000-0000-0000-0000-000000000009', 'f0000000-0000-0000-0000-000000000010', 'cashier', '{}'),
  ('a0000000-0000-0000-0000-000000000009', 'f0000000-0000-0000-0000-000000000011', 'manager', '{}');

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000010', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select register_device('phone-1', '0.1.0') $$,
  'cashier can register their own device'
);
select throws_ok(
  $$ select revoke_device((select id from devices where user_id = 'f0000000-0000-0000-0000-000000000011')) $$,
  null, 'not permitted',
  'cashier cannot revoke another user''s device (has_perm denies, not the device owner) — but note the row IS visible internally since revoke_device() is security definer'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000011', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select register_device('tablet-1', '0.1.0') $$,
  'manager can register their own device'
);
select lives_ok(
  $$ select revoke_device((select id from devices where user_id = 'f0000000-0000-0000-0000-000000000010')) $$,
  'manager can revoke the cashier''s device (has_perm MANAGE_DEVICES)'
);
select ok(
  (select revoked_at is not null from devices where user_id = 'f0000000-0000-0000-0000-000000000010'),
  'revoked_at is set after manager revokes'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000010', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select revoke_device((select id from devices where user_id = 'f0000000-0000-0000-0000-000000000010')) $$,
  'cashier can revoke their own already-revoked device (self is always allowed)'
);
reset role;

select * from finish();
rollback;
```

- [ ] **Step 4: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0008_device_rpcs.sql
```
Expected: `1..6`, all 6 lines `ok`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0008_device_rpcs.sql supabase/tests/0008_device_rpcs.sql
git commit -m "feat: register_device/revoke_device RPCs, self-service insert policy, pgTAP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 7: Audit log + generic trigger

**Files:**
- Create: `supabase/migrations/0009_audit_log.sql`
- Create: `supabase/tests/0009_audit_log.sql`

**Interfaces:**
- Consumes: `current_tenant_id()`/`has_perm()` (Task 3), tables from Task 2.
- Produces: table `audit_log`; `audit_row_change()` trigger function attached to `tenants`, `shops`, `tenant_users`, `invites`, `devices`. Later phases attach the same trigger to their own tables — no per-feature audit code.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0009_audit_log.sql`:
```sql
-- Append-only audit trail. See spec §4/§6.
-- Approved exception to "every table gets full standard columns": this is a
-- control/log table like Phase 0's schema_meta/backup_runs — insert-only, never
-- updated or deleted by anyone, so it skips client_id/deleted_at/updated_at.
-- tenant_id is added beyond §7.4's literal column list because RLS needs it for
-- per-tenant isolation.

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  user_id uuid,
  device_id uuid,
  table_name text not null,
  row_id uuid not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

alter table audit_log enable row level security;
grant select on audit_log to authenticated;

create policy audit_log_select_own on audit_log for select
  using (tenant_id = current_tenant_id() and has_perm('VIEW_AUDIT_LOG'));
-- No insert/update/delete grants: only audit_row_change() (below, security
-- definer) writes this table.

create function audit_row_change() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row_id uuid := coalesce((to_jsonb(new)->>'id')::uuid, (to_jsonb(old)->>'id')::uuid);
  v_tenant_id uuid;
begin
  if TG_TABLE_NAME = 'tenants' then
    v_tenant_id := v_row_id;
  else
    v_tenant_id := coalesce(
      (to_jsonb(new)->>'tenant_id')::uuid,
      (to_jsonb(old)->>'tenant_id')::uuid
    );
  end if;

  insert into audit_log (tenant_id, user_id, table_name, row_id, action, before, after)
  values (
    v_tenant_id,
    auth.uid(),
    TG_TABLE_NAME,
    v_row_id,
    TG_OP,
    case when TG_OP = 'INSERT' then null else to_jsonb(old) end,
    case when TG_OP = 'DELETE' then null else to_jsonb(new) end
  );

  return coalesce(new, old);
end;
$$;

create trigger audit_tenants after insert or update or delete on tenants
  for each row execute function audit_row_change();
create trigger audit_shops after insert or update or delete on shops
  for each row execute function audit_row_change();
create trigger audit_tenant_users after insert or update or delete on tenant_users
  for each row execute function audit_row_change();
create trigger audit_invites after insert or update or delete on invites
  for each row execute function audit_row_change();
create trigger audit_devices after insert or update or delete on devices
  for each row execute function audit_row_change();
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0009_audit_log.sql
```
Expected: `CREATE TABLE`, `GRANT`, `CREATE POLICY`, `CREATE FUNCTION`, `CREATE TRIGGER` x5, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0009_audit_log.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into tenants (id, name, slug) values ('a0000000-0000-0000-0000-00000000000a', 'Audit Co', 'audit-co');
select ok(
  exists(select 1 from audit_log where table_name = 'tenants' and row_id = 'a0000000-0000-0000-0000-00000000000a' and action = 'INSERT'),
  'inserting a tenant writes an audit_log row'
);

update tenants set name = 'Audit Co Renamed' where id = 'a0000000-0000-0000-0000-00000000000a';
select ok(
  exists(
    select 1 from audit_log
    where table_name = 'tenants' and row_id = 'a0000000-0000-0000-0000-00000000000a' and action = 'UPDATE'
      and before->>'name' = 'Audit Co' and after->>'name' = 'Audit Co Renamed'
  ),
  'updating a tenant writes an audit_log row with correct before/after'
);

insert into tenant_users (tenant_id, user_id, role, shop_ids) values
  ('a0000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1', 'cashier', '{}');
select ok(
  exists(select 1 from audit_log where table_name = 'tenant_users' and action = 'INSERT' and tenant_id = 'a0000000-0000-0000-0000-00000000000a'),
  'inserting a tenant_users row writes an audit_log row tagged with the right tenant_id'
);

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
select is_empty(
  $$ select * from audit_log $$,
  'cashier (no VIEW_AUDIT_LOG) cannot read audit_log'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object(
    'sub', 'f0000000-0000-0000-0000-0000000000a1', 'role', 'authenticated',
    'tenant_id', 'a0000000-0000-0000-0000-00000000000a', 'app_role', 'owner', 'shop_ids', '[]'
  )::text, true);
select isnt_empty(
  $$ select * from audit_log $$,
  'owner (claim path, VIEW_AUDIT_LOG) can read audit_log'
);
reset role;

select * from finish();
rollback;
```

- [ ] **Step 4: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0009_audit_log.sql
```
Expected: `1..5`, all 5 lines `ok`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0009_audit_log.sql supabase/tests/0009_audit_log.sql
git commit -m "feat: audit_log table + generic audit_row_change() trigger, pgTAP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 8: `doc_sequences` + `next_doc_no()`

**Files:**
- Create: `supabase/migrations/0010_doc_sequences.sql`
- Create: `supabase/tests/0010_doc_sequences.sql`

**Interfaces:**
- Consumes: `current_tenant_id()` (Task 3), `tenants`/`shops` (Task 2).
- Produces: table `doc_sequences`; `next_doc_no(p_shop_id uuid, p_series text) returns bigint`. Phase 4/5 document-numbering RPCs (`post_sale()`, etc.) will call this by name.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0010_doc_sequences.sql`:
```sql
-- See spec §4. Server-only counter table: no client_id/deleted_at/updated_at
-- (not client-originated, not soft-deleted) — same approved-exception style as
-- schema_meta/backup_runs/audit_log.

create table doc_sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  shop_id uuid not null references shops(id),
  series text not null,
  next_no bigint not null default 0,
  unique (tenant_id, shop_id, series)
);

alter table doc_sequences enable row level security;
-- No grants, no policies: only next_doc_no() (security definer) touches this
-- table.

create function next_doc_no(p_shop_id uuid, p_series text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
  v_next bigint;
begin
  if v_tenant_id is null then
    raise exception 'user has no tenant';
  end if;

  insert into doc_sequences (tenant_id, shop_id, series, next_no)
  values (v_tenant_id, p_shop_id, p_series, 0)
  on conflict (tenant_id, shop_id, series) do nothing;

  -- A single UPDATE both locks the row and increments it atomically — no
  -- separate SELECT ... FOR UPDATE needed.
  update doc_sequences
  set next_no = next_no + 1
  where tenant_id = v_tenant_id and shop_id = p_shop_id and series = p_series
  returning next_no into v_next;

  return v_next;
end;
$$;

revoke all on function next_doc_no(uuid, text) from public;
grant execute on function next_doc_no(uuid, text) to authenticated;
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0010_doc_sequences.sql
```
Expected: `CREATE TABLE`, `ALTER TABLE`, `CREATE FUNCTION`, `REVOKE`/`GRANT`, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0010_doc_sequences.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into tenants (id, name, slug) values ('a0000000-0000-0000-0000-00000000000b', 'Seq Co', 'seq-co');
insert into shops (id, tenant_id, name) values ('e0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000b', 'Seq Shop');
insert into tenant_users (tenant_id, user_id, role, shop_ids) values
  ('a0000000-0000-0000-0000-00000000000b', 'f0000000-0000-0000-0000-0000000000b1', 'owner', '{}');

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);

select is(next_doc_no('e0000000-0000-0000-0000-00000000000b', 'INV'), 1::bigint, 'first call returns 1');
select is(next_doc_no('e0000000-0000-0000-0000-00000000000b', 'INV'), 2::bigint, 'second call returns 2, no gap/repeat');
select is(next_doc_no('e0000000-0000-0000-0000-00000000000b', 'PUR'), 1::bigint, 'a different series starts its own count at 1');
reset role;

set role anon;
select throws_ok(
  $$ select * from doc_sequences $$,
  '42501', null,
  'anon has no grant on doc_sequences (permission denied, not empty)'
);
reset role;

select * from finish();
rollback;
```

- [ ] **Step 4: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0010_doc_sequences.sql
```
Expected: `1..4`, all 4 lines `ok`. (True concurrent-race testing is deferred — see spec §7/§9; this proves sequential correctness only.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0010_doc_sequences.sql supabase/tests/0010_doc_sequences.sql
git commit -m "feat: doc_sequences table + next_doc_no() RPC, pgTAP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 9: Access-token hook

**Files:**
- Create: `supabase/migrations/0011_access_token_hook.sql`
- Create: `supabase/tests/0011_access_token_hook.sql`
- Modify: `docs/HANDOVER.md` (add the manual Dashboard steps, so the instructions live with the phase they belong to)

**Interfaces:**
- Consumes: `tenant_users` (Task 2).
- Produces: `custom_access_token_hook(event jsonb) returns jsonb`, `execute` granted to `supabase_auth_admin`. Nothing later in this plan depends on it — it's the manual wiring point for real Supabase Auth sessions, proven independently of the RLS/RPC gate criteria.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0011_access_token_hook.sql`:
```sql
-- Custom Access Token Hook. See spec §5. Function signature and claim-injection
-- pattern required by Supabase Auth Hooks. Wiring Auth to actually call this
-- function is a manual Dashboard step (Authentication → Hooks → Custom Access
-- Token) — see docs/HANDOVER.md for the exact steps handed to the operator.
-- A user with no tenant_users row yet is left with unmodified claims — no
-- tenant_id claim means every tenant-scoped RLS policy resolves to zero rows,
-- per CLAUDE.md's "fresh user has no tenant until create_tenant()" rule.

create function custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_membership record;
  v_claims jsonb;
begin
  select tenant_id, role, shop_ids into v_membership
  from tenant_users
  where user_id = (event->>'user_id')::uuid
    and status = 'active';

  v_claims := event->'claims';

  if v_membership.tenant_id is not null then
    v_claims := v_claims
      || jsonb_build_object(
        'tenant_id', v_membership.tenant_id,
        'app_role', v_membership.role,
        'shop_ids', to_jsonb(v_membership.shop_ids)
      );
  end if;

  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

revoke all on function custom_access_token_hook(jsonb) from public;
grant execute on function custom_access_token_hook(jsonb) to supabase_auth_admin;
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0011_access_token_hook.sql
```
Expected: `CREATE FUNCTION`, `REVOKE`/`GRANT`, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0011_access_token_hook.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

select has_function('public', 'custom_access_token_hook', array['jsonb'], 'custom_access_token_hook() exists');

insert into tenants (id, name, slug) values ('a0000000-0000-0000-0000-00000000000c', 'Hook Co', 'hook-co');
insert into tenant_users (tenant_id, user_id, role, shop_ids) values
  ('a0000000-0000-0000-0000-00000000000c', 'f0000000-0000-0000-0000-0000000000c1', 'manager', array['e0000000-0000-0000-0000-00000000000c']::uuid[]);

select is(
  (
    custom_access_token_hook(
      jsonb_build_object('user_id', 'f0000000-0000-0000-0000-0000000000c1', 'claims', jsonb_build_object('sub', 'f0000000-0000-0000-0000-0000000000c1'))
    ) -> 'claims' ->> 'app_role'
  ),
  'manager',
  'hook injects app_role for a user with a tenant_users row'
);

select is(
  (
    custom_access_token_hook(
      jsonb_build_object('user_id', 'f0000000-0000-0000-0000-000000000fff', 'claims', jsonb_build_object('sub', 'f0000000-0000-0000-0000-000000000fff'))
    ) -> 'claims' ->> 'app_role'
  ),
  null,
  'hook leaves claims unmodified for a user with no tenant yet'
);

select * from finish();
rollback;
```

- [ ] **Step 4: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0011_access_token_hook.sql
```
Expected: `1..3`, all 3 lines `ok`.

- [ ] **Step 5: Add the manual Dashboard steps to `docs/HANDOVER.md`**

Append a short section (don't rewrite the whole file — this is an addition, matching the "append only" session protocol):
```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0011_access_token_hook.sql supabase/tests/0011_access_token_hook.sql docs/HANDOVER.md
git commit -m "feat: custom_access_token_hook(), pgTAP, manual enablement steps

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 10: Explicit REVOKE hardening — fixes CI environment drift

**Why this task exists (added mid-execution, not in the original plan):** the first attempt at gate verification found that `supabase/config.toml`'s `auto_expose_new_tables` setting (commented out, defaults to `true`) makes a fresh `supabase db reset` — exactly what CI's `pgtap` job runs — auto-grant full CRUD to `anon`/`authenticated` on every table created by migrations `0003`-`0011`. This silently undid the "a table with no grant statement has no access" assumption several earlier tasks' pgTAP assertions relied on, and CI caught it (7/73 assertions failed) even though the same tests passed cleanly against the long-lived `dsb-pro-dev` project. This task makes every table's intended access explicit and portable, independent of that config setting.

**Files:**
- Create: `supabase/migrations/0012_explicit_revokes.sql`
- Create: `supabase/tests/0012_explicit_revokes.sql`
- Modify: `supabase/config.toml` (line 23: uncomment and set `auto_expose_new_tables = false`, so future fresh resets — including Phase 2+'s own CI runs — don't reintroduce this for new tables)

**Interfaces:**
- Consumes: every table from Tasks 1, 2, 7, 8 (`permissions`, `role_permissions`, `doc_sequences`, `tenants`, `shops`, `tenant_users`, `invites`, `devices`, `audit_log`).
- Produces: nothing new — only tightens existing grants back to each table's originally intended state.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0012_explicit_revokes.sql`:
```sql
-- Defense-in-depth: make every Phase 1 table's "no access for a given role"
-- posture explicit, independent of supabase/config.toml's auto_expose_new_tables
-- setting (which defaults to true and was discovered, via CI's fresh `supabase
-- db reset`, to auto-grant full CRUD to anon/authenticated on every new table
-- created in migrations 0003-0011 — undoing the "absence of a grant statement
-- means no access" assumption those migrations' RLS/pgTAP relied on). This
-- migration is idempotent and portable: it works regardless of any CLI/project
-- config, so it holds on a fresh `db reset`, the long-lived dev project, and
-- any future self-hosted or per-shop deployment (Phase 8) alike.

-- Tables with zero client access, ever (only security definer functions read them):
revoke all on permissions from anon, authenticated;
revoke all on role_permissions from anon, authenticated;
revoke all on doc_sequences from anon, authenticated;

-- Tables where authenticated gets exactly SELECT (RLS-filtered), anon gets nothing:
revoke all on tenants from anon, authenticated;
grant select on tenants to authenticated;

revoke all on shops from anon, authenticated;
grant select on shops to authenticated;

revoke all on tenant_users from anon, authenticated;
grant select on tenant_users to authenticated;

revoke all on invites from anon, authenticated;
grant select on invites to authenticated;

revoke all on audit_log from anon, authenticated;
grant select on audit_log to authenticated;

-- devices: authenticated gets SELECT + self-service INSERT, anon gets nothing:
revoke all on devices from anon, authenticated;
grant select, insert on devices to authenticated;
```

- [ ] **Step 2: Update `supabase/config.toml`**

Change line 23 from:
```
# auto_expose_new_tables = true
```
to:
```
auto_expose_new_tables = false
```

- [ ] **Step 3: Apply the migration to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0012_explicit_revokes.sql
```
Expected: 9 `REVOKE` lines and 6 `GRANT` lines, no errors. (Revoking a privilege that isn't currently granted is a harmless no-op in Postgres, so this is safe to run against `dsb-pro-dev` even though it likely never had the drift CI showed.)

- [ ] **Step 4: Write the pgTAP test**

`supabase/tests/0012_explicit_revokes.sql`:
```sql
-- Regression test for the CI environment-drift bug this migration fixes:
-- every table below must deny anon regardless of auto_expose_new_tables.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

set role anon;
select throws_ok($$ select * from permissions $$, '42501', null, 'anon cannot read permissions');
select throws_ok($$ select * from role_permissions $$, '42501', null, 'anon cannot read role_permissions');
select throws_ok($$ select * from doc_sequences $$, '42501', null, 'anon cannot read doc_sequences');
select throws_ok($$ select * from tenants $$, '42501', null, 'anon cannot read tenants');
select throws_ok($$ select * from shops $$, '42501', null, 'anon cannot read shops');
select throws_ok($$ select * from tenant_users $$, '42501', null, 'anon cannot read tenant_users');
select throws_ok($$ select * from invites $$, '42501', null, 'anon cannot read invites');
select throws_ok($$ select * from devices $$, '42501', null, 'anon cannot read devices');
select throws_ok($$ select * from audit_log $$, '42501', null, 'anon cannot read audit_log');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 5: Run it and verify it passes**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0012_explicit_revokes.sql
```
Expected: `1..9`, all 9 lines `ok`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0012_explicit_revokes.sql supabase/tests/0012_explicit_revokes.sql supabase/config.toml
git commit -m "fix: explicit REVOKE hardening — CI's fresh db reset was auto-granting anon/authenticated full CRUD via auto_expose_new_tables

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```

---

### Task 11: Phase 1 gate verification + handover

**Files:**
- Modify: `docs/HANDOVER.md` (append the Phase 1 completion entry, per the session protocol's "End of session: append delta to docs/HANDOVER.md only")
- Modify: `CLAUDE.md` (bump `Current phase` and `Last completed change-set`)

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: nothing further in code — this task is verification and documentation only.

- [ ] **Step 1: Run the complete local pgTAP suite against the dev project, in order**

```bash
for f in supabase/tests/0003_permissions.sql \
         supabase/tests/0004_tenancy.sql \
         supabase/tests/0005_claims_resolver.sql \
         supabase/tests/0006_tenancy_rls.sql \
         supabase/tests/0007_tenant_lifecycle_rpcs.sql \
         supabase/tests/0008_device_rpcs.sql \
         supabase/tests/0009_audit_log.sql \
         supabase/tests/0010_doc_sequences.sql \
         supabase/tests/0011_access_token_hook.sql \
         supabase/tests/0012_explicit_revokes.sql; do
  echo "=== $f ==="
  PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f "$f"
done
```
Expected: every file prints only `ok` lines, no `not ok`, pasted in full — not "✓", per CLAUDE.md's rule.

- [ ] **Step 2: Push the branch and confirm CI's ephemeral-Postgres pgTAP job is green**

```bash
git push -u origin worktree-phase-1-tenancy-auth-rls
gh run list --workflow=ci.yml --branch worktree-phase-1-tenancy-auth-rls --limit 1
```
Expected: the `pgtap` job (and every other job) shows success. This is the authoritative, Docker-backed run of the exact same test files — CI applies every migration fresh via `supabase db reset` and runs `supabase test db`, so it independently re-proves everything Step 1 proved against the long-lived dev project.

- [ ] **Step 3: Confirm the phase gate criteria explicitly, one by one**

- pgTAP 100%: shown by Steps 1 and 2 above (paste both outputs).
- Two tenants provably isolated: `supabase/tests/0006_tenancy_rls.sql`'s 8 assertions, both paths.
- Cashier cannot escalate: `supabase/tests/0007_tenant_lifecycle_rpcs.sql`'s escalation assertions.
- Auth works with hook disabled: `supabase/tests/0005_claims_resolver.sql`'s fallback-path assertions pass identically to the claim-path ones, and the hook is confirmed *not yet enabled* in the Dashboard at the time this is checked (Task 9, Step 5's manual step is deliberately left undone for this proof, then can be enabled afterward).

- [ ] **Step 4: Append the Phase 1 entry to `docs/HANDOVER.md`**

Append (don't rewrite existing content):
```markdown
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
- pgTAP 100%: <paste Step 1's full output here>
- CI green: <paste the `gh run list` link/output here>
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
```

- [ ] **Step 5: Update `CLAUDE.md`'s phase marker**

Change:
```
Current phase: 0. Last completed change-set: none.
```
to:
```
Current phase: 1 (backend complete; UI follow-up spec pending). Last completed change-set: Phase 1 tenancy/auth/RLS backend.
```

- [ ] **Step 6: Commit**

```bash
git add docs/HANDOVER.md CLAUDE.md
git commit -m "docs: Phase 1 backend handover entry — gate verified

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YGQwZyy69m2CoYtoiZeaSG"
```
