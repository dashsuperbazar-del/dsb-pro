-- Packet P1: guarded upgrade receipts and staging proof.
--
-- app_migration_receipts is a control table, not tenant data: it is the
-- same category of exception as schema_meta (0001_init.sql). It proves
-- exactly which migration bytes were applied, by whom, and when. It does
-- NOT prove the absence of later manual schema tampering — see mechanism
-- point 6 in docs/COMPLETE_REMAINING_BUILD_PLAN.md §4 P1: the classifier
-- must additionally verify expected columns/constraints/functions/grants,
-- not just check this table for a version string.
--
-- Unlike schema_meta (which anon/authenticated may read to display a
-- version banner), this table is denied entirely to anon and authenticated:
-- it is written only by the Node receipt runner (scripts/apply-migrations-
-- with-receipts.mjs), which connects as a privileged role (service_role or
-- the migration superuser), never by application code, and never by
-- ordinary cashier-facing sessions.
create table app_migration_receipts (
  version text primary key,
  checksum_sha256 text not null,
  applied_at timestamptz not null default now(),
  applied_by text not null default current_user,
  constraint app_migration_receipts_version_format check (version ~ '^[0-9]{4}$'),
  constraint app_migration_receipts_checksum_format check (checksum_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table app_migration_receipts is
  'Control table (standard-column exception, like schema_meta): proves which '
  'migration file bytes were applied and when. Not tenant data; excluded from '
  'per-shop/tenant export. Written only by the privileged Node receipt runner.';

alter table app_migration_receipts enable row level security;

-- Deny-all: no policies are created for anon/authenticated, and both roles'
-- table privileges are explicitly revoked so a future stray GRANT ALL on
-- public schema tables cannot silently reopen this. Only service_role
-- (which bypasses RLS under Supabase's default grants) or a superuser/
-- migration role can read or write it.
revoke all on app_migration_receipts from public;
revoke all on app_migration_receipts from anon;
revoke all on app_migration_receipts from authenticated;

-- Operator backup/export, not ordinary per-shop cashier data: matches the
-- existing backup_ro grant pattern (0030_phase6_ledgers_reports_dr.sql,
-- 0036_phase65_returns.sql). This table has no tenant_id column and is
-- never filtered into any per-shop/tenant export path.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'backup_ro') then
    grant select on app_migration_receipts to backup_ro;
  end if;
end
$$;

-- This statement is itself covered by a receipt: the Node runner computes
-- this file's SHA-256, applies it, and inserts a matching row for version
-- '0044' in the same transaction, after this CREATE TABLE has run and
-- before COMMIT (mechanism point 4). Migration 0044's own SQL body never
-- inserts its own receipt row and never invents a checksum.
