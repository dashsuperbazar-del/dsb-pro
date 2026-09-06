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
