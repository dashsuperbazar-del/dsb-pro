// SF5: online orders under real concurrency (separate database sessions racing).
//  1. 8 customers race for the last 3 units: exactly 3 orders succeed, held == 3, nothing oversold.
//  2. The same request sent 5 times at once: exactly one order, one hold.
//  3. A POS sale and a fulfilment race for the same item (shop finance lock order): both finish, no deadlock,
//     stock moves exactly once per sale, nothing stays held.
//  4. Two staff devices cancel and hand over the same order at once: exactly one wins, no sale for a cancelled order.
//  5. held == sum of active holds at the end, and ledger invariants pass.
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ownerId = randomUUID();
const slug = `oc-${randomUUID().slice(0, 8)}`;

const fail = (msg, detail) => {
  console.error(`FAIL ${msg}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  process.exit(1);
};
const ok = (msg) => console.log(`ok - ${msg}`);

async function session(fn, { role = 'authenticated', userId = ownerId, ip } = {}) {
  const c = new Client({ connectionString });
  await c.connect();
  try {
    await c.query('begin');
    if (role === 'anon') {
      await c.query('set local role anon');
      await c.query("select set_config('request.headers', $1, true)", [
        JSON.stringify({
          'cf-connecting-ip':
            ip ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        }),
      ]);
    } else {
      await c.query('set local role authenticated');
      await c.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
    }
    const r = await fn(c);
    await c.query('commit');
    return { ok: true, value: r };
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    await c.end();
  }
}

const admin = new Client({ connectionString });
await admin.connect();
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];

try {
  await admin.query('insert into auth.users(id) values($1)', [ownerId]);
  await admin.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: ownerId, role: 'authenticated' }),
  ]);
  const setup = await session(async (c) => {
    await c.query("select create_tenant('Order Concurrency',$1,'Main',$2)", [
      slug,
      `t-${randomUUID()}`,
    ]);
    const r = await c.query(
      'select current_tenant_id() t,(select id from shops where tenant_id=current_tenant_id() and is_default limit 1) s',
    );
    return r.rows[0];
  });
  if (!setup.ok) fail('setup', setup.message);
  const { t: tenant, s: shop } = setup.value;
  const item = (
    await one(
      "insert into items(tenant_id,name,unit1,client_id) values($1,'Oil','pc',$2) returning id",
      [tenant, `oc-item-${randomUUID()}`],
    )
  ).id;
  await admin.query(
    "insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,client_id) values($1,$2,null,'retail',1,10000,$3)",
    [tenant, item, `oc-p-${randomUUID()}`],
  );
  await admin.query(
    "insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id) values($1,$2,$3,'ADJUSTMENT',gen_random_uuid(),3,$4)",
    [tenant, shop, item, `oc-open-${randomUUID()}`],
  );
  const cfg = await session(async (c) => {
    await c.query('select set_storefront_items($1,$2,$3)', [
      shop,
      JSON.stringify([{ itemId: item, published: true }]),
      `oc-i-${randomUUID().slice(0, 8)}`,
    ]);
    await c.query('select set_storefront_settings($1,$2,$3)', [
      shop,
      JSON.stringify({ slug, displayName: 'OC', enabled: true }),
      `oc-s-${randomUUID()}`,
    ]);
  });
  if (!cfg.ok) fail('storefront config', cfg.message);

  const order = (requestId, token, qty) =>
    session(
      (c) =>
        c.query(
          'select place_order($1,$2::uuid,$3,\'pickup\',null,\'{"name":"R","phone":"9876543210"}\'::jsonb,$4::jsonb) r',
          [
            slug,
            requestId,
            token,
            JSON.stringify([{ itemId: item, unitLevel: 1, qty: String(qty) }]),
          ],
        ),
      { role: 'anon' },
    );
  const stock = () =>
    one('select on_hand::numeric oh, reserved::numeric res from stock_current where item_id=$1', [
      item,
    ]);
  const activeHolds = () =>
    one(
      'select coalesce(sum(qty_base),0)::numeric h from stock_reservations where item_id=$1 and released_at is null',
      [item],
    );

  // 1. Race for the last 3 units.
  const race = await Promise.all(
    Array.from({ length: 8 }, () => order(randomUUID(), randomBytes(32).toString('hex'), 1)),
  );
  const won = race.filter((r) => r.ok).length;
  if (won !== 3)
    fail(
      'exactly 3 of 8 racing orders get the last 3 units',
      race.map((r) => r.ok || r.message),
    );
  const s1 = await stock();
  if (Number(s1.res) !== 3 || Number(s1.oh) !== 3) fail('held 3, on hand 3', s1);
  ok('8 customers race for 3 units: exactly 3 orders, nothing oversold');

  // Free them for the next steps.
  const open = (
    await admin.query("select id,revision from orders where shop_id=$1 and status='NEW'", [shop])
  ).rows;
  for (const o of open) {
    const r = await session((c) =>
      c.query("select set_order_status($1,'CANCELLED',$2,'test')", [o.id, o.revision]),
    );
    if (!r.ok) fail('cancel', r.message);
  }
  if (Number((await stock()).res) !== 0) fail('all released', await stock());

  // 2. Same request 5 times at once.
  const rid = randomUUID();
  const tok = randomBytes(32).toString('hex');
  const dup = await Promise.all(Array.from({ length: 5 }, () => order(rid, tok, 1)));
  if (!dup.every((r) => r.ok))
    fail(
      'every duplicate gets the same order back',
      dup.map((r) => r.message),
    );
  const refs = new Set(dup.map((r) => r.value.rows[0].r.ref));
  const n = await one('select count(*)::int n from orders where request_id=$1', [rid]);
  if (refs.size !== 1 || n.n !== 1 || Number((await stock()).res) !== 1)
    fail('one order, one hold', { refs: [...refs], n });
  ok('the same request 5 times at once: one order, one hold');

  // 3. Fulfilment racing a POS sale of the remaining free units.
  const o = await one('select id from orders where request_id=$1', [rid]);
  for (const [to, rev] of [
    ['CONFIRMED', 1],
    ['PREPARING', 2],
    ['READY', 3],
  ]) {
    const r = await session((c) => c.query('select set_order_status($1,$2,$3)', [o.id, to, rev]));
    if (!r.ok) fail(`step ${to}`, r.message);
  }
  const [ful, pos] = await Promise.all([
    session((c) =>
      c.query('select fulfil_order($1,4,\'[{"mode":"cash","amount_paise":10000}]\'::jsonb) r', [
        o.id,
      ]),
    ),
    session((c) =>
      c.query(
        "select post_sale($1,null,current_date,0,0,$2,jsonb_build_array(jsonb_build_object('item_id',$3::text,'unit_level',1,'qty',2,'price_kind','retail')),'[{\"mode\":\"cash\",\"amount_paise\":20000}]'::jsonb)",
        [shop, `oc-pos-${randomUUID()}`, item],
      ),
    ),
  ]);
  if (!ful.ok || !pos.ok)
    fail('fulfilment and a POS sale both finish (no deadlock)', [ful.message, pos.message]);
  const s3 = await stock();
  if (Number(s3.oh) !== 0 || Number(s3.res) !== 0)
    fail('3 units sold exactly once, nothing held', s3);
  ok('fulfilment and a counter sale race: both finish, stock moves exactly once each');

  // 4. Cancel vs hand-over on the same READY order.
  await admin.query(
    "insert into stock_movements(tenant_id,shop_id,item_id,source_type,source_id,qty_base,client_id) values($1,$2,$3,'ADJUSTMENT',gen_random_uuid(),2,$4)",
    [tenant, shop, item, `oc-refill-${randomUUID()}`],
  );
  const r2 = randomUUID();
  if (!(await order(r2, randomBytes(32).toString('hex'), 1)).ok) fail('order 4');
  const o2 = await one('select id from orders where request_id=$1', [r2]);
  for (const [to, rev] of [
    ['CONFIRMED', 1],
    ['PREPARING', 2],
    ['READY', 3],
  ]) {
    await session((c) => c.query('select set_order_status($1,$2,$3)', [o2.id, to, rev]));
  }
  const [cx, fx] = await Promise.all([
    session((c) => c.query("select set_order_status($1,'CANCELLED',4,'race')", [o2.id])),
    session((c) =>
      c.query('select fulfil_order($1,4,\'[{"mode":"cash","amount_paise":10000}]\'::jsonb)', [
        o2.id,
      ]),
    ),
  ]);
  const final = await one('select status,sale_invoice_id from orders where id=$1', [o2.id]);
  if ([cx.ok, fx.ok].filter(Boolean).length !== 1)
    fail('exactly one of cancel / hand-over wins', [cx.message, fx.message]);
  if (final.status === 'CANCELLED' && final.sale_invoice_id)
    fail('a cancelled order has no sale', final);
  if (final.status === 'DELIVERED' && !final.sale_invoice_id)
    fail('a delivered order has its sale', final);
  ok(`cancel and hand-over race: one wins (${final.status}), never both`);

  // 5. Invariants.
  const s5 = await stock();
  const h5 = await activeHolds();
  if (Number(s5.res) !== Number(h5.h)) fail('held == sum of active holds', { s5, h5 });
  const inv = await session((c) => c.query('select check_invariants() r'));
  if (!inv.ok || inv.value.rows[0].r.ok !== true)
    fail('ledger invariants', inv.message ?? inv.value.rows[0].r);
  ok('held equals active holds; ledger invariants pass');
  console.log('ORDER CONCURRENCY PROOF: PASS');
} finally {
  await admin.end();
}
