# DSB Pro — Remaining Build Plan, Architecture and Detailed Design

> **SUPERSEDED.** Replaced by [`docs/COMPLETE_REMAINING_BUILD_PLAN.md`](./COMPLETE_REMAINING_BUILD_PLAN.md) (v1.1), adopted 2026-09-23 after a second debate round found eight design gaps in this file's Batch C–G design (cross-shop allocation, an unrunnable acceptance test, missing opening-balance settlement, no uncertain-outcome payment recovery, an allocation-ID namespace collision, and others). This file is retained for history only. Do not implement from it; do not combine its SQL/migration numbers with the adopted plan's.

**Status:** DRAFT FOR DEBATE. No implementation is authorized by this file until the user approves it after the debate.
**Prepared:** 2026-09-22 against `main` = `cc9c64c463526e84210df520ee534847465ae1f6` (Batch B merged; hotfix PR #35 approved, not yet merged).
**Supersedes for Batches C–G:** `DSB_PRO_REPAIR_AND_BUILD_EXECUTION_PLAN_v2` (its Batch C–G sections were outlines; this file is the executable design).
**Audience:** an implementing model that must be able to follow this without improvising. Every SQL object, file path and trap below was verified in the repository on the date above.

---

## 0. How to use this document (read first, every session)

### 0.1 Rules for the implementing model

1. **Do exactly one Work Packet (WP) per PR.** Each WP lists its files, migration, tests and acceptance checks. Do not merge WPs.
2. **Never edit an existing migration file.** All database changes are new numbered files. `0001`–`0043` are immutable.
3. **Copy, don't retype.** When this plan says "copy the body of X from migration N verbatim and change only line Y", open that migration, copy the whole function, change only the stated line. Retyping long SQL is how silent regressions happen.
4. **Test first.** Write the pgTAP / unit / E2E test for the WP, run it against the pre-change code, confirm it fails for the expected reason, then implement.
5. **Stop conditions (stop and report instead of improvising):**
   - A verified fact in §2 turns out false in the repo you are looking at.
   - A test in this plan cannot be made to pass without changing a rule in §3.
   - You need a new table, permission, or RPC signature not named in this plan.
   - Any existing test starts failing and the fix is outside the WP's file list.
   - CI is red for a reason you cannot name precisely.
6. **Every conditional JSX sibling block gets a stable `key`.** (Lesson from the held-cart bug, which recurred three times. See §3.9.)
7. **Money is integer paise, quantities go through `@dsb-pro/core` fixed-point helpers.** Never `Math.round(x*100)`, never `Number(qty)*price`. (Batch B contract.)
8. **No deployment, no live migration** in any WP. Those are separate attended operations (§9).

### 0.2 PR template (fill every heading)

```
## Work packet
<WP id and title from REMAINING_BUILD_PLAN.md>
## Invariant
## Pre-fix reproduction (failing test name + failure message)
## Implementation (files touched)
## Migration / rollback behaviour
## Tests added
## Security impact
## Offline impact
## Unresolved risks
## Evidence (exact head SHA, CI run ids for two unchanged-head green runs)
```

### 0.3 Merge gate (unchanged from Batches A/B)

Draft PR → independent review of the exact head → **two** green CI runs on the **unchanged** head → merge → verify the post-merge `push` run on `main` shows `deploy` and every live-migration job `skipped`.

---

## 1. Remaining scope at a glance

| Order | Batch | Work packets | Migrations | Nature |
|---|---|---|---|---|
| P0 | Pre-flight | P0.1–P0.3 | none | Merge #35, fix stale docs |
| 1 | C — Supplier payments | C1–C4 | 0044 | New feature, money-out |
| 2 | D — Reports, settings, export, health | D1–D5 | 0045, 0046 | Correctness fixes + wiring |
| 3 | E — Shell + automated dry run | E1–E6 | none | UI only |
| — | Human gates H1–H4 | — | — | Real shop evidence |
| 4 | F — Phase 7 cutover | F1–F5 | 0047, 0048 | Numbering, importer, cutover |
| 5 | G — Phase 8 | outline only | re-plan | Storefront, after cutover |

Estimated engineering sessions (floor, not forecast — Batch A ran 3× its estimate): C 2–3, D 3–4, E 3–4, F 4–6. Human gates add calendar time that cannot be compressed.

---

## 2. Verified current state (ground truth, 2026-09-22)

### 2.1 Database objects the remaining work builds on

| Object | Location of latest definition | Relevant facts |
|---|---|---|
| `payments` | 0023 + 0036 | `kind in ('customer','party','walkin')`; `direction in ('in','out')` default `'in'` (0036); identity check: `kind='party'` ⇒ `party_id not null, customer_id null`; `status in ('POSTED','VOID')`; `unique(tenant_id,client_id)` |
| `payment_allocations` | 0023 | `doc_type in ('SALE','PURCHASE')`; `purchase_bill_id` FK exists; `unique(tenant_id,client_id)`; insert trigger `allocation_validate` → `phase4_validate_allocation()` |
| `phase4_validate_allocation()` | **0036** | **Rejects any payment whose `direction<>'in'`** — supplier payments are `'out'` → blocked today (trap §3.1) |
| `check_invariants()` | **0039** | `paymentDirectionViolations` counts every POSTED allocation whose payment `direction<>'in'` → supplier allocations would fail health (trap §3.2). `bad_refunds` is keyed on `sale_returns` only (safe) |
| `void_payment(uuid)` | 0023 | Requires `VOID_SALES` (owner only). Voids allocations then payment |
| `phase65_refund_payment_void_guard` | 0037 | Only acts on `source_sale_return_id` rows or `direction='in'`; supplier payments pass through (safe) |
| `phase4_payment_guard` | 0036 | Payments immutable except POSTED→VOID with identical fields |
| `payments_read` policy | 0023 | `tenant_id=current_tenant_id()` only — **cashiers can read supplier payments** (trap §3.3) |
| `purchase_bills_read` policy | 0034 | Requires `POST_PURCHASES` or `VIEW_REPORTS` |
| `purchase_bills` | 0017 | `party_id` **nullable**; `bill_no` is the supplier's number (no own doc_no); `status in ('POSTED','VOID')` |
| `purchase_returns` | 0036 | `status in ('DRAFT','POSTED','VOID')`, `total_paise`, `purchase_bill_id`, `party_id` |
| `get_party_ledger` | 0036 | Balance = Σ(debit−credit): PURCHASE debit, PURCHASE_RETURN credit, PAYMENT `out` credit / `in` debit. **Already correct for supplier payments** |
| `get_day_book` | 0036 | `payments_paise` = Σ party payments `out` minus `in`. **Already correct** |
| `customer_invoice_outstanding` view | 0036 | Current-state only (not as-of) |
| `get_customer_aging_report` | 0040 | Uses the current-state view → wrong for historical as-of dates (trap §3.5) |
| `get_item_sales_report` | 0040 | Sold side uses `line_total_paise` (pre header-discount), return side uses allocated `amount_paise` (trap §3.6) |
| `phase65_sale_line_cap(line_id)` | 0036 | Allocated net merchandise value of a sale line (header discount distributed). **Reuse it** |
| `update_shop_settings` (9 args) | 0039 | Owner **or manager** may change everything incl. `allow_negative_stock`; timezone only checked non-empty (trap §3.7) |
| `next_doc_no(shop, series)` | 0022 | Per `(tenant,shop,series)` counter; sale doc_no uses `coalesce(invoice_prefix,'INV')` |
| `sync_idempotency_keys` | 0029 | `(tenant_id, operation, op_client_id, payload jsonb)` unique on first three — **reuse for supplier-payment idempotency** |
| Permissions | 0017/0022/0030 | `POST_PURCHASES` (owner, manager); `VIEW_REPORTS` (owner, manager, accountant); `VOID_SALES` (owner); `EXPORT_DATA` (owner, manager, accountant); `POST_SALES` (owner, manager, cashier) |
| Legacy importer | 0027 + `packages/core/src/legacyDsbImport.ts` | Masters, parties, customers, opening stock only. No purchases/payments/opening balances |

### 2.2 Application layer

| Area | Fact |
|---|---|
| Routes | `apps/admin/src/App.tsx` — flat link list, no bottom nav; routes: signup, join, team, devices, inventory, pos, customers, salesHistory, sync, reports, returns, settings |
| i18n | `apps/admin/src/lib/i18n.ts` — **9 keys total**; almost all UI text is hardcoded English |
| Dark mode | `style.css` has `prefers-color-scheme: dark` tokens; no manual toggle; print styles not verified in dark |
| Receipt | `PosScreen.tsx:~231` and `SalesHistoryScreen.tsx:~89` hardcode `<h1>DSB Store</h1>`; printer width not applied |
| Health | `packages/adapters/src/reports.ts` `InvariantHealth` has 6 fields; SQL returns 12; `HealthPanel.tsx` renders the 6 |
| Nightly export | `.github/workflows/phase6-json-export.yml` `schemaVersion: 3`; includes payments, allocations, expenses, stockCounts; **no sale/purchase returns** |
| Migration gate | `supabase/phase6-upgrade-manifest.txt` groups: foundation, hardening, phase65, batcha, batchb; `scripts/inspect-phase6-upgrade-state.sh` fail-closed classifier; `scripts/apply-phase6-upgrade.sh <url> <group...>` atomic per call |
| Tests | pgTAP last file `supabase/tests/0034_*`; E2E specs in `apps/admin/e2e/` |
| Adapters | one module per domain in `packages/adapters/src/`, re-exported from `index.ts`; errors via `classifyError`/`errorMessage` |

---

## 3. Trap register (verified pitfalls — each has a mandatory test)

| # | Trap | Consequence if missed | Mandatory handling |
|---|---|---|---|
| 3.1 | `phase4_validate_allocation` rejects `direction<>'in'` | Every supplier allocation raises `payment unavailable` | C1 rewrites the validator direction-aware |
| 3.2 | `paymentDirectionViolations` counts any non-`in` allocation | Invariant health = FAIL after first supplier payment | C1 redefines the invariant: SALE⇔`in`+`customer`, PURCHASE⇔`out`+`party` |
| 3.3 | `payments_read` is tenant-wide | Cashier can read supplier payment amounts (cost confidentiality leak, same class as A1) | C1 restricts `kind='party'` rows and PURCHASE allocations to `POST_PURCHASES`/`VIEW_REPORTS` |
| 3.4 | Purchase return after full payment makes bill net negative | A naïve "allocated > net" invariant flags a legitimate supplier credit | Do **not** add such an invariant. Per-bill outstanding clamps at 0; the party ledger carries the credit |
| 3.5 | Aging uses current-state outstanding | Historical aging includes future invoices and later payments | D1 adds an as-of outstanding function |
| 3.6 | Item-sales sold side ignores header discount | Full return of a discounted invoice shows non-zero net sales | D1 uses `phase65_sale_line_cap` on the sold side |
| 3.7 | Manager can toggle negative stock; any timezone text accepted | Policy violation; invalid timezone breaks `shop_business_date` and blocks posting | D2 enforces owner-only change and validates against `pg_timezone_names` |
| 3.8 | Nightly export lacks returns | Portable restore loses return documents | D3 bumps to schema v4 and adds a coverage test that fails when any tenant table is missing |
| 3.9 | Conditional JSX siblings without `key` | Preact positional reconciliation rebuilds later siblings → lost input (held-cart bug ×3) | Rule §0.1-6 + E-series review checklist item |
| 3.10 | `purchase_bills.party_id` nullable | Allocation to a party-less bill | Outstanding view excludes party-less bills; allocation validator rejects |
| 3.11 | Supplier and customer payments share `payments.client_id` namespace | Accidental cross-type idempotent replay | Supplier idempotency uses `sync_idempotency_keys.operation='record_supplier_payment'` with full-payload comparison |
| 3.12 | Deadlock when two payments allocate the same bills in different orders | Intermittent 40P01 under concurrency | Insert allocations ordered by `purchase_bill_id` |

---

## 4. Global conventions (apply to every WP)

### 4.1 Migration file skeleton

```sql
-- <nnnn>_<phase>_<topic>.sql
-- Purpose: <one paragraph>. Forward-only; replaces <objects> defined in <migrations>.
set local search_path = public, pg_temp;
-- fail-closed preconditions (raise if the database is not in the expected state)
-- objects
-- revoke/grant for every function (revoke from public,anon; grant to authenticated only if user-callable)
```

### 4.2 RPC pattern (copy of the proven Batch A/B pattern)

1. `client_id` required, non-blank.
2. Permission check with `has_perm(...)` — never trust an argument for role.
3. `v_tenant := phase3_assert_shop(p_shop_id)`.
4. `perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':<operation>:'||p_client_id,0));`
5. Idempotency lookup → exact payload comparison → return existing id, or raise `client_id payload mismatch`.
6. Validate inputs → insert → return id.
7. `security definer set search_path=public`; `revoke all ... from public,anon; grant execute ... to authenticated;`

### 4.3 Migration gate extension recipe (every WP that adds a migration)

1. Append rows to `supabase/phase6-upgrade-manifest.txt` with a new group name.
2. In `scripts/inspect-phase6-upgrade-state.sh`: add one CTE for the group with the signals listed in the WP, add it to `read -r`, the `select`, `emit_state`, and add exactly one new valid state line (previous full state + `:0`, and full state + `:<n>`). Keep the `*)` refuse branch.
3. In `scripts/apply-phase6-upgrade.sh`: add the group to the accepted list and to `all`.
4. In `.github/workflows/ci.yml` `phase6_db_upgrade_proof`: add `apply <group>` + `assert_state` after the previous group; add the group's live-verify signals to both the disposable and live verify SQL blocks.
5. In the `phase6_db_upgrade` job: add a step `Apply <group> atomically` gated by `steps.preflight.outputs.needs_<group> == 'true'`.

### 4.4 Test numbering

pgTAP: next is `supabase/tests/0035_*.sql`. E2E: one new spec per screen. Unit tests beside source (`*.test.ts`).

### 4.5 UI conventions (binding from E1 onward, and for any new screen in C/D)

- All user-facing strings through `t()` (§6 E1).
- Every screen: loading, empty, error (taxonomy §6 E2), success states.
- Every conditional sibling block: stable `key`.
- Money display: `money(paise)`; money input parsing: `parseRupeesToPaise` from `@dsb-pro/core`.
- Every new screen ships with a Playwright spec.

---

## 5. Batch C — Supplier payments

**Goal:** record money paid to suppliers, allocate it to purchase bills (fully, partially, or as an unallocated advance allocated later), void it, and see correct supplier balances everywhere — without breaking any existing invariant.

**Decisions (debate items D-C1..D-C4 in §12):** advances allowed; online-only (no offline queue); post = `POST_PURCHASES` (owner, manager); void = `VOID_SALES` (owner only); cashier sees nothing.

### WP C1 — Migration `0044_phase65_supplier_payments.sql`

**Contents, in this order:**

**(a) Precondition**

```sql
do $pre$ begin
  if exists(select 1 from payment_allocations where doc_type='PURCHASE') then
    raise exception 'unexpected pre-existing PURCHASE allocations; stop and inspect before migrating';
  end if;
  if exists(select 1 from payments where kind='party') then
    raise exception 'unexpected pre-existing party payments; stop and inspect before migrating';
  end if;
end $pre$;
```

(Rationale: no RPC has ever created party payments; if any exist, the live database differs from our model — stop condition.)

**(b) Single source of truth for bill outstanding**

```sql
create view purchase_bill_outstanding with(security_invoker=true) as
with alloc as (
  select pa.tenant_id, pa.purchase_bill_id, sum(pa.amount_paise)::bigint allocated_paise
  from payment_allocations pa
  join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id
  where pa.doc_type='PURCHASE' and pa.status='POSTED' and p.status='POSTED' and p.direction='out'
  group by pa.tenant_id, pa.purchase_bill_id
), ret as (
  select tenant_id, purchase_bill_id, sum(total_paise)::bigint returned_paise
  from purchase_returns where status='POSTED'
  group by tenant_id, purchase_bill_id
)
select b.tenant_id, b.shop_id, b.party_id, b.id purchase_bill_id, b.bill_no, b.business_date, b.total_paise,
  coalesce(r.returned_paise,0)::bigint returned_paise,
  coalesce(a.allocated_paise,0)::bigint allocated_paise,
  (b.total_paise-coalesce(r.returned_paise,0)-coalesce(a.allocated_paise,0))::bigint net_outstanding_paise,
  greatest(b.total_paise-coalesce(r.returned_paise,0)-coalesce(a.allocated_paise,0),0)::bigint outstanding_paise
from purchase_bills b
left join alloc a on a.tenant_id=b.tenant_id and a.purchase_bill_id=b.id
left join ret r on r.tenant_id=b.tenant_id and r.purchase_bill_id=b.id
where b.status='POSTED' and b.deleted_at is null and b.party_id is not null;
```

- `net_outstanding_paise` may be negative (supplier credit after a return). `outstanding_paise` is what may still be allocated.
- `security_invoker=true` → cashier RLS on `purchase_bills` hides every row. Do not grant anything extra.

**(c) Direction-aware allocation validator** — `create or replace function phase4_validate_allocation()`:

- Copy the 0036 body verbatim.
- Change the first check to `if not found or v_payment.status<>'POSTED' then raise exception 'payment unavailable'; end if;`
- At the top of the `SALE` branch add `if v_payment.direction<>'in' then raise exception 'payment unavailable'; end if;` — the rest of the SALE branch stays byte-identical.
- Replace the whole `else` (PURCHASE) branch with:

```sql
 else
   if v_payment.direction<>'out' or v_payment.kind<>'party' then
     raise exception 'supplier allocation requires an outgoing party payment';
   end if;
   perform 1 from purchase_bills b
     where b.id=new.purchase_bill_id and b.tenant_id=new.tenant_id and b.status='POSTED' for update;
   if not found then raise exception 'purchase unavailable'; end if;
   select o.party_id, o.outstanding_paise into v_party, v_doc_total
     from purchase_bill_outstanding o
     where o.tenant_id=new.tenant_id and o.purchase_bill_id=new.purchase_bill_id;
   if not found or v_party is distinct from v_payment.party_id then
     raise exception 'payment and purchase party mismatch';
   end if;
   if new.amount_paise>v_doc_total then
     raise exception 'allocation exceeds document outstanding amount';
   end if;
   return new;
 end if;
```

(The SALE branch keeps its own final comparison. The `for update` on the bill serialises concurrent allocations to the same bill.)

**(d) Invariant correction** — `create or replace function check_invariants()`:

- Copy the **0039** body verbatim. Change only the `bad_payment_direction` statement to:

```sql
 select count(*) into bad_payment_direction from payment_allocations a
   join payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
  where a.tenant_id=v_tenant and a.status='POSTED' and (
    p.status<>'POSTED'
    or (a.doc_type='SALE' and (p.direction<>'in' or p.kind not in ('customer')))
    or (a.doc_type='PURCHASE' and (p.direction<>'out' or p.kind<>'party'))
  );
```

- Do **not** add any "allocated > bill net" invariant (trap 3.4). `bad_alloc` (Σ allocations ≤ payment amount) already covers supplier payments.

**(e) Confidentiality** — replace the two read policies:

```sql
drop policy payments_read on payments;
create policy payments_read on payments for select using(
  tenant_id=current_tenant_id()
  and (kind<>'party' or has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
);
drop policy payment_allocations_read on payment_allocations;
create policy payment_allocations_read on payment_allocations for select using(
  tenant_id=current_tenant_id()
  and (doc_type<>'PURCHASE' or has_perm('POST_PURCHASES') or has_perm('VIEW_REPORTS'))
);
```

Before writing, grep every `security definer` function selecting from `payments`/`payment_allocations` that a cashier can call (sync pull, receipts, customer ledger). Record in the PR which ones could return `kind='party'` rows and add a filter or prove none can. Same method as A1's six-function triage.

**(f) `record_supplier_payment`**

```sql
create function record_supplier_payment(
  p_shop_id uuid, p_party_id uuid, p_business_date date, p_amount_paise bigint,
  p_mode text, p_reference text, p_allocations jsonb, p_client_id text
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_tenant uuid; v_payment uuid; v_stored jsonb; v_request jsonb; v_row record; v_sum bigint:=0;
begin
  if p_client_id is null or btrim(p_client_id)='' then raise exception 'client_id required'; end if;
  if not has_perm('POST_PURCHASES') then raise exception 'not permitted'; end if;
  v_tenant:=phase3_assert_shop(p_shop_id);
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text||':supplier-payment:'||p_client_id,0));

  v_request:=jsonb_build_object('shop_id',p_shop_id,'party_id',p_party_id,'business_date',p_business_date,
    'amount_paise',p_amount_paise,'mode',p_mode,'reference',p_reference,
    'allocations',coalesce(p_allocations,'[]'::jsonb));
  select payload into v_stored from sync_idempotency_keys
    where tenant_id=v_tenant and operation='record_supplier_payment' and op_client_id=p_client_id;
  if v_stored is not null then
    if v_stored is distinct from v_request then raise exception 'client_id payload mismatch'; end if;
    select id into v_payment from payments where tenant_id=v_tenant and client_id=p_client_id;
    return v_payment;
  end if;

  if p_amount_paise is null or p_amount_paise<=0 then raise exception 'invalid payment amount'; end if;
  if p_mode is null or p_mode not in ('cash','upi','card','bank','other') then raise exception 'invalid payment mode'; end if;
  if not exists(select 1 from parties where id=p_party_id and tenant_id=v_tenant and deleted_at is null)
    then raise exception 'party not in tenant'; end if;
  if p_allocations is null or jsonb_typeof(p_allocations)<>'array' then raise exception 'allocations must be an array'; end if;
  if exists(select 1 from jsonb_array_elements(p_allocations) e
      where coalesce(e->>'amount_paise','') !~ '^[1-9][0-9]*$'
         or coalesce(e->>'purchase_bill_id','') !~ '^[0-9a-f-]{36}$') then
    raise exception 'invalid allocation';
  end if;
  if (select count(*) from jsonb_array_elements(p_allocations))
     <> (select count(distinct e->>'purchase_bill_id') from jsonb_array_elements(p_allocations) e) then
    raise exception 'duplicate bill allocation';
  end if;
  select coalesce(sum((e->>'amount_paise')::bigint),0) into v_sum from jsonb_array_elements(p_allocations) e;
  if v_sum>p_amount_paise then raise exception 'allocations exceed payment amount'; end if;

  insert into sync_idempotency_keys(tenant_id,operation,op_client_id,payload,client_id)
    values(v_tenant,'record_supplier_payment',p_client_id,v_request,'record_supplier_payment:'||p_client_id);
  insert into payments(tenant_id,shop_id,kind,party_id,business_date,amount_paise,direction,mode,reference,status,client_id)
    values(v_tenant,p_shop_id,'party',p_party_id,coalesce(p_business_date,shop_business_date(p_shop_id)),
           p_amount_paise,'out',p_mode,nullif(btrim(coalesce(p_reference,'')),''),'POSTED',p_client_id)
    returning id into v_payment;
  for v_row in
    select (e->>'purchase_bill_id')::uuid bill_id,(e->>'amount_paise')::bigint amount,
           row_number() over(order by e->>'purchase_bill_id') ord
    from jsonb_array_elements(p_allocations) e order by e->>'purchase_bill_id'
  loop
    insert into payment_allocations(tenant_id,payment_id,doc_type,purchase_bill_id,amount_paise,client_id)
      values(v_tenant,v_payment,'PURCHASE',v_row.bill_id,v_row.amount,p_client_id||':alloc:'||v_row.ord);
  end loop;
  return v_payment;
end $$;
revoke all on function record_supplier_payment(uuid,uuid,date,bigint,text,text,jsonb,text) from public,anon;
grant execute on function record_supplier_payment(uuid,uuid,date,bigint,text,text,jsonb,text) to authenticated;
```

The allocation trigger (c) enforces party match, bill status and per-bill outstanding. Empty `p_allocations` = pure advance.

**(g) `allocate_supplier_payment`** — allocate an existing advance later.

```sql
create function allocate_supplier_payment(p_payment_id uuid, p_allocations jsonb, p_client_id text)
returns void language plpgsql security definer set search_path=public as $$
-- 1 client_id required; has_perm('POST_PURCHASES')
-- 2 v_tenant:=current_tenant_id(); advisory lock on v_tenant||':supplier-allocation:'||p_client_id
-- 3 idempotency via sync_idempotency_keys operation='allocate_supplier_payment', payload={payment_id,allocations}
-- 4 select payment for update where id=p_payment_id and tenant_id=v_tenant and kind='party' and direction='out' and status='POSTED'
--   else raise 'supplier payment unavailable'; perform phase3_assert_shop(payment.shop_id)
-- 5 same allocation shape checks as (f)
-- 6 (existing POSTED allocations of this payment) + Σ new amounts <= payment.amount_paise else 'allocations exceed payment amount'
-- 7 insert ordered by purchase_bill_id, client_id = p_client_id||':alloc:'||ord
$$;
```

(Write the body following the comments exactly; same grants as (f).)

**(h) `void_supplier_payment`**

```sql
create function void_supplier_payment(p_payment_id uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_tenant uuid:=current_tenant_id(); v_payment payments%rowtype;
begin
  if not has_perm('VOID_SALES') then raise exception 'not permitted'; end if;
  select * into v_payment from payments where id=p_payment_id and tenant_id=v_tenant for update;
  if not found or v_payment.kind<>'party' or v_payment.direction<>'out' then raise exception 'supplier payment not found'; end if;
  if v_payment.status='VOID' then return v_payment.id; end if;
  perform phase3_assert_shop(v_payment.shop_id);
  update payment_allocations set status='VOID' where tenant_id=v_tenant and payment_id=v_payment.id and status='POSTED';
  update payments set status='VOID',voided_at=now() where id=v_payment.id;
  return v_payment.id;
end $$;
```

Do not change `void_payment`; it keeps serving customer payments.

**(i) Reports for suppliers**

```sql
create function get_supplier_outstanding(p_shop_id uuid)
returns table(party_id uuid, party_name text, bills_outstanding_paise bigint,
              unallocated_advance_paise bigint, ledger_balance_paise bigint)
-- phase6_assert_report_access(); phase3_assert_shop(p_shop_id)
-- bills_outstanding  = Σ purchase_bill_outstanding.outstanding_paise for the party and shop
-- unallocated_advance= Σ(payment.amount − Σ its POSTED allocations) for POSTED party 'out' payments in the shop
-- ledger_balance     = Σ purchases − Σ posted purchase returns − Σ 'out' payments + Σ 'in' party payments (shop-scoped;
--                      must equal the last running_balance of get_party_ledger restricted to the shop)
```

Grant like other reports.

**(j) Signals for the migration gate (group `batchc`, 3 signals)**

- `to_regprocedure('public.record_supplier_payment(uuid,uuid,date,bigint,text,text,jsonb,text)') is not null`
- `to_regclass('public.purchase_bill_outstanding') is not null`
- whitespace-stripped `pg_get_functiondef('public.phase4_validate_allocation()')` contains `supplierallocationrequiresanoutgoingpartypayment`

### WP C2 — pgTAP `supabase/tests/0035_phase65_supplier_payments.sql`

Required assertions (each a separate `ok`/`is`/`throws_ok`):

1. Partial allocation: bill 1000, pay 400 allocated 400 → outstanding 600.
2. Exact allocation → outstanding 0.
3. Multi-bill allocation in one payment.
4. Over-allocation on a bill → `allocation exceeds document outstanding amount`.
5. Allocations sum > payment → `allocations exceed payment amount`.
6. Duplicate bill in one request → `duplicate bill allocation`.
7. Pure advance (empty allocations) → `unallocated_advance_paise` = amount.
8. Later `allocate_supplier_payment` of the advance; cannot exceed remaining advance.
9. Allocation to another party's bill → `payment and purchase party mismatch`.
10. Allocation to a VOID bill and to a party-less bill → rejected.
11. Purchase return **before** payment reduces outstanding.
12. Purchase return **after** full payment is allowed; bill `net_outstanding_paise` negative, `outstanding_paise` 0, party ledger balance negative (supplier owes us). If `post_return` rejects this → STOP and report (unknown behaviour).
13. Void supplier payment → allocations VOID, outstanding restored, ledger restored, day book restored.
14. Idempotent retry with identical payload returns same id; changed payload → `client_id payload mismatch`.
15. Cashier: `record_supplier_payment` → `not permitted`; `select count(*) from payments where kind='party'` = 0; `select count(*) from purchase_bill_outstanding` = 0.
16. Manager can post, cannot void (`not permitted`); owner can void.
17. `check_invariants()->>'ok'` = true after every scenario above (the trap 3.2 regression test).
18. Customer payment path unchanged: existing customer allocation still works; customer payment with `direction='out'` allocation still rejected.
19. Cross-tenant: party/bill from another tenant rejected.

Plus a two-connection concurrency script `scripts/test-supplier-payment-concurrency.mjs` (copy the structure of `test-stock-recovery-concurrency.mjs`): two concurrent payments each allocating 600 against a 1000 bill → exactly one succeeds, the other fails with the outstanding error, invariants OK. Wire into the `pgtap` CI job after the existing concurrency steps.

### WP C3 — Adapter `packages/adapters/src/supplierPayments.ts`

```ts
export type SupplierAllocationInput={purchaseBillId:string;amountPaise:number};
export type RecordSupplierPaymentInput={shopId:string;partyId:string;businessDate?:string;amountPaise:number;
  mode:'cash'|'upi'|'card'|'bank'|'other';reference?:string;allocations:SupplierAllocationInput[];clientId:string};
export type PurchaseBillOutstanding={purchase_bill_id:string;party_id:string;bill_no:string|null;business_date:string;
  total_paise:number;returned_paise:number;allocated_paise:number;net_outstanding_paise:number;outstanding_paise:number};
export type SupplierOutstandingRow={party_id:string;party_name:string;bills_outstanding_paise:number;
  unallocated_advance_paise:number;ledger_balance_paise:number};

export async function recordSupplierPayment(i:RecordSupplierPaymentInput):Promise<string>   // rpc record_supplier_payment
export async function allocateSupplierPayment(i:{paymentId:string;allocations:SupplierAllocationInput[];clientId:string}):Promise<void>
export async function voidSupplierPayment(paymentId:string):Promise<string>
export async function listPurchaseBillOutstanding(partyId:string):Promise<PurchaseBillOutstanding[]> // from view, outstanding_paise>0, order business_date asc
export async function listSupplierPayments(partyId:string):Promise<…>  // payments where kind='party' and party_id, newest first, with allocated sum
export async function getSupplierOutstanding(shopId:string):Promise<SupplierOutstandingRow[]>
```

- Map allocation input to `{purchase_bill_id, amount_paise}` (snake_case) — the SQL keys.
- Validate client-side before calling: integers > 0, Σ ≤ amount (same rules; server remains authoritative).
- Errors via `classifyError`/`errorMessage`. Export all from `index.ts`.
- Unit test `supplierPayments.test.ts` with a mocked client (pattern: `shopSettings.test.ts`): payload shape, snake_case keys, client-side rejection cases.

### WP C4 — Screen `apps/admin/src/screens/SuppliersScreen.tsx` + route + E2E

**Route:** add `appRoute.suppliers` in `lib/paths.ts`, `<Route path={appRoute.suppliers} component={SuppliersScreen}/>` in `App.tsx`, link in home nav ("Suppliers & payments"). Hidden for cashier (check `useSession` membership role; server enforces anyway).

**Layout (each block with a stable key):**

1. `key="supplier-summary"` — table from `getSupplierOutstanding`: party, bills outstanding, advance, ledger balance.
2. `key="supplier-pick"` — select party.
3. `key="supplier-bills"` — open bills (`listPurchaseBillOutstanding`), each row with an allocation amount input (rupees text → `parseRupeesToPaise`) and a "Fill" button (sets outstanding).
4. `key="supplier-pay-form"` — date (default shop business date), amount (rupees text), mode, reference, computed "Allocated ₹X / Advance ₹Y", Pay button.
5. `key="supplier-history"` — past payments, allocated vs advance, "Allocate advance" (opens bill allocation with remaining advance), "Void" (owner only).
6. `key="supplier-ledger"` — `getPartyLedger(partyId)` table.

**Behaviour rules:**

- One `clientId` per form attempt (`useState(()=>crypto.randomUUID())`); regenerate only after success. Double-click → same clientId → idempotent.
- Online only: if `!navigator.onLine` disable Pay with message "Supplier payments need a connection."
- Confirm dialog before Pay showing party, amount, allocations, advance.
- After success: refresh summary, bills, history, ledger.

**E2E `apps/admin/e2e/suppliers.spec.ts`:** create party → post 2 purchase bills → pay partial to bill 1 + advance → verify outstanding and ledger balances → allocate advance to bill 2 → void as owner → balances restored → cashier cannot open the screen (redirect or no link) and receives `not permitted` via direct RPC.

**Batch C acceptance:** all C2 assertions, concurrency script, adapter tests, E2E, invariants `ok` in E2E after flows, disposable migration proof through `batchc`, two unchanged-head green runs.

---

## 6. Batch D — Reports, settings, print, export, health

### WP D1 — Migration `0045_phase65_report_corrections.sql`

**(a) Item-wise sales** — `create or replace function get_item_sales_report(uuid,date,date)` with the **same return columns**. Copy the 0040 body; change only the `sold` CTE:

```sql
 with sold as (
  select sii.item_id,max(sii.item_name_snapshot) item_name,sum(sii.base_qty) qty,
         sum(sii.line_total_paise)::bigint gross,
         sum(phase65_sale_line_cap(sii.id))::bigint net_merch
  from sale_invoice_items sii join sale_invoices si on si.tenant_id=sii.tenant_id and si.id=sii.sale_invoice_id
  where sii.tenant_id=v_tenant and sii.shop_id=p_shop_id and si.status='FINALIZED' and si.business_date between p_from and p_to
  group by sii.item_id
 ), ...
```

and `net_sales_paise = coalesce(sold.net_merch,0) - coalesce(returned.amt,0)`. `gross_sales_paise` stays `line_total` sum (pre header discount) — document this in a SQL comment.

**(b) As-of customer outstanding** — new function:

```sql
create function customer_invoice_outstanding_as_of(p_as_of date)
returns table(tenant_id uuid, customer_id uuid, sale_invoice_id uuid, shop_id uuid, business_date date, outstanding_paise bigint)
language sql stable security definer set search_path=public as $$
 with inv as (
   select s.* from sale_invoices s
   where s.tenant_id=current_tenant_id() and s.customer_id is not null
     and s.status='FINALIZED' and s.deleted_at is null and s.business_date<=p_as_of
 ), alloc as (
   select pa.sale_invoice_id, sum(pa.amount_paise)::bigint v from payment_allocations pa
   join payments p on p.tenant_id=pa.tenant_id and p.id=pa.payment_id
   where pa.tenant_id=current_tenant_id() and pa.status='POSTED' and p.status='POSTED'
     and p.direction='in' and p.business_date<=p_as_of
   group by pa.sale_invoice_id
 ), ret as (
   select sale_invoice_id, sum(total_paise)::bigint v from sale_returns
   where tenant_id=current_tenant_id() and status='POSTED' and business_date<=p_as_of group by sale_invoice_id
 ), ref as (
   select source_sale_invoice_id sale_invoice_id, sum(amount_paise)::bigint v from payments
   where tenant_id=current_tenant_id() and status='POSTED' and direction='out'
     and source_sale_invoice_id is not null and business_date<=p_as_of group by source_sale_invoice_id
 )
 select i.tenant_id,i.customer_id,i.id,i.shop_id,i.business_date,
   greatest(i.total_paise-coalesce(r.v,0)-coalesce(a.v,0)+coalesce(f.v,0),0)::bigint
 from inv i left join alloc a on a.sale_invoice_id=i.id left join ret r on r.sale_invoice_id=i.id
 left join ref f on f.sale_invoice_id=i.id
 where i.total_paise-coalesce(r.v,0)-coalesce(a.v,0)+coalesce(f.v,0)>0
$$;
revoke all on function customer_invoice_outstanding_as_of(date) from public,anon,authenticated;
```

Policy note (write it as a SQL comment): voided documents are excluded at every as-of date — a void is a correction meaning "never valid", not a dated event.

Rewrite `get_customer_aging_report` (same signature/columns) to read from `customer_invoice_outstanding_as_of(p_as_of)` filtered by `shop_id=p_shop_id`. Age = `p_as_of - business_date`.

Invariant for the test: for `p_as_of = shop_business_date(shop)` the as-of function must equal the current `customer_invoice_outstanding` view row-for-row.

**(c) Supplier aging** — `get_supplier_aging_report(p_shop_id uuid, p_as_of date)`, same bucket columns as customer aging, built from an as-of analogue of `purchase_bill_outstanding` (bills, returns, `out` allocations with `payment.business_date<=p_as_of`).

**Signals (group `batchd`, part 1):** aging function body contains `customer_invoice_outstanding_as_of`; `to_regprocedure('public.get_supplier_aging_report(uuid,date)') is not null`.

**pgTAP `0036_phase65_report_corrections.sql`:** discounted invoice (100 paise, header discount 10) fully returned → net qty 0 and net sales 0; partial return; aging with past, same-day, future invoice (future excluded), payment dated after as-of (not counted), return after as-of (not counted), voided invoice (excluded), refund; as-of == current view on today; supplier aging mirror cases.

### WP D2 — Migration `0046_phase65_settings_guards.sql` + UI

`create or replace function update_shop_settings(...)` same 9-arg signature. Copy 0039; add after the existing checks:

```sql
  if not exists(select 1 from pg_timezone_names where name=btrim(p_timezone)) then
    raise exception 'invalid timezone';
  end if;
  if p_allow_negative_stock is distinct from (select allow_negative_stock from shops where id=p_shop_id and tenant_id=v_tenant)
     and "current_role"()<>'owner' then
    raise exception 'only the owner can change the negative-stock policy';
  end if;
```

Also reject a change of `fiscal_year_start_month` with `raise exception 'fiscal year numbering is not yet enabled'` unless the value is unchanged (it becomes editable, with its own guard, in F1).

**Signal (group `batchd`, part 2):** update_shop_settings body contains `pg_timezone_names`.

**pgTAP `0037_phase65_settings_guards.sql`:** `Invalid/Nowhere` rejected; `Asia/Kolkata` accepted; manager changing negative stock rejected; manager changing name accepted with negative stock unchanged; owner changes negative stock; fiscal month change rejected.

**UI (`SettingsScreen.tsx`):** timezone becomes a `<select>` from a static list (`Asia/Kolkata` first, then `Intl.supportedValuesOf('timeZone')` if available); negative-stock toggle disabled for non-owner with explanation; fiscal-year control disabled with label "Not yet applied to numbering".

### WP D3 — Receipt uses shop settings

- New `apps/admin/src/components/ReceiptHeader.tsx`: props `{shop:{name,address,gstin}|null}`; renders name (fallback "Shop"), address, `GSTIN: …` when present.
- Load settings once per screen (`getShopSettings(shopId)`), cache in state; offline fallback: last settings stored in `localStorage` key `dsb-pro:shop-settings:<shopId>` (per-viewer convenience, wrapped in try/catch).
- Replace both `<h1>DSB Store</h1>` occurrences.
- Printer width: add class `receipt-58mm` / `receipt-80mm` to the print area from settings; CSS `@media print` widths 58mm/80mm, font sizes for thermal; A4 mode unchanged.
- E2E: settings name "Test Mart" → receipt shows "Test Mart"; width class present.

### WP D4 — Nightly export v4 + coverage test

- `phase6-json-export.yml`: `schemaVersion` → 4; add `saleReturns` (`sale_returns`), `saleReturnLines` (`sale_return_items`), `purchaseReturns`, `purchaseReturnLines`, `stockCountLines` if absent, `syncIdempotencyKeys`, plus every other table found by the coverage test.
- New `scripts/test-export-coverage.mjs` (runs in the `pgtap` job against the local DB): lists `information_schema.columns` tables in `public` having a `tenant_id` column; fails if any is missing from the export key map (maintain the map in `scripts/export-tables.json` shared by the workflow's generator step if practical; otherwise the script parses the workflow file).
- Restore round-trip: extend the existing portable-restore proof (if it validates key presence only) to import v4 JSON into a fresh DB and compare row counts per table.

### WP D5 — Health UI shows every invariant

- `reports.ts`: `export type InvariantHealth={ok:boolean}&Record<string,number|boolean>`; keep the six named fields as optional for existing callers.
- `HealthPanel.tsx`: render `ok` then every other key sorted, with a label map (unknown keys shown raw). Any non-zero value highlighted.
- Unit test: a payload with an unknown new field renders it.

**Batch D migration gate:** group `batchd` = 0045 + 0046, signals from D1 and D2 (3 total).

---

## 7. Batch E — Phase 6.5 shell and automated dry run

UI only, no migrations. Order matters: E1 before others (they consume it).

### WP E1 — i18n infrastructure and coverage

- Replace `lib/i18n.ts` with `lib/i18n/index.ts` + `lib/i18n/en.ts` + `lib/i18n/hi.ts`.
- `en.ts` exports a nested `as const` object grouped by screen: `common`, `nav`, `pos`, `returns`, `customers`, `suppliers`, `inventory`, `reports`, `settings`, `sync`, `team`, `devices`, `auth`, `errors`.
- `hi.ts` typed `: typeof en`-shaped (use a `DeepStringRecord<typeof en>` helper) so a missing key is a type error.
- `t('pos.holdCart')` dot-path with a typed key union; interpolation `t('pos.itemsCount',{count})` via `{count}` placeholders.
- `useLocale()` hook reading/writing `localStorage` key `dsb-pro-locale` (existing), re-rendering on change.
- Unit test `i18n.test.ts`: identical key sets; no empty strings; placeholders match between languages.
- Migrate screens one PR per 2–3 screens (E1a…E1e). Hindi strings: machine draft flagged `// TODO(review-hi)`; user to review. Money/number formatting stays `₹` with `toFixed(2)`.
- E2E smoke `i18n.spec.ts`: switch to Hindi, visit every route, assert no English label from a fixed list of 20 core labels remains.

### WP E2 — Error taxonomy

`components/ErrorNotice.tsx` + `lib/errorClass.ts`:

| Class | Detected by (`classifyError` result / signal) | Message key | Action |
|---|---|---|---|
| `validation` | user input rejected (known validation messages) | `errors.validation` + server text | fix and retry |
| `permission` | `not permitted` | `errors.permission` | none |
| `offline` | `!navigator.onLine` or network failure | `errors.offline` ("Saved locally, will sync" for queued ops; "Needs connection" for online-only) | retry when online |
| `authExpired` | JWT expired / 401 | `errors.authExpired` ("Sign in again; your draft is kept") | re-login preserving draft |
| `conflict` | `client_id payload mismatch`, `price changed; review required`, `stock changed since count` | `errors.conflict` | review |
| `invariant` | `check_invariants().ok=false` on posting screens | `errors.invariantStop` | contact owner |
| `server` | anything else | `errors.server` ("Not saved; your draft is preserved") | retry |

Never render "Something went wrong". Replace every `setError(String(e))` with `setError(toUserError(e))`. Unit tests for the classifier with real server messages copied from migrations.

### WP E3 — Bottom navigation + home dashboard

- `components/BottomNav.tsx`, visible below 768px, fixed bottom, 5 items: Home · Sales (POS) · Returns · Stock (Inventory) · More (sheet: Customers, Suppliers, Reports, Sync, Team, Devices, Settings, Sign out). "Orders" from the old §10 is Phase 8 and is **not** shown yet (debate item).
- Items filtered by role (cashier: Home, Sales, Returns, More→Customers, Sync).
- Desktop keeps the existing link bar, restyled as a top nav.
- Home dashboard: today's sales total, receipts, purchases, payments out, low-stock count, sync status, invariant status — each a card with loading/empty/error states. Source: `getDayBook`, `getLowStockReport`, sync dashboard, `checkInvariants` (report roles only).
- E2E: mobile viewport (390×844) navigation through all tabs.

### WP E4 — Async state component and per-screen states

`components/AsyncState.tsx`: `{status:'loading'|'empty'|'error'|'ready', emptyText, error, onRetry, children}`. Apply to every list/table in every screen. Stale/offline banner when showing cached data (`SyncRuntime` already knows online state).

### WP E5 — Dark mode toggle + accessibility pass

- Toggle in Settings (System/Light/Dark) → `document.documentElement.dataset.theme`; CSS: tokens under `:root[data-theme="dark"]` and `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`.
- `@media print` forces light tokens (receipts always black on white).
- Accessibility: every input has a `<label>`; focus-visible outline; tap targets ≥ 44px in BottomNav and POS buttons; `role="status"` for success messages (already used), `role="alert"` for errors.
- Playwright `@axe-core/playwright` is **not** in the repo — adding it is a dependency decision (debate item); without it, assert labels via `getByLabel` in specs.

### WP E6 — Automated dry run spec + human dry-run checklist

`apps/admin/e2e/dry-run.spec.ts` (runs in CI once, not in the ×10 stress):
1. Create/import masters (5 items with 3 units, 2 parties, 2 customers).
2. Multi-line supplier bill (5 lines).
3. Partial supplier payment + advance.
4. 20-item mixed-unit sale with header discount and split tender.
5. Hold/resume cart.
6. Offline sale (Playwright `context.setOffline(true)`) → online → sync → reconciliation (no warning).
7. Partial and full returns with every disposition.
8. Customer credit sale then settlement.
9. Assert: day book, party ledger, customer ledger, stock, GST summary, stock valuation, item sales, aging, supplier outstanding all internally consistent; `checkInvariants().ok===true`.

`docs/DRY_RUN_CHECKLIST.md`: the same steps for a human on the real device with real data, with a sign-off table (expected vs observed, initials, date).

**Batch E acceptance:** i18n parity test, taxonomy tests, mobile nav E2E, dry-run spec green twice.

---

## 8. Human gates (no code can satisfy these)

| Gate | Evidence required | Owner |
|---|---|---|
| H1 | One week of real purchases entered while old DSB stays authoritative; physical stock count matches; supplier balances match | User |
| H2 | One full real shop day in parallel; cash/UPI/card/bank, sales, returns, customer balances, purchases, supplier payments, expenses, closing stock reconciled (use `get_shop_day_reconciliation` + legacy comparison) | User |
| H3 | Offline/restart/network-interruption exercise on the actual shop device | User |
| H4 | Hosted backup restored into a clean target; Auth decrypted with the paper key; RPO/RTO measured; evidence sheet signed | User |

Replacement for the 50-invoice parity gate (old DSB had no sales invoices): all available historical purchase bills + payments for an agreed sample period, plus synthetic golden sale cases, plus H2. Record this amendment in `DSB_PRO_BUILD_PLAN.md` §19.

---

## 9. Attended live operations (not part of any WP; each needs explicit user instruction)

**L1 — Live migration through the current top group** (first needed before H1):

1. Confirm `main` head, CI green on that exact SHA.
2. Run workflow `CI` via `workflow_dispatch` with `operation=phase6_db_upgrade` on `main`.
3. Preflight prints `observed_state=…`; if it is not one of the declared states, the job refuses — stop, do not hand-patch.
4. Backups verified in both destinations before apply (existing steps).
5. After apply: live verify block passes (function-body checks), invariants `ok`.
6. Record SHA, run id, observed state before/after in `docs/HANDOVER.md`.

**L2 — Static deploy** only after L1 succeeds for the migrations the build expects: `workflow_dispatch` with `operation=deploy_production`. Never in the same dispatch as L1.

Order rule: **database first, app second**, every time (the Batch A incident).

---

## 10. Batch F — Phase 7 migration and cutover

### WP F0 — Old-DSB export inventory (STOP gate)

The implementer cannot design the importer extension without a real old-DSB export. Required from the user: one full export file + a list of which records exist (purchases? payments? supplier balances? date range?). Output: `docs/LEGACY_DATA_INVENTORY.md` (fields, counts, quality issues). F2 does not start until this exists.

### WP F1 — Fiscal-year document numbering (`0047_phase7_fiscal_year_numbering.sql`)

- Series key becomes `<base>:<fy>`, e.g. `SALE:2026-27`, where FY is derived from `business_date` and `shops.fiscal_year_start_month` (`fy_start_year = year(business_date) - (month(business_date) < start_month ? 1 : 0)`; label `YYYY-YY`).
- Helper `phase7_fiscal_year_label(p_shop_id uuid, p_date date) returns text` (immutable given inputs; test boundaries: last day before start month, first day of start month, Jan with start month 1).
- Sale doc_no format: `<prefix>/<fy>/<seq>` e.g. `INV/2026-27/000123` (zero-pad 6). Returns and any other series follow the same helper.
- **Historical numbers never change.** Only documents posted after the migration use the new series.
- `update_shop_settings`: fiscal month change allowed only if no FY-series document exists for the shop in the current FY (else `raise 'fiscal year start cannot change after documents are numbered this year'`).
- Concurrency test: 50 parallel sales across a FY boundary date → no duplicate, no gap within a series.
- Offline provisional numbers unchanged (server assigns official numbers on sync).

### WP F2 — Opening balances (`0048_phase7_opening_balances.sql`)

Recommended over importing every historical bill (debate item):

```sql
create table party_opening_balances(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id), shop_id uuid not null,
  party_id uuid not null, as_of_date date not null,
  amount_paise bigint not null,  -- positive = we owe the supplier; negative = supplier owes us
  source text not null check(source in ('LEGACY_IMPORT','MANUAL')),
  status text not null default 'POSTED' check(status in ('POSTED','VOID')),
  created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
  updated_at bigint not null default 0, deleted_at bigint, client_id text not null,
  unique(tenant_id,client_id), unique(tenant_id,shop_id,party_id) -- one live opening per party per shop
  -- plus the standard (tenant,shop) and (tenant,party) composite FKs
);
```

Same for `customer_opening_balances` (positive = customer owes us). RLS, immutability trigger (POSTED→VOID only), pgTAP, audit trigger — all per the standard columns rule.
Integrations (each with tests): `get_party_ledger` adds an `OPENING` entry; `get_supplier_outstanding` and supplier aging include it (as a pseudo-bill dated `as_of_date`, allocatable? **No** — opening balances are settled by unallocated payments; document this); customer ledger/aging likewise; exports v5; `check_invariants` unchanged.

### WP F3 — Importer extension

- `packages/core/src/legacyDsbImport.ts`: extend `LegacyDsbImportPlan` with `partyOpeningBalances`, `customerOpeningBalances` (and historical purchase bills only if F0 shows they exist and the debate chooses full import).
- `import_legacy_dsb_opening_balances(p_shop_id, p_plan jsonb, p_client_id)` owner-only, idempotent, all-or-nothing.
- Dry-run mode (`p_dry_run boolean`) returning the computed diff without writing.

### WP F4 — Dry-run diff report

`scripts/legacy-dry-run-diff.mjs` → `artifacts/legacy-diff-<date>.md` + `.json`: counts per entity, money totals, per-party and per-customer balances (old vs new), stock quantities per item, unmapped rows, duplicates, invalid dates, rounding differences. Exit non-zero on any unexplained difference; explanations supplied in `docs/legacy-diff-explanations.json` (explicit, reviewed). Re-run twice against clean targets → byte-identical JSON (idempotency proof).

### WP F5 — Cutover runbook

`docs/CUTOVER_RUNBOOK.md`: freeze window, final delta import, archive old export + SHA-256 checksums, switch authority, first production backup restored and verified, rollback conditions and the last safe rollback point (before first real sale on DSB Pro after freeze).

---

## 11. Batch G — Phase 8 (outline only; re-plan before starting)

Starts only after cutover evidence is accepted. Components: `public_catalog` view (no cost fields; anon pen-test), `place_order()` RPC (server-priced, anon-rate-limited), `orders`/`order_items`, `stock_reservations` + expiry job (reservations already respected by `apply_stock_movement` via `reserved`), admin order queue, per-shop config + deploy checklist, `apps/superadmin` health board. A dedicated plan document will be written and debated at that time; nothing here is authorized.

---

## 12. Decisions for the debate (defaults marked ★)

| ID | Question | Options | Default |
|---|---|---|---|
| D-C1 | Who may post supplier payments? | ★ `POST_PURCHASES` (owner+manager) / new permission | ★ |
| D-C2 | Who may void supplier payments? | ★ owner only (`VOID_SALES`) / also manager | ★ owner only — cash-out corrections are the highest-risk edit |
| D-C3 | Offline supplier payments? | ★ online-only / offline queue | ★ online-only |
| D-C4 | Unallocated advances? | ★ allowed + later allocation / always allocate | ★ allowed |
| D-C5 | Idempotency storage | ★ reuse `sync_idempotency_keys` / add `request_fingerprint` column to `payments` | ★ reuse (no schema change to a hot table) |
| D-D1 | As-of treatment of voids | ★ void = never valid / void effective from `voided_at` | ★ never valid |
| D-D2 | Item-sales "gross" column | ★ keep pre-discount gross, fix net / change gross too | ★ |
| D-E1 | Bottom nav 5th item | ★ Returns now, Orders in Phase 8 / Orders placeholder | ★ |
| D-E2 | Add `@axe-core/playwright` | yes / ★ no (labels asserted manually) | ★ no |
| D-E3 | Hindi strings | ★ machine draft + user review / user supplies | ★ |
| D-F1 | Historical import | ★ opening balances only (+ sample-period bills for parity evidence) / full history | ★ |
| D-F2 | FY doc_no format | ★ `INV/2026-27/000123` / keep `INV-123` with FY series | ★ |

---

## 13. Dependency graph and PR list

```
P0.1 merge #35 ─┐
P0.2 verify push run ─┤
P0.3 docs refresh ─┘
      │
      ▼
C1 (0044) → C2 tests (same PR as C1) → C3 adapter → C4 screen      [C1+C2 one PR, C3 one PR, C4 one PR]
      │
      ▼
D1 (0045) ─┬─ D2 (0046)+UI ─ D3 receipt ─ D4 export ─ D5 health     [one PR each; D1/D2 share group batchd:
           │                                                          D2's PR adds its signal; gate verified at D2]
           ▼
E1 (i18n infra) → E1a..E1e screen migrations → E2 → E3 → E4 → E5 → E6
      │
      ▼
L1 live migration + L2 deploy (attended) → H1..H4 human gates
      │
      ▼
F0 inventory (user data) → F1 (0047) → F2 (0048) → F3 → F4 → F5 → cutover
      │
      ▼
G (separate plan)
```

**P0 details:**
- P0.1 Merge PR #35 under the exact-head guard.
- P0.2 Verify the post-merge `push` run: all validation green, `deploy` and live jobs `skipped`.
- P0.3 Update `CLAUDE.md` "Current phase" paragraph (stale since PR #17) and append the Batch A/B/#35 delta to `docs/HANDOVER.md`. Docs-only PR.

---

## 14. Review checklist the independent reviewer will apply to every PR

1. Head SHA in PR body equals actual head; CI runs cite that SHA.
2. No edit to an existing migration.
3. Every replaced function: diff against the source migration shows only the lines this plan names.
4. Every new function: `security definer set search_path=public`, permission check first, revoke/grant present.
5. Every trap in §3 touched by the WP has its test.
6. Money: no `Math.round`/float arithmetic on paise; quantities via fixed-point helpers.
7. JSX: conditional sibling blocks keyed; no controlled input whose value depends on async parent state.
8. Migration gate extended per §4.3; disposable staged proof asserts the new state.
9. `deploy`/live jobs skipped on PR and post-merge push runs.
10. PR template complete; unresolved risks honest.
