// D3b proof (COMPLETE_REMAINING_BUILD_PLAN v1.1 §11.3): a non-empty shop built through the real RPCs
// is exported, restored into a fresh database with the same schema, and compared row for row.
// Also: refusals happen before any write, a corrupted amount is caught, a half-done restore rolls
// back, a repeat import refuses, and replaying original request IDs on the restored copy adds nothing.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { checkTarget, restore, RestoreError } from './restore-business-json.mjs';

const source =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const superUrl =
  process.env.RESTORE_SUPER_URL ?? 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres';
const container = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_phase-0-foundations';
// Refuse production addresses before fixture writes, database creation or deletion.
checkTarget(source, []);
checkTarget(superUrl, []);
const targetDb = `dsb_d3b_${randomUUID().replaceAll('-', '')}`;
const targetUrl = new URL(superUrl);
targetUrl.pathname = `/${targetDb}`;
const target = targetUrl.href;
checkTarget(target, []);
if (new pg.Client({ connectionString: target }).database !== targetDb) {
  throw new Error('Target database override is not allowed in the restore proof.');
}
const ownerId = randomUUID();
const assert = (ok, msg, detail) => {
  if (!ok) throw new Error(`${msg}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`ok - ${msg}`);
};

async function client(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
async function asOwner(c) {
  await c.query('set local role authenticated');
  await c.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: ownerId, role: 'authenticated' }),
  ]);
}

// Fresh target: same schema as the source (public + auth), no rows.
async function freshTarget() {
  const a = await client(superUrl);
  await a.query(`create database ${targetDb}`);
  await a.end();
  const schema = execFileSync(
    'docker',
    [
      'exec',
      container,
      'pg_dump',
      '-U',
      'supabase_admin',
      '--schema-only',
      '-n',
      'public',
      '-n',
      'auth',
      '-n',
      'storage',
      'postgres',
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  )
    .toString()
    .replace(/^CREATE SCHEMA public;$/m, '')
    .replace(/^CREATE SCHEMA auth;$/m, 'CREATE SCHEMA IF NOT EXISTS auth;');
  const prelude = `create schema if not exists extensions;
    create extension if not exists btree_gist with schema extensions;
    create extension if not exists pgcrypto with schema extensions;
    create extension if not exists "uuid-ossp" with schema extensions;`;
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-q',
      '-U',
      'supabase_admin',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      targetDb,
    ],
    { input: prelude + schema, stdio: ['pipe', 'ignore', 'inherit'], maxBuffer: 256 * 1024 * 1024 },
  );
}

async function targetCount(sql) {
  const c = await client(target);
  try {
    return (await c.query(sql)).rows[0].n;
  } finally {
    await c.end();
  }
}
async function refuses(raw, msg, pattern, extra = {}) {
  try {
    await restore({ raw, target, ...extra });
  } catch (e) {
    const tenants = await targetCount(
      `select ((select count(*) from public.tenants)+(select count(*) from public.sale_invoices)
        +(select count(*) from public.payments)+(select count(*) from public.stock_movements)
        +(select count(*) from public.financial_requests)+(select count(*) from public.permissions)
        +(select count(*) from public.audit_log))::int n`,
    );
    assert(pattern.test(String(e.message)) && tenants === 0, `${msg} (target left empty)`, {
      error: e.message,
      tenants,
    });
    return;
  }
  throw new Error(`${msg}: restore was accepted`);
}

// ---- 1. a realistic shop through the real RPCs
const src = await client(source);
const req = {};
let raw;
const exactOpenings = [];
try {
  await src.query('insert into auth.users(id) values($1)', [ownerId]);
  await src.query('begin');
  await asOwner(src);
  await src.query("select create_tenant('Restore Co',$1,'Main Shop',$2)", [
    `d3b-${randomUUID()}`,
    `tenant-${randomUUID()}`,
  ]);
  const { t, s } = (
    await src.query(`select current_tenant_id() t,
      (select id from shops where tenant_id=current_tenant_id() and is_default limit 1) s`)
  ).rows[0];
  const one = async (sql, params) => Object.values((await src.query(sql, params)).rows[0])[0];
  const item = await one(
    `insert into items(tenant_id,name,unit1,client_id) values($1,'Restore Item','piece',$2) returning id`,
    [t, `item-${randomUUID()}`],
  );
  const customer = await one(
    `insert into customers(tenant_id,name,client_id) values($1,'Restore Customer',$2) returning id`,
    [t, `cust-${randomUUID()}`],
  );
  const party = await one(
    `insert into parties(tenant_id,name,client_id) values($1,'Restore Supplier',$2) returning id`,
    [t, `party-${randomUUID()}`],
  );
  await src.query(`select set_item_price($1::uuid,$2::uuid,'retail',1::smallint,1000::bigint,$3)`, [
    item,
    s,
    `price-${randomUUID()}`,
  ]);
  const line = (qty, price) =>
    JSON.stringify([{ item_id: item, unit_level: 1, qty, unit_price_paise: price }]);
  req.purchase = [s, party, 'B-1', randomUUID(), line(20, 500)];
  const bill = await one(
    `select post_purchase($1::uuid,$2::uuid,$3,current_date,0,0,$4,$5::jsonb,null)`,
    req.purchase,
  );
  req.sale = [
    s,
    customer,
    randomUUID(),
    JSON.stringify([{ item_id: item, unit_level: 1, qty: 3, price_kind: 'retail' }]),
  ];
  const saleSql = `select post_sale($1::uuid,$2::uuid,current_date,0,0,$3,$4::jsonb,'[]'::jsonb,null)`;
  const sale = await one(saleSql, req.sale);
  req.receipt = [
    s,
    customer,
    JSON.stringify([{ sale_invoice_id: sale, amount_paise: 1000 }]),
    randomUUID(),
  ];
  const receiptSql = `select record_customer_payment($1::uuid,$2::uuid,current_date,1000,'cash',null,$3::jsonb,$4)`;
  await one(receiptSql, req.receipt);
  await src.query(
    `select record_supplier_payment($1::uuid,$2::uuid,current_date,4000,'cash',null,$3::jsonb,$4)`,
    [s, party, JSON.stringify([{ purchase_bill_id: bill, amount_paise: 4000 }]), randomUUID()],
  );
  const saleLine = await one('select id from sale_invoice_items where sale_invoice_id=$1', [sale]);
  await src.query(`select post_return('SALE',$1::uuid,current_date,$2,$3::jsonb,'restore proof')`, [
    sale,
    randomUUID(),
    JSON.stringify([{ sale_invoice_item_id: saleLine, qty: 1, disposition: 'RETURN_TO_SELLABLE' }]),
  ]);
  await src.query(
    `select post_expense($1::uuid,current_date,'Rent','Shop rent',2500,'cash',null,$2)`,
    [s, randomUUID()],
  );
  const opening = await one(
    `select record_account_opening($1::uuid,'CUSTOMER',$2::uuid,current_date-30,5000,'cutover balance',$3)`,
    [s, customer, randomUUID()],
  );
  const advance = await one(
    `select record_customer_payment($1::uuid,$2::uuid,current_date,3000,'cash',null,'[]'::jsonb,$3)`,
    [s, customer, randomUUID()],
  );
  await src.query(`select settle_opening($1::uuid,$2::uuid,2000,$3)`, [
    opening,
    advance,
    randomUUID(),
  ]);
  // Export as PostgreSQL text, and prove real restored bigint values beyond JS's
  // safe integer range in both directions, not a comparison to a rounded JS object.
  for (const amount of ['9007199254740993', '-9007199254740993']) {
    const exactCustomer = await one(
      `insert into customers(tenant_id,name,client_id) values($1,'Exact opening customer',$2) returning id`,
      [t, `exact-customer-${randomUUID()}`],
    );
    const id = await one(
      `select record_account_opening($1::uuid,'CUSTOMER',$2::uuid,current_date-30,$3::bigint,'exact restore proof',$4)`,
      [s, exactCustomer, amount, randomUUID()],
    );
    exactOpenings.push({ id, amount });
  }
  raw = (await src.query('select phase6_export_tenant($1::uuid)::text e', [s])).rows[0].e;
  const inv = (await src.query('select check_invariants() v')).rows[0].v;
  assert(inv.ok === true, 'source invariants pass before export', inv);
  await src.query('commit');
} finally {
  await src.end();
}
const doc = JSON.parse(raw);
for (const k of [
  'sales',
  'payments',
  'allocations',
  'saleReturns',
  'expenses',
  'accountOpenings',
  'openingSettlements',
  'financialRequests',
  'stockMovements',
])
  assert(doc[k].length > 0, `fixture has ${k}`);

// ---- 2. refusals and rollbacks, each leaving the target empty
await freshTarget();
assert(
  (() => {
    try {
      checkTarget('postgresql://u:p@db.example.com:5432/postgres', []);
      return false;
    } catch (e) {
      return e instanceof RestoreError;
    }
  })(),
  'a non-local target is refused without --allow-target',
);
await refuses(
  JSON.stringify({ ...doc, schemaVersion: 99 }),
  'unknown format refuses before writes',
  /unknown export format/,
);
const noRequests = { ...doc };
delete noRequests.financialRequests;
await refuses(
  JSON.stringify(noRequests),
  'missing request ledger refuses',
  /missing financialRequests/,
);
await refuses(
  JSON.stringify({
    ...doc,
    items: [...doc.items, { ...doc.items[0], id: randomUUID(), tenant_id: randomUUID() }],
  }),
  'a row from another tenant refuses',
  /another tenant/,
);
{
  const extra = structuredClone(doc);
  extra.sales[0].future_fee_paise = 100;
  await refuses(
    JSON.stringify(extra),
    'a column the target lacks refuses instead of being dropped',
    /row columns do not match/,
  );
  const missing = structuredClone(doc);
  delete missing.payments[0].amount_paise;
  await refuses(
    JSON.stringify(missing),
    'a row missing a column refuses instead of becoming NULL',
    /row columns do not match/,
  );
  const coerced = structuredClone(doc);
  coerced.sales[0].total_paise = String(coerced.sales[0].total_paise);
  await refuses(
    JSON.stringify(coerced),
    'a coerced row refuses before writes',
    /row values would change/,
  );
}
assert(
  (() => {
    try {
      checkTarget('postgresql://u:p@localhost/postgres?host=db.example.com', []);
      return false;
    } catch (e) {
      return e instanceof RestoreError;
    }
  })(),
  'a ?host= override to a non-local server is refused',
);
const corrupt = structuredClone(doc);
corrupt.sales[0].total_paise = Number(corrupt.sales[0].total_paise) + 100;
const { createHash } = await import('node:crypto');
const goodSha = createHash('sha256').update(raw).digest('hex');
await refuses(JSON.stringify(corrupt), 'a corrupted amount fails the file checksum', /checksum/, {
  expectSha256: goodSha,
});
await refuses(
  JSON.stringify(corrupt),
  'a corrupted amount fails invariants and rolls back the half-done restore',
  /invariants fail/,
  { createAuthStubs: true },
);

// ---- 3. the real restore
const report = await restore({ raw, target, expectSha256: goodSha, createAuthStubs: true });
{
  const exactClient = await client(target);
  try {
    for (const { id, amount } of exactOpenings) {
      const restored = (
        await exactClient.query(
          'select amount_paise::text amount from public.account_openings where id=$1',
          [id],
        )
      ).rows[0];
      assert(restored?.amount === amount, 'real restored opening preserves exact signed bigint', {
        expected: amount,
        actual: restored?.amount,
      });
    }
  } finally {
    await exactClient.end();
  }
}
assert(
  report.invariants.ok === true && report.foreignKeys > 0,
  'restore commits with all rows equal, FKs and invariants',
);
{
  const sales = await targetCount('select count(*)::int n from public.sale_invoices');
  let message = '';
  await restore({ raw, target, createAuthStubs: true }).catch((e) => (message = String(e.message)));
  const after = await targetCount('select count(*)::int n from public.sale_invoices');
  assert(
    /already has tenants/.test(message) && after === sales,
    'a repeat import refuses instead of appending',
    { message, sales, after },
  );
}

// ---- 4. replaying original request IDs on the restored copy adds nothing
const tc = await client(target);
try {
  const counts = async () =>
    (
      await tc.query(`select (select count(*) from sale_invoices)::int sales,
        (select count(*) from payments)::int payments,
        (select count(*) from stock_movements)::int moves,
        (select count(*) from purchase_bills)::int bills`)
    ).rows[0];
  const before = await counts();
  await tc.query('begin');
  await asOwner(tc);
  await tc.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
  const sale = (
    await tc.query(
      `select post_sale($1::uuid,$2::uuid,current_date,0,0,$3,$4::jsonb,'[]'::jsonb,null) id`,
      req.sale,
    )
  ).rows[0].id;
  await tc.query(
    `select record_customer_payment($1::uuid,$2::uuid,current_date,1000,'cash',null,$3::jsonb,$4)`,
    req.receipt,
  );
  await tc.query(
    `select post_purchase($1::uuid,$2::uuid,$3,current_date,0,0,$4,$5::jsonb,null)`,
    req.purchase,
  );
  await tc.query('commit');
  assert(sale === doc.sales[0].id, 'sale replay returns the original sale id');
  assert(
    JSON.stringify(await counts()) === JSON.stringify(before),
    'replays add no sale, payment, bill or stock movement',
    { before, after: await counts() },
  );
} finally {
  await tc.end();
}
const a = await client(superUrl);
await a.query(`drop database if exists ${targetDb} with (force)`);
await a.end();
console.log('D3b restore proof passed');
