# A1 `item_prices` security-definer triage

The migration history contains nine `SECURITY DEFINER` function bodies that
touch `item_prices`, but later migrations redefine the same sync function.
There are six distinct active functions after migration 0041.

| Active function | Access | Classification |
|---|---|---|
| `set_item_price` | `authenticated`; requires `MANAGE_MASTER_DATA` | Authorized writer; returns only the written row ID |
| `phase4_current_price` | revoked from `public`; no authenticated grant | Internal sale-price resolver; callers restrict kind to retail/wholesale |
| `import_legacy_dsb_master` | `authenticated`; requires owner | Authorized opening-state importer/writer |
| `phase5_sync_pull` | `authenticated`; active registered device and shop | Read feed; 0041 filters `cost_last` unless caller has `POST_PURCHASES` or `VIEW_REPORTS` |
| `get_stock_valuation` | `authenticated`; `phase6_assert_report_access()` | Authorized report that derives valuation from cost prices |
| `phase6_export_tenant` export chain | public wrapper is `authenticated`; requires `EXPORT_DATA` and shop membership; renamed bases are revoked | Authorized complete owner/export feed; raw-price base functions are internal-only |

Migration 0041 also returns the effective `canViewCostPrices` capability. The
client purges unauthorized cached cost rows and resets only its price cursor
when authorization is later gained, preventing both residual disclosure and a
role-change pagination gap.

The pgTAP A1 suite tests each restriction and will fail if the classified
function inventory changes without review.
