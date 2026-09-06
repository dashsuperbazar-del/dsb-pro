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
