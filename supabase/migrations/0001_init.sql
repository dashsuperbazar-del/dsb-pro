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
grant select on schema_meta to anon, authenticated;
-- No policies: RLS is the actual barrier here. The explicit grant above
-- matters because default privileges for tables vary by which role applies
-- the migration (Supabase's own tooling normally runs as supabase_admin,
-- whose defaults grant anon/authenticated full CRUD server-side; a table
-- created by a different role, e.g. a direct `postgres` connection, may not
-- inherit that default at all) — granting explicitly makes the RLS-is-the-
-- barrier design hold regardless of how the migration gets applied.
-- Only the service role (bypasses RLS) may write to this table.

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
grant select on backup_runs to anon, authenticated;
-- No policies here either: RLS default-deny (no policies) is the actual
-- barrier, same reasoning as schema_meta above. get_latest_backup_status()
-- (0002_backup_status_rpc.sql) exposes a narrow, non-sensitive read path for
-- the admin app's health panel; only the service role may write directly.
