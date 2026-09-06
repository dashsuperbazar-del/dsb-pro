-- Post-hoc hardening + bug fixes from the final whole-branch review of Phase 1
-- (tenancy/auth/RLS), after all 11 original tasks were done, reviewed, and
-- merged. Forward-only: this migration supersedes buggy function bodies via
-- `create or replace function` rather than editing 0004/0007/0011 in place,
-- and adds plain revoke/grant/index/comment statements for everything else.
-- See docs/HANDOVER.md and this task's SDD report for the full findings list.

-- ============================================================================
-- Fix 4: indexes on every tenant_id column RLS policies filter on.
-- Every SELECT policy on these tables (0006_tenancy_rls.sql, 0009_audit_log.sql)
-- filters by `tenant_id = current_tenant_id()`, and none of these four columns
-- were indexed. Tables are currently empty in every environment this runs
-- against, so these are free: no lock contention, no migration risk.
-- ============================================================================

create index if not exists shops_tenant_id_idx on shops (tenant_id);
create index if not exists tenant_users_tenant_id_idx on tenant_users (tenant_id);
create index if not exists devices_tenant_id_idx on devices (tenant_id);
-- Composite, not just (tenant_id): the expected query shape is "this tenant's
-- audit log, most recent first" (tenant_id = ... order by created_at desc).
create index if not exists audit_log_tenant_id_created_at_idx on audit_log (tenant_id, created_at);

-- ============================================================================
-- Fix 1: create_tenant() could silently return NULL on an ordinary,
-- non-concurrent slug collision against a DIFFERENT tenant.
--
-- The original `exception when unique_violation` handler assumed any
-- unique_violation raised anywhere in the function's three inserts was the
-- idempotency-retry case against tenants(created_by, client_id) (constraint
-- name confirmed live against dsb-pro-dev: tenants_created_by_client_id_key —
-- see `\d tenants`). But tenants.slug also carries a bare `unique` constraint
-- (tenants_slug_key, also confirmed live). A caller who picks a slug some
-- OTHER tenant already owns hits that constraint instead: no tenants row was
-- ever inserted, so the recovery SELECT (which only ever looked for a row
-- matching the CALLER's own created_by/client_id) matched nothing,
-- v_tenant_id stayed NULL, and the function returned NULL instead of
-- raising — a caller got no error and no tenant.
--
-- Fix: use GET STACKED DIAGNOSTICS to read the constraint that actually
-- fired. Only treat it as "idempotent retry, return the existing tenant" when
-- it is genuinely tenants_created_by_client_id_key AND the recovery SELECT
-- actually finds a row; anything else re-raises the original exception.
-- ============================================================================

create or replace function create_tenant(p_name text, p_slug text, p_shop_name text, p_client_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_tenant_id uuid;
  v_tenant_id uuid;
  v_shop_id uuid;
  v_constraint text;
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
    get stacked diagnostics v_constraint = constraint_name;

    -- Only the concurrent-retry constraint gets the "return existing tenant"
    -- treatment. A slug collision (tenants_slug_key) or anything else is a
    -- genuine, reportable error.
    if v_constraint is distinct from 'tenants_created_by_client_id_key' then
      raise;
    end if;

    select t.id into v_tenant_id
    from tenants t
    where t.created_by = auth.uid() and t.client_id = p_client_id;

    -- Belt and braces: even for the expected constraint, never silently
    -- return NULL. If the recovery SELECT still finds nothing, re-raise
    -- rather than hand the caller an unusable NULL tenant id.
    if v_tenant_id is null then
      raise;
    end if;

    return v_tenant_id;
end;
$$;

-- ============================================================================
-- Fix 2: accept_invite() had no row lock — one token could be redeemed twice.
--
-- Under READ COMMITTED, two concurrent callers redeeming the same token could
-- both pass the unlocked SELECT's WHERE clause before either committed, both
-- insert their own tenant_users row, and both mark the invite accepted.
-- `for update` locks the matched row so a second concurrent caller blocks
-- until the first transaction commits, then re-evaluates the WHERE clause
-- against the now-committed accepted_at and correctly falls through to the
-- existing "invite invalid, expired, or already used" exception.
--
-- This is a genuinely concurrent bug: it cannot be exercised by a single
-- pgTAP session (see this migration's test file and the fix report for why
-- no test asserts the race directly — the lock's correctness is documented
-- here instead).
-- ============================================================================

create or replace function accept_invite(p_token text, p_client_id text)
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

  -- `for update`: locks the matched invite row for the rest of this
  -- transaction. A second concurrent redemption attempt of the same token
  -- blocks here until this transaction commits (or rolls back), then
  -- re-runs the WHERE clause against the committed row — at which point
  -- accepted_at is no longer null and `not found` correctly fires below.
  -- Without this lock, two concurrent callers could both pass the WHERE
  -- clause before either commits and both redeem the same token.
  select * into v_invite from invites
  where token = p_token
    and revoked_at is null
    and accepted_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'invite invalid, expired, or already used';
  end if;

  insert into tenant_users (tenant_id, user_id, role, shop_ids, status, client_id)
  values (v_invite.tenant_id, auth.uid(), v_invite.role, v_invite.shop_ids, 'active', p_client_id);

  update invites set accepted_at = now() where id = v_invite.id;

  return v_invite.tenant_id;
end;
$$;

-- ============================================================================
-- Fix 3 (bundled): set_updated_at() missing `set search_path = public`, and
-- custom_access_token_hook()'s jsonb_set() being non-defensive against a
-- missing `claims` key. Neither changes observable behavior in this project
-- (Supabase always sends a claims key; set_updated_at() isn't security
-- definer so the mutable search_path was hygiene debt, not an exploit path),
-- but both are adjacent, cheap, and already being touched.
-- ============================================================================

create or replace function set_updated_at() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  return new;
end;
$$;

create or replace function custom_access_token_hook(event jsonb)
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

  -- Defensive: jsonb_set() is strict on NULL, so if `event` ever arrived
  -- without a `claims` key at all, the original `event->'claims'` would be
  -- NULL and the whole function would return NULL (dropping the event
  -- entirely) instead of the harmless unmodified-claims case below. Supabase
  -- always sends a claims key in practice, but this costs nothing.
  v_claims := coalesce(event->'claims', '{}'::jsonb);

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

-- ============================================================================
-- Fix 3 (main): explicit anon/authenticated EXECUTE lockdown for every
-- function created across migrations 0003-0012.
--
-- supabase/config.toml's own comment says auto_expose_new_tables governs
-- "tables, views, sequences and functions" reachable through the Data API
-- roles without explicit grants. Task 10 (0012_explicit_revokes.sql) closed
-- this for every TABLE but missed FUNCTIONS. Every function below already
-- does `revoke all on function X from public`, but revoking from the PUBLIC
-- pseudo-role does NOT undo a grant Supabase's auto-expose mechanism might
-- make directly to the named roles anon/authenticated — a separate grant
-- path from PUBLIC entirely. Highest-stakes case: custom_access_token_hook()
-- is security definer, takes an arbitrary user_id, and returns that user's
-- tenant_id/app_role/shop_ids — if anon/authenticated could call it directly,
-- that's a cross-tenant enumeration vector on a hosted project.
--
-- Pattern (matches 0012's table-level revoke-then-regrant): revoke from both
-- anon and authenticated unconditionally, then re-grant to authenticated
-- only where that access is meant to exist, making it deliberate rather than
-- an assumption resting on the absence of a statement.
-- ============================================================================

-- 0004_tenancy.sql: trigger-only function, no direct caller ever needed.
revoke execute on function set_updated_at() from anon, authenticated;

-- 0005_claims_resolver.sql: claims resolver, callable by any authenticated
-- session (each one only ever resolves the caller's OWN membership/claims).
revoke execute on function "current_membership"() from anon, authenticated;
grant execute on function "current_membership"() to authenticated;

revoke execute on function "current_tenant_id"() from anon, authenticated;
grant execute on function "current_tenant_id"() to authenticated;

revoke execute on function "current_role"() from anon, authenticated;
grant execute on function "current_role"() to authenticated;

revoke execute on function "current_shop_ids"() from anon, authenticated;
grant execute on function "current_shop_ids"() to authenticated;

revoke execute on function "has_perm"(text) from anon, authenticated;
grant execute on function "has_perm"(text) to authenticated;

-- 0007_tenant_lifecycle_rpcs.sql
revoke execute on function create_tenant(text, text, text, text) from anon, authenticated;
grant execute on function create_tenant(text, text, text, text) to authenticated;

revoke execute on function create_invite(text, uuid[]) from anon, authenticated;
grant execute on function create_invite(text, uuid[]) to authenticated;

revoke execute on function revoke_invite(uuid) from anon, authenticated;
grant execute on function revoke_invite(uuid) to authenticated;

revoke execute on function accept_invite(text, text) from anon, authenticated;
grant execute on function accept_invite(text, text) to authenticated;

revoke execute on function set_user_role(uuid, text) from anon, authenticated;
grant execute on function set_user_role(uuid, text) to authenticated;

-- 0008_device_rpcs.sql
revoke execute on function register_device(text, text) from anon, authenticated;
grant execute on function register_device(text, text) to authenticated;

revoke execute on function revoke_device(uuid) from anon, authenticated;
grant execute on function revoke_device(uuid) to authenticated;

-- 0009_audit_log.sql: trigger-only function, no direct caller ever needed.
revoke execute on function audit_row_change() from anon, authenticated;

-- 0010_doc_sequences.sql
revoke execute on function next_doc_no(uuid, text) from anon, authenticated;
grant execute on function next_doc_no(uuid, text) to authenticated;

-- 0011_access_token_hook.sql: the highest-stakes case. This function must
-- have NO anon/authenticated access at all — it is only ever meant to be
-- called by Supabase Auth's own supabase_auth_admin role, which already
-- holds its own, untouched EXECUTE grant from 0011. No re-grant here.
revoke execute on function custom_access_token_hook(jsonb) from anon, authenticated;

-- Required per Supabase's own Auth Hooks documentation for
-- supabase_auth_admin to actually be able to call a function in the public
-- schema once the hook is enabled in the Dashboard (see docs/HANDOVER.md's
-- manual enablement step) — was missing.
grant usage on schema public to supabase_auth_admin;

-- ============================================================================
-- Fix 3 (schema documentation): comments recording two gotchas in the schema
-- itself, without editing the historical migrations that introduced them.
-- ============================================================================

comment on function "current_role"() is
  'Name collides with the reserved SQL keyword / role-inspection built-in '
  '`current_role` — must be double-quoted at every definition and call site '
  '(see 0005_claims_resolver.sql and every caller). Kept as-is for symmetry '
  'with current_tenant_id()/current_shop_ids(); a rename is a bigger diff '
  'than the quoting requirement is worth.';

comment on function next_doc_no(uuid, text) is
  'Does not currently validate that p_shop_id belongs to the caller''s own '
  'tenant (current_tenant_id()) before allocating a sequence number under '
  'it. Low risk today only because shops has no RLS visibility into other '
  'tenants'' rows, so exploiting this requires already guessing a live shop '
  'UUID belonging to another tenant — but a future caller/phase should '
  'either verify shop ownership before calling this, or this function '
  'should add that check itself.';
