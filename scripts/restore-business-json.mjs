#!/usr/bin/env node
// D3b: restore one business JSON export (phase6_export_tenant, format v4) into an EMPTY disposable
// PostgreSQL target that already has the DSB schema. Operator tool only — never production replacement.
//
//   node scripts/restore-business-json.mjs <export.json> <target-url> [--expect-sha256 HEX]
//        [--create-auth-stubs] [--allow-target HOST]
//
// Safety: the target host must be local or named with --allow-target; the file is fully validated
// before any write; the target must have no tenants; everything runs in ONE transaction, which
// rolls back unless every row matches the file, every foreign key holds and check_invariants passes.
// Triggers are off only inside that transaction (session_replication_role=replica) so restored
// stock/audit rows are not posted twice; foreign keys are then checked explicitly.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'export-tables.json'), 'utf8'),
);

export class RestoreError extends Error {}
const fail = (msg) => {
  throw new RestoreError(msg);
};

export function parseArgs(argv) {
  const [file, target, ...rest] = argv;
  if (!file || !target)
    fail('usage: restore-business-json.mjs <export.json> <target-url> [options]');
  const opts = { file, target, expectSha256: null, createAuthStubs: false, allowTargets: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--expect-sha256') {
      opts.expectSha256 = String(rest[++i] ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(opts.expectSha256))
        fail('--expect-sha256 needs a 64-hex checksum');
    } else if (rest[i] === '--create-auth-stubs') opts.createAuthStubs = true;
    else if (rest[i] === '--allow-target') opts.allowTargets.push(String(rest[++i] ?? ''));
    else fail(`unknown option ${rest[i]}`);
  }
  return opts;
}

export function checkTarget(url, allowTargets) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('target URL is not valid');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    fail('target must be a PostgreSQL URL');
  // Check the host the driver will actually use: a ?host= parameter overrides the URL host.
  const hosts = new Set([parsed.hostname, new pg.Client({ connectionString: url }).host]);
  for (const k of ['host', 'hostaddr'])
    if (parsed.searchParams.has(k)) hosts.add(parsed.searchParams.get(k));
  const allowed = ['127.0.0.1', 'localhost', '::1', '[::1]', ...allowTargets.filter(Boolean)];
  for (const host of hosts)
    if (!allowed.includes(host))
      fail(
        `target host ${host} is not allowed; restore only into a disposable target (--allow-target)`,
      );
}

// Validate the whole file before connecting: format, every mapped key, row shapes, one tenant.
export function validateExport(raw, expectSha256) {
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (expectSha256 && expectSha256 !== sha256)
    fail(`file checksum ${sha256} does not match the expected ${expectSha256}`);
  let doc;
  try {
    // Keep numeric tokens exact all the way into jsonb_populate_recordset. Parsing
    // PostgreSQL bigint/numeric values as JS Numbers would round the restore itself.
    doc = JSON.parse(raw, (_key, value, context) =>
      typeof value === 'number' ? JSON.rawJSON(context.source) : value,
    );
  } catch {
    fail('file is not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || JSON.isRawJSON(doc))
    fail('export must be a JSON object');
  if (!JSON.isRawJSON(doc.schemaVersion) || !/^(0|[1-9][0-9]*)$/.test(doc.schemaVersion.rawJSON))
    fail('export format must be an integer');
  const version = Number(doc.schemaVersion.rawJSON);
  doc.schemaVersion = version;
  if (!manifest.formatVersions.includes(doc.schemaVersion))
    fail(`unknown export format ${JSON.stringify(doc.schemaVersion)}`);
  if (doc.exportKind !== 'portable-business-data') fail('not a business data export');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(String(doc.tenantId)) || !uuid.test(String(doc.shopId)))
    fail('export has no valid tenantId/shopId');
  const known = new Set(manifest.tables.map((t) => t.key));
  for (const k of Object.keys(doc)) {
    const meta = ['schemaVersion', 'exportKind', 'exportedAt', 'tenantId', 'shopId'];
    if (!known.has(k) && !meta.includes(k)) fail(`unmapped export key ${k}`);
  }
  const tables = manifest.tables.map((t) => {
    // An optional table was added after format 4 shipped: an older export has none of it, which is valid.
    if (!(t.key in doc) && !t.optional) fail(`export is missing ${t.key}`);
    const rows = t.single ? [doc[t.key]] : (doc[t.key] ?? []);
    if (!Array.isArray(rows)) fail(`${t.key} must be a list`);
    for (const r of rows) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || JSON.isRawJSON(r))
        fail(`${t.key} has a malformed row`);
      if (t.scope !== 'global' && r[t.table === 'tenants' ? 'id' : 'tenant_id'] !== doc.tenantId)
        fail(`${t.key} has a row from another tenant`);
    }
    return { ...t, rows };
  });
  return { sha256, doc, tables };
}

const q = (id) => `"${id.replaceAll('"', '""')}"`;

async function columns(c, table) {
  const r = await c.query(
    `select a.attname, a.attgenerated<>'' as generated from pg_attribute a
      where a.attrelid=$1::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`,
    [`public.${table}`],
  );
  return r.rows;
}

// Every foreign key on a restored table must resolve (they were not enforced while triggers were off).
async function checkForeignKeys(c, tables) {
  const r = await c.query(
    `select con.conname, con.conrelid::regclass::text child, con.confrelid::regclass::text parent,
       (select array_agg(a.attname::text order by k.n) from unnest(con.conkey) with ordinality k(attnum,n)
         join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.attnum) ccols,
       (select array_agg(a.attname::text order by k.n) from unnest(con.confkey) with ordinality k(attnum,n)
         join pg_attribute a on a.attrelid=con.confrelid and a.attnum=k.attnum) pcols
     from pg_constraint con where con.contype='f' and con.conrelid = any($1::regclass[])`,
    [tables.map((t) => `public.${t}`)],
  );
  const broken = [];
  for (const fk of r.rows) {
    const notNull = fk.ccols.map((col) => `c.${q(col)} is not null`).join(' and ');
    const match = fk.ccols.map((col, i) => `p.${q(fk.pcols[i])}=c.${q(col)}`).join(' and ');
    const n = await c.query(
      `select count(*)::int n from ${fk.child} c where ${notNull}
        and not exists(select 1 from ${fk.parent} p where ${match})`,
    );
    if (n.rows[0].n > 0) broken.push(`${fk.conname} (${n.rows[0].n})`);
  }
  if (broken.length) fail(`foreign keys do not resolve: ${broken.join(', ')}`);
  return r.rows.length;
}

export async function restore({ raw, target, expectSha256, createAuthStubs, allowTargets = [] }) {
  checkTarget(target, allowTargets);
  const { sha256, doc, tables } = validateExport(raw, expectSha256);
  const c = new pg.Client({ connectionString: target });
  await c.connect();
  const report = { sha256, tenantId: doc.tenantId, shopId: doc.shopId, tables: {} };
  try {
    await c.query('begin');
    await c.query("set local lock_timeout='10s'");
    await c.query("set local timezone='UTC'");
    const initial = await c.query('select count(*)::int n from public.tenants');
    if (initial.rows[0].n > 0)
      fail('target already has tenants; restore only into an empty target');
    // Hold every restored table through the empty-target check and final comparison.
    // Otherwise a concurrent writer could add rows after that table was checked.
    await c.query(
      `lock table ${tables.map((t) => `public.${q(t.table)}`).join(',')} in access exclusive mode`,
    );
    const existing = await c.query('select count(*)::int n from public.tenants');
    if (existing.rows[0].n > 0)
      fail('target already has tenants; restore only into an empty target');
    // Every row must carry exactly the target's columns: an unknown key would be dropped silently
    // and a missing one would become NULL, and neither would show in the row comparison below.
    const colsByTable = new Map();
    for (const t of tables) {
      const all = await columns(c, t.table);
      if (!all.length) fail(`target has no table ${t.table}`);
      const want = all
        .map((x) => x.attname)
        .sort()
        .join(',');
      for (const r of t.rows)
        if (Object.keys(r).sort().join(',') !== want)
          fail(`${t.key}: row columns do not match the target table ${t.table}`);
      colsByTable.set(
        t.table,
        all.filter((col) => !col.generated).map((x) => x.attname),
      );
      // Compare with the input JSON before insertion, not just two copies of the
      // same coerced record. A narrower numeric type or a string-to-number cast
      // must not silently change an immutable row under a different schema.
      const cast = await c.query(
        `select count(*)::int changed from jsonb_array_elements($1::jsonb) as src(value)
          where to_jsonb(jsonb_populate_record(null::public.${q(t.table)}, src.value)) is distinct from src.value`,
        [JSON.stringify(t.rows)],
      );
      if (cast.rows[0].changed > 0)
        fail(`${t.key}: row values would change under the target schema`);
    }
    await c.query('set local session_replication_role=replica');
    for (const t of tables) {
      const cols = colsByTable.get(t.table);
      const list = cols.map(q).join(',');
      const conflict = t.scope === 'global' ? ' on conflict do nothing' : '';
      await c.query(
        `insert into public.${q(t.table)}(${list}) overriding system value
          select ${list} from jsonb_populate_recordset(null::public.${q(t.table)},$1::jsonb)${conflict}`,
        [JSON.stringify(t.rows)],
      );
    }
    await c.query('set local session_replication_role=origin');

    if (createAuthStubs) {
      // Portable target only: placeholder auth identities, not working logins.
      await c.query(
        `insert into auth.users(id) select distinct user_id from public.tenant_users
          where user_id is not null union select distinct user_id from public.devices
          where user_id is not null on conflict do nothing`,
      );
    }
    report.foreignKeys = await checkForeignKeys(
      c,
      tables.map((t) => t.table),
    );

    // Exact content: every file row is present unchanged, and nothing else is in the target.
    for (const t of tables) {
      const tbl = `public.${q(t.table)}`;
      const r = await c.query(
        `with src as (select jsonb_populate_record(null::${tbl}, e) r from jsonb_array_elements($1::jsonb) e)
         select (select count(*)::int from src where not exists(
                   select 1 from ${tbl} x where x::text=(src.r)::text)) missing,
                (select count(*)::int from ${tbl}) target_rows`,
        [JSON.stringify(t.rows)],
      );
      const { missing, target_rows } = r.rows[0];
      if (missing > 0) fail(`${t.key}: ${missing} row(s) differ from the file`);
      if (t.scope !== 'global' && target_rows !== t.rows.length)
        fail(`${t.key}: target has ${target_rows} rows, file has ${t.rows.length}`);
      report.tables[t.key] = t.rows.length;
    }

    const owner = (doc.tenantUsers ?? []).find((u) => u.role === 'owner' && u.user_id);
    if (!owner) fail('export has no owner to run the invariant check as');
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: owner.user_id, role: 'authenticated' }),
    ]);
    await c.query("select set_config('request.jwt.claim.sub',$1,true)", [owner.user_id]);
    const inv = (await c.query('select public.check_invariants() v')).rows[0].v;
    await c.query('reset role');
    if (!inv || inv.ok !== true) fail(`invariants fail after restore: ${JSON.stringify(inv)}`);
    report.invariants = inv;
    await c.query('commit');
    return report;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    checkTarget(opts.target, opts.allowTargets);
    const report = await restore({ ...opts, raw: readFileSync(opts.file, 'utf8') });
    console.log(JSON.stringify({ restored: true, ...report }, null, 2));
  } catch (e) {
    console.error(`RESTORE REFUSED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
