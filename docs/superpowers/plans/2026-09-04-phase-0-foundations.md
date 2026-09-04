# Phase 0 — Foundations + Backup Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the DSB Pro repo end-to-end for Phase 0 — scaffold, CI, two hosting mirrors serving the same build, a Supabase dev project with a working migrations pipeline, Sentry, and a nightly backup workflow that lands a verified encrypted dump in two destinations.

**Architecture:** pnpm monorepo (`apps/admin` + `packages/core`/`db` only — other apps/packages stay uncreated until their own phase). A single GitHub Actions CI workflow gates lint/typecheck/test/pgTAP/build before deploying the identical build artifact to Cloudflare Pages and GitHub Pages. A separate scheduled workflow dumps the dev Postgres DB, encrypts it with `age`, and uploads to Backblaze B2 + Cloudflare R2, recording each run in a `backup_runs` table that a narrow RPC exposes to a small in-app health panel.

**Tech Stack:** Vite + TypeScript + Preact, pnpm workspaces, Supabase (Postgres + CLI), pgTAP, Vitest, ESLint (flat config), GitHub Actions, Cloudflare Pages + Wrangler, GitHub Pages, Backblaze B2 + Cloudflare R2 (via rclone), `age` encryption, Sentry.

**Spec:** `docs/superpowers/specs/2026-09-04-phase-0-foundations-design.md` — read alongside this plan; task notes below reference its sections by number.

## Global Constraints

(From `DSB_PRO_BUILD_PLAN.md` v1.5 §2, and the spec above — apply to every task.)

- SQL migration before code.
- Standard columns on every table (`id`, `tenant_id`, `shop_id`, `created_by`, `created_at`, `updated_at` bigint-by-trigger, `deleted_at`, `client_id`) — **except** `schema_meta` and `backup_runs`, which are approved-exception control tables (spec §5): `id` + real timestamps only, no tenant/sync columns.
- No client-side `DELETE` grants; privileged ops via Postgres RPC (`security definer`, `set search_path=public`).
- Escape at render only; never store escaped strings.
- Money is integer paise in DB and `packages/core`; formatted to ₹ only at render.
- Providers only behind adapters — **Phase 0 exception** (spec-consistent, noted in Task 8): the health panel talks to PostgREST directly via `fetch`, not through `packages/adapters` (which doesn't exist until later phases) and not via the `@supabase/supabase-js` SDK, keeping Phase 0 free of a provider SDK outside the one narrow, non-financial, read-only call it needs.
- One change-set per reply; never "done" without pasted verification output.
- Backup role password, and the `age` private key, are never committed to git (spec §7 risks).

---

### Task 1: Root workspace + `packages/core`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.npmrc`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/paise.ts`, `packages/core/src/paise.test.ts`

**Interfaces:**
- Produces: `toRupeeString(paise: number): string`, exported from `packages/core/src/paise.ts`. Root scripts `lint`, `typecheck`, `test`, `build`, `gen:types` (some wired up fully in later tasks; defined now, extended later).

- [ ] **Step 1: Create root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - apps/*
  - packages/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.env
.env.local
supabase/.branches
supabase/.temp
coverage/
*.log
```

`.npmrc`:
```
auto-install-peers=true
strict-peer-dependencies=false
```

`package.json`:
```json
{
  "name": "dsb-pro",
  "private": true,
  "packageManager": "pnpm@11.25.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "pnpm -r --if-present run typecheck",
    "test": "pnpm -r --if-present run test",
    "build": "pnpm --filter @dsb-pro/admin run build",
    "gen:types": "mkdir -p packages/db/src && supabase gen types typescript --local > packages/db/src/types.ts"
  }
}
```

- [ ] **Step 2: Create `packages/core`**

`packages/core/package.json`:
```json
{
  "name": "@dsb-pro/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test**

`packages/core/src/paise.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { toRupeeString } from './paise';

describe('toRupeeString', () => {
  it('formats whole rupees with paise', () => {
    expect(toRupeeString(123456)).toBe('₹1,234.56');
  });

  it('formats zero', () => {
    expect(toRupeeString(0)).toBe('₹0.00');
  });

  it('formats amounts under one rupee', () => {
    expect(toRupeeString(45)).toBe('₹0.45');
  });

  it('formats negative amounts', () => {
    expect(toRupeeString(-500)).toBe('-₹5.00');
  });

  it('applies Indian digit grouping for large amounts', () => {
    expect(toRupeeString(1000000000)).toBe('₹1,00,00,000.00');
  });

  it('throws on non-integer input', () => {
    expect(() => toRupeeString(100.5)).toThrow('integer paise');
  });
});
```

- [ ] **Step 4: Install dependencies and run the test to verify it fails**

```bash
pnpm add -Dw typescript eslint @eslint/js typescript-eslint vitest
```

Run: `pnpm --filter @dsb-pro/core test`
Expected: FAIL — `paise.ts` does not exist / `toRupeeString` is not exported.

- [ ] **Step 5: Write the minimal implementation**

`packages/core/src/paise.ts`:
```ts
/**
 * Formats an integer paise amount as a ₹ rupee string, e.g. 123456 -> "₹1,234.56".
 * Money is always integer paise in the DB and packages/core; this is the only
 * place it is formatted for display (DSB_PRO_BUILD_PLAN.md §2: "escape at render only").
 */
export function toRupeeString(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new Error(`toRupeeString expects an integer paise value, got ${paise}`);
  }
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const remainderPaise = abs % 100;
  const rupeesFormatted = rupees.toLocaleString('en-IN');
  const sign = negative ? '-' : '';
  return `${sign}₹${rupeesFormatted}.${remainderPaise.toString().padStart(2, '0')}`;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @dsb-pro/core test`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .npmrc packages/core pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat: root workspace scaffold + packages/core toRupeeString

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
```

---

### Task 2: Workspace lint & typecheck tooling

**Files:**
- Create: `eslint.config.js`

**Interfaces:**
- Consumes: `packages/core/src/*.ts` (Task 1) as the first real lint/typecheck target.
- Produces: working `pnpm lint` and `pnpm typecheck` at the repo root, applied to every future package automatically via the flat config's glob.

- [ ] **Step 1: Write the ESLint flat config**

`eslint.config.js`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'packages/db/src/types.ts'],
  }
);
```

- [ ] **Step 2: Run lint to verify it fails or passes cleanly against Task 1's code**

Run: `pnpm lint`
Expected: PASS (no violations) — `packages/core/src/paise.ts` and `paise.test.ts` are clean. If it fails, fix the reported violations in those files (do not weaken the config to silence them).

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — `tsc --noEmit` clean for `packages/core`.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore: workspace ESLint flat config + typecheck script

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
```

---

### Task 3: `apps/admin` scaffold (Vite + Preact + TS)

**Files:**
- Create: `apps/admin/` (via scaffolding tool, then overwritten as below)
- Modify: `apps/admin/package.json`, `apps/admin/vite.config.ts`, `apps/admin/index.html`
- Create: `apps/admin/src/main.tsx`, `apps/admin/src/style.css`

**Interfaces:**
- Produces: a building Vite app at `apps/admin`, package name `@dsb-pro/admin`, `pnpm --filter @dsb-pro/admin run build` → `apps/admin/dist/`, built with relative `base: './'`.

- [ ] **Step 1: Scaffold via create-vite**

```bash
pnpm create vite@latest apps/admin -- --template preact-ts
rm -f apps/admin/package-lock.json
```

- [ ] **Step 2: Fix the package name and remove template placeholder files we're about to replace**

Edit `apps/admin/package.json`: set `"name": "@dsb-pro/admin"`, `"private": true`.

```bash
rm -f apps/admin/src/App.tsx apps/admin/src/app.tsx apps/admin/src/App.css apps/admin/src/index.css apps/admin/src/assets -r
```

- [ ] **Step 3: Replace the entry point, HTML shell, and styles**

`apps/admin/src/main.tsx`:
```tsx
import { render } from 'preact';
import './style.css';

function App() {
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Phase 0 placeholder. Billing, inventory, and everything else arrives in later phases.</p>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
```

`apps/admin/src/style.css`:
```css
body {
  margin: 0;
  font-family: system-ui, sans-serif;
}
main {
  padding: 1.5rem;
  max-width: 640px;
}
```

`apps/admin/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DSB Pro Admin</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Set the relative base path**

`apps/admin/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  base: './',
  plugins: [preact()],
});
```

- [ ] **Step 5: Install and build**

```bash
pnpm install
pnpm --filter @dsb-pro/admin run build
```

Expected: build succeeds, `apps/admin/dist/index.html` exists.

- [ ] **Step 6: Verify the relative base actually took effect**

Run: `grep -o 'src="\./assets/[^"]*"' apps/admin/dist/index.html`
Expected: at least one match — asset paths are `./assets/...`, not `/assets/...`. This is the exact bug that would break the GitHub Pages mirror (spec §2), so confirm it here rather than discovering it after deploy.

- [ ] **Step 7: Commit**

```bash
git add apps/admin package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat: apps/admin Vite+Preact+TS scaffold, relative base path

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
```

---

### Task 4: Supabase local project + `schema_meta` / `backup_runs` migration + pgTAP

**Files:**
- Create: `supabase/config.toml` (via `supabase init`)
- Create: `supabase/migrations/0001_init.sql`
- Create: `supabase/tests/0001_schema_meta_and_backup_runs.sql`

**Interfaces:**
- Produces: tables `schema_meta` (singleton: `id boolean pk`, `current_version`, `min_supported_version`) and `backup_runs` (`id uuid pk`, `started_at`, `finished_at`, `status`, `dump_size_bytes`, `sha256`, `destinations jsonb`, `app_version`, `schema_version`, `manifest jsonb`, `error`, `created_at`), both RLS-enabled with no policies (default-deny). Local Supabase stack running for later tasks.

- [ ] **Step 1: Verify Docker is available, install the Supabase CLI, and init**

```bash
docker ps
pnpm add -Dw supabase
pnpm exec supabase init
```

Expected: `docker ps` succeeds (empty list is fine — if this errors, Docker Desktop must be started before continuing). `supabase init` creates `supabase/config.toml`.

- [ ] **Step 2: Write the migration**

`supabase/migrations/0001_init.sql`:
```sql
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
-- No policies: default-deny for anon/authenticated. Only the service role
-- (bypasses RLS) may read/write this table directly.

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
```

- [ ] **Step 3: Apply it locally**

```bash
pnpm exec supabase start
pnpm exec supabase db reset
```

Expected: both succeed (first `start` pulls Docker images and can take several minutes); `db reset` reports the migration applied.

- [ ] **Step 4: Write the failing pgTAP test**

`supabase/tests/0001_schema_meta_and_backup_runs.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;

select plan(4);

-- backup_runs: RLS must deny anon and authenticated SELECT (default-deny, no policies).
set role anon;
select is_empty(
  $$ select * from backup_runs $$,
  'anon cannot read backup_runs (RLS default-deny)'
);
reset role;

set role authenticated;
select is_empty(
  $$ select * from backup_runs $$,
  'authenticated cannot read backup_runs (RLS default-deny)'
);
reset role;

-- schema_meta: singleton constraint rejects a second row.
select throws_ok(
  $$ insert into schema_meta (id, current_version, min_supported_version) values (true, 2, 1) $$,
  '23505',
  null,
  'schema_meta rejects a second row (id primary key collision)'
);

select throws_ok(
  $$ insert into schema_meta (id, current_version, min_supported_version) values (false, 2, 1) $$,
  '23514',
  null,
  'schema_meta rejects id = false (singleton check constraint)'
);

select * from finish();
rollback;
```

This test should already pass since the migration in Step 2 already enables RLS with no policies and the singleton constraint — there is no "make it pass" step here beyond the migration itself. Run it now to confirm.

- [ ] **Step 5: Run pgTAP and verify it passes**

```bash
pnpm exec supabase test db
```

Expected: `1..4`, all 4 ok.

- [ ] **Step 6: Commit**

```bash
git add supabase
git commit -m "$(cat <<'EOF'
feat: schema_meta + backup_runs tables, RLS default-deny, pgTAP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
```

---

### Task 5: `get_latest_backup_status()` RPC

**Files:**
- Create: `supabase/migrations/0002_backup_status_rpc.sql`
- Create: `supabase/tests/0002_backup_status_rpc.sql`

**Interfaces:**
- Consumes: `backup_runs` table (Task 4).
- Produces: `get_latest_backup_status()` — a `security definer` SQL function returning `table(status text, finished_at timestamptz, destinations jsonb, app_version text, schema_version integer)`, `execute` granted to `anon, authenticated`. Consumed by Task 8's health panel.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0002_backup_status_rpc.sql`:
```sql
-- Narrow, non-sensitive read path onto backup_runs for apps/admin's health panel.
-- backup_runs itself stays fully locked down (0001_init.sql); this function is
-- security definer so it can read the table despite RLS, and returns only
-- operational metadata — never `error` or `manifest`, which could carry more
-- detail than we want exposed pre-auth (Phase 1 adds real authentication).
create function get_latest_backup_status()
returns table (
  status text,
  finished_at timestamptz,
  destinations jsonb,
  app_version text,
  schema_version integer
)
language sql
security definer
set search_path = public
stable
as $$
  select status, finished_at, destinations, app_version, schema_version
  from backup_runs
  order by created_at desc
  limit 1;
$$;

revoke all on function get_latest_backup_status() from public;
grant execute on function get_latest_backup_status() to anon, authenticated;
```

- [ ] **Step 2: Write the failing pgTAP test**

`supabase/tests/0002_backup_status_rpc.sql`:
```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(2);

select has_function('public', 'get_latest_backup_status', 'get_latest_backup_status() exists');

set role anon;
select lives_ok(
  $$ select * from get_latest_backup_status() $$,
  'anon can execute get_latest_backup_status()'
);
reset role;

select * from finish();
rollback;
```

- [ ] **Step 3: Apply and run**

```bash
pnpm exec supabase db reset
pnpm exec supabase test db
```

Expected: both test files run; this file reports `1..2`, both ok.

- [ ] **Step 4: Commit**

```bash
git add supabase
git commit -m "$(cat <<'EOF'
feat: get_latest_backup_status() RPC for the health panel

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
```

---

### Task 6: `packages/db` generated types

**Files:**
- Create: `packages/db/package.json`

**Interfaces:**
- Produces: `packages/db/src/types.ts` (generated, committed), containing `Database` type reflecting Tasks 4–5's schema. Regenerated by root `pnpm gen:types`.

- [ ] **Step 1: Create the package**

`packages/db/package.json`:
```json
{
  "name": "@dsb-pro/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/types.ts"
}
```

- [ ] **Step 2: Generate types and verify the command fails without a running local stack, then succeeds with one**

```bash
pnpm exec supabase stop
pnpm gen:types
```
Expected: FAIL — no local Supabase instance running to introspect.

```bash
pnpm exec supabase start
pnpm gen:types
```
Expected: PASS — `packages/db/src/types.ts` created.

- [ ] **Step 3: Verify the generated file is real**

Run: `grep -c "export type Database" packages/db/src/types.ts`
Expected: `1`.
Run: `grep -c "backup_runs" packages/db/src/types.ts`
Expected: at least `1` (the table appears in the generated types).

- [ ] **Step 4: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat: packages/db generated Supabase types

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
```

---

### Task 7: Sentry wiring in `apps/admin`

**Files:**
- Create: `apps/admin/.env.example`
- Modify: `apps/admin/src/main.tsx`

**Interfaces:**
- Consumes: `apps/admin/src/main.tsx` (Task 3).
- Produces: `Sentry.init()` called from `main.tsx` when `VITE_SENTRY_DSN` is set; a "Send test event to Sentry" button for one-time manual verification.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @dsb-pro/admin add @sentry/browser
```

- [ ] **Step 2: Add the env placeholder**

`apps/admin/.env.example`:
```
VITE_SENTRY_DSN=
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

(The Supabase entries are added now so Task 8 only has to fill in real values, not add new keys.)

- [ ] **Step 3: Wire Sentry into the entry point**

`apps/admin/src/main.tsx`:
```tsx
import { render } from 'preact';
import * as Sentry from '@sentry/browser';
import './style.css';

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn });
}

function App() {
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Phase 0 placeholder. Billing, inventory, and everything else arrives in later phases.</p>
      <button onClick={() => Sentry.captureMessage('Phase 0 Sentry wiring test')}>
        Send test event to Sentry
      </button>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
```

- [ ] **Step 4: Build to verify Sentry is bundled**

```bash
pnpm --filter @dsb-pro/admin run build
grep -c "Sentry" apps/admin/dist/assets/*.js
```
Expected: build succeeds; grep reports at least one match.

- [ ] **Step 5: Manual one-time verification (human, not automated)**

```bash
cp apps/admin/.env.example apps/admin/.env
# edit apps/admin/.env, set VITE_SENTRY_DSN to the real DSN
pnpm --filter @dsb-pro/admin run dev
```
Open the dev URL, click "Send test event to Sentry," then check the Sentry project dashboard for a "Phase 0 Sentry wiring test" message event. Record the result (event received: yes/no) before moving on.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/package.json apps/admin/.env.example apps/admin/src/main.tsx pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat: wire Sentry into apps/admin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
```

---

### Task 8: Health panel

**Files:**
- Create: `apps/admin/src/HealthPanel.tsx`
- Modify: `apps/admin/src/main.tsx`

**Interfaces:**
- Consumes: `get_latest_backup_status()` RPC (Task 5) over PostgREST; `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (Task 7's `.env.example`).
- Produces: `HealthPanel` component, rendered from `main.tsx`.

- [ ] **Step 1: Write the component**

`apps/admin/src/HealthPanel.tsx`:
```tsx
import { useEffect, useState } from 'preact/hooks';

// Talks to PostgREST directly rather than pulling in @supabase/supabase-js:
// this is one read-only, non-financial call outside the sync system, so
// staying off the provider SDK keeps Phase 0 aligned with the "providers
// only behind adapters" rule until Phase 1 actually builds that layer.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

type BackupStatus = {
  status: string;
  finished_at: string | null;
  destinations: { name: string; verified: boolean }[];
  app_version: string | null;
  schema_version: number | null;
};

export function HealthPanel() {
  const [backup, setBackup] = useState<BackupStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${SUPABASE_URL}/rest/v1/rpc/get_latest_backup_status`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`${res.status} ${await res.text()}`);
        }
        return res.json() as Promise<BackupStatus[]>;
      })
      .then((rows) => setBackup(rows[0] ?? null))
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) {
    return <p role="alert">Backup status unavailable: {error}</p>;
  }

  if (backup === undefined) {
    return <p>Loading backup status…</p>;
  }

  if (backup === null) {
    return <p>No backup has run yet.</p>;
  }

  return (
    <section aria-label="Backup health">
      <h2>Backup</h2>
      <p>Status: {backup.status}</p>
      <p>Last finished: {backup.finished_at ?? 'never'}</p>
      <p>
        Destinations:{' '}
        {backup.destinations.length
          ? backup.destinations.map((d) => `${d.name} (${d.verified ? 'verified' : 'unverified'})`).join(', ')
          : 'none yet'}
      </p>
    </section>
  );
}
```

- [ ] **Step 2: Wire it into `main.tsx`**

`apps/admin/src/main.tsx`:
```tsx
import { render } from 'preact';
import * as Sentry from '@sentry/browser';
import { HealthPanel } from './HealthPanel';
import './style.css';

const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn });
}

function App() {
  return (
    <main>
      <h1>DSB Pro — Admin</h1>
      <p>Phase 0 placeholder. Billing, inventory, and everything else arrives in later phases.</p>
      <button onClick={() => Sentry.captureMessage('Phase 0 Sentry wiring test')}>
        Send test event to Sentry
      </button>
      <HealthPanel />
    </main>
  );
}

render(<App />, document.getElementById('app')!);
```

- [ ] **Step 3: Manual verification against the local Supabase stack**

```bash
pnpm exec supabase status
```
Copy the local `API URL` and `anon key` into `apps/admin/.env` as `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

```bash
pnpm --filter @dsb-pro/admin run dev
```
Open the dev URL: expect "Loading backup status…" briefly, then "No backup has run yet." (correct — `backup_runs` is empty until Task 11's workflow runs). This confirms the RPC round-trip works end-to-end before real data exists.

- [ ] **Step 4: Build check**

```bash
pnpm --filter @dsb-pro/admin run build
```
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/HealthPanel.tsx apps/admin/src/main.tsx
git commit -m "$(cat <<'EOF'
feat: backup health panel in apps/admin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
```

---

### Task 9: CI workflow (lint, typecheck, test, pgTAP, build)

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts `lint`/`typecheck`/`test` (Tasks 1–2), `packages/core` tests (Task 1), `supabase/migrations` + `supabase/tests` (Tasks 4–5), `apps/admin` build (Task 3).
- Produces: an `admin-dist` build artifact, uploaded for Task 10's deploy job to consume via `needs`.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  pgtap:
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
      - run: supabase db reset
      - run: supabase test db

  build:
    needs: [lint, typecheck, test, pgtap]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @dsb-pro/admin run build
      - uses: actions/upload-artifact@v4
        with:
          name: admin-dist
          path: apps/admin/dist
```

- [ ] **Step 2: Push a branch and open a PR to verify it runs**

```bash
git checkout -b ci/phase-0-pipeline
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: lint/typecheck/test/pgTAP/build pipeline

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
git push -u origin ci/phase-0-pipeline
gh pr create --fill
```

- [ ] **Step 3: Watch it run and verify all jobs pass**

```bash
gh pr checks --watch
```
Expected: `lint`, `typecheck`, `test`, `pgtap`, `build` all succeed. Paste the actual output here before proceeding — do not merge on an assumption.

- [ ] **Step 4: Merge**

```bash
gh pr merge --squash --delete-branch
```

---

### Task 10: CI deploy job — Cloudflare Pages + GitHub Pages

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `admin-dist` artifact (Task 9).
- Produces: live builds at the Cloudflare Pages URL and the GitHub Pages URL, both serving the identical artifact.

- [ ] **Step 1: Operator setup (human, outside this repo) — do this before Step 2**

1. Cloudflare dashboard → Workers & Pages → Create → Pages → **Direct Upload**, name it `dsb-pro`. Do not connect it to the GitHub repo — our own workflow pushes builds.
2. Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom Token, permission `Account | Cloudflare Pages | Edit`, scoped to the account. Copy the token.
3. Cloudflare dashboard → Workers & Pages → Overview (sidebar) → copy the Account ID.
4. Repo Settings → Pages → Source: **GitHub Actions**.
5. Set the two secrets:
```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```
(each prompts for the value on stdin).

- [ ] **Step 2: Add the deploy job**

Append to `.github/workflows/ci.yml`:
```yaml
  deploy:
    needs: [build]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: admin-dist
          path: apps/admin/dist
      - name: Deploy to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy apps/admin/dist --project-name=dsb-pro
      - uses: actions/upload-pages-artifact@v3
        with:
          path: apps/admin/dist
      - uses: actions/deploy-pages@v4
```

- [ ] **Step 3: Push directly to `main` (deploy only fires on `main`) and watch it**

```bash
git checkout main
git pull
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: deploy to Cloudflare Pages + GitHub Pages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
git push
gh run watch
```

- [ ] **Step 4: Verify both mirrors serve the same build**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://dsb-pro.pages.dev/
curl -s -o /dev/null -w "%{http_code}\n" https://dashsuperbazar-del.github.io/dsb-pro/
curl -s https://dsb-pro.pages.dev/ | grep -o '<title>[^<]*</title>'
curl -s https://dashsuperbazar-del.github.io/dsb-pro/ | grep -o '<title>[^<]*</title>'
```
Expected: both return `200`, both `<title>` values are `DSB Pro Admin`. Paste actual output before considering this task done.

---

### Task 11: Backup workflow (`infra/backup.yml`)

**Files:**
- Create: `infra/backup.yml`

**Interfaces:**
- Consumes: `backup_runs` table (Task 4).
- Produces: a nightly (and manually-dispatchable) workflow writing one `backup_runs` row per run and one encrypted object per destination bucket.

- [ ] **Step 1: Operator setup (human, outside CI) — do this before Step 3**

Create the `backup_ro` role directly in the Supabase SQL Editor for the dev project — **never in a migration file**, since the password would become permanent git history:
```sql
create role backup_ro login password '<choose a strong password here, do not reuse it, do not commit it>';
grant usage on schema public to backup_ro;
grant select on all tables in schema public to backup_ro;
alter default privileges in schema public grant select on tables to backup_ro;
```

Generate the `age` keypair locally:
```bash
age-keygen -o dsb-pro-backup-key.txt
```
This prints the public key as a comment line (`# public key: age1...`). Keep `dsb-pro-backup-key.txt` (the private key) **out of git** — store it per the plan's §18 Q4 physical-custody decision (two independent physical copies); it is only ever needed off-CI, for a restore drill.

Set the secrets and variable:
```bash
gh variable set AGE_PUBLIC_KEY --body "age1..."   # the public key from above
gh secret set BACKUP_RO_DATABASE_URL              # postgresql://backup_ro:<password>@<db-host>:5432/postgres
gh secret set SUPABASE_DB_URL                     # the project's postgres/owner connection string (Project Settings → Database)
gh secret set B2_ACCOUNT_ID                       # Backblaze B2 application key ID, scoped to APD-BB
gh secret set B2_APPLICATION_KEY
gh secret set R2_ACCESS_KEY_ID                    # Cloudflare R2 → Manage API Tokens
gh secret set R2_SECRET_ACCESS_KEY
gh secret set R2_ENDPOINT                         # https://<account-id>.r2.cloudflarestorage.com
```

Create the R2 bucket if it doesn't exist yet: Cloudflare dashboard → R2 → Create bucket → `dsb-pro-backups`.

- [ ] **Step 2: Write the workflow**

`infra/backup.yml`:
```yaml
name: Nightly backup

on:
  schedule:
    - cron: '30 20 * * *'
  workflow_dispatch:

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - name: Install tools
        run: |
          sudo apt-get update
          sudo apt-get install -y postgresql-client age rclone

      - name: Configure rclone
        run: |
          mkdir -p ~/.config/rclone
          cat > ~/.config/rclone/rclone.conf <<CONF
          [b2]
          type = b2
          account = ${{ secrets.B2_ACCOUNT_ID }}
          key = ${{ secrets.B2_APPLICATION_KEY }}

          [r2]
          type = s3
          provider = Cloudflare
          access_key_id = ${{ secrets.R2_ACCESS_KEY_ID }}
          secret_access_key = ${{ secrets.R2_SECRET_ACCESS_KEY }}
          endpoint = ${{ secrets.R2_ENDPOINT }}
          CONF

      - name: Mark backup run as started
        id: start
        run: |
          RUN_ID=$(psql "${{ secrets.SUPABASE_DB_URL }}" -t -A -c \
            "insert into backup_runs (started_at, status) values (now(), 'running') returning id;")
          echo "run_id=$RUN_ID" >> "$GITHUB_OUTPUT"

      - name: Dump database
        run: pg_dump --format=custom "${{ secrets.BACKUP_RO_DATABASE_URL }}" -f dump.pgcustom

      - name: Encrypt dump
        run: age -r "${{ vars.AGE_PUBLIC_KEY }}" -o dump.pgcustom.age dump.pgcustom

      - name: Checksum
        id: checksum
        run: |
          SHA=$(sha256sum dump.pgcustom.age | cut -d' ' -f1)
          SIZE=$(stat -c%s dump.pgcustom.age)
          echo "sha256=$SHA" >> "$GITHUB_OUTPUT"
          echo "size=$SIZE" >> "$GITHUB_OUTPUT"

      - name: Build manifest
        id: manifest
        run: |
          MANIFEST=$(psql "${{ secrets.SUPABASE_DB_URL }}" -t -A -c \
            "select json_build_object('schema_meta', (select count(*) from schema_meta), 'backup_runs', (select count(*) from backup_runs));")
          echo "json=$MANIFEST" >> "$GITHUB_OUTPUT"

      - name: Upload to B2 (primary) and verify
        run: |
          NAME="backup-$(date +%F).pgcustom.age"
          rclone copyto dump.pgcustom.age "b2:APD-BB/$NAME"
          rclone cat "b2:APD-BB/$NAME" | sha256sum | cut -d' ' -f1 > b2_sha.txt
          diff <(echo "${{ steps.checksum.outputs.sha256 }}") b2_sha.txt

      - name: Upload to R2 (secondary) and verify
        run: |
          NAME="backup-$(date +%F).pgcustom.age"
          rclone copyto dump.pgcustom.age "r2:dsb-pro-backups/$NAME"
          rclone cat "r2:dsb-pro-backups/$NAME" | sha256sum | cut -d' ' -f1 > r2_sha.txt
          diff <(echo "${{ steps.checksum.outputs.sha256 }}") r2_sha.txt

      - name: Mark backup run as succeeded
        if: success()
        run: |
          psql "${{ secrets.SUPABASE_DB_URL }}" -c "
            update backup_runs set
              finished_at = now(),
              status = 'success',
              dump_size_bytes = ${{ steps.checksum.outputs.size }},
              sha256 = '${{ steps.checksum.outputs.sha256 }}',
              destinations = '[{\"name\":\"b2\",\"verified\":true},{\"name\":\"r2\",\"verified\":true}]'::jsonb,
              app_version = '${{ github.sha }}',
              schema_version = 1,
              manifest = '${{ steps.manifest.outputs.json }}'::jsonb
            where id = '${{ steps.start.outputs.run_id }}';
          "

      - name: Mark backup run as failed
        if: failure()
        run: |
          psql "${{ secrets.SUPABASE_DB_URL }}" -c "
            update backup_runs set finished_at = now(), status = 'failed',
              error = 'CI job failed — see Actions run ${{ github.run_id }}'
            where id = '${{ steps.start.outputs.run_id }}';
          " || true
```

- [ ] **Step 3: Commit and dispatch a manual run**

```bash
git add infra/backup.yml
git commit -m "$(cat <<'EOF'
feat: nightly backup workflow — pg_dump, age-encrypt, B2 + R2

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
git push
gh workflow run "Nightly backup"
gh run watch
```

- [ ] **Step 4: Verify end-to-end — not just that the job went green**

```bash
psql "$SUPABASE_DB_URL" -c "select status, finished_at, destinations, dump_size_bytes, sha256, manifest from backup_runs order by created_at desc limit 1;"
```
Expected: `status = success`, both destinations `verified: true`, non-null size/checksum/manifest.

Then confirm the objects independently, not just via the workflow's own claim:
```bash
rclone lsl b2:APD-BB/
rclone lsl r2:dsb-pro-backups/
```
Expected: today's `backup-YYYY-MM-DD.pgcustom.age` listed in both. Paste actual output before considering this task done.

---

### Task 12: `restore.md` draft

**Files:**
- Create: `infra/restore.md`

**Interfaces:**
- None — documentation only, referenced by the Phase 0 gate and drilled for real in Phase 6.

- [ ] **Step 1: Write the draft**

`infra/restore.md`:
```markdown
# Restore procedure

**Status: NOT YET DRILLED — first drill is a Phase 6 gate (DSB_PRO_BUILD_PLAN.md v1.5 §13).**
This is the documented procedure only. Do not treat it as proven until it has actually been
run end-to-end and the result compared against production, per the Phase 6 gate.

## Restore into a fresh Supabase project

1. Create a new Supabase project (or reuse an empty one reserved for drills).
2. `supabase link --project-ref <new-project-ref>`
3. `supabase db push` — applies every migration in `supabase/migrations/` in order.
4. Fetch the latest encrypted dump from Backblaze B2 (primary) or Cloudflare R2 (secondary):
   `rclone copy b2:APD-BB/<backup-file> .`
5. Decrypt with the `age` private key (kept per §18 Q4 physical custody, never in this repo):
   `age -d -i <private-key-file> -o dump.pgcustom <backup-file>`
6. Restore: `pg_restore --clean --if-exists -d "<new-project-connection-string>" dump.pgcustom`
7. Point a preview deployment at the new project's URL/anon key.
8. Compare row counts and, once real financial data exists, invoice/payment totals against
   the manifest recorded in the corresponding `backup_runs` row.

## Restore into local Docker Postgres (provider-independence proof)

1. `docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=postgres postgres:15`
2. Apply migrations directly: `psql postgresql://postgres:postgres@localhost:5433/postgres -f supabase/migrations/0001_init.sql -f supabase/migrations/0002_backup_status_rpc.sql`
3. Decrypt and restore the same dump as above, pointed at `localhost:5433`.
4. Confirm the restored data matches step 8 above.

## Open items for the Phase 6 drill

- Exact RTO/RPO measured, not assumed (target: RPO ≤ 24h, RTO ≤ 2h per §6).
- Key-recovery-from-paper drill: decrypt using only the physical private-key copy.
- `auth.users` export/import test (bcrypt hashes are portable; verify in practice).
```

- [ ] **Step 2: Commit**

```bash
git add infra/restore.md
git commit -m "$(cat <<'EOF'
docs: restore.md draft (untested, Phase 6 drills it for real)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
```

---

### Task 13: `docs/HANDOVER.md` + Phase 0 gate verification

**Files:**
- Create: `docs/HANDOVER.md`

**Interfaces:**
- None — closes out Phase 0 per CLAUDE.md's "End of session: append delta to docs/HANDOVER.md only" rule.

- [ ] **Step 1: Run every gate check one more time, together, and record real output**

```bash
gh run list --workflow=ci.yml --branch main --limit 1
curl -s -o /dev/null -w "%{http_code}\n" https://dsb-pro.pages.dev/
curl -s -o /dev/null -w "%{http_code}\n" https://dashsuperbazar-del.github.io/dsb-pro/
psql "$SUPABASE_DB_URL" -c "select status, destinations from backup_runs order by created_at desc limit 1;"
pnpm exec supabase test db
```

- [ ] **Step 2: Write the handover entry**

`docs/HANDOVER.md`:
```markdown
# DSB Pro — Handover Log

## Phase 0 — Foundations + backup pipeline (complete)

- Repo scaffolded: pnpm workspace, `apps/admin` (Vite+Preact+TS), `packages/core`
  (`toRupeeString`), `packages/db` (generated Supabase types).
- CI (`​.github/workflows/ci.yml`): lint → typecheck → test → pgTAP → build → deploy,
  gated so deploy only runs on `main` after everything else is green.
- Two hosting mirrors live and serving the identical build: Cloudflare Pages
  (`dsb-pro.pages.dev`) and GitHub Pages (`dashsuperbazar-del.github.io/dsb-pro`).
- Supabase dev project: `schema_meta` + `backup_runs` control tables (RLS default-deny),
  `get_latest_backup_status()` narrow RPC, pgTAP asserting both.
- Sentry wired into `apps/admin`, verified via a manual test event.
- Nightly backup workflow (`infra/backup.yml`): dumps the dev DB, encrypts with `age`,
  uploads to Backblaze B2 (`APD-BB`, Object Lock) + Cloudflare R2, verifies each upload
  by re-download checksum, records every run in `backup_runs`.
- `infra/restore.md` drafted, explicitly marked undrilled — first real drill is a
  Phase 6 gate.

**Gate status:** CI green (see run linked above) · both mirrors return 200 with matching
build · `backup_runs` shows a verified `success` row in both destinations · `restore.md`
exists.

**Known Phase 0-only simplifications, to revisit later:**
- Health panel talks to PostgREST directly (no `packages/adapters` yet — that lands
  when Phase 1+ actually needs a swappable DB layer).
- `app_version` in `backup_runs` is the git SHA, not a formal `APP_VERSION` build
  pipeline (§2's versioning rule) — no real app version exists to track yet.
- Migrations are pushed to the dev project manually (`supabase db push`), not from CI.

**Next:** Phase 1 — Tenancy, auth, RLS (`DSB_PRO_BUILD_PLAN.md` v1.5 §13).
```

- [ ] **Step 3: Commit**

```bash
git add docs/HANDOVER.md
git commit -m "$(cat <<'EOF'
docs: Phase 0 handover entry — gate verified

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EpXDex5L3Eg3xQzTkHqGPc
EOF
)"
git push
```
