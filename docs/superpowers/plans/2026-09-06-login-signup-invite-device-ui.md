# Login/Signup/Invite/Device UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the UI half of the Phase 1 gate item "login/signup/invite/device UI": login, signup, the no-tenant landing, create-tenant, invite creation/sharing/acceptance, an owner/manager Team screen, and device registration/listing/revocation — wired to the already-merged Phase 1 backend (PR #1, `origin/main` commit `995a589`).

**Architecture:** A new `packages/adapters` package (the `AuthAdapter`/tenancy/device interfaces from `DSB_PRO_BUILD_PLAN.md` §4) wraps `@supabase/supabase-js` so no provider name appears in `apps/admin`. `apps/admin` gets its first real router (`preact-router`) and a session-state layer (`useSession`) driving four states — loading / signed-out / no-tenant / active — that gate which screens render. Two small, pure, zero-dep utilities (slug generation, password strength, role→permission lookup) land in `packages/core`. One small backend addition (a `devices.label` column + `set_device_label()` RPC, migration `0014`) closes a gap the spec needs that Phase 1 didn't ship. Every screen gets a Playwright smoke test, bootstrapped in Task 8 and run against a CI-local `supabase start` instance (this dev machine has no Docker/WSL2, matching the constraint the Phase 1 backend plan already worked under).

**Tech Stack:** Preact 10, `preact-router`, `@supabase/supabase-js`, Vite, Vitest, Playwright, Supabase Postgres/Auth (local `supabase start` in CI; the `dsb-pro-dev` hosted project for local manual verification).

**Spec:** `docs/superpowers/specs/2026-09-06-login-signup-invite-device-ui-design.md`

## Global Constraints

- Adapter rule (`DSB_PRO_BUILD_PLAN.md` §4): UI and sync code import only adapter interfaces; no provider name (`supabase`, `@supabase/supabase-js`) appears outside `packages/adapters`.
- Privileged ops go through the existing `security definer` RPCs; no new client-side table insert/update/delete grants are added anywhere in this plan except the one new RPC in Task 1.
- RLS/RPCs check `has_perm('CODE')`, never a hard-coded role string — the client mirrors this with a pure `hasPerm(role, code)` lookup (Task 2), never a hard-coded `role === 'owner'` check in a screen component.
- Custom JWT claim keys are `tenant_id`, `app_role`, `shop_ids` (never `role`) — this plan never reads them directly; it always goes through `current_membership()`/`current_tenant_id()`/`has_perm()`, which already handle the claim-vs-table-fallback split.
- One tenant per user this phase (`tenant_users` has `unique(user_id)`) — no "switch tenant" UI exists or is needed.
- Money/units/financial rules from `CLAUDE.md` don't apply to this plan — no financial data is touched.
- `DSB_PRO_BUILD_PLAN.md` §10 asks for Hindi/English strings, dark mode, empty/loading/error states, focus/contrast, and a Playwright smoke test on every screen. This plan ships empty/loading/error states and a Playwright smoke test per screen (that part is a hard requirement below). **Dark mode and Hindi strings are explicitly deferred**, matching how Phase 0's own `apps/admin` placeholder shipped without either — literal English JSX text throughout, no `prefers-color-scheme` handling in `style.css`. This is a real, acknowledged gap against §10, not an oversight; it's recorded as such in Task 13's `docs/HANDOVER.md` entry rather than silently assumed away. Building real i18n/theming infrastructure for a five-screen MVP is deferred to whichever later phase first needs it broadly (by then more screens exist to amortize the cost against).
- Error taxonomy (`DSB_PRO_BUILD_PLAN.md` §10) is fixed: user error / offline / auth-expired / server error — every screen routes failures through `classifyError()` (Task 3), never a generic message.
- **Two backend truths this plan must represent honestly, not paper over** (`docs/HANDOVER.md`, "Known Phase 1-only simplifications"): (a) device revocation has zero enforcement today — revoking someone else's device only removes it from the list; (b) a role/status change via `set_user_role` takes effect on that user's next request (table-fallback path) but can take up to the JWT's lifetime (~1 hour) once the access-token hook is enabled. Copy in Tasks 11–12 must say this, not imply instant effect.

---

### Task 1: `devices.label` column + `set_device_label()` RPC

**Files:**
- Create: `supabase/migrations/0014_device_label.sql`
- Create: `supabase/tests/0014_device_label.sql`

**Interfaces:**
- Produces: `devices.label text` (nullable) and RPC `set_device_label(p_id uuid, p_label text) returns void`, callable by `authenticated`, permission rule identical to `revoke_device` (self, or `has_perm('MANAGE_DEVICES')` for someone else's device). Consumed by Task 6's `renameDevice()`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0014_device_label.sql`:
```sql
-- Adds a human-readable label to devices, needed by the login/signup/invite/
-- device UI spec (docs/superpowers/specs/2026-09-06-login-signup-invite-device-ui-design.md
-- §5): Phase 1 shipped devices with no name/label column, but the UI's
-- "auto-name on register, rename later" behavior needs somewhere to store it.
-- Mirrors revoke_device()'s permission shape exactly (0008_device_rpcs.sql):
-- a device's own user can always act on it; anyone else needs MANAGE_DEVICES.

alter table devices add column label text;

create function set_device_label(p_id uuid, p_label text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device devices%rowtype;
begin
  select * into v_device from devices
  where id = p_id and tenant_id = current_tenant_id();

  if not found then
    raise exception 'device not found';
  end if;

  if v_device.user_id <> auth.uid() and not has_perm('MANAGE_DEVICES') then
    raise exception 'not permitted';
  end if;

  update devices set label = p_label where id = p_id;
end;
$$;

revoke all on function set_device_label(uuid, text) from public;
revoke execute on function set_device_label(uuid, text) from anon, authenticated;
grant execute on function set_device_label(uuid, text) to authenticated;
```

- [ ] **Step 2: Apply it to the dev project**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/migrations/0014_device_label.sql
```
Expected: `ALTER TABLE`, `CREATE FUNCTION`, three revoke/grant lines, no errors.

- [ ] **Step 3: Write the pgTAP test**

`supabase/tests/0014_device_label.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id)
values
  ('f0000000-0000-0000-0000-000000000020'),
  ('f0000000-0000-0000-0000-000000000021')
on conflict do nothing;

insert into tenants (id, name, slug, created_by) values ('a0000000-0000-0000-0000-000000000010', 'Tenant Label', 'tenant-label', 'f0000000-0000-0000-0000-000000000020');
insert into tenant_users (tenant_id, user_id, role, shop_ids, created_by) values
  ('a0000000-0000-0000-0000-000000000010', 'f0000000-0000-0000-0000-000000000020', 'cashier', '{}', 'f0000000-0000-0000-0000-000000000020'),
  ('a0000000-0000-0000-0000-000000000010', 'f0000000-0000-0000-0000-000000000021', 'manager', '{}', 'f0000000-0000-0000-0000-000000000020');

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000020', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select register_device('phone-label-1', '0.1.0') $$,
  'cashier registers a device to label'
);
select lives_ok(
  $$ select set_device_label((select id from devices where device_id = 'phone-label-1'), 'My Phone') $$,
  'cashier can label their own device'
);
select is(
  (select label from devices where device_id = 'phone-label-1'),
  'My Phone',
  'label persisted'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000021', 'role', 'authenticated')::text, true);
select lives_ok(
  $$ select set_device_label((select id from devices where device_id = 'phone-label-1'), 'Relabeled by manager') $$,
  'manager can relabel the cashier''s device too (has_perm MANAGE_DEVICES, same rule as revoke_device)'
);
select lives_ok(
  $$ select register_device('tablet-label-1', '0.1.0') $$,
  'manager registers their own device'
);
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000020', 'role', 'authenticated')::text, true);
select throws_ok(
  $$ select set_device_label((select id from devices where device_id = 'tablet-label-1'), 'Hijacked') $$,
  null, 'not permitted',
  'cashier cannot relabel the manager''s device (not the owner, no MANAGE_DEVICES)'
);
reset role;

select * from finish();
rollback;
```

- [ ] **Step 4: Run the test**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0014_device_label.sql
```
Expected: `plan(6)`, six `ok` lines, zero `not ok`, then `ROLLBACK`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0014_device_label.sql supabase/tests/0014_device_label.sql
git commit -m "feat: devices.label column + set_device_label() RPC"
```

---

### Task 2: `packages/core` — roles, slug, and password-strength utilities

**Files:**
- Create: `packages/core/src/roles.ts`
- Create: `packages/core/src/roles.test.ts`
- Create: `packages/core/src/slug.ts`
- Create: `packages/core/src/slug.test.ts`
- Create: `packages/core/src/password.ts`
- Create: `packages/core/src/password.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `type Role = 'owner' | 'manager' | 'cashier' | 'accountant'`; `type PermissionCode = 'MANAGE_TENANT_USERS' | 'MANAGE_INVITES' | 'MANAGE_DEVICES' | 'VIEW_AUDIT_LOG'`; `hasPerm(role: Role | null | undefined, code: PermissionCode): boolean`; `toSlug(input: string): string`; `makeTenantSlug(name: string): string`; `passwordStrength(password: string): { valid: boolean; message: string }`. Consumed by `packages/adapters` (Tasks 5–6) and every `apps/admin` screen from Task 8 onward.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/roles.test.ts`:
```ts
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
```

`packages/core/src/slug.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { toSlug, makeTenantSlug } from './slug';

describe('toSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(toSlug("Ramesh's Store")).toBe('ramesh-s-store');
  });

  it('collapses repeated separators and trims edges', () => {
    expect(toSlug('  Hello   World!! ')).toBe('hello-world');
  });

  it('returns "shop" for input with no alphanumeric characters', () => {
    expect(toSlug('!!!')).toBe('shop');
  });
});

describe('makeTenantSlug', () => {
  it('appends a random suffix so two shops with the same name never collide', () => {
    const a = makeTenantSlug('Ramesh Store');
    const b = makeTenantSlug('Ramesh Store');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^ramesh-store-[a-z0-9]{4}$/);
  });
});
```

`packages/core/src/password.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { passwordStrength } from './password';

describe('passwordStrength', () => {
  it('rejects passwords shorter than 8 characters', () => {
    const result = passwordStrength('a1b2c3');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/8 characters/);
  });

  it('rejects passwords with no digit', () => {
    const result = passwordStrength('longenoughpassword');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/number/);
  });

  it('accepts a password with 8+ characters and at least one digit', () => {
    const result = passwordStrength('shop2026');
    expect(result.valid).toBe(true);
    expect(result.message).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @dsb-pro/core test
```
Expected: FAIL — `Cannot find module './roles'` (and `./slug`, `./password`).

- [ ] **Step 3: Write the implementations**

`packages/core/src/roles.ts`:
```ts
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
```

`packages/core/src/slug.ts`:
```ts
export function toSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'shop';
}

function randomSuffix(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// create_tenant() (supabase/migrations/0007_tenant_lifecycle_rpcs.sql) requires
// a globally-unique slug (tenants_slug_key). The UI only ever asks for a shop
// name (spec §4 "Minimal: shop name only"), so a random suffix is always
// appended rather than asking the user to pick a slug or resolve a collision.
export function makeTenantSlug(name: string): string {
  return `${toSlug(name)}-${randomSuffix(4)}`;
}
```

`packages/core/src/password.ts`:
```ts
const MIN_LENGTH = 8;

// UI-only guidance (DSB_PRO_BUILD_PLAN.md §2: "JS validation is UX only") —
// Supabase Auth's configured policy (supabase/config.toml [auth],
// minimum_password_length / password_requirements) is the enforced source of
// truth; a signup can still fail server-side even if this passes, and that
// failure is surfaced through the normal error taxonomy (classifyError).
export function passwordStrength(password: string): { valid: boolean; message: string } {
  if (password.length < MIN_LENGTH) {
    return { valid: false, message: `Use at least ${MIN_LENGTH} characters.` };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Include at least one number.' };
  }
  return { valid: true, message: '' };
}
```

`packages/core/src/index.ts` — add three lines to the existing barrel:
```ts
export { toRupeeString } from './paise';
export { hasPerm } from './roles';
export type { Role, PermissionCode } from './roles';
export { toSlug, makeTenantSlug } from './slug';
export { passwordStrength } from './password';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @dsb-pro/core test
```
Expected: PASS, 10 tests (4 + 3 + 3).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): role permission lookup, tenant slug, password strength"
```

---

### Task 3: `packages/adapters` — package scaffold, Supabase client, error classifier

**Files:**
- Create: `packages/adapters/package.json`
- Create: `packages/adapters/tsconfig.json`
- Create: `packages/adapters/src/client.ts`
- Create: `packages/adapters/src/errors.ts`
- Create: `packages/adapters/src/errors.test.ts`
- Create: `packages/adapters/src/index.ts`

**Interfaces:**
- Produces: `getSupabaseClient(): SupabaseClient` (memoized singleton); `type ErrorClass = 'user' | 'offline' | 'auth-expired' | 'server'`; `classifyError(error: unknown): ErrorClass`; `errorMessage(errorClass: ErrorClass, error: unknown): string`. Consumed by Tasks 4–6 (all adapter calls) and every `apps/admin` screen from Task 8 onward.

- [ ] **Step 1: Write the package scaffold**

`packages/adapters/package.json`:
```json
{
  "name": "@dsb-pro/adapters",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.58.0"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "vitest": "^5.0.0"
  }
}
```

`packages/adapters/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM"],
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`packages/adapters/src/client.ts`:
```ts
// The only file in this package (and the only file in the whole repo outside
// apps/admin's Phase 0 HealthPanel, which predates this package) allowed to
// import @supabase/supabase-js directly — DSB_PRO_BUILD_PLAN.md §4's adapter
// rule: "no provider name appears outside packages/adapters."
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set.');
  }

  client = createClient(url, anonKey);
  return client;
}

// Test-only escape hatch: vitest specs inject a mock client instead of
// hitting the network. Never called from apps/admin.
export function __setSupabaseClientForTest(mock: SupabaseClient): void {
  client = mock;
}
```

`packages/adapters/src/errors.ts`:
```ts
// The four error classes are fixed by DSB_PRO_BUILD_PLAN.md §10: "one message
// per class, never 'Something went wrong'": user error (fix and retry) ·
// offline ("saved locally, will sync") · auth expired (re-login, draft kept) ·
// server error ("not saved; your draft is preserved"). This module maps
// whatever Supabase/network throws onto one of those four classes.
export type ErrorClass = 'user' | 'offline' | 'auth-expired' | 'server';

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export function classifyError(error: unknown): ErrorClass {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'offline';
  }

  const message = messageOf(error).toLowerCase();

  if (
    message.includes('jwt expired') ||
    message.includes('invalid refresh token') ||
    message.includes('session missing') ||
    message.includes('not authenticated')
  ) {
    return 'auth-expired';
  }

  // Supabase Postgres errors we deliberately raise from RPCs (e.g. "invite
  // invalid, expired, or already used", "not permitted", "user already
  // belongs to a tenant") are always user-facing, correctable mistakes — a
  // Postgres error with no 5xx/network signal is a user error, not a server
  // error.
  if (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('failed to fetch')
  ) {
    return 'server';
  }

  return 'user';
}

const CLASS_MESSAGES: Record<ErrorClass, string> = {
  user: '',
  offline: "You're offline. Changes will sync once you're back online.",
  'auth-expired': 'Your session expired. Please sign in again.',
  server: "Something didn't save. Please try again in a moment.",
};

export function errorMessage(errorClass: ErrorClass, error: unknown): string {
  if (errorClass === 'user') return messageOf(error);
  return CLASS_MESSAGES[errorClass];
}
```

`packages/adapters/src/index.ts`:
```ts
export { getSupabaseClient } from './client';
export type { ErrorClass } from './errors';
export { classifyError, errorMessage } from './errors';
```

- [ ] **Step 2: Write the failing test**

`packages/adapters/src/errors.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { classifyError, errorMessage } from './errors';

describe('classifyError', () => {
  it('classifies a session error as auth-expired', () => {
    expect(classifyError(new Error('JWT expired'))).toBe('auth-expired');
  });

  it('classifies a fetch failure as server', () => {
    expect(classifyError(new Error('Failed to fetch'))).toBe('server');
  });

  it('classifies an RPC-raised business error as user', () => {
    expect(classifyError(new Error('invite invalid, expired, or already used'))).toBe('user');
  });

  it('classifies as offline when the browser reports offline, regardless of message', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(classifyError(new Error('anything'))).toBe('offline');
    vi.restoreAllMocks();
  });
});

describe('errorMessage', () => {
  it('passes the raw message through for user errors', () => {
    expect(errorMessage('user', new Error('not permitted'))).toBe('not permitted');
  });

  it('uses the fixed copy for the other three classes', () => {
    expect(errorMessage('offline', new Error('x'))).toMatch(/offline/i);
    expect(errorMessage('auth-expired', new Error('x'))).toMatch(/session expired/i);
    expect(errorMessage('server', new Error('x'))).toMatch(/try again/i);
  });
});
```

- [ ] **Step 3: Run to verify it fails, then it already passes once client.ts/errors.ts exist**

```bash
pnpm --filter @dsb-pro/adapters test
```
Expected: PASS, 6 tests (the implementation was written in Step 1 alongside the scaffold, since `client.ts` has no independent test — Step 2 is the first real red/green cycle in this package). If you prefer strict red-green, comment out `errors.ts`'s body before Step 2 and restore it here.

- [ ] **Step 4: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): package scaffold, Supabase client singleton, error classifier"
```

---

### Task 4: `packages/adapters` — `auth.ts` (AuthAdapter)

**Files:**
- Create: `packages/adapters/src/auth.ts`
- Create: `packages/adapters/src/auth.test.ts`
- Modify: `packages/adapters/src/index.ts`

**Interfaces:**
- Consumes: `getSupabaseClient()` (Task 3).
- Produces: `signUp(email: string, password: string): Promise<void>`; `signIn(email: string, password: string): Promise<void>`; `signOut(scope?: 'global' | 'local' | 'others'): Promise<void>`; `getSession(): Promise<Session | null>`; `onAuthStateChange(cb: (session: Session | null) => void): () => void`; `isEmailVerified(session: Session): boolean`; `resendVerificationEmail(email: string): Promise<void>`; `resetPasswordForEmail(email: string): Promise<void>`. `Session` is re-exported from `@supabase/supabase-js`'s type. Consumed by Task 6 (self-revoke's `signOut({scope:'others'})`) and every `apps/admin` screen from Task 8 onward.

- [ ] **Step 1: Write the failing test**

`packages/adapters/src/auth.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { __setSupabaseClientForTest } from './client';
import {
  signUp,
  signIn,
  signOut,
  getSession,
  isEmailVerified,
  resendVerificationEmail,
  resetPasswordForEmail,
} from './auth';

function makeMockClient(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      signUp: vi.fn().mockResolvedValue({ error: null }),
      signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      resend: vi.fn().mockResolvedValue({ error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
      ...overrides,
    },
  };
}

describe('auth adapter', () => {
  beforeEach(() => {
    __setSupabaseClientForTest(makeMockClient() as never);
  });

  it('signUp calls supabase.auth.signUp with email/password', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await signUp('a@example.com', 'shop2026');
    expect(client.auth.signUp).toHaveBeenCalledWith({ email: 'a@example.com', password: 'shop2026' });
  });

  it('signUp throws the underlying error on failure', async () => {
    const client = makeMockClient({
      signUp: vi.fn().mockResolvedValue({ error: new Error('already registered') }),
    });
    __setSupabaseClientForTest(client as never);
    await expect(signIn('a@example.com', 'x')).rejects.toThrow();
  });

  it('signIn calls supabase.auth.signInWithPassword', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await signIn('a@example.com', 'shop2026');
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@example.com',
      password: 'shop2026',
    });
  });

  it('signOut defaults to scope "global"', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await signOut();
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
  });

  it('signOut passes through an explicit scope', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await signOut('others');
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
  });

  it('getSession returns the session from supabase', async () => {
    const fakeSession = { user: { id: 'u1' } };
    const client = makeMockClient({
      getSession: vi.fn().mockResolvedValue({ data: { session: fakeSession }, error: null }),
    });
    __setSupabaseClientForTest(client as never);
    await expect(getSession()).resolves.toBe(fakeSession);
  });

  it('isEmailVerified reads email_confirmed_at off the session user', () => {
    expect(isEmailVerified({ user: { email_confirmed_at: '2026-01-01' } } as never)).toBe(true);
    expect(isEmailVerified({ user: { email_confirmed_at: null } } as never)).toBe(false);
  });

  it('resendVerificationEmail calls supabase.auth.resend with type "signup"', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await resendVerificationEmail('a@example.com');
    expect(client.auth.resend).toHaveBeenCalledWith({ type: 'signup', email: 'a@example.com' });
  });

  it('resetPasswordForEmail calls supabase.auth.resetPasswordForEmail', async () => {
    const client = makeMockClient();
    __setSupabaseClientForTest(client as never);
    await resetPasswordForEmail('a@example.com');
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith('a@example.com');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @dsb-pro/adapters test
```
Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 3: Write the implementation**

`packages/adapters/src/auth.ts`:
```ts
import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient } from './client';

export type { Session };

export async function signUp(email: string, password: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.signUp({ email, password });
  if (error) throw error;
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

// Default scope is 'global' (signs this device out, matching a normal logout
// button). Task 6 passes 'others' for the self-revoke-a-lost-device case:
// Supabase can't selectively invalidate one OTHER session, but 'others'
// invalidates every session for this account except the current one, which
// is the closest real enforcement available without new backend work.
export async function signOut(scope: 'global' | 'local' | 'others' = 'global'): Promise<void> {
  const { error } = await getSupabaseClient().auth.signOut({ scope });
  if (error) throw error;
}

export async function getSession(): Promise<Session | null> {
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthStateChange(cb: (session: Session | null) => void): () => void {
  const { data } = getSupabaseClient().auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

export function isEmailVerified(session: Session): boolean {
  return Boolean(session.user.email_confirmed_at);
}

export async function resendVerificationEmail(email: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.resend({ type: 'signup', email });
  if (error) throw error;
}

export async function resetPasswordForEmail(email: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email);
  if (error) throw error;
}
```

Update `packages/adapters/src/index.ts` to add:
```ts
export {
  signUp,
  signIn,
  signOut,
  getSession,
  onAuthStateChange,
  isEmailVerified,
  resendVerificationEmail,
  resetPasswordForEmail,
} from './auth';
export type { Session } from './auth';
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @dsb-pro/adapters test
```
Expected: PASS, all tests in the package (6 from Task 3 + 9 here = 15).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): AuthAdapter (signUp/signIn/signOut/session/verify/reset)"
```

---

### Task 5: `packages/adapters` — `tenancy.ts`

**Files:**
- Create: `packages/adapters/src/tenancy.ts`
- Create: `packages/adapters/src/tenancy.test.ts`
- Modify: `packages/adapters/src/index.ts`
- Modify: `packages/adapters/package.json` (add `@dsb-pro/core` dependency)

**Interfaces:**
- Consumes: `getSupabaseClient()` (Task 3); `makeTenantSlug`, `Role` (Task 2, `@dsb-pro/core`).
- Produces: `type Membership = { tenantId: string; role: Role; shopIds: string[] }`; `type Invite = { id: string; role: Role; shopIds: string[]; token: string; expiresAt: string; createdAt: string }`; `type TenantUser = { userId: string; role: Role; status: 'active' | 'disabled' }`; `createTenant(shopName: string): Promise<string>`; `getDefaultShopId(): Promise<string>`; `createInvite(role: Role): Promise<Invite>`; `revokeInvite(id: string): Promise<void>`; `acceptInvite(token: string): Promise<string>`; `setUserRole(userId: string, role: Role): Promise<void>`; `getCurrentMembership(): Promise<Membership | null>`; `listTenantUsers(): Promise<TenantUser[]>`; `listInvites(): Promise<Invite[]>`. Consumed by every `apps/admin` screen from Task 9 onward.

- [ ] **Step 1: Write the failing test**

`packages/adapters/src/tenancy.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { __setSupabaseClientForTest } from './client';
import {
  createTenant,
  getDefaultShopId,
  createInvite,
  revokeInvite,
  acceptInvite,
  setUserRole,
  getCurrentMembership,
  listTenantUsers,
  listInvites,
} from './tenancy';

function makeMockClient(rpcResults: Record<string, unknown> = {}, fromResults: Record<string, unknown> = {}) {
  return {
    rpc: vi.fn((fn: string) => Promise.resolve({ data: rpcResults[fn] ?? null, error: null })),
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: (fromResults[table] as unknown[])?.[0] ?? null, error: null }),
          then: (resolve: (r: unknown) => void) =>
            resolve({ data: fromResults[table] ?? [], error: null }),
        }),
      }),
    })),
  };
}

describe('tenancy adapter', () => {
  beforeEach(() => {
    __setSupabaseClientForTest(makeMockClient() as never);
  });

  it('createTenant calls create_tenant with a generated slug, matching shop name, and a client_id', async () => {
    const client = makeMockClient({ create_tenant: 'tenant-1' });
    __setSupabaseClientForTest(client as never);
    const id = await createTenant("Ramesh's Store");
    expect(id).toBe('tenant-1');
    const call = client.rpc.mock.calls[0];
    expect(call[0]).toBe('create_tenant');
    expect(call[1].p_name).toBe("Ramesh's Store");
    expect(call[1].p_shop_name).toBe("Ramesh's Store");
    expect(call[1].p_slug).toMatch(/^ramesh-s-store-[a-z0-9]{4}$/);
    expect(typeof call[1].p_client_id).toBe('string');
  });

  it('createInvite looks up the default shop then calls create_invite', async () => {
    const client = makeMockClient(
      { create_invite: [{ id: 'inv-1', token: 'tok', expires_at: '2026-09-13T00:00:00Z' }] },
      { shops: [{ id: 'shop-1' }] },
    );
    __setSupabaseClientForTest(client as never);
    const invite = await createInvite('cashier');
    expect(invite).toEqual({
      id: 'inv-1',
      role: 'cashier',
      shopIds: ['shop-1'],
      token: 'tok',
      expiresAt: '2026-09-13T00:00:00Z',
      createdAt: expect.any(String),
    });
  });

  it('revokeInvite calls revoke_invite with the id', async () => {
    const client = makeMockClient({ revoke_invite: null });
    __setSupabaseClientForTest(client as never);
    await revokeInvite('inv-1');
    expect(client.rpc).toHaveBeenCalledWith('revoke_invite', { p_id: 'inv-1' });
  });

  it('acceptInvite calls accept_invite with the token and a client_id', async () => {
    const client = makeMockClient({ accept_invite: 'tenant-2' });
    __setSupabaseClientForTest(client as never);
    const tenantId = await acceptInvite('abc123');
    expect(tenantId).toBe('tenant-2');
    const call = client.rpc.mock.calls[0];
    expect(call[1].p_token).toBe('abc123');
    expect(typeof call[1].p_client_id).toBe('string');
  });

  it('setUserRole calls set_user_role with user id and role', async () => {
    const client = makeMockClient({ set_user_role: null });
    __setSupabaseClientForTest(client as never);
    await setUserRole('user-1', 'manager');
    expect(client.rpc).toHaveBeenCalledWith('set_user_role', { p_user_id: 'user-1', p_role: 'manager' });
  });

  it('getCurrentMembership maps the RPC row to camelCase, or null if empty', async () => {
    const client = makeMockClient({
      current_membership: [{ tenant_id: 't1', role: 'owner', shop_ids: ['s1'] }],
    });
    __setSupabaseClientForTest(client as never);
    await expect(getCurrentMembership()).resolves.toEqual({ tenantId: 't1', role: 'owner', shopIds: ['s1'] });

    const emptyClient = makeMockClient({ current_membership: [] });
    __setSupabaseClientForTest(emptyClient as never);
    await expect(getCurrentMembership()).resolves.toBeNull();
  });

  it('listTenantUsers and listInvites map rows to camelCase', async () => {
    const client = makeMockClient(
      {},
      {
        tenant_users: [{ user_id: 'u1', role: 'cashier', status: 'active' }],
        invites: [{ id: 'i1', role: 'manager', shop_ids: ['s1'], token: 't', expires_at: 'e', created_at: 'c' }],
      },
    );
    __setSupabaseClientForTest(client as never);
    await expect(listTenantUsers()).resolves.toEqual([{ userId: 'u1', role: 'cashier', status: 'active' }]);
    await expect(listInvites()).resolves.toEqual([
      { id: 'i1', role: 'manager', shopIds: ['s1'], token: 't', expiresAt: 'e', createdAt: 'c' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @dsb-pro/adapters test
```
Expected: FAIL — `Cannot find module './tenancy'`.

- [ ] **Step 3: Add the `@dsb-pro/core` dependency**

`packages/adapters/package.json` — add to `dependencies`:
```json
    "@dsb-pro/core": "workspace:*",
```

- [ ] **Step 4: Write the implementation**

`packages/adapters/src/tenancy.ts`:
```ts
import { makeTenantSlug, type Role } from '@dsb-pro/core';
import { getSupabaseClient } from './client';

export type Membership = { tenantId: string; role: Role; shopIds: string[] };
export type Invite = {
  id: string;
  role: Role;
  shopIds: string[];
  token: string;
  expiresAt: string;
  createdAt: string;
};
export type TenantUser = { userId: string; role: Role; status: 'active' | 'disabled' };

function newClientId(): string {
  return crypto.randomUUID();
}

// create_tenant() (0007_tenant_lifecycle_rpcs.sql) needs three names —
// tenant name, slug, shop name — but the spec (§4) only ever asks the user
// for one: "shop name". Tenant name and shop name are set to the same value;
// the slug is derived + suffixed so it can never collide (packages/core's
// makeTenantSlug).
export async function createTenant(shopName: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('create_tenant', {
    p_name: shopName,
    p_slug: makeTenantSlug(shopName),
    p_shop_name: shopName,
    p_client_id: newClientId(),
  });
  if (error) throw error;
  return data as string;
}

// v1 UI has exactly one shop per tenant (DSB_PRO_BUILD_PLAN.md §11) — this
// looks up the shop create_tenant() marked is_default, so invite creation
// never needs a shop picker (spec §1).
export async function getDefaultShopId(): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .from('shops')
    .select('id')
    .eq('is_default', true)
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function createInvite(role: Role): Promise<Invite> {
  const shopId = await getDefaultShopId();
  const { data, error } = await getSupabaseClient().rpc('create_invite', {
    p_role: role,
    p_shop_ids: [shopId],
  });
  if (error) throw error;
  const row = (data as { id: string; token: string; expires_at: string }[])[0];
  return {
    id: row.id,
    role,
    shopIds: [shopId],
    token: row.token,
    expiresAt: row.expires_at,
    createdAt: new Date().toISOString(),
  };
}

export async function revokeInvite(id: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('revoke_invite', { p_id: id });
  if (error) throw error;
}

export async function acceptInvite(token: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('accept_invite', {
    p_token: token,
    p_client_id: newClientId(),
  });
  if (error) throw error;
  return data as string;
}

export async function setUserRole(userId: string, role: Role): Promise<void> {
  const { error } = await getSupabaseClient().rpc('set_user_role', { p_user_id: userId, p_role: role });
  if (error) throw error;
}

export async function getCurrentMembership(): Promise<Membership | null> {
  const { data, error } = await getSupabaseClient().rpc('current_membership');
  if (error) throw error;
  const rows = data as { tenant_id: string; role: Role; shop_ids: string[] }[];
  if (!rows.length) return null;
  return { tenantId: rows[0].tenant_id, role: rows[0].role, shopIds: rows[0].shop_ids };
}

export async function listTenantUsers(): Promise<TenantUser[]> {
  const { data, error } = await getSupabaseClient().from('tenant_users').select('user_id, role, status');
  if (error) throw error;
  return (data as { user_id: string; role: Role; status: 'active' | 'disabled' }[]).map((r) => ({
    userId: r.user_id,
    role: r.role,
    status: r.status,
  }));
}

// RLS (invites_select_own, 0007_tenant_lifecycle_rpcs.sql) already restricts
// this to callers with MANAGE_INVITES (owner only) — no client-side role
// check is needed to make this safe, only to decide whether to show the UI
// that calls it.
export async function listInvites(): Promise<Invite[]> {
  const { data, error } = await getSupabaseClient()
    .from('invites')
    .select('id, role, shop_ids, token, expires_at, created_at');
  if (error) throw error;
  return (data as { id: string; role: Role; shop_ids: string[]; token: string; expires_at: string; created_at: string }[]).map(
    (r) => ({
      id: r.id,
      role: r.role,
      shopIds: r.shop_ids,
      token: r.token,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }),
  );
}
```

Update `packages/adapters/src/index.ts` to add:
```ts
export type { Membership, Invite, TenantUser } from './tenancy';
export {
  createTenant,
  getDefaultShopId,
  createInvite,
  revokeInvite,
  acceptInvite,
  setUserRole,
  getCurrentMembership,
  listTenantUsers,
  listInvites,
} from './tenancy';
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm install && pnpm --filter @dsb-pro/adapters test
```
Expected: PASS, all tests (15 from Tasks 3–4 + 8 here = 23).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters pnpm-lock.yaml
git commit -m "feat(adapters): tenancy RPCs (create_tenant/invites/accept/set_user_role/membership)"
```

---

### Task 6: `packages/adapters` — `devices.ts`

**Files:**
- Create: `packages/adapters/src/devices.ts`
- Create: `packages/adapters/src/devices.test.ts`
- Modify: `packages/adapters/src/index.ts`

**Interfaces:**
- Consumes: `getSupabaseClient()` (Task 3); `signOut()` (Task 4).
- Produces: `type Device = { id: string; userId: string; deviceId: string; label: string | null; lastSeen: string; appVersion: string | null; revokedAt: string | null }`; `getOrCreateDeviceId(): string`; `guessDeviceLabel(userAgent: string): string`; `registerCurrentDevice(): Promise<string>`; `listDevices(filter: { onlyUserId?: string }): Promise<Device[]>`; `renameDevice(id: string, label: string): Promise<void>`; `revokeDevice(id: string, opts: { isSelf: boolean }): Promise<void>`. Consumed by `apps/admin`'s DevicesScreen (Task 12) and the session bootstrap (Task 7, which calls `registerCurrentDevice()` once per app load).

- [ ] **Step 1: Write the failing test**

`packages/adapters/src/devices.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { __setSupabaseClientForTest } from './client';
import * as authModule from './auth';
import {
  getOrCreateDeviceId,
  guessDeviceLabel,
  registerCurrentDevice,
  listDevices,
  renameDevice,
  revokeDevice,
} from './devices';

function makeMockClient(rpcResults: Record<string, unknown> = {}, deviceRows: unknown[] = []) {
  return {
    rpc: vi.fn((fn: string) => Promise.resolve({ data: rpcResults[fn] ?? null, error: null })),
    from: vi.fn(() => ({
      select: () => ({
        eq: () => Promise.resolve({ data: deviceRows, error: null }),
        then: (resolve: (r: unknown) => void) => resolve({ data: deviceRows, error: null }),
      }),
    })),
  };
}

describe('getOrCreateDeviceId', () => {
  beforeEach(() => localStorage.clear());

  it('creates a uuid on first call and persists it', () => {
    const id = getOrCreateDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getOrCreateDeviceId()).toBe(id);
  });
});

describe('guessDeviceLabel', () => {
  it('recognizes Chrome on Android', () => {
    expect(guessDeviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/128 Mobile Safari')).toBe('Chrome on Android');
  });

  it('falls back to a generic label for an unrecognized UA', () => {
    expect(guessDeviceLabel('SomeWeirdBot/1.0')).toBe('Unknown device');
  });
});

describe('registerCurrentDevice', () => {
  it('calls register_device then set_device_label with a guessed label', async () => {
    localStorage.clear();
    const client = makeMockClient({ register_device: 'device-row-1', set_device_label: null });
    __setSupabaseClientForTest(client as never);
    const id = await registerCurrentDevice();
    expect(id).toBe('device-row-1');
    expect(client.rpc).toHaveBeenCalledWith(
      'register_device',
      expect.objectContaining({ p_device_id: expect.any(String), p_app_version: expect.any(String) }),
    );
    expect(client.rpc).toHaveBeenCalledWith('set_device_label', { p_id: 'device-row-1', p_label: expect.any(String) });
  });
});

describe('listDevices', () => {
  it('maps rows to camelCase', async () => {
    const client = makeMockClient({}, [
      { id: 'd1', user_id: 'u1', device_id: 'dev-1', label: 'My Phone', last_seen: 'ls', app_version: '1.0', revoked_at: null },
    ]);
    __setSupabaseClientForTest(client as never);
    await expect(listDevices({})).resolves.toEqual([
      { id: 'd1', userId: 'u1', deviceId: 'dev-1', label: 'My Phone', lastSeen: 'ls', appVersion: '1.0', revokedAt: null },
    ]);
  });
});

describe('renameDevice', () => {
  it('calls set_device_label', async () => {
    const client = makeMockClient({ set_device_label: null });
    __setSupabaseClientForTest(client as never);
    await renameDevice('d1', 'Counter tablet');
    expect(client.rpc).toHaveBeenCalledWith('set_device_label', { p_id: 'd1', p_label: 'Counter tablet' });
  });
});

describe('revokeDevice', () => {
  it('calls revoke_device only, when revoking someone else\'s device', async () => {
    const client = makeMockClient({ revoke_device: null });
    __setSupabaseClientForTest(client as never);
    const signOutSpy = vi.spyOn(authModule, 'signOut').mockResolvedValue();
    await revokeDevice('d1', { isSelf: false });
    expect(client.rpc).toHaveBeenCalledWith('revoke_device', { p_id: 'd1' });
    expect(signOutSpy).not.toHaveBeenCalled();
    signOutSpy.mockRestore();
  });

  it('also signs out other sessions when revoking your own other device', async () => {
    const client = makeMockClient({ revoke_device: null });
    __setSupabaseClientForTest(client as never);
    const signOutSpy = vi.spyOn(authModule, 'signOut').mockResolvedValue();
    await revokeDevice('d1', { isSelf: true });
    expect(client.rpc).toHaveBeenCalledWith('revoke_device', { p_id: 'd1' });
    expect(signOutSpy).toHaveBeenCalledWith('others');
    signOutSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @dsb-pro/adapters test
```
Expected: FAIL — `Cannot find module './devices'`.

- [ ] **Step 3: Write the implementation**

`packages/adapters/src/devices.ts`:
```ts
import { getSupabaseClient } from './client';
import { signOut } from './auth';

export type Device = {
  id: string;
  userId: string;
  deviceId: string;
  label: string | null;
  lastSeen: string;
  appVersion: string | null;
  revokedAt: string | null;
};

const DEVICE_ID_KEY = 'dsb-pro-device-id';

// Stable per-browser identifier for register_device()'s (tenant_id, user_id,
// device_id) unique key — one row per browser, not per login.
export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

// Best-effort browser/OS guess so a device is never left unlabeled after
// registration (spec §5: "auto-name, editable later"). Deliberately simple —
// this is a display convenience, not a security-relevant fingerprint.
export function guessDeviceLabel(userAgent: string): string {
  const browser = /edg\//i.test(userAgent)
    ? 'Edge'
    : /chrome\//i.test(userAgent)
      ? 'Chrome'
      : /firefox\//i.test(userAgent)
        ? 'Firefox'
        : /safari\//i.test(userAgent)
          ? 'Safari'
          : null;
  const os = /android/i.test(userAgent)
    ? 'Android'
    : /iphone|ipad/i.test(userAgent)
      ? 'iOS'
      : /windows/i.test(userAgent)
        ? 'Windows'
        : /mac os/i.test(userAgent)
          ? 'macOS'
          : /linux/i.test(userAgent)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  return 'Unknown device';
}

export async function registerCurrentDevice(): Promise<string> {
  const deviceId = getOrCreateDeviceId();
  const appVersion = import.meta.env.VITE_APP_VERSION ?? 'dev';
  const { data, error } = await getSupabaseClient().rpc('register_device', {
    p_device_id: deviceId,
    p_app_version: appVersion,
  });
  if (error) throw error;
  const id = data as string;

  const { error: labelError } = await getSupabaseClient().rpc('set_device_label', {
    p_id: id,
    p_label: guessDeviceLabel(navigator.userAgent),
  });
  if (labelError) throw labelError;

  return id;
}

// RLS (devices_select_own, 0006_tenancy_rls.sql) lets any tenant member read
// every device row in their tenant — filter.onlyUserId is a UI-level choice
// (spec §5: cashier/accountant see only their own), not an RLS boundary.
export async function listDevices(filter: { onlyUserId?: string }): Promise<Device[]> {
  let query = getSupabaseClient()
    .from('devices')
    .select('id, user_id, device_id, label, last_seen, app_version, revoked_at');
  if (filter.onlyUserId) {
    query = query.eq('user_id', filter.onlyUserId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (
    data as {
      id: string;
      user_id: string;
      device_id: string;
      label: string | null;
      last_seen: string;
      app_version: string | null;
      revoked_at: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    userId: r.user_id,
    deviceId: r.device_id,
    label: r.label,
    lastSeen: r.last_seen,
    appVersion: r.app_version,
    revokedAt: r.revoked_at,
  }));
}

export async function renameDevice(id: string, label: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('set_device_label', { p_id: id, p_label: label });
  if (error) throw error;
}

// Revoking someone ELSE's device has zero enforcement today (docs/HANDOVER.md:
// "nothing yet checks it against incoming requests") — revoke_device() only
// marks the row. Revoking your OWN other device additionally calls
// signOut('others'), which Supabase Auth actually enforces immediately
// (invalidates every session for this account except the current one) — the
// closest real protection available without new backend work (Phase 5 is
// where per-device enforcement lands for real).
export async function revokeDevice(id: string, opts: { isSelf: boolean }): Promise<void> {
  const { error } = await getSupabaseClient().rpc('revoke_device', { p_id: id });
  if (error) throw error;
  if (opts.isSelf) {
    await signOut('others');
  }
}
```

Update `packages/adapters/src/index.ts` to add:
```ts
export type { Device } from './devices';
export {
  getOrCreateDeviceId,
  guessDeviceLabel,
  registerCurrentDevice,
  listDevices,
  renameDevice,
  revokeDevice,
} from './devices';
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @dsb-pro/adapters test
```
Expected: PASS, all tests (23 from Tasks 3–5 + 9 here = 32).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): device registration, listing, rename, revoke"
```

---

### Task 7: `apps/admin` — routing shell + `useSession` + AuthGate

**Files:**
- Modify: `apps/admin/package.json` (add `@dsb-pro/adapters`, `@dsb-pro/core`, `preact-router` dependencies)
- Create: `apps/admin/src/lib/useSession.ts`
- Create: `apps/admin/src/App.tsx`
- Modify: `apps/admin/src/main.tsx`
- Modify: `apps/admin/.env.example` (add `VITE_APP_VERSION=`)

**Interfaces:**
- Consumes: `getSession`, `onAuthStateChange`, `registerCurrentDevice`, `getCurrentMembership` (Tasks 4–6).
- Produces: `type SessionState = { status: 'loading' } | { status: 'signed-out' } | { status: 'no-tenant'; session: Session } | { status: 'active'; session: Session; membership: Membership }`; `useSession(): SessionState`. Consumed by every screen from Task 8 onward — this is the hook that decides which screen renders.

- [ ] **Step 1: Add dependencies**

`apps/admin/package.json` — add to `dependencies`:
```json
    "@dsb-pro/adapters": "workspace:*",
    "@dsb-pro/core": "workspace:*",
    "preact-router": "^4.1.2",
```

Run:
```bash
pnpm install
```

- [ ] **Step 2: Write `useSession`**

`apps/admin/src/lib/useSession.ts`:
```ts
import { useEffect, useState } from 'preact/hooks';
import {
  getSession,
  onAuthStateChange,
  getCurrentMembership,
  registerCurrentDevice,
  type Session,
  type Membership,
} from '@dsb-pro/adapters';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'no-tenant'; session: Session }
  | { status: 'active'; session: Session; membership: Membership };

// The one place apps/admin decides which of the four top-level screens to
// show (spec §2's routing table). Registers this device once per new
// session (not on every render) — register_device() is idempotent
// (on conflict do update) so a duplicate call is harmless, but there's no
// reason to call it more than once per sign-in.
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let registeredForUserId: string | null = null;

    async function resolve(session: Session | null) {
      if (!session) {
        if (!cancelled) setState({ status: 'signed-out' });
        return;
      }
      if (registeredForUserId !== session.user.id) {
        registeredForUserId = session.user.id;
        await registerCurrentDevice().catch(() => {
          // Device registration failing must never block sign-in — it's a
          // convenience list for the owner, not an access gate.
        });
      }
      const membership = await getCurrentMembership();
      if (cancelled) return;
      setState(
        membership
          ? { status: 'active', session, membership }
          : { status: 'no-tenant', session },
      );
    }

    getSession().then(resolve);
    const unsubscribe = onAuthStateChange((session) => {
      resolve(session);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}
```

- [ ] **Step 3: Write `App.tsx`**

`apps/admin/src/App.tsx`:
```tsx
import { Router, Route } from 'preact-router';
import { useSession } from './lib/useSession';
import { HealthPanel } from './HealthPanel';

export function App() {
  const session = useSession();

  return (
    <Router>
      <Route path="/*" component={() => <Home session={session} />} />
    </Router>
  );
}

// Screens land in Tasks 8-12: LoginScreen/SignupScreen (signed-out),
// NoTenantScreen (no-tenant), the real app shell (active). This placeholder
// keeps Phase 0's HealthPanel reachable so the plan's earlier tasks stay
// green before those screens exist.
function Home({ session }: { session: ReturnType<typeof useSession> }) {
  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }
  if (session.status === 'signed-out') {
    return <p>Signed out. Login/Signup screens land in Task 8.</p>;
  }
  if (session.status === 'no-tenant') {
    return <p>Signed in, no tenant yet. NoTenantScreen lands in Task 9.</p>;
  }
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Signed in as tenant {session.membership.tenantId}, role {session.membership.role}.</p>
      <HealthPanel />
    </main>
  );
}
```

- [ ] **Step 4: Wire `main.tsx`**

`apps/admin/src/main.tsx`:
```tsx
import { render } from 'preact';
import * as Sentry from '@sentry/browser';
import { App } from './App';
import './style.css';

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn });
}

render(<App />, document.getElementById('app')!);
```

- [ ] **Step 5: Add the new env var placeholder**

`apps/admin/.env.example` — add one line:
```
VITE_APP_VERSION=
```

- [ ] **Step 6: Verify the build still passes**

```bash
pnpm --filter @dsb-pro/admin run build
```
Expected: builds cleanly (`tsc -b && vite build`), no type errors. This task has no automated test of its own — `useSession`'s real behavior is exercised end-to-end by Task 8's first Playwright spec, once a real Login screen exists to observe the `signed-out` state through.

- [ ] **Step 7: Commit**

```bash
git add apps/admin pnpm-lock.yaml
git commit -m "feat(admin): routing shell, useSession hook, session-state placeholder screens"
```

---

### Task 8: `apps/admin` — Login/Signup screens, Playwright bootstrap, CI `e2e` job

**Files:**
- Create: `apps/admin/src/screens/LoginScreen.tsx`
- Create: `apps/admin/src/screens/SignupScreen.tsx`
- Modify: `apps/admin/src/App.tsx`
- Modify: `apps/admin/package.json` (add `@playwright/test` devDependency, `e2e` script)
- Create: `apps/admin/playwright.config.ts`
- Create: `apps/admin/e2e/auth.spec.ts`
- Modify: `.github/workflows/ci.yml` (add `e2e` job)

**Interfaces:**
- Consumes: `signUp`, `signIn`, `classifyError`, `errorMessage` (Tasks 3–4); `passwordStrength` (Task 2); `useSession` (Task 7).
- Produces: routes `/` (login) and `/signup`, both reachable from `Home` when `session.status === 'signed-out'`.

- [ ] **Step 1: Add Playwright**

`apps/admin/package.json` — add to `devDependencies`:
```json
    "@playwright/test": "^1.48.0",
```
and to `scripts`:
```json
    "e2e": "playwright test",
```

Run:
```bash
pnpm install
pnpm --filter @dsb-pro/admin exec playwright install --with-deps chromium
```

- [ ] **Step 2: Write the failing Playwright spec**

`apps/admin/e2e/auth.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('signup then login with the same credentials', async ({ page }) => {
  const email = uniqueEmail();
  const password = 'shop2026pw';

  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();

  // Local supabase config has enable_confirmations = false, so this lands
  // straight on the no-tenant placeholder (real NoTenantScreen is Task 9).
  await expect(page.getByText(/no tenant yet/i)).toBeVisible();

  await page.reload();
  // Reloading keeps the same Supabase session (signed in) — still no-tenant.
  await expect(page.getByText(/no tenant yet/i)).toBeVisible();
});

test('shows a user-facing error for wrong credentials', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('nobody@example.com');
  await page.getByLabel('Password').fill('wrongpassword');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid/i);
});

test('signup rejects a weak password before calling the server', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('alert')).toContainText(/8 characters/);
});
```

`apps/admin/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'pnpm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm --filter @dsb-pro/admin run build
pnpm --filter @dsb-pro/admin run e2e
```
Expected: FAIL — no `/signup` route, no Login/Signup form exists yet.

- [ ] **Step 4: Write `LoginScreen.tsx` and `SignupScreen.tsx`**

`apps/admin/src/screens/LoginScreen.tsx`:
```tsx
import { useState } from 'preact/hooks';
import { route } from 'preact-router';
import { signIn } from '@dsb-pro/adapters';
import { classifyError, errorMessage } from '@dsb-pro/adapters';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email, password);
      // useSession's onAuthStateChange listener picks up the new session and
      // re-renders Home — no manual navigation needed here.
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Log in</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Log in
        </button>
      </form>
      <p>
        No account? <a href="/signup">Sign up</a>
      </p>
    </main>
  );
}
```

`apps/admin/src/screens/SignupScreen.tsx`:
```tsx
import { useState } from 'preact/hooks';
import { signUp } from '@dsb-pro/adapters';
import { classifyError, errorMessage } from '@dsb-pro/adapters';
import { passwordStrength } from '@dsb-pro/core';

export function SignupScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);

    const strength = passwordStrength(password);
    if (!strength.valid) {
      setError(strength.message);
      return;
    }

    setBusy(true);
    try {
      await signUp(email, password);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Sign up</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Sign up
        </button>
      </form>
      <p>
        Already have an account? <a href="/">Log in</a>
      </p>
    </main>
  );
}
```

- [ ] **Step 5: Wire the routes into `App.tsx`**

Replace `App.tsx`'s `Home` signed-out branch and add the `/signup` route:

```tsx
import { Router, Route } from 'preact-router';
import { useSession } from './lib/useSession';
import { HealthPanel } from './HealthPanel';
import { LoginScreen } from './screens/LoginScreen';
import { SignupScreen } from './screens/SignupScreen';

export function App() {
  const session = useSession();

  return (
    <Router>
      <Route path="/signup" component={SignupScreen} />
      <Route path="/*" component={() => <Home session={session} />} />
    </Router>
  );
}

function Home({ session }: { session: ReturnType<typeof useSession> }) {
  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }
  if (session.status === 'signed-out') {
    return <LoginScreen />;
  }
  if (session.status === 'no-tenant') {
    return <p>Signed in, no tenant yet. NoTenantScreen lands in Task 9.</p>;
  }
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Signed in as tenant {session.membership.tenantId}, role {session.membership.role}.</p>
      <HealthPanel />
    </main>
  );
}
```

- [ ] **Step 6: Run against the hosted dev project to verify locally**

This machine has no Docker/WSL2 (same constraint the Phase 1 backend plan hit), so local Playwright runs point at the `dsb-pro-dev` hosted project, matching how Phase 1's `psql` verification did:

```bash
# apps/admin/.env has VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY set to dsb-pro-dev
pnpm --filter @dsb-pro/admin run build
pnpm --filter @dsb-pro/admin run e2e
```
Expected: PASS, 3 tests. (CI's `e2e` job, added in Step 7, is the authoritative run against a disposable local Supabase instance — this step is real signal but creates real throwaway users in `dsb-pro-dev`, acceptable since Phase 6 is when a real-data cleanup policy starts to matter.)

- [ ] **Step 7: Add the CI `e2e` job**

Add to `.github/workflows/ci.yml`, as a new job alongside `pgtap`, and add it to `build`'s `needs`:

```yaml
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - run: supabase start
      - name: Export local Supabase URL/anon key
        run: |
          API_URL=$(supabase status -o env | grep '^API_URL=' | cut -d= -f2- | tr -d '"')
          ANON_KEY=$(supabase status -o env | grep '^ANON_KEY=' | cut -d= -f2- | tr -d '"')
          echo "VITE_SUPABASE_URL=$API_URL" >> "$GITHUB_ENV"
          echo "VITE_SUPABASE_ANON_KEY=$ANON_KEY" >> "$GITHUB_ENV"
      - run: supabase db reset
      - run: pnpm --filter @dsb-pro/admin run build
      - run: pnpm --filter @dsb-pro/admin exec playwright install --with-deps chromium
      - run: pnpm --filter @dsb-pro/admin run e2e
```

And change `build`'s `needs` line from:
```yaml
    needs: [lint, typecheck, test, pgtap]
```
to:
```yaml
    needs: [lint, typecheck, test, pgtap, e2e]
```

- [ ] **Step 8: Commit**

```bash
git add apps/admin .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "feat(admin): Login/Signup screens, Playwright bootstrap, CI e2e job"
```

---

### Task 9: `apps/admin` — No-tenant landing + join-invite deep link

**Files:**
- Create: `apps/admin/src/screens/NoTenantScreen.tsx`
- Create: `apps/admin/src/screens/JoinInviteScreen.tsx`
- Modify: `apps/admin/src/App.tsx`
- Create: `apps/admin/e2e/invite-join.spec.ts`

**Interfaces:**
- Consumes: `createTenant`, `acceptInvite` (Task 5); `classifyError`, `errorMessage` (Task 3); `useSession` (Task 7).
- Produces: route `/join/:token?`; the `no-tenant` branch of `Home`.

- [ ] **Step 1: Write the failing Playwright spec**

`apps/admin/e2e/invite-join.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('create your shop takes an owner straight into the app', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();

  await page.getByLabel('Shop name').fill('Ramesh Store');
  await page.getByRole('button', { name: 'Create your shop' }).click();

  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();
  await expect(page.getByText(/role owner/i)).toBeVisible();
});

test('visiting a join link while signed out routes through signup first, then joins', async ({ page, request, context }) => {
  // Seed a real invite by creating an owner account + tenant + invite via the UI first.
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Invite Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();
  await expect(page.getByText(/DSB Pro — Admin/)).toBeVisible();

  // Team screen (Task 11) will make this a UI click; until then, this spec
  // only proves the /join/:token route itself for an already-known invalid
  // token, which doesn't require a real invite yet.
  await context.clearCookies();
  await page.goto('/join/not-a-real-token');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|expired|already used/i);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @dsb-pro/admin run build && pnpm --filter @dsb-pro/admin run e2e
```
Expected: FAIL — no "Shop name" field, no `/join/:token` route exists yet.

- [ ] **Step 3: Write `NoTenantScreen.tsx`**

`apps/admin/src/screens/NoTenantScreen.tsx`:
```tsx
import { useState } from 'preact/hooks';
import { createTenant, acceptInvite, classifyError, errorMessage } from '@dsb-pro/adapters';

export function NoTenantScreen() {
  return (
    <main>
      <h1>Welcome</h1>
      <CreateShopCard />
      <JoinCodeCard />
    </main>
  );
}

function CreateShopCard() {
  const [shopName, setShopName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await createTenant(shopName);
      // useSession's next getCurrentMembership() poll (triggered by its own
      // auth-state listener firing again is NOT automatic here since no new
      // sign-in event occurs — see Task 7's follow-up note below) picks this
      // up. Simplest fix: reload, which re-runs useSession's initial resolve.
      window.location.reload();
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Create your shop">
      <h2>Create your shop</h2>
      <form onSubmit={onSubmit}>
        <label>
          Shop name
          <input
            value={shopName}
            onInput={(e) => setShopName((e.target as HTMLInputElement).value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Create your shop
        </button>
      </form>
    </section>
  );
}

function JoinCodeCard() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await acceptInvite(code.trim());
      window.location.reload();
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Have an invite code?">
      <h2>Have an invite code?</h2>
      <form onSubmit={onSubmit}>
        <label>
          Invite code
          <input
            value={code}
            onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Join
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 4: Write `JoinInviteScreen.tsx`**

`apps/admin/src/screens/JoinInviteScreen.tsx`:
```tsx
import { useState } from 'preact/hooks';
import { acceptInvite, classifyError, errorMessage } from '@dsb-pro/adapters';
import { useSession } from '../lib/useSession';
import { LoginScreen } from './LoginScreen';
import { SignupScreen } from './SignupScreen';

// Deep-link target for a shared invite (spec §5's "dsbpro.in/join/<token>").
// While signed out, shows Signup (default) so a brand-new hire can create an
// account and land right back here; once signed in, auto-submits
// accept_invite(token) exactly once.
export function JoinInviteScreen({ token }: { token?: string }) {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }

  if (session.status === 'signed-out') {
    return (
      <div>
        <p>Sign up or log in to accept this invite.</p>
        <SignupScreen />
        <LoginScreen />
      </div>
    );
  }

  if (!attempted && token) {
    setAttempted(true);
    acceptInvite(token)
      .then(() => window.location.reload())
      .catch((err) => setError(errorMessage(classifyError(err), err)));
  }

  if (error) {
    return <p role="alert">{error}</p>;
  }

  return <p>Joining…</p>;
}
```

- [ ] **Step 5: Wire the route and the `no-tenant` branch into `App.tsx`**

```tsx
import { Router, Route } from 'preact-router';
import { useSession } from './lib/useSession';
import { HealthPanel } from './HealthPanel';
import { LoginScreen } from './screens/LoginScreen';
import { SignupScreen } from './screens/SignupScreen';
import { NoTenantScreen } from './screens/NoTenantScreen';
import { JoinInviteScreen } from './screens/JoinInviteScreen';

export function App() {
  const session = useSession();

  return (
    <Router>
      <Route path="/signup" component={SignupScreen} />
      <Route path="/join/:token?" component={JoinInviteScreen} />
      <Route path="/*" component={() => <Home session={session} />} />
    </Router>
  );
}

function Home({ session }: { session: ReturnType<typeof useSession> }) {
  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }
  if (session.status === 'signed-out') {
    return <LoginScreen />;
  }
  if (session.status === 'no-tenant') {
    return <NoTenantScreen />;
  }
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Signed in as tenant {session.membership.tenantId}, role {session.membership.role}.</p>
      <HealthPanel />
    </main>
  );
}
```

- [ ] **Step 6: Run to verify it passes**

```bash
pnpm --filter @dsb-pro/admin run build && pnpm --filter @dsb-pro/admin run e2e
```
Expected: PASS, all specs (3 from Task 8 + 2 here = 5).

- [ ] **Step 7: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): no-tenant landing (create shop / join code), join-invite deep link"
```

---

### Task 10: `apps/admin` — Verification banner

**Files:**
- Create: `apps/admin/src/components/VerificationBanner.tsx`
- Modify: `apps/admin/src/App.tsx`
- Create: `apps/admin/e2e/verification-banner.spec.ts`

**Interfaces:**
- Consumes: `isEmailVerified`, `resendVerificationEmail`, `classifyError`, `errorMessage` (Task 4); the `active` and `no-tenant` branches' `session.session` (Task 7).
- Produces: `<VerificationBanner session={Session} />`, rendered above both the no-tenant and active screens whenever the email is unverified.

- [ ] **Step 1: Write the failing Playwright spec**

`apps/admin/e2e/verification-banner.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('unverified email shows a dismissible reminder banner, not a block', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();

  const banner = page.getByRole('status', { name: 'Email verification reminder' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/verify your email/i);

  // Not blocking: the create-shop form underneath is still usable.
  await expect(page.getByLabel('Shop name')).toBeEnabled();

  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @dsb-pro/admin run build && pnpm --filter @dsb-pro/admin run e2e
```
Expected: FAIL — no banner exists yet.

- [ ] **Step 3: Write `VerificationBanner.tsx`**

`apps/admin/src/components/VerificationBanner.tsx`:
```tsx
import { useState } from 'preact/hooks';
import type { Session } from '@dsb-pro/adapters';
import { isEmailVerified, resendVerificationEmail, classifyError, errorMessage } from '@dsb-pro/adapters';

// Soft gate only (spec §7): shown app-wide, dismissible per browser tab,
// never blocks anything except the two actions that check
// isEmailVerified() directly (invite creation, Task 11; export, once export
// ships in a later phase).
export function VerificationBanner({ session }: { session: Session }) {
  const [dismissed, setDismissed] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (dismissed || isEmailVerified(session)) {
    return null;
  }

  async function resend() {
    setError(null);
    try {
      await resendVerificationEmail(session.user.email!);
      setSent(true);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  return (
    <div role="status" aria-label="Email verification reminder">
      <p>
        Please verify your email ({session.user.email}).{' '}
        {sent ? 'Verification email sent.' : <button onClick={resend}>Resend email</button>}
      </p>
      {error && <p role="alert">{error}</p>}
      <button aria-label="Dismiss" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Render it above the no-tenant and active screens in `App.tsx`**

```tsx
function Home({ session }: { session: ReturnType<typeof useSession> }) {
  if (session.status === 'loading') {
    return <p>Loading…</p>;
  }
  if (session.status === 'signed-out') {
    return <LoginScreen />;
  }
  if (session.status === 'no-tenant') {
    return (
      <>
        <VerificationBanner session={session.session} />
        <NoTenantScreen />
      </>
    );
  }
  return (
    <>
      <VerificationBanner session={session.session} />
      <main>
        <h1>DSB Pro — Admin</h1>
        <p>Signed in as tenant {session.membership.tenantId}, role {session.membership.role}.</p>
        <HealthPanel />
      </main>
    </>
  );
}
```
Add the import: `import { VerificationBanner } from './components/VerificationBanner';`.

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter @dsb-pro/admin run build && pnpm --filter @dsb-pro/admin run e2e
```
Expected: PASS, all specs (5 from Tasks 8–9 + 1 here = 6).

- [ ] **Step 6: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): email verification reminder banner (soft gate)"
```

---

### Task 11: `apps/admin` — Team screen

**Files:**
- Create: `apps/admin/src/screens/TeamScreen.tsx`
- Modify: `apps/admin/src/App.tsx` (add `/team` route + a link to it from the active shell)
- Create: `apps/admin/e2e/team.spec.ts`

**Interfaces:**
- Consumes: `createInvite`, `revokeInvite`, `listInvites`, `listTenantUsers`, `setUserRole` (Task 5); `isEmailVerified` (Task 4); `hasPerm` (Task 2); `useSession` (Task 7).
- Produces: route `/team`, gated to `hasPerm(role, 'MANAGE_INVITES')` for the invite half and rendered (read-only member list) for anyone who can reach it.

- [ ] **Step 1: Write the failing Playwright spec**

`apps/admin/e2e/team.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('owner creates an invite, shares the link, and accepting it joins the right role', async ({ page, context }) => {
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Team Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();

  await page.goto('/team');
  await page.getByLabel('Role').selectOption('cashier');
  await page.getByRole('button', { name: 'Create invite' }).click();

  const link = await page.getByTestId('invite-link').textContent();
  expect(link).toMatch(/\/join\//);

  // Accept it in a fresh, signed-out browser context.
  const joinPage = await context.browser()!.newContext().then((c) => c.newPage());
  await joinPage.goto(new URL(link!).pathname);
  await joinPage.getByLabel('Email').fill(uniqueEmail());
  await joinPage.getByLabel('Password').fill('shop2026pw');
  await joinPage.getByRole('button', { name: 'Sign up' }).click();
  await expect(joinPage.getByText(/role cashier/i)).toBeVisible();

  // Back on the owner's page, the invite has moved from pending to accepted.
  await page.reload();
  await expect(page.getByTestId('pending-invites')).not.toContainText(link!.split('/').pop()!);
  await expect(page.getByTestId('members-list')).toContainText(/cashier/i);
});

test('owner revokes a pending invite', async ({ page }) => {
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Revoke Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();

  await page.goto('/team');
  await page.getByLabel('Role').selectOption('manager');
  await page.getByRole('button', { name: 'Create invite' }).click();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('pending-invites')).toContainText(/no pending invites/i);
});

test('owner changes a member\'s role, with the latency caveat shown', async ({ page, context }) => {
  const ownerEmail = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Role Change Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();

  await page.goto('/team');
  await page.getByLabel('Role').selectOption('cashier');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const link = await page.getByTestId('invite-link').textContent();

  const joinPage = await context.browser()!.newContext().then((c) => c.newPage());
  await joinPage.goto(new URL(link!).pathname);
  await joinPage.getByLabel('Email').fill(uniqueEmail());
  await joinPage.getByLabel('Password').fill('shop2026pw');
  await joinPage.getByRole('button', { name: 'Sign up' }).click();

  await page.reload();
  await page.goto('/team');
  await page.getByTestId('members-list').getByRole('combobox').selectOption('manager');
  await expect(page.getByText(/takes effect.*next.*sign|up to.*hour/i)).toBeVisible();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @dsb-pro/admin run build && pnpm --filter @dsb-pro/admin run e2e
```
Expected: FAIL — no `/team` route exists yet.

- [ ] **Step 3: Write `TeamScreen.tsx`**

`apps/admin/src/screens/TeamScreen.tsx`:
```tsx
import { useEffect, useState } from 'preact/hooks';
import {
  createInvite,
  revokeInvite,
  listInvites,
  listTenantUsers,
  setUserRole,
  classifyError,
  errorMessage,
  type Invite,
  type TenantUser,
} from '@dsb-pro/adapters';
import { hasPerm, type Role } from '@dsb-pro/core';
import { useSession } from '../lib/useSession';

const ROLES: Role[] = ['manager', 'cashier', 'accountant'];

export function TeamScreen() {
  const session = useSession();

  if (session.status !== 'active') {
    return <p>Sign in to view your team.</p>;
  }

  const canManageInvites = hasPerm(session.membership.role, 'MANAGE_INVITES');
  const canManageMembers = hasPerm(session.membership.role, 'MANAGE_TENANT_USERS');

  return (
    <main>
      <h1>Team</h1>
      {canManageInvites && <InviteForm />}
      {canManageInvites && <PendingInvites />}
      <MembersList canManageMembers={canManageMembers} />
    </main>
  );
}

function InviteForm() {
  const [role, setRole] = useState<Role>('cashier');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    try {
      const invite = await createInvite(role);
      setLink(`${window.location.origin}/join/${invite.token}`);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  return (
    <section aria-label="Invite a team member">
      <h2>Invite</h2>
      <form onSubmit={onSubmit}>
        <label>
          Role
          <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Create invite</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {link && (
        <p>
          Share this link: <span data-testid="invite-link">{link}</span>{' '}
          <a href={`https://wa.me/?text=${encodeURIComponent(link)}`} target="_blank" rel="noreferrer">
            Share on WhatsApp
          </a>
        </p>
      )}
    </section>
  );
}

function PendingInvites() {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listInvites().then(setInvites).catch((err) => setError(errorMessage(classifyError(err), err)));
  }, []);

  async function onRevoke(id: string) {
    await revokeInvite(id);
    setInvites((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
  }

  const pending = invites?.filter((i) => new Date(i.expiresAt) > new Date()) ?? [];

  return (
    <section aria-label="Pending invites">
      <h2>Pending invites</h2>
      {error && <p role="alert">{error}</p>}
      <ul data-testid="pending-invites">
        {pending.length === 0 && <li>No pending invites.</li>}
        {pending.map((invite) => (
          <li key={invite.id}>
            {invite.role} — expires {new Date(invite.expiresAt).toLocaleDateString()}{' '}
            <button onClick={() => onRevoke(invite.id)}>Revoke</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MembersList({ canManageMembers }: { canManageMembers: boolean }) {
  const [members, setMembers] = useState<TenantUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caveat, setCaveat] = useState(false);

  useEffect(() => {
    listTenantUsers().then(setMembers).catch((err) => setError(errorMessage(classifyError(err), err)));
  }, []);

  async function onRoleChange(userId: string, role: Role) {
    setError(null);
    try {
      await setUserRole(userId, role);
      setMembers((prev) => (prev ? prev.map((m) => (m.userId === userId ? { ...m, role } : m)) : prev));
      setCaveat(true);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  return (
    <section aria-label="Team members" data-testid="members-list">
      <h2>Members</h2>
      {error && <p role="alert">{error}</p>}
      {caveat && (
        <p>A role change takes effect on that person's next sign-in — or up to about an hour if they're already signed in.</p>
      )}
      <ul>
        {members?.map((member) => (
          <li key={member.userId}>
            {member.userId} — {member.status}
            {canManageMembers && member.role !== 'owner' ? (
              <select
                value={member.role}
                onChange={(e) => onRoleChange(member.userId, (e.target as HTMLSelectElement).value as Role)}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <span> ({member.role})</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Add the `/team` route and a link to it from the active shell, in `App.tsx`**

```tsx
import { TeamScreen } from './screens/TeamScreen';
// ...
      <Route path="/team" component={TeamScreen} />
// ... and inside the active branch's <main>, add:
        <p><a href="/team">Team</a> · <a href="/devices">Devices</a></p>
```
(the `/devices` link is inert until Task 12 adds that route — clicking it 404s harmlessly under `preact-router`'s default not-found passthrough until then).

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter @dsb-pro/admin run build && pnpm --filter @dsb-pro/admin run e2e
```
Expected: PASS, all specs (6 from Tasks 8–10 + 3 here = 9).

- [ ] **Step 6: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): Team screen (invite create/share/revoke, member role change)"
```

---

### Task 12: `apps/admin` — Devices screen

**Files:**
- Create: `apps/admin/src/screens/DevicesScreen.tsx`
- Modify: `apps/admin/src/App.tsx` (add `/devices` route)
- Create: `apps/admin/e2e/devices.spec.ts`

**Interfaces:**
- Consumes: `listDevices`, `renameDevice`, `revokeDevice` (Task 6); `hasPerm` (Task 2); `useSession` (Task 7).
- Produces: route `/devices`.

- [ ] **Step 1: Write the failing Playwright spec**

`apps/admin/e2e/devices.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

test('an owner sees their own device, auto-labeled, and can rename it', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Devices Test Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();

  await page.goto('/devices');
  await expect(page.getByTestId('my-devices')).toContainText(/chrome/i);

  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('New name').fill('My laptop');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('my-devices')).toContainText('My laptop');
});

test('revoking someone else\'s device is honest about not enforcing anything yet', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('shop2026pw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Shop name').fill('Owner Devices Shop');
  await page.getByRole('button', { name: 'Create your shop' }).click();

  await page.goto('/devices');
  await expect(page.getByText(/does not yet block/i)).toBeVisible();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @dsb-pro/admin run build && pnpm --filter @dsb-pro/admin run e2e
```
Expected: FAIL — no `/devices` route exists yet.

- [ ] **Step 3: Write `DevicesScreen.tsx`**

`apps/admin/src/screens/DevicesScreen.tsx`:
```tsx
import { useEffect, useState } from 'preact/hooks';
import {
  listDevices,
  renameDevice,
  revokeDevice,
  getOrCreateDeviceId,
  classifyError,
  errorMessage,
  type Device,
} from '@dsb-pro/adapters';
import { hasPerm } from '@dsb-pro/core';
import { useSession } from '../lib/useSession';

export function DevicesScreen() {
  const session = useSession();

  if (session.status !== 'active') {
    return <p>Sign in to view devices.</p>;
  }

  const canManageOthers = hasPerm(session.membership.role, 'MANAGE_DEVICES');

  return (
    <main>
      <h1>Devices</h1>
      <MyDevices userId={session.session.user.id} />
      {canManageOthers && <AllDevices selfUserId={session.session.user.id} />}
    </main>
  );
}

function DeviceRow({
  device,
  isSelf,
  isCurrentBrowser,
  onRenamed,
  onRevoked,
}: {
  device: Device;
  isSelf: boolean;
  isCurrentBrowser: boolean;
  onRenamed: (id: string, label: string) => void;
  onRevoked: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [newLabel, setNewLabel] = useState(device.label ?? '');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    try {
      await renameDevice(device.id, newLabel);
      onRenamed(device.id, newLabel);
      setRenaming(false);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  async function revoke() {
    try {
      await revokeDevice(device.id, { isSelf });
      onRevoked(device.id);
    } catch (err) {
      setError(errorMessage(classifyError(err), err));
    }
  }

  return (
    <li>
      {device.label ?? 'Unlabeled device'}
      {isCurrentBrowser && ' (this device)'} — last seen {new Date(device.lastSeen).toLocaleString()}
      {renaming ? (
        <>
          <label>
            New name
            <input value={newLabel} onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)} />
          </label>
          <button onClick={save}>Save</button>
        </>
      ) : (
        <button onClick={() => setRenaming(true)}>Rename</button>
      )}
      {device.revokedAt ? (
        <span> (revoked)</span>
      ) : (
        <button onClick={revoke}>Revoke</button>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

function MyDevices({ userId }: { userId: string }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const currentDeviceId = getOrCreateDeviceId();

  useEffect(() => {
    listDevices({ onlyUserId: userId }).then(setDevices);
  }, [userId]);

  function onRenamed(id: string, label: string) {
    setDevices((prev) => (prev ? prev.map((d) => (d.id === id ? { ...d, label } : d)) : prev));
  }
  function onRevoked(id: string) {
    setDevices((prev) => (prev ? prev.map((d) => (d.id === id ? { ...d, revokedAt: new Date().toISOString() } : d)) : prev));
  }

  return (
    <section aria-label="My devices" data-testid="my-devices">
      <h2>My devices</h2>
      <p>Revoking one of your own other devices also signs you out everywhere else.</p>
      <ul>
        {devices?.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            isSelf
            isCurrentBrowser={d.deviceId === currentDeviceId}
            onRenamed={onRenamed}
            onRevoked={onRevoked}
          />
        ))}
      </ul>
    </section>
  );
}

function AllDevices({ selfUserId }: { selfUserId: string }) {
  const [devices, setDevices] = useState<Device[] | null>(null);

  useEffect(() => {
    listDevices({}).then((all) => setDevices(all.filter((d) => d.userId !== selfUserId)));
  }, [selfUserId]);

  function onRenamed(id: string, label: string) {
    setDevices((prev) => (prev ? prev.map((d) => (d.id === id ? { ...d, label } : d)) : prev));
  }
  function onRevoked(id: string) {
    setDevices((prev) => (prev ? prev.map((d) => (d.id === id ? { ...d, revokedAt: new Date().toISOString() } : d)) : prev));
  }

  return (
    <section aria-label="All devices">
      <h2>All devices</h2>
      <p>
        Revoking someone else's device removes it from this list. It does not yet block that device from
        continuing to use the app — that protection is planned for a later update.
      </p>
      <ul>
        {devices?.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            isSelf={false}
            isCurrentBrowser={false}
            onRenamed={onRenamed}
            onRevoked={onRevoked}
          />
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Add the `/devices` route in `App.tsx`**

```tsx
import { DevicesScreen } from './screens/DevicesScreen';
// ...
      <Route path="/devices" component={DevicesScreen} />
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm --filter @dsb-pro/admin run build && pnpm --filter @dsb-pro/admin run e2e
```
Expected: PASS, all specs (9 from Tasks 8–11 + 2 here = 11).

- [ ] **Step 6: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): Devices screen (my devices rename/revoke, all-devices for owner/manager)"
```

---

### Task 13: Full-suite verification + `docs/HANDOVER.md` entry

**Files:**
- Modify: `docs/HANDOVER.md`

**Interfaces:** None — this task only verifies and documents.

- [ ] **Step 1: Run every check this plan touches, in order**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @dsb-pro/admin run build
pnpm --filter @dsb-pro/admin run e2e
```
Expected: all green. Paste the real output into the SDD report — per `CLAUDE.md`, never "✓" without it.

- [ ] **Step 2: Apply migration 0014 to the dev project one more time, idempotently checked**

```bash
PGSERVICEFILE="C:/Users/LENOVO/AppData/Roaming/postgresql/pg_service.conf" C:/PROGRA~1/PostgreSQL/17/bin/psql.exe "service=dsbprodev" -f supabase/tests/0014_device_label.sql
```
Expected: same 5/5 `ok` result as Task 1 — confirms nothing later in this plan altered the migration's behavior.

- [ ] **Step 3: Push and confirm CI green on the real branch**

```bash
git push -u origin HEAD
gh pr create --fill
```
Then check the Actions run for this push completes with `lint`, `typecheck`, `test`, `pgtap`, `e2e`, and `build` all green (`deploy` skipped, correctly, since this isn't `main`).

- [ ] **Step 4: Append the `docs/HANDOVER.md` entry**

Append a new section (following the existing file's format — see the "Phase 1 — Tenancy, auth, RLS (complete)" section for the exact style to match):

```markdown
## Login/signup/invite/device UI (complete)

- `packages/adapters` created: AuthAdapter (`auth.ts`), tenancy RPCs (`tenancy.ts`), device
  RPCs (`devices.ts`) — the first real implementation of `DSB_PRO_BUILD_PLAN.md` §4's adapter
  layer. No provider name appears in `apps/admin` outside Phase 0's pre-existing HealthPanel.
- `packages/core` gained `hasPerm()` (mirrors `role_permissions`), `makeTenantSlug()`,
  `passwordStrength()`.
- One new migration: `0014_device_label.sql` (`devices.label` + `set_device_label()` RPC) —
  Phase 1 shipped devices with no name column; this UI needed one.
- `apps/admin` screens: Login, Signup, no-tenant landing (create shop / join code), join-invite
  deep link, Team (invite create/share/revoke, member role change), Devices (self-service +
  owner/manager all-devices view).
- Playwright bootstrapped for the first time (`apps/admin/playwright.config.ts`,
  `apps/admin/e2e/`) with a new CI `e2e` job, run against a disposable `supabase start`
  instance — never against `dsb-pro-dev`.

**Known simplifications, carried forward honestly rather than silently assumed away:**
- Device revocation (self or by an owner/manager) still has no real enforcement against an
  already-revoked device continuing to make requests — Phase 5's sync layer is still where
  that lands. The one exception: revoking your OWN other device also calls
  `supabase.auth.signOut({scope:'others'})`, which Supabase Auth does enforce immediately.
  Revoking someone ELSE's device only removes it from the list — the Devices screen says so.
- No deactivate/reactivate/remove exists for a `tenant_users` row — only role change
  (`set_user_role`). Dropped from this plan's Team screen scope rather than adding a new RPC
  for it; add one when it's actually needed.
- Role changes take effect on the affected user's next request via the table-fallback path,
  or up to ~1 hour (JWT lifetime) if the access-token hook is enabled and they're already
  signed in. The Team screen's copy says this; nothing was built to make it instant.
- Dark mode and Hindi strings (`DSB_PRO_BUILD_PLAN.md` §10) are not in this plan — every
  screen is literal English JSX text with no theming, matching Phase 0's own placeholder
  screen. Deferred to whichever later phase first needs i18n/theming broadly enough to be
  worth building once instead of screen-by-screen.

**Next:** Phase 2 — Core library (`DSB_PRO_BUILD_PLAN.md` v1.5 §13).
```

- [ ] **Step 5: Commit**

```bash
git add docs/HANDOVER.md
git commit -m "docs: login/signup/invite/device UI handover entry — gate verified"
```
