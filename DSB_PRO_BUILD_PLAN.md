# DSB PRO — MASTER BUILD PLAN (v1.5 — LOCKED, 2026-09-04)

Successor to DSB (single-file PWA). Goal, in this order:
  A. A free-tier, break-proof, data-safe POS + inventory app for Apd's own shop (Phases 0–7).
  B. The same app given to known shops, one deployment each (Phase 8).
  C. Optional sellable SaaS version later (Phase 9). Nothing in A/B blocks C.
This document + the DSB handover docs are the only source of truth in every new chat.

---

## 0. HONEST FRAMING

"Unbreakable" does not exist. What exists: **no single point of failure, every layer replaceable in one evening,
three copies of the data at all times, and the app keeps billing even when every cloud service is down.**
That is the design target. Any feature that violates it loses.

Free-tier reality (verified as of 2026-09): Supabase Free = 500MB DB, 1GB storage, 5GB egress, 50k MAU,
no backups, pauses after 7 days of zero activity. We replace "no backups" ourselves (§6) and never rely on
anything a provider can switch off without us having a copy (§5).

---

## 1. TRUST = 8 PROPERTIES (everything serves these)

1. Data can always be taken out — one-click full export (JSON + CSV + PDF), documented schema.
2. Financial records are immutable — finalized invoice/payment is voided + reissued, never edited.
3. Stock is derived from an append-only movements ledger, never a stored counter.
4. Backups exist in 3 places AND restore has been tested (restore drill is a phase gate).
5. Every mutation is attributable (who, when, device, before → after).
6. Sync cannot lose or resurrect data — outbox + tombstones + server timestamps. `mergeById` union is banned.
7. Security is enforced in the database (RLS + RPC), never in JS.
8. Money paths are tested (pricing, units, totals, sync merge, RLS isolation).

---

## 2. NON-NEGOTIABLE RULES

- SQL migration before code. Every schema change = numbered file in `supabase/migrations/`.
- Standard columns on every table: `id uuid pk default gen_random_uuid()`, `tenant_id uuid not null`,
  `shop_id uuid` (where applicable), `created_by uuid`, `created_at timestamptz default now()`,
  `updated_at bigint not null default 0`, `deleted_at bigint null`, `client_id text` (idempotency).
- `updated_at` set by DB trigger (server clock). Client never writes it.
- No client-side `DELETE` grants. Delete = RPC → `deleted_at` + `audit_log`.
- Privileged ops via Postgres RPC (`security definer`, `set search_path=public`). Server recomputes totals.
- Escape at render only. Never store escaped strings.
- Prices are final all-inclusive; never re-apply GST math. GST fields are informational for print.
- **Money is integer paise** in DB and `packages/core` (`bigint`/`int`), formatted to ₹ only at render. No floats in totals.
- **Line snapshots:** every invoice/bill line stores `item_name_at_sale, unit_at_sale, conv1/conv2_at_sale, price_at_sale,
  tax_rate_at_sale, hsn_at_sale`. Renaming an item never changes history.
- **Returns are documents, not reversals:** `sale_returns`/`purchase_returns` (+ items) with `disposition
  [RETURN_TO_SELLABLE|DAMAGED|EXPIRED|SUPPLIER_RETURN]`; they post their own stock movements and ledger entries.
- **DB constraints are the final authority:** NOT NULL / CHECK (`qty > 0`, `amount >= 0`) / UNIQUE / FK on every table; JS validation is UX only.
- Units `unit1/unit2/unit3 + conv1/conv2`; `calcBigEquiv()` ported with golden tests (parity with DSB).
- No demo seeding in production builds.
- **Portability rule:** use only standard Postgres + standard web APIs wherever a choice exists. Supabase-specific
  features (auth hook, realtime, storage) are wrapped behind adapters (§4) so each can be swapped.
- **Stock is written only by RPCs.** No app code inserts into `stock_movements` directly; `post_purchase()`,
  `post_sale()`, `post_return()`, `adjust_stock()`, `void_*()` are the only writers (GRANT INSERT to nobody else).
- **LWW is for mutable master data only.** Financial events (invoices, payments, movements, expenses) are
  append-only, idempotent by `client_id`, never merged, never overwritten. Two devices → two rows, always.
- **Invariants are tests.** For every financial/stock table an invariant is written as SQL + Vitest before the
  feature is "done": invoice.total = Σ(lines) − discount + charges; customer.balance = opening + credit sales −
  payments − returns ± adjustments; stock = Σ(valid movements); Σ(payment allocations) ≤ payment.amount;
  void reverses movements exactly. A nightly `check_invariants()` RPC runs these on real data and writes to
  `backup_runs`-style health; any violation = red banner. Silent corruption is treated as worse than a crash.
- **Unknown-outcome rule:** a mutation whose network result is unknown enters `UNKNOWN`, never auto-retried; the
  client reconciles by `client_id` (`get_by_client_id()` RPC) → SUCCESS or safe retry. Applies to invoices, payments, orders.
- **Negative stock prohibited** — enforced inside `post_sale()`/`post_return()` after the row lock (a view cannot carry a CHECK), plus a nightly invariant asserting no negative `stock_current`. Owner-only override setting, audited, reportable.
- **Price history has no overlaps:** `item_prices` uses an EXCLUDE constraint on (item, shop, kind, unit_level, tstzrange).
- **Business dates use shop timezone; DB stores UTC.** `fiscal_year` is derived by a function from shop settings
  (Apr–Mar default), used by doc series and reports. Client flags device-clock drift > 5 min against server time.
- **Schema negotiation:** client sends `schema_version`; server exposes `min_supported`/`current`. Below minimum →
  sync refused with "update required", never silent incompatible sync.
- **Tombstone GC:** tombstones kept ≥ 90 days and never purged while any registered device's cursor predates them.
- Expenses: no delete after posting; void/correction only (same as other financial docs).
- One change-set per reply. Plan before code. Paste verification output, never "✓".
- Version = git tag + `APP_VERSION` + SW cache key, written by the build script in one commit.

---

## 3. STACK

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vite + TypeScript + Preact + preact-router | Small, JSX auto-escape, Claude-friendly |
| State | @preact/signals + Dexie live queries | |
| Local DB | Dexie (IndexedDB) | localStorage 5MB cap is a multi-year risk |
| Backend | Supabase (Postgres/Auth/Storage/Realtime/Edge Fn) | Continuity; standard Postgres underneath |
| Migrations | Supabase CLI, files in repo | Reproducible on ANY Postgres |
| Types | `supabase gen types` → `packages/db/types.ts` | |
| Tests | Vitest, pgTAP, Playwright | Replaces the 4-step regex check |
| CI/CD | GitHub Actions (lint → tsc → vitest → pgTAP → build → deploy) | Deploy blocked on red |
| Hosting | Cloudflare Pages (primary) | Static; trivially mirrored |
| Errors | Sentry free | |
| Backups | GitHub Actions cron `pg_dump` → encrypted → B2 (object-lock) + R2 (§6) | Free, immutable, verified |

Cost during Phases 0–8: ₹0/month (domain optional, ~₹1000/yr). Pro ($25) only if triggers in §5 fire.

---

## 4. REPO LAYOUT (pnpm monorepo)

```
dsb-pro/
  apps/admin/            POS + inventory PWA
  apps/storefront/       customer catalog + orders
  apps/superadmin/       Apd: deployments, health, backups status (Phase 8)
  packages/core/         pure TS: units, pricing, totals, validation — 100% tested, zero deps
  packages/adapters/     interfaces + implementations (the portability layer)
      db/                DbAdapter: supabase-postgrest | (future) pocketbase | self-hosted supabase
      auth/              AuthAdapter: supabase-auth | (future) self-hosted gotrue
      storage/           StorageAdapter: supabase-storage | cloudflare-r2 | backblaze-b2 | local-only
      realtime/          RealtimeAdapter: supabase-realtime | polling (fallback, always available)
  packages/sync/         Dexie schema, outbox, cursors, LWW merge, conflict log
  packages/ui/           shared Preact components
  packages/print/        58/80mm thermal + A4 templates
  supabase/migrations/   0001_init.sql …  (standard Postgres; runs on any Postgres 15+)
  supabase/functions/    nightly-export, send-invite, (later) razorpay-webhook
  supabase/tests/        pgTAP
  infra/
      backup.yml         GitHub Actions nightly pg_dump → encrypted → 2 destinations
      restore.md         step-by-step restore into fresh Supabase / self-hosted Postgres
      deploy-tenant.md   "new shop deployment" checklist (Phase 8)
  docs/                  ARCHITECTURE.md, DATA_MODEL.md, RUNBOOK.md, HANDOVER.md
  config/                per-deployment `env.<shop>.json` (url, anon key, storage provider) — NOT secrets
```

**Adapter rule:** UI and sync code import only the interfaces. Swapping a provider = new implementation +
config flag. No provider name appears outside `packages/adapters`.

---

## 5. RESILIENCE MAP — primary / fallback / migration trigger

| Layer | Primary (free) | Fallback (free) | Trigger to migrate | Migration effort |
|---|---|---|---|---|
| App hosting | Cloudflare Pages | GitHub Pages + Netlify (mirrored on every deploy) | Primary down > 1h or ToS change | Zero — DNS/URL switch; PWA already installed keeps working |
| Database | Supabase Free project | 2nd Supabase Free project (same org) → self-hosted Supabase (Docker on Oracle Cloud Always-Free VM) | DB > 400MB, Free tier withdrawn, project locked | `pg_restore` latest dump + migrations + `config/env` change; drilled in Phase 6 |
| Auth | Supabase Auth (email+password only — no magic-link dependency) | Self-hosted GoTrue (ships with self-hosted Supabase); users re-set password via email | Same as DB | Export `auth.users` in dump; passwords are bcrypt hashes → portable |
| File storage (bill/item images) | Supabase Storage 1GB | Cloudflare R2 10GB → Backblaze B2 10GB → device-local only | Bucket > 800MB | Adapter flag; images referenced by path, copied by script |
| Realtime | Supabase Realtime | 30s polling on cursors | Realtime disabled/unavailable | Automatic runtime fallback |
| Backups | GitHub Actions cron → encrypted dump → Backblaze B2 (object-lock, primary) + Cloudflare R2 (secondary) | Google Drive via rclone (3rd copy) | Never migrate; always ≥2 verified destinations | — |
| Keep-alive | Daily shop use | cron-job.org hitting an anon read-only RPC | — | — |
| Offline | Dexie full mirror on every device | — | Backend fully down | App still bills, queues writes; syncs when back |

**Hard rule:** any layer's fallback must be exercised at least once (Phase 6 drill) before real data goes in.

Self-hosted Supabase on Oracle Always-Free (ARM 4 vCPU/24GB) is the "if Supabase Free disappears" exit. It is
NOT the day-one choice because Apd is non-technical and it adds ops burden; it exists as a rehearsed escape hatch.

---

## 6. BACKUP & RESTORE (the part that makes "free" trustworthy)

Three independent copies, always:
1. **Nightly logical dump** — GitHub Actions `schedule: cron '30 20 * * *'` (02:00 IST): `pg_dump --format=custom`
   via a SELECT-only backup role → `age`-encrypt → SHA-256 → upload **primary: Backblaze B2 with object-lock
   (immutable) retention** → verify → **secondary: Cloudflare R2 (or Google Drive via rclone)** → verify → write
   `backup_runs` row. GitHub holds scripts, manifests and checksums only — LFS is not an archive (1GB quota, not
   immutable). Manifest per dump: app version, schema version, timestamp, checksum, per-table row counts, Σ invoice
   totals / Σ payments (used by the restore drill to prove completeness). Retention: 30 daily, 12 monthly, yearly.
   Targets: RPO ≤ 24h, RTO ≤ 2h (own shop); both measured in the Phase 6 drill, not assumed.
2. **Per-tenant JSON export** — Edge Function nightly → Storage `exports/{tenant}/{date}.json.gz` + on-demand
   "Export everything" button (JSON + CSV + invoice PDFs zip). Human-readable, provider-independent.
3. **Device snapshot** — Dexie holds full data; a weekly "Save backup to phone" writes the JSON export to the
   device's Downloads via File System Access / share sheet.

Monitoring: Settings → Health card shows DB · Sync · Backup (age, both destinations, checksum) · Storage · Invariants ·
Version/Schema · Outbox count · Conflicts · Last restore drill. Any red = banner on every screen. Silence = failure.
A **Sync Reconciliation** screen lists UNKNOWN ops, pending outbox, rejected mutations, conflicts — nothing financial is
ever auto-"fixed".

Restore drill (Phase 6 gate, repeated every 6 months): fresh Supabase project → run migrations → `pg_restore` →
point a preview deployment at it → run Playwright suite → compare invoice count/totals with production.
Also drilled once into a local Docker Postgres to prove provider-independence.

---

## 7. DATA MODEL

### 7.1 Tenancy & auth
- `tenants` (name, slug, plan, status, gstin, address, settings jsonb)
- `shops` (tenant_id, name, code, address, invoice_prefix, is_default) — v1 UI uses one; schema allows many
- `tenant_users` (tenant_id, user_id → auth.users, role[owner|manager|cashier|accountant], shop_ids uuid[], status)
- `invites`, `devices` (tenant_id, user_id, device_id, last_seen, app_version, revoked_at)
- Claims (`tenant_id`, `role`, `shop_ids`) injected by Supabase Access Token Hook. **Fallback:** every RLS policy
  also works via `tenant_users` lookup (`current_tenant()` function tries claim first, then table). Portable.

### 7.2 Master data
- `items` (name, sku, hsn, category_id, unit1/2/3, conv1/2, tax_info, min_stock, image_path, is_active)
- `item_barcodes` (item_id, barcode, unit_level) unique per tenant
- `item_prices` (item_id, shop_id null=all, kind[retail|wholesale|mrp|cost_last], unit_level, price_paise, effective_from, effective_to null=open) — history, never overwrite; EXCLUDE constraint prevents overlaps
- `categories`, `parties` (suppliers), `customers` (normalize/find helpers ported from DSB v62–63)

### 7.3 Transactions (header + line rows, never JSON blobs)
- `purchase_bills` / `purchase_bill_items` (bill image path, discount, extra charges — DSB v65 parity)
- `sale_invoices` / `sale_invoice_items` (entry_mode, conv snapshot, is_big_unit, unit_price, qty, line_total, discount)
- `payments` (kind[party|customer], party/customer_id, amount_paise, mode, ref) + `payment_allocations` (payment_id, doc_type, doc_id, amount_paise) — a table, not jsonb, so the Σ-allocations invariant and FKs are enforceable (multi-select allocation, DSB v57)
- `expenses`
- `sale_returns`/`sale_return_items`, `purchase_returns`/`purchase_return_items` (see §2)
- `stock_counts`/`stock_count_lines` (expected, counted, variance, reason, approved_by) → posts one adjustment movement.
  Replaces ad-hoc "edit stock" entirely.
- `stock_reservations` (order_id, item_id, qty, reserved_at, expires_at, released_at, release_reason)
- `purchase_batches` (item_id, shop_id, bill_item_id, qty_in, qty_remaining, unit_cost_paise, received_at) +
  `batch_consumptions` (sale_item_id, batch_id, qty, unit_cost_paise) — FIFO COGS, written only by `post_sale()`.
  v1 reports use FIFO if batches exist, else `cost_last`. Never recomputed retroactively.
- `stock_movements` append-only (item_id, shop_id, qty_delta_smallest, reason, ref_table, ref_id) — **only stock truth**;
  `stock_current` is a **plain table** (item_id, shop_id, on_hand, reserved, updated_at) maintained by an AFTER INSERT trigger on `stock_movements` (`+= qty_delta`) and by reservation changes. It is a projection, never the truth; a nightly invariant recomputes Σ movements and flags drift. Not a materialized view — MV refresh cannot be incremental.
- `orders` / `order_items` / `shop_customers` (Phase 8). `stock_current` exposes `on_hand`, `reserved`, `available`;
  `place_order()` reserves atomically (`available >= qty` check inside the same tx). Order state machine enforced by trigger:
  NEW → CONFIRMED → PREPARING → READY → DELIVERED, or → CANCELLED (releases reservation); expired reservations auto-release.

### 7.4 Control
- `audit_log` (user, device, table, row_id, action, before, after, at)
- `permissions` (code) + `role_permissions` (role, code) — RLS/RPC check `has_perm('VIEW_COST')`, never hard-coded role names in app code. Adding a role = rows, not code.
- `feature_flags` (tenant_id, key, enabled) — Phase 9, for gradual rollout.
- `doc_sequences` (tenant, shop, series, next_no) + `next_doc_no()` RPC with row lock
- `sync_conflicts`, `backup_runs`, `exports`, `webhook_events` (Phase 9)
- `schema_meta` (current_version, min_supported_version) — read by clients at sync start (§9 negotiation)
- **Idempotency:** unique index on `(tenant_id, client_id)` for every table that accepts client-originated inserts.

### 7.5 Immutability
`sale_invoices.status`: draft → finalized → voided. Trigger denies UPDATE on finalized rows except status→voided.
Same for purchase bills and payments. Edit = `void_*()` RPC + new draft. Void writes reversing `stock_movements`.

---

## 8. SECURITY

- RLS on every table: `tenant_id = current_tenant()` + role per verb.
  cashier: read items/customers/prices; insert draft invoices/payments; no price/item updates; no deletes.
  manager: + items/prices/purchases/adjustments. owner: + settings/users/exports/void. accountant: read + export.
- Anon (storefront): SELECT on `public_catalog` view only (name, price, unit, image, in_stock, slug).
  Orders via `place_order()` RPC; server looks up price; client price ignored.
- Storage RLS by path prefix `{tenant_id}/…`. Images compressed client-side to ≤150KB; bill images auto-purged after 90 days (configurable) to stay under free quota.
- Signups enabled; fresh user has no tenant until `create_tenant()` or invite accept → RLS returns 0 rows.
- Email verification; strong password policy; TOTP optional for owner.
- Service-role key exists only in GitHub Actions secrets / Edge Functions. Never in browser, never in cron-job.org.
- Backup role = SELECT-only DB role; dumps encrypted; private key offline.
- pgTAP asserts: cross-tenant isolation on every table, role escalation impossible, anon sees only the view,
  immutability trigger holds, `next_doc_no` has no duplicates under concurrency. CI fails otherwise.
- Dependency audit (`pnpm audit`) in CI; Sentry for runtime errors with scrubbing of phone, address, invoice payloads.
- Hosting headers: CSP (self + Supabase URL + CDN allowlist), HSTS, X-Content-Type-Options, Referrer-Policy,
  Permissions-Policy, frame-ancestors 'none'. Protected `main`, required CI, pinned Actions, lockfile committed.
- Auth portability caveat: GoTrue → self-hosted GoTrue keeps bcrypt hashes; any *other* auth provider = forced
  password reset. Auth migration gets its own Phase 6 test.
- Security regression suite runs every release: cross-tenant read/write, cashier→manager escalation, anon→private,
  storage path bypass, order-token guessing, finalized-invoice edit, payment edit, direct `stock_movements` insert.

---

## 9. SYNC (offline-first, multi-device)

- Dexie mirrors synced tables + `outbox` + `meta` (cursor per table).
- Write: UI → Dexie (optimistic) → outbox {op, table, client_id, payload} → pusher (ordered, backoff, idempotent by `client_id`).
- Pull: `(updated_at, id) > cursor` (server clock; tie-break by id so equal-millisecond rows are never skipped),
  LWW per row for master data only, `deleted_at` → local removal, cursor advanced after commit.
- Cursor safety: pull uses `updated_at <= server_now() - 1s` to avoid reading rows written in the same millisecond
  the cursor is saved.
- Finalized docs are immutable → no conflicts by design. Master-data conflicts → `sync_conflicts` + "Needs review" tray.
- Offline invoice numbering: provisional `T-<device>-<n>`, finalized on sync via `next_doc_no()`; receipt shows
  "provisional" until then. Owner setting: allow/deny offline finalization.
- Realtime adapter → polling fallback automatically.

---

## 10. PROFESSIONAL UI (DSB parity + upgrade, not redesign for its own sake)

- Keep every DSB workflow that works (billing keystrokes, 3 entry modes, peek widget, multi-select payments).
- Add: consistent design tokens (spacing, type scale, color roles), keyboard map shown in-app, empty/loading/error
  states everywhere, undo toasts for reversible actions, confirmation for irreversible ones, print preview,
  dark mode, Hindi/English strings from day one (i18n table, English default), accessibility basics (focus, contrast).
- Storefront: fast catalog (search, categories, images), cart, order status, WhatsApp share of order.
- Error taxonomy, one message per class, never "Something went wrong": user error (fix and retry) · offline
  ("saved locally, will sync") · auth expired (re-login, draft kept) · server error ("not saved; your draft is preserved").
- Imports (Excel/CSV) and restores follow upload → validate → preview (✓/⚠/❌ counts) → confirm → apply; restore
  also creates a restore point first. Never write on upload.
- Mobile-first admin: bottom nav (Home · Sales · Orders · Stock · More) + quick actions; dashboard leads with today's
  numbers and actions, not charts.
- Every screen ships with a Playwright smoke test.

---

## 11. DEPLOYMENT MODELS (answers "one Supabase per friend?")

**Model A — one deployment per shop (Phase 8, free):** yes, this works. Each shop = its own free Supabase
project + its own `config/env.<shop>.json` + same app build. The app reads config at load (or per-subdomain:
`ramu.dsbpro.in` → ramu's project). Backups workflow runs per project (matrix in GitHub Actions). You are admin of
N projects via `apps/superadmin` (health, last backup, version). Schema still carries `tenant_id`, so any shop can
later be merged into Model B with one script. Limits: Supabase Free allows 2 active projects per org by default —
each friend creates their *own* Supabase account and invites you as org member (also keeps their data legally theirs).

**Model B — one multi-tenant project (Phase 9, $25/mo, sellable):** many shops in one DB isolated by RLS.
Same code, `tenant_id` from claims. Only choose this when someone is paying.

Both models run the same codebase; the difference is config + who owns the Supabase account.

---

## 12. TESTING & GATES

- `packages/core` ≥95% coverage; golden tests from 50 real DSB invoices, totals to the paisa.
- pgTAP suite (§8). Playwright: login → item → purchase → 3-mode sale → payment → void → export.
- Concurrency: two devices sell from stock 5 (4 + 4) → exactly one succeeds; two identical `client_id` submits → one invoice.
- Performance (Phase 6 gate): 10k items, 100k invoices, 3 devices, throttled 3G — billing screen < 300ms search, sync < 60s full pull.
- Chaos suite (Phase 5): airplane mode mid-invoice, two devices same item, app kill, backend down for 1h.
- Lighthouse PWA ≥ 90; admin bundle < 250KB gz.
- Human gate per phase: Apd runs it one real shop day alongside DSB before phase closes.

---

## 13. PHASES (strict; each gate must pass)

**Phase 0 — Foundations + backup pipeline (week 1)**
Repo, scaffold, CI, Cloudflare Pages + GitHub Pages mirror, Supabase dev project, migrations pipeline, Sentry,
`infra/backup.yml` running nightly against the empty dev DB, `backup_runs` health card.
Gate: CI green; two hosting mirrors serve the same build; a backup file lands encrypted in 2 destinations; restore.md draft.

**Phase 1 — Tenancy, auth, RLS (weeks 2–3)**
Tables §7.1 + `audit_log` + `doc_sequences` + `devices`; access-token hook + table fallback; RPCs
`create_tenant/accept_invite/next_doc_no`; all RLS; pgTAP suite; login/signup/invite/device UI.
Gate: pgTAP 100%; two tenants provably isolated; cashier cannot escalate; auth works with hook disabled (fallback proven).

**Phase 2 — Core library (week 4)**
Port units/pricing/totals/discount/extra-charges/`calcBigEquiv` into `packages/core` with golden tests.
Gate: 50 real DSB invoices match to the paisa.

**Phase 3 — Master data + purchases, online-only (weeks 5–6)** — parallel data entry with live DSB; DSB stays authoritative until Phase 7
Items/barcodes/price history/images (storage adapter + compression + purge), categories, parties, purchase bills →
stock_movements, stock_current, peek widget component.
Gate: one week of real purchases entered; stock matches physical count.

**Phase 4 — Sales POS + customers + payments (weeks 7–9)**
Keyboard-first billing, barcode, 3 entry modes, customer ledger, multi-select allocation, void flow,
thermal + A4 print, i18n scaffolding, UI tokens (§10).
Gate: one real shop day in parallel with DSB; end-of-day totals reconcile.

**Phase 5 — Offline-first sync (weeks 10–11)**
Dexie schema, outbox, cursors, LWW, tombstones, provisional numbering, conflict tray, device registry,
realtime→polling fallback. Chaos suite.
Gate: zero data loss across chaos suite; no resurrected deletes; no duplicate numbers under concurrency; app bills for 1h with backend unreachable and syncs cleanly after.

**Phase 6 — Ledgers, reports, exports, DR drill (week 12)** — incl. stock counts, RPO/RTO measurement, key-recovery-from-paper drill, auth export/import test
Party/customer ledgers, day book, stock valuation, GST summary, expenses, full export, nightly JSON export,
device snapshot backup.
Gate: **restore drill passes into (a) fresh Supabase project and (b) local Docker Postgres**; storage adapter switched to R2 and back in a preview deploy; RUNBOOK.md complete.

**Phase 7 — Migration & cut-over (week 13)**
DSB → DSB Pro import script (dry-run + diff report), 1 week parallel run, DSB frozen read-only, archived.
Gate: Apd sign-off; first real backup of real data verified by restore.

**Phase 8 — Storefront + orders + per-shop deployments (weeks 14–16)**
`public_catalog`, `place_order()`, cart, order status, admin Orders tab, realtime; `deploy-tenant.md`;
`apps/superadmin` health board; first friend deployment (Model A).
Gate: anon pen-check (no cost/purchase data, cannot set price); a friend's shop deployed by checklist in < 1 hour with backups running.

**Phase 9 — Sellable SaaS (only with a paying shop)**
Multi-tenant Model B on Supabase Pro, onboarding wizard, plans, Razorpay, staff per-screen gating, multi-shop UI,
privacy/ToS, support inbox.
Gate: an external shop completes a 14-day trial without you touching their data.

**Priority guard:** Phases 0–7 are the product. If any Phase 8/9 idea appears during 0–7 it goes into
docs/BACKLOG.md, not into code. Order of concern inside every phase: billing → inventory → customers →
suppliers → payments → reports → backup → recovery. UI polish never blocks a gate.

Timeline [Guessing]: 13 weeks to "trustworthy for Apd", 16 to "friends", Phase 9 when justified.

---

## 14. RUNBOOK CONTENTS (docs/RUNBOOK.md, written during phases, not after)

Backup verify · Restore (Supabase / Docker) · Rotate anon key · Rotate backup role password · Revoke a device ·
Suspend/restore a user · Storage provider switch · Hosting mirror switch · "Supabase is down" (app still works; what to tell staff) ·
"Free tier discontinued" (self-host playbook, ~1 evening) · Semi-annual drill checklist.

---

## 15. SESSION PROTOCOL (paste at top of every new chat)

```
You are lead engineer of DSB Pro. Sources of truth: DSB_PRO_BUILD_PLAN.md v1.5, docs/HANDOVER.md, provided repo files.
Current phase: <N>. Last completed change-set: <id>.
Rules: plan before code; one change-set per reply (what + where + diff + verification output);
SQL migration before code; standard columns on every table; RLS + pgTAP for every new table; no client DELETE;
server-set updated_at; escape at render only; providers only behind adapters; never print full files;
never "done" without output. If ambiguous, ask ONE question. Flag security/sync/data-loss risks BEFORE code.
End of session: append delta to docs/HANDOVER.md only.
Treat this as a production financial system: for every phase list silent data-corruption risks before crashes.
No phase closes until invariant tests, failure tests, restore tests and real-shop reconciliation pass.
Financial events are never lost to LWW/conflict resolution. Stock and balances are derived from immutable ledgers.
Old DSB behaviour is locked by golden tests before any refactor.
```

---

## 16. DEFINITION OF DONE (project A: own shop)

- 30 days of real shop data with zero app-caused corrections.
- Backups: 3 copies, health card green, restore drilled twice (Supabase + Docker).
- Every layer's fallback exercised once.
- Full export opened outside the app.
- CI/pgTAP/Playwright green on `main`. RUNBOOK complete.

---

## 17. ARCHITECTURE FREEZE

v1.4 is the locked specification. Further review targets the *implementation* (migrations, RLS, RPCs, sync code)
against this document, not the document itself. New ideas → docs/BACKLOG.md (currently: approval workflows for large
voids/discounts; data-retention policy matrix; feature flags UI).

## 18. DECISIONS NEEDED BEFORE PHASE 0

1. Thermal printer model/width in the shop today?
2. GST-registered shop? (drives invoice format)
3. Cashiers may finalize offline (provisional numbers) or draft-only offline?
4. Backup private key custody: **two independent physical copies** (printed QR in shop safe + sealed copy with one trusted person). Key-recovery is a formal drill in Phase 6 (decrypt a dump using only the paper copy). Losing the key = backups unreadable.
5. Domain now (`dsbpro.in`-style, ~₹1000/yr) or free subdomain until Phase 8?
