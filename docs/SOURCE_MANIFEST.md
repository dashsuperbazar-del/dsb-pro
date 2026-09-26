# Source Manifest

Built for P0 per `docs/COMPLETE_REMAINING_BUILD_PLAN.md` §5: "Build a source manifest: effective
function name/signature, defining migration, wrappers, client callers, grants, relevant tests."

**Scope honesty note**: Part A (migration hash table) is complete and exhaustive — every baseline
migration `0001`–`0043` currently in the repository. Part B (function cross-reference) is **not**
an exhaustive catalog of all ~38 files that define functions; it covers the financial-critical RPC
surface that C0a/C0b/C1/C2/C3 will read, wrap, or re-wrap (`post_sale` and its wrapper chain,
`get_item_sales_report`, `get_party_ledger`, `void_sale`, `phase65_sale_line_cap`). Extending Part B
to the full function surface is not required by P0's stated acceptance criteria ("source paths
exist") and is deferred to whichever later packet first needs a function not listed here — at that
point add a row rather than growing this document speculatively.

## Part A — Migration integrity (SHA-256, `0001`–`0043`)

Computed via `sha256sum` against the exact bytes in `supabase/migrations/` at commit
`6ddd7c0de8baae5a9411c57c4a043c5e814c9253` (branch `claude/eloquent-mccarthy-m8m5cj`). Re-run
`for f in supabase/migrations/0*.sql; do sha256sum "$f"; done | sort -k2` to reverify; do not
hand-edit this table if it drifts — recompute and replace it, and open a P0-follow-up note in
`docs/BUILD_EXECUTION_LEDGER.md` if a hash for `0001`–`0043` ever changes (it must not — those
files are immutable per forward-only-migration policy).

| # | File | SHA-256 |
|---|------|---------|
| 0001 | init.sql | `49cfb94af43038e653e7b9154a540fa99bde400fd3ccf4455bfcc28f8c0e82c8` |
| 0002 | backup_status_rpc.sql | `47b9061fa58b6e422e6333547a515e5751bb25c5ba463b0b643213123658ceef` |
| 0003 | permissions.sql | `d6294b152b5fa1e6905a44d38b0c8a39b28f097386b8ef45e413dc3be4dfcdfd` |
| 0004 | tenancy.sql | `8263d883ba77a87521d05644900bd7c3e6400458670871451f900c2b74203ebb` |
| 0005 | claims_resolver.sql | `d63fa962046242fb53cf8e3976a1112a2ba0eb805fb03e3f053c6ca72b17de47` |
| 0006 | tenancy_rls.sql | `6f62ffc461eb799df0a3bbff865dc35ff6bf4a9301d385fe13385f2f6054169f` |
| 0007 | tenant_lifecycle_rpcs.sql | `c84bca6a7912c4a43a626da3365290d5e005a6155c17acf83cd8afdfc0a6363a` |
| 0008 | device_rpcs.sql | `859816ea80d8e5d27099617dbce67245f5b33274ce28df4518a03234395c89e4` |
| 0009 | audit_log.sql | `68075ce86104140bf808bd6469048cf35fc05e1a6f3890251c767d9b8156701b` |
| 0010 | doc_sequences.sql | `bab69b2d57ee7c3b78257c9b9d9392e37efd9ddb9560f52eb7c3733a2927533d` |
| 0011 | access_token_hook.sql | `7a4c68ef2d9b63e96244123f77cadc4640f5468ce4f80464e3f8531178baaa37` |
| 0012 | explicit_revokes.sql | `04dcda988bd70829113fcb23d7fe3eabc82dbc52429d97d48510030c7439ada3` |
| 0013 | hardening_and_fixes.sql | `a97b81187b1c7220aaaa0ebced5ef7a0f0b1eafae9f4e376b0f47b7a3834e1a3` |
| 0014 | device_label.sql | `fca7addcc9603f67121c18d8b71eff7ce86c9a80c397ad597897158c117f727b` |
| 0015 | role_hardening.sql | `02d3699c099f8c62050aeee9c5d5f8e5059660a3d2e55dc9a7684158a909c131` |
| 0016 | team_member_lifecycle.sql | `f770acbb87a0d91c816dec767f7b32cd750c96f099888686b7d17993da251bd7` |
| 0017 | master_data_purchases.sql | `840e14d547e40f4bed5df08af66844d89fc36b0b98176675e0b7b76837b872c1` |
| 0018 | phase3_storage.sql | `e2c170a162700a7325969bcac4e003496c6dcf033ea678d75edacbbc3a9d59f3` |
| 0019 | phase3_price_rpc.sql | `ca421a5cccba249e622e871b992da43a28257710d46af2eb8af15fee8e7bb55a` |
| 0020 | phase3_tenant_integrity.sql | `c8d5a256cd24857c9ce568be38b505c71e1b44fff5fbf98167e7057d18770fa0` |
| 0021 | phase3_unit_semantics_fix.sql | `a883423ae78e4f968cd707cfed6ef0a43aef83eb3e44e92154d5a0a3d5ce079d` |
| 0022 | phase4_stock_projection_customers.sql | `014227e5855e2ad336c301f3482024658edcdaa328eed54c75be41d7f3b1c507` |
| 0023 | phase4_sales_payments.sql | `9490635ff84dd7405df3ee4a4dc33bd90240ee7193455415399cbaf53cc3076a` |
| 0024 | phase4_trigger_hardening.sql | `bcf814e037dad4e7f41604152788dde012bafc6a033097ddca597e8bf8e84d97` |
| 0025 | phase4_allocation_integrity.sql | `52b4a57c31df854ff335784fbe77484f3b1d1414b6c9aec0fb139245665c332c` |
| 0026 | phase4_idempotency_locking.sql | `15fcf80862c83775bc32c2cd041aa79183f8e0a62e46607fb2e12a512cdcbec8` |
| 0027 | phase4_legacy_import.sql | `c6a5745389c35bb8aa044f5caf3f1407505a4883895e60f8b950460f24178b14` |
| 0028 | phase4_day_reconciliation.sql | `b1ebca350829beed78b453115ebaf4a718c625572147bfad1e254816f6b7bddc` |
| 0029 | phase5_sync.sql | `9e33c824095bea83986a5fb925c8f990a31c3f07f3f2b6b5e68d4ab9a80a5b58` |
| 0030 | phase6_ledgers_reports_dr.sql | `b5dcc58cdf6712abbaa189657e15282ab5462d470b5983d7c8922a2bce2ece77` |
| 0031 | phase6_sync_page_size.sql | `090a63a72920dba253324ab5d99624f2222dc7fd5c75e1708482ce0d9e6df145` |
| 0032 | phase6_parallel_sync_pulls.sql | `fb8908afef1e6fa09fc08c8835a8d94d8977a8aa6df93097d0af230793d5f446` |
| 0033 | phase6_streaming_page_size.sql | `11c5a6ac4937344625fb219c14b7a430257b1c22355d6f599c9833daeca9115b` |
| 0034 | phase6_integrity_hardening.sql | `10f8f2927db0f810eb585370c1fac7067e44fd6cabd453aea400fd7ec9a82a47` |
| 0035 | phase6_complete_export.sql | `abe8eedd012ced9e75bb2f2a99a6870f34f0ee19c10b4e10c7db107b3fc69eba` |
| 0036 | phase65_returns.sql | `9f9e9794573185f75c94b5954859a1699f60cf4b57eec265dcf3da3ae8ba21b3` |
| 0037 | phase65_offline_returns.sql | `b443710de3b4db7ddee75a10d8b658266a63cb55ae154f60b5a62ca0bb9c0977` |
| 0038 | phase65_shop_settings.sql | `ef32cef9e6ff6d3a57b1cc25e244240b2496039c42a9904ce6fe9e85149c57d2` |
| 0039 | phase65_negative_stock_override.sql | `07f5ebbcb775a28a5e6267293699cf23fc9ebf2860ce232875ffb5c025b2c7b6` |
| 0040 | phase65_missing_reports.sql | `e954abf3aa72278b84caef22636f0862b72b4e5a55a1ebef5c52c3b1c04daccb` |
| 0041 | phase65_sync_cost_confidentiality.sql | `0cde20371bd91d9b1ed5f25483fa941232778f8acbf38c1fc199624b34e2ed24` |
| 0042 | phase65_negative_stock_recovery.sql | `a0935d9405eb4af10d20fdf6bb90d6238b1d89a8ea60cec6470913f06c25ee65` |
| 0043 | phase65_fixed_point_sale_ack.sql | `cb191c062c3ed9edcfdd1a4ffcb330f969fa647031176c287f95f63511d4730e` |

Next free migration number for new work is `0044` (P1, `upgrade_receipts`, per plan §4).

## Part B — Financial-critical function cross-reference

### `post_sale(uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)`

- **Defining/redefining migrations, in order**: `0023_phase4_sales_payments.sql` (created) →
  `0026_phase4_idempotency_locking.sql` (redefined to delegate to locking wrapper) →
  `0043_phase65_fixed_point_sale_ack.sql` (redefined for fixed-point ack contract; current
  effective definition).
- **Wrapper chain**: `0026` introduces `phase4_post_sale_unlocked(uuid,uuid,date,bigint,bigint,
  text,jsonb,jsonb,text)` as the actual logic; `post_sale` becomes a `security definer` wrapper
  that takes the advisory lock and calls it. `0029_phase5_sync.sql` adds a sync-aware wrapper
  `phase5_sync_post_sale(text,integer,uuid,uuid,date,bigint,bigint,text,jsonb,jsonb,text)`
  (idempotency-keyed) that itself calls `post_sale`. `0039_phase65_negative_stock_override.sql`
  further redefines `phase4_post_sale_unlocked` for negative-stock override handling.
- **Grants**: `revoke all ... from public` then `grant execute ... to authenticated` on
  `post_sale`, reasserted at every redefining migration (`0023`, `0026`, `0043`).
  `phase4_post_sale_unlocked` is revoked from both `public` and `authenticated` at `0026` and
  `0039` — it is never directly callable by a client, only reachable via `post_sale`.
  `phase5_sync_post_sale` is revoked from `public,anon` and granted to `authenticated` (`0029`,
  reasserted `0043`).
- **Client callers**: POS sale-posting path (search `post_sale` / `phase5_sync_post_sale` under
  `apps/*/src` for exact call sites before touching this function in C0a/C0b).
- **Relevant tests**: pgTAP suites under `supabase/tests/` covering phase4/phase5/phase6.5 sale
  posting, plus the `phase6_db_upgrade_proof` CI job (exercises this function across the upgrade
  path) and the e2e "held-cart" / sale-flow specs.
- **C0a/C0b relevance**: this is the primary target of C0b's locking-wrapper hardening — any
  change here must preserve the exact grant/wrapper topology above (do not grant
  `phase4_post_sale_unlocked` directly to `authenticated`).

### `get_item_sales_report`

- **Defining migration (current)**: `0040_phase65_missing_reports.sql`.
- **P2 relevance**: plan §5a requires copying this function's `0040` definition and correcting it
  to use `phase65_sale_line_cap` (see below) on the sold side, as a new migration `0045` — `0040`
  itself is not edited (forward-only).

### `get_party_ledger`

- **Defining migration (current)**: `0036_phase65_returns.sql`.
- **Known gap flagged during plan debate**: no shop parameter — do not write a cross-shop
  ledger-comparison test against this function without first confirming (in whichever packet
  touches it) whether a shop-scoped variant exists or needs adding.

### `void_sale`

- **Defining migration (current)**: `0023_phase4_sales_payments.sql`. Check later migrations for
  redefinitions before editing — this manifest records the earliest hit only; confirm the
  effective definition via `grep -n "create or replace function void_sale" supabase/migrations/*.sql`
  before any C-series packet touches it.

### `phase65_sale_line_cap`

- **Defining migration (current)**: `0036_phase65_returns.sql`. Referenced by P2's item-sales fix
  (§5a) as the correct sold-side cap to reuse in the new `get_item_sales_report` definition.

## Maintenance

Add a row to Part B whenever a packet's implementation reads, wraps, or redefines a function not
yet listed here. Do not backfill unrelated functions speculatively — this manifest tracks what the
active build actually touches, not the full schema.
