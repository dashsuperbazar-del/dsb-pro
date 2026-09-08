import { describe, expect, it } from 'vitest';
import { hasPerm } from './roles';

describe('hasPerm', () => {
  it('owner has every permission', () => {
    expect(hasPerm('owner', 'MANAGE_TENANT_USERS')).toBe(true);
    expect(hasPerm('owner', 'MANAGE_INVITES')).toBe(true);
    expect(hasPerm('owner', 'MANAGE_DEVICES')).toBe(true);
    expect(hasPerm('owner', 'VIEW_AUDIT_LOG')).toBe(true);
  });

  it('manager only has MANAGE_DEVICES', () => {
    expect(hasPerm('manager', 'MANAGE_DEVICES')).toBe(true);
    expect(hasPerm('manager', 'MANAGE_INVITES')).toBe(false);
  });

  it('cashier and accountant have none of these', () => {
    expect(hasPerm('cashier', 'MANAGE_DEVICES')).toBe(false);
    expect(hasPerm('accountant', 'VIEW_AUDIT_LOG')).toBe(false);
  });

  it('a null/undefined role (no membership yet) has no permissions', () => {
    expect(hasPerm(null, 'MANAGE_INVITES')).toBe(false);
    expect(hasPerm(undefined, 'MANAGE_INVITES')).toBe(false);
  });
});
