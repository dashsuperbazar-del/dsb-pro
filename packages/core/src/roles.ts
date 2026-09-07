// Mirrors supabase/migrations/0003_permissions.sql's role_permissions seed
// data exactly. This is a UI-gating convenience only — the RPCs themselves
// re-check has_perm() server-side (DSB_PRO_BUILD_PLAN.md §2: "Privileged ops
// via Postgres RPC"), so a mismatch here is a UX bug, never a security hole.
// If role_permissions.sql ever changes, update this table too.

export type Role = 'owner' | 'manager' | 'cashier' | 'accountant';

export type PermissionCode =
  | 'MANAGE_TENANT_USERS'
  | 'MANAGE_INVITES'
  | 'MANAGE_DEVICES'
  | 'VIEW_AUDIT_LOG';

const ROLE_PERMISSIONS: Record<Role, PermissionCode[]> = {
  owner: ['MANAGE_TENANT_USERS', 'MANAGE_INVITES', 'MANAGE_DEVICES', 'VIEW_AUDIT_LOG'],
  manager: ['MANAGE_DEVICES'],
  cashier: [],
  accountant: [],
};

export function hasPerm(role: Role | null | undefined, code: PermissionCode): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(code);
}
