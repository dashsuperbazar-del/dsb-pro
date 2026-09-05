-- Phase 0 control tables. See docs/superpowers/specs/2026-09-04-phase-0-foundations-design.md §5.
-- These are server-only control tables, not tenant data: they intentionally skip the
-- standard tenant_id/shop_id/client_id/deleted_at columns (approved exception, see spec §5).

create table schema_meta (
  id boolean primary key default true,
  current_version integer not null,
  min_supported_version integer not null,
  updated_at timestamptz not null default now(),
  constraint schema_meta_singleton check (id)
);

insert into schema_meta (id, current_version, min_supported_version)
values (true, 1, 1);

alter table schema_meta enable row level security;
-- No policies: default-deny for anon/authenticated via RLS. On this project,
-- anon/authenticated also have no default SELECT grant on new tables at all
-- (verified against information_schema.role_table_grants), so direct access
-- is rejected at the grant level before RLS is even evaluated; RLS is
-- defense in depth here, not the sole barrier. Only the service role
-- (bypasses RLS and holds real grants) may read/write this table directly.

create table backup_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  dump_size_bytes bigint,
  sha256 text,
  destinations jsonb not null default '[]'::jsonb,
  app_version text,
  schema_version integer,
  manifest jsonb,
  error text,
  created_at timestamptz not null default now()
);

alter table backup_runs enable row level security;
-- No policies here either: the base table stays fully locked down.
-- get_latest_backup_status() (0002_backup_status_rpc.sql) exposes a narrow,
-- non-sensitive read path for the admin app's health panel.
