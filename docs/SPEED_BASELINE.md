# SP0 — repeatable navigation baseline before optimization

Scope: measurement and source inventory only. No application handlers, money arithmetic, migrations,
cache semantics, outbox or authorization change in this packet. Do not call preparation a speed improvement.
Base app is main `ef880dad401cd12cb470b432edb5444eec46ad66` (production #861).

## What runs and what counts

`e2e/navigation-baseline.spec.ts` is opt-in (`SP0_NAVIGATION=1`), runs in the existing disposable
production-scale performance workflow, and refuses a non-loopback app target. Every routed HTTP request
is limited to literal loopback at ports 4173/54321; no hosted app, real account or live database is used.
Synthetic owner/device/catalog setup reuses the existing workflow. Eight suppliers/customers are added
only after the existing scale gate; 10k items and 100k invoices stay unchanged. There are zero purchase
bills in this initial fixture: purchase measurements represent an empty history plus the catalog editor,
not a populated purchase ledger. Add a realistic document distribution before extrapolating to the shop.

| Measurement                     | Definition                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Login to Overview               | App load + disposable login + visible Overview; includes credential entry automation                 |
| Login to catalog ready          | Above plus POS rendering its 10,000-item local catalog; first sync reported separately               |
| HTTP-cold cached-catalog reload | Authenticated POS reload after HTTP cache clear; IndexedDB remains. NOT fresh install                |
| Route first visit               | Actual SPA link click to useful data/control readiness + two animation frames after catalog sync     |
| Route revisit                   | Same link-based measurement, seven samples per route; preserves current app behavior                 |
| Requests                        | Fetch/XHR counts by RPC/table/auth category; includes background activity until bounded quiet window |
| Memory/storage                  | Bootstrap/end DOM counters, end JS heap and origin storage estimate, not a bounded-memory proof      |

Routes: POS, Inventory, Purchases, Suppliers, Customers. Useful readiness means expected fixture catalog
or party/customer options loaded and actionable controls enabled; purchases require completed history
load and visible New purchase. It does not merely time a route heading or fixed sleep. Menu preparation
(Home/More) is outside the timing; the measured click is a real visible anchor. Delays from polling and
Playwright assertions are included, so compare profiles/runs with this same harness rather than treating
the result as a browser-native INP measurement. Inventory stock completeness is not proven by item count.

Two **synthetic desktop Chromium** profiles use a 390×844 viewport: reference (CPU 1×, no network
throttling), and mobile-like (CPU 4× slowdown, 150 ms latency, 1.6 Mbit/s down/750 Kbit/s up using the
existing workflow's throughput convention). This is not the user's actual Android device or measured
India-to-host RTT. Service workers are blocked, and Playwright request interception disables Chromium's
HTTP cache. Revisits retain app/IndexedDB state but do not represent normal HTTP-cache or PWA behavior.
Offline worker startup/update behavior and installed-PWA cold start need separate measurements.
Startup gets a separate bounded 180-second quiet wait because invoice sync continues after the POS
catalog becomes usable; route request accounting keeps its 30-second bound. Neither wait changes the
existing 60-second catalog-sync gate or turns a timeout into a passing timing sample.

Nearest-rank p50/p95 are reported with sample count/min/max. With seven samples p95 equals max; it is
an empirical tail observation, not a population estimate or statistically stable budget. No 150 ms / 2.5 s
claim or pass threshold is introduced before seeing the baseline. Existing 60-second sync and 300 ms
search gates are unchanged. Failures/timeouts are retained, never retried into a green measurement.

## Run and retrieve

The existing `Phase 6 production-scale performance` workflow runs on relevant PR path changes and manual
dispatch. It creates local Supabase and synthetic identities, runs its existing scale gate, then SP0.
JSON artifacts: `sp0-navigation-<run_id>-<attempt>`, one report per profile. Reports include source SHA,
profile, dataset shape, individual samples, request categories, memory/storage and completion/failure status.
Partial results survive failure. Request query strings, bodies, tokens, customer IDs and raw URLs are omitted.
Playwright failure traces contain synthetic fixture activity only, as in the existing dedicated workflow.

Local prechecks (do not claim these execute the browser or DB):

```sh
node --test scripts/navigation-baseline.test.mjs
pnpm --filter @dsb-pro/admin exec playwright test e2e/navigation-baseline.spec.ts --list
```

Full local execution additionally needs disposable Supabase, its seeded fixture, the compiled app against
the local API, registered fixture device, Chromium and the opt-in environment. Never point this workflow
at a hosted deployment or substitute real credentials. No live measurement script is provided.

## Baseline evidence register

| Item                                                                                | Status at initial packet preparation                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Function-call waterfalls in Inventory/Purchases/Customers/Suppliers                 | Source inspected; repeated context/data reads confirmed                       |
| Measured wire-request counts                                                        | PENDING actual SP0 artifact; function-call count is not network-request count |
| Route/reload p50/p95                                                                | PENDING actual SP0 artifact; no numbers invented                              |
| Physical shop phone/browser/connection                                              | NOT RECORDED; use a separate dated device sheet                               |
| Previous production-scale gate                                                      | Existing fixture/gate retained; not equivalent to the new route benchmark     |
| Cold install, installed-PWA/offline restart, populated purchase/financial histories | NOT PROVEN by this fixture                                                    |

SP1 must compare before/after using the same harness/dataset/profile and report request reduction,
first useful paint, p50/p95 and memory change. On auth/shop/role change, midnight in shop timezone,
reconnect/focus, failed refresh, account switching and navigation away/back, preserve authorization,
drafts and immutable financial identities. SP2 needs bounded per-identity/per-query snapshots, explicit
stale/as-of labels, deletion/invalidation rules and eviction that cannot touch protected pending work.
