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
