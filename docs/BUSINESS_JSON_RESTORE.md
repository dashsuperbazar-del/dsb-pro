# D3b — portable business JSON restore

The operator CLI restores a `phase6_export_tenant` format-v4 business export into an empty PostgreSQL
target with the same schema. It is not an in-app restore or a production replacement. Auth/public
database dumps remain the full recovery authority. Image/document bytes and working hosted logins
are separate recovery work; `--create-auth-stubs` creates placeholder identities for portability only.

```sh
node scripts/restore-business-json.mjs export.json postgresql://operator@127.0.0.1:54322/empty_database --expect-sha256 INPUT_SHA256
```

Provide the independently recorded input SHA-256. Local targets are accepted by default; a named
remote target requires an explicit `--allow-target HOST`. Both CLI and imported `restore()` check
the URL host, effective driver host and host/hostaddr query overrides before opening a connection.
The proof script accepts loopback addresses only and validates both source and control URLs before
fixture writes or database creation. It uses a unique database name and never drops an existing
named target at setup. No live operation is authorized by building or testing this tool.

Silent-data-loss risks addressed before crashes: JS rounding bigint/numeric values; silent SQL
type coercion; absent request history; incomplete row keys; wrong tenant; a nonempty or changing
target; replaying stock/audit triggers; unresolved foreign keys; altered financial totals.

`export-tables.json` explicitly maps the existing v4 business keys in restore order. Missing/unknown
keys, unsupported formats, malformed rows, tenant mismatches and row-column drift refuse. Numeric
JSON tokens remain exact via Node 24's raw JSON representation through database insertion; metadata
format version is checked as an integer. The fixture exports PostgreSQL `::text` directly, avoiding
a parse/stringify round trip through floating-point values. This cannot repair a file that was
already rounded before it reached this tool; it does not change the existing app exporter.

The transaction checks emptiness, locks all restored tables with a bounded lock wait, rechecks
emptiness and validates every typed row against its original JSON before insertion. Narrowing or
changing a value under the target schema refuses. Replica trigger mode is confined to this
privileged transaction to avoid duplicate stock/audit events; normal mode is restored before FK
and invariant checks. Generated columns are omitted from inserts and still compared with the
original row. Failure rolls back all business/global/stub inserts. Repeated import refuses.

Verification includes six DB-free regressions that failed on the supplied patch: exact large signed
integers and decimal tokens, imported-function target enforcement, and source/control URL guards.
The disposable proof builds purchases, sales, receipts, supplier payments, returns, expenses,
openings and a settlement through real RPCs, exports them, checks checksum/coverage/shape/tenant/
coercion refusals and rollback, restores and compares full rows/FKs/invariants. Positive and negative
opening values near their permitted limit and a large fractional stock quantity are checked directly
as exact SQL text after restore. The stock quantity would lose digits through JS Number conversion.
Replaying the original sale/receipt/purchase IDs adds no rows. The fresh target includes public,
auth and storage schema definitions for dependency compatibility; attachment bytes are not restored.

This packet adds no migration or format-v5 envelope. Streaming, complete catalog/schema manifests,
multi-shop edge cases and actual hosted recovery remain broader D3/human-gate work. Final exact-head
CI and independent review are required; test results do not establish shop or production readiness.
