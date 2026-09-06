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
