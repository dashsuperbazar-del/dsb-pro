// Packet billcode (mig 0069): proofs that need real separate sessions or the migration text itself.
//  1. Backfill: on a shop with posted purchases and sales, drop the 0069 objects, run the migration file, and
//     check every row got a code and nothing but bill_code/updated_at changed (money, stock, ledgers hashed).
//  2. Same-candidate race: two sessions pick the SAME candidate code; the second waits for the first to commit,
//     then takes the next candidate. Never two documents with one code, never a stuck session.
//  3. 40 parallel postings (20 purchases + 20 sales) in one shop: no error, 40 different codes.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const connectionString =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const migrationSql = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/0069_bill_codes.sql', import.meta.url)),
  'utf8',
);
const ownerId = randomUUID();
const FORMAT = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

const fail = (m) => {
  throw new Error(m);
};
const asAuthenticated = async (c) => {
  await c.query('set local role authenticated');
  await c.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: ownerId, role: 'authenticated' }),
  ]);
};

async function connect() {
  const c = new Client({ connectionString });
  await c.connect();
  return c;
}

async function postSale(shopId, itemId, clientId) {
  const c = await connect();
  try {
    await c.query('begin');
    await asAuthenticated(c);
    const r = await c.query(
      `select phase5_sync_post_sale('bc-dev',1,$1::uuid,null,current_date,0,0,$2,
        jsonb_build_array(jsonb_build_object('item_id',$3::text,'unit_level',1,'qty',1,'price_kind','retail','discount_paise',0,'expected_unit_price_paise',100)),
        jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null)->>'saleId' as id`,
      [shopId, clientId, itemId],
    );
    await c.query('commit');
    return r.rows[0].id;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    await c.end();
  }
}

async function postPurchase(c, shopId, itemId, clientId) {
  const r = await c.query(
    `select post_purchase($1::uuid,null,'BC',current_date,0,0,$2,
      jsonb_build_array(jsonb_build_object('item_id',$3::text,'unit_level',1,'qty',1,'unit_price_paise',50)),null)::text as id`,
    [shopId, clientId, itemId],
  );
  return r.rows[0].id;
}

const admin = await connect();
let originalCandidate = null;
try {
  await admin.query('insert into auth.users(id) values($1)', [ownerId]);
  await admin.query('begin');
  await asAuthenticated(admin);
  await admin.query("select create_tenant('Bill Code Co',$1,'Main Shop',$2)", [
    `bill-code-${randomUUID()}`,
    `tenant-${randomUUID()}`,
  ]);
  const ids = await admin.query(
    `select current_tenant_id() as tenant_id, (select id from shops where tenant_id=current_tenant_id() and is_default limit 1) as shop_id`,
  );
  const { tenant_id: tenantId, shop_id: shopId } = ids.rows[0];
  await admin.query("select register_device('bc-dev','bill-code')");
  const item = await admin.query(
    `insert into items(tenant_id,name,sku,unit1,tax_rate_bp,client_id) values($1,'Code Item',$2,'piece',0,$3) returning id`,
    [tenantId, `BC-${randomUUID()}`, `item-${randomUUID()}`],
  );
  const itemId = item.rows[0].id;
  await admin.query(
    `insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id)
     values($1,$2,$3,'retail',1,100,now()-interval '1 minute',$4)`,
    [tenantId, itemId, shopId, `price-${randomUUID()}`],
  );
  await postPurchase(admin, shopId, itemId, `seed-${randomUUID()}`);
  await admin.query('commit');

  // Raise stock so the 20 parallel sales cannot run out.
  const stockClient = await connect();
  await stockClient.query('begin');
  await asAuthenticated(stockClient);
  for (let i = 0; i < 3; i += 1) {
    await stockClient.query(
      `select post_purchase($1::uuid,null,'BC-STOCK',current_date,0,0,$2,
        jsonb_build_array(jsonb_build_object('item_id',$3::text,'unit_level',1,'qty',100,'unit_price_paise',50)),null)`,
      [shopId, `stock-${randomUUID()}`, itemId],
    );
  }
  await stockClient.query('commit');
  await stockClient.end();

  // 3. 40 parallel postings
  const parallel = await Promise.allSettled([
    ...Array.from({ length: 20 }, () => postSale(shopId, itemId, `par-s-${randomUUID()}`)),
    ...Array.from({ length: 20 }, async () => {
      const c = await connect();
      try {
        await c.query('begin');
        await asAuthenticated(c);
        const id = await postPurchase(c, shopId, itemId, `par-p-${randomUUID()}`);
        await c.query('commit');
        return id;
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        await c.end();
      }
    }),
  ]);
  const rejected = parallel.filter((r) => r.status === 'rejected');
  if (rejected.length)
    fail(`parallel postings failed: ${rejected.map((r) => r.reason?.message).join(' | ')}`);
  const codes = await admin.query(
    `select bill_code from purchase_bills where shop_id=$1 union all select bill_code from sale_invoices where shop_id=$1`,
    [shopId],
  );
  const distinct = new Set(codes.rows.map((r) => r.bill_code));
  if (codes.rowCount !== 44 || distinct.size !== 44)
    fail(`expected 44 documents with 44 different codes, got ${codes.rowCount}/${distinct.size}`);
  if (![...distinct].every((c) => FORMAT.test(c))) fail('a parallel code is outside the format');
  console.log('PARALLEL POSTINGS: 40 documents, 40 different codes, no error');

  // 2. Same-candidate race
  originalCandidate = (
    await admin.query(
      "select pg_get_functiondef('public.dsb_bill_code_candidate()'::regprocedure) as d",
    )
  ).rows[0].d;
  await admin.query(`create or replace function public.dsb_bill_code_candidate() returns text language plpgsql as $f$
    declare v_list text[] := string_to_array(coalesce(current_setting('zz.cands',true),''),',');
            v_i integer := coalesce(nullif(current_setting('zz.i',true),''),'0')::integer + 1;
    begin
      perform set_config('zz.i',v_i::text,false);
      return v_list[least(v_i,array_length(v_list,1))];
    end $f$`);
  const a = await connect();
  const b = await connect();
  try {
    await a.query('begin');
    await asAuthenticated(a);
    await a.query("select set_config('zz.cands','RRRR-2222',false), set_config('zz.i','0',false)");
    const aId = await postPurchase(a, shopId, itemId, `race-a-${randomUUID()}`);
    await b.query(
      "select set_config('zz.cands','RRRR-2222,SSSS-3333',false), set_config('zz.i','0',false)",
    );
    await b.query('begin');
    await asAuthenticated(b);
    let bDone = false;
    const bPost = postPurchase(b, shopId, itemId, `race-b-${randomUUID()}`).then((id) => {
      bDone = true;
      return id;
    });
    await new Promise((r) => setTimeout(r, 1500));
    if (bDone) fail('the second session did not wait for the first to commit');
    await a.query('commit');
    const bId = await Promise.race([
      bPost,
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error('the second session never finished after the first committed')),
          15000,
        ),
      ),
    ]);
    await b.query('commit');
    const rows = await admin.query(
      'select id::text, bill_code from purchase_bills where id = any($1::uuid[])',
      [[aId, bId]],
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.bill_code]));
    if (byId[aId] !== 'RRRR-2222' || byId[bId] !== 'SSSS-3333')
      fail(`race outcome wrong: ${JSON.stringify(byId)}`);
    const tries = (await b.query("select current_setting('zz.i') as i")).rows[0].i;
    if (tries !== '2') fail(`the waiting session should have tried two candidates, tried ${tries}`);
    console.log('SAME-CANDIDATE RACE: first kept RRRR-2222, second waited, then took SSSS-3333');
  } finally {
    await a.end();
    await b.end();
    await admin.query(originalCandidate);
    originalCandidate = null;
  }

  // 1. Backfill on real rows, then roll everything back
  await admin.query('begin');
  const hash = async () =>
    (
      await admin.query(
        `select
          (select md5(coalesce(string_agg((to_jsonb(p)-'bill_code'-'updated_at')::text,'|' order by p.id),'')) from purchase_bills p where shop_id=$1) as purchases,
          (select md5(coalesce(string_agg((to_jsonb(s)-'bill_code'-'updated_at')::text,'|' order by s.id),'')) from sale_invoices s where shop_id=$1) as sales,
          (select md5(coalesce(string_agg(to_jsonb(m)::text,'|' order by m.id),'')) from stock_movements m where shop_id=$1) as movements,
          (select md5(coalesce(string_agg(to_jsonb(p)::text,'|' order by p.id),'')) from payments p where shop_id=$1) as payments,
          (select md5(coalesce(string_agg(to_jsonb(l)::text,'|' order by l.id),'')) from purchase_bill_items l where tenant_id=$2) as lines,
          (select min(updated_at) from sale_invoices where shop_id=$1) as min_sale_updated`,
        [shopId, tenantId],
      )
    ).rows[0];
  const before = await hash();
  await admin.query('drop trigger purchase_bills_bill_code on purchase_bills');
  await admin.query('drop trigger sale_invoices_bill_code on sale_invoices');
  await admin.query('alter table purchase_bills drop column bill_code');
  await admin.query('alter table sale_invoices drop column bill_code');
  await admin.query('drop function find_bills_by_code(uuid,text)');
  await admin.query('drop function dsb_bill_code_guard()');
  await admin.query('drop function dsb_new_bill_code(uuid,boolean)');
  await admin.query('drop function dsb_bill_code_candidate()');
  await admin.query(migrationSql);
  const after = await hash();
  for (const k of ['purchases', 'sales', 'movements', 'payments', 'lines']) {
    if (before[k] !== after[k]) fail(`backfill changed ${k}`);
  }
  if (!(Number(after.min_sale_updated) >= Number(before.min_sale_updated)))
    fail('updated_at went backwards');
  const filled = await admin.query(
    `select count(*)::int total, count(distinct bill_code)::int distinct_codes, count(*) filter (where bill_code ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$')::int ok
       from (select bill_code from purchase_bills where shop_id=$1 union all select bill_code from sale_invoices where shop_id=$1) x`,
    [shopId],
  );
  const f = filled.rows[0];
  if (f.total < 46 || f.total !== f.distinct_codes || f.total !== f.ok)
    fail(`backfill result wrong: ${JSON.stringify(f)}`);
  await admin.query('rollback');
  console.log(
    `BACKFILL: ${f.total} existing documents got ${f.distinct_codes} different codes; money, stock, ledger rows identical`,
  );
} finally {
  if (originalCandidate) await admin.query(originalCandidate).catch(() => {});
  await admin.end();
}
