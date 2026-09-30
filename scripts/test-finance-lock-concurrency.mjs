// Packet C0 gate (SINGLE_BUILDER_PLAN v2.0 row 3): real multi-connection proof that
//  1. five sessions racing to allocate the same invoice cannot double-allocate it, and
//  2. the shop finance lock serializes money writers within one shop while a second shop in the
//     same tenant is not blocked.
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ownerId = randomUUID();

function jwt(userId) {
  return JSON.stringify({ sub: userId, role: 'authenticated' });
}

async function asAuthenticated(client, userId) {
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claims', $1, true)", [jwt(userId)]);
}

async function connect() {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function inTransaction(fn) {
  const client = await connect();
  try {
    await client.query('begin');
    await asAuthenticated(client, ownerId);
    const value = await fn(client);
    await client.query('commit');
    return { ok: true, value };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end();
  }
}

const saleSql = `select post_sale($1::uuid,$2::uuid,current_date,0,0,$3,
  jsonb_build_array(jsonb_build_object('item_id',$4::text,'unit_level',1,'qty',1,'price_kind','retail')),$5::jsonb,null)`;

const admin = await connect();
try {
  await admin.query('insert into auth.users(id) values($1)', [ownerId]);
  await admin.query('begin');
  await asAuthenticated(admin, ownerId);
  await admin.query("select create_tenant('Finance Lock Co',$1,'Main Shop',$2)", [`finance-lock-${randomUUID()}`, `tenant-${randomUUID()}`]);
  const base = await admin.query(`select current_tenant_id() as tenant_id,
    (select id from shops where tenant_id=current_tenant_id() and is_default limit 1) as shop_id`);
  const { tenant_id: tenantId, shop_id: shopA } = base.rows[0];
  await admin.query('commit');

  const shopB = randomUUID();
  await admin.query('insert into shops(id,tenant_id,name,created_by) values($1,$2,$3,$4)', [shopB, tenantId, 'Second Shop', ownerId]);

  await admin.query('begin');
  await asAuthenticated(admin, ownerId);
  const item = await admin.query(
    `insert into items(tenant_id,name,unit1,client_id) values($1,'Lock Item','piece',$2) returning id`,
    [tenantId, `item-${randomUUID()}`],
  );
  const itemId = item.rows[0].id;
  const customer = await admin.query(
    `insert into customers(tenant_id,name,client_id) values($1,'Lock Customer',$2) returning id`,
    [tenantId, `cust-${randomUUID()}`],
  );
  const customerId = customer.rows[0].id;
  for (const shopId of [shopA, shopB]) {
    await admin.query(`select set_item_price($1::uuid,$2::uuid,'retail',1::smallint,1000::bigint,$3)`, [itemId, shopId, `price-${randomUUID()}`]);
    await admin.query(
      `select post_purchase($1::uuid,null,$2,current_date,0,0,$3,
        jsonb_build_array(jsonb_build_object('item_id',$4::text,'unit_level',1,'qty',50,'unit_price_paise',500)),null)`,
      [shopId, `SEED-${randomUUID()}`, `seed-${randomUUID()}`, itemId],
    );
  }
  const credit = await admin.query(saleSql, [shopA, customerId, `credit-${randomUUID()}`, itemId, '[]']);
  const saleId = credit.rows[0].post_sale;
  await admin.query('commit');

  // 1. Five sessions each try to allocate the full 1000-paise invoice.
  const race = await Promise.all(
    Array.from({ length: 5 }, () =>
      inTransaction((client) =>
        client.query(
          `select record_customer_payment($1::uuid,$2::uuid,current_date,1000,'cash',null,
            jsonb_build_array(jsonb_build_object('sale_invoice_id',$3::text,'amount_paise',1000)),$4)`,
          [shopA, customerId, saleId, `race-${randomUUID()}`],
        ),
      ),
    ),
  );
  const winners = race.filter((r) => r.ok);
  const losers = race.filter((r) => !r.ok);
  if (winners.length !== 1 || losers.length !== 4) {
    throw new Error(`expected exactly one of five allocations to win: ${JSON.stringify(race)}`);
  }
  for (const loser of losers) {
    if (!/allocation exceeds (document outstanding amount|invoice balance)/i.test(loser.message)) {
      throw new Error(`allocation race loser failed for the wrong reason: ${loser.message}`);
    }
  }
  const allocated = await admin.query(
    `select coalesce(sum(amount_paise),0)::bigint as total, count(*)::int as n
       from payment_allocations where tenant_id=$1 and sale_invoice_id=$2 and status='POSTED'`,
    [tenantId, saleId],
  );
  if (Number(allocated.rows[0].total) !== 1000 || allocated.rows[0].n !== 1) {
    throw new Error(`double allocation: ${JSON.stringify(allocated.rows[0])}`);
  }

  // 2. Hold ONLY shop A's finance advisory lock (no row locks), so a blocked probe can only be
  //    blocked by that lock -- not by stock rows or document counters a real sale would also hold.
  const holder = await connect();
  await holder.query('begin');
  await holder.query('select dsb_lock_shop_finance($1::uuid,$2::uuid)', [tenantId, shopA]);

  const withLockTimeout = (shopId) =>
    inTransaction(async (client) => {
      await client.query("set local lock_timeout = '1500ms'");
      return client.query(saleSql, [shopId, null, `probe-${randomUUID()}`, itemId, JSON.stringify([{ amount_paise: 1000, mode: 'cash' }])]);
    });

  const [sameShop, otherShop] = await Promise.all([withLockTimeout(shopA), withLockTimeout(shopB)]);
  await holder.query('rollback');
  await holder.end();

  if (sameShop.ok || !/lock timeout/i.test(sameShop.message)) {
    throw new Error(`a second money writer in the same shop was not serialized: ${JSON.stringify(sameShop)}`);
  }
  if (!otherShop.ok) {
    throw new Error(`a money writer in a different shop was blocked: ${JSON.stringify(otherShop)}`);
  }

  const afterRelease = await withLockTimeout(shopA);
  if (!afterRelease.ok) {
    throw new Error(`same-shop writer still blocked after the holder released: ${JSON.stringify(afterRelease)}`);
  }

  console.log('C0 FINANCE LOCK CONCURRENCY: PASS (1 of 5 allocations won; same shop serialized; other shop unblocked)');
} finally {
  await admin.end();
}
