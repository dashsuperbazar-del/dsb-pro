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

## First measured baseline (local disposable run, 15 October 2026)

Produced by the verifier-turned-builder in a local container on this packet's code, against local
Supabase with the exact 10k item / 100k invoice fixture and eight suppliers/customers. **This is not CI
evidence and not the shop phone.** CI must repeat it on the final head; the numbers below only show
shape. Both JSON reports completed (`status: complete`), each holds 40 measurements (5 routes x 8 visits),
zero failed requests, zero blocked external requests.

| Route     | Desktop reference p50 / p95 | Mobile-like (CPU 4x, 150 ms, 1.6 Mbit/s) p50 / p95 | Requests per visit (desktop / mobile) |
| --------- | --------------------------- | -------------------------------------------------- | ------------------------------------- |
| POS       | 293 ms / 2,416 ms           | 500 ms / 737 ms                                    | 6.1 / 5.0                             |
| Inventory | 5,224 ms / 5,322 ms         | 20,953 ms / 21,224 ms                              | 17.4 / 20.0                           |
| Purchases | 189 ms / 208 ms             | 1,506 ms / 1,545 ms                                | 24.4 / 28.0                           |
| Suppliers | 160 ms / 210 ms             | 967 ms / 994 ms                                    | 5.0 / 4.0                             |
| Customers | 266 ms / 316 ms             | 1,007 ms / 1,049 ms                                | 5.0 / 6.0                             |

Startup: login to Overview 0.6 s / 2.6 s; login to usable POS catalog 5.8 s / 30.2 s; HTTP-cold reload
with cached catalog 1.1 s / 9.9 s. Memory after the run: JS heap 35 MB / 22 MB; IndexedDB 24 MB.

Seven revisit samples, so p95 equals the maximum (see above); the POS p95 contains one slower sample.

### What the baseline already shows (all on the 10k-item fixture)

1. **Inventory re-downloads the whole item catalog on every visit**: 11 `table:items` requests each time
   (10,000 items in pages of 1,000), plus the supplier, stock, shop and membership reads. It is by far the
   slowest screen: 5.2 s on a fast machine and 21 s on the mobile-like profile, with a 10,001-option item
   selector on top. Purchases repeats the same 11 item requests and adds 4 membership, 3 supplier and 2
   shop reads per visit (24 to 28 requests in total) although it renders sooner.
2. **Suppliers and Customers are already light** (4 to 6 requests, about 1 s mobile-like).
3. A shop with 276 items (your imported catalog) needs 1 item page, not 11, so its Inventory cost is
   much lower than this fixture. The fixture is a stress shape, not your shop. Measure on your device.

### Product defect found while making this baseline pass

**POS showed only the first 1,000 items after a first sync and never refreshed.** If POS opened while a new
device was still downloading the catalog, the device cache held exactly one page (1,000 items), POS
treated "1,000 or more cached items" as a complete catalog, skipped the server read, and never looked at
the cache again. IndexedDB reached 10,000 items within seconds, but POS kept showing 1,000 (observed for
more than 90 s until a reload). Items beyond that were not findable by name search until the app was
reopened. This is a read-side display defect (selling still goes through the server and the outbox), but
a new device in a shop with more than 1,000 items would hit it on day one. Fixed in this packet by
`lib/catalogWatch.ts`: POS re-reads the device catalog whenever its size changes, display only, stopped
when the screen closes, and covered by five unit tests (the fixed behaviour fails without the change).

The failed CI run's two failures were therefore different in kind: the POS one was this real defect (the
harness exposed it); the Customers one was a harness mistake (it waited for the "Create customer" button,
which sits inside a collapsed "Add customer" section; it now waits for the visible "Add customer" control).
No assertion was removed or weakened.
