import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ownerId = randomUUID();
const slug = `sale-concurrency-${randomUUID()}`;
const seedClientId = `seed-${randomUUID()}`;

function jwt(userId) {
  return JSON.stringify({ sub: userId, role: 'authenticated' });
}

async function asAuthenticated(client, userId) {
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claims', $1, true)", [jwt(userId)]);
}

async function postSale({ shopId, itemId, clientId, qty }) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    await asAuthenticated(client, ownerId);
    const result = await client.query(
      `select post_sale(
        $1::uuid,
        null,
        current_date,
        0,
        0,
        $2,
        jsonb_build_array(jsonb_build_object('item_id',$3::text,'unit_level',1,'qty',$4::numeric,'price_kind','retail')),
        jsonb_build_array(jsonb_build_object('amount_paise',($4::numeric*100)::bigint,'mode','cash')),
        null
      ) as sale_id`,
      [shopId, clientId, itemId, qty],
    );
    await client.query('commit');
    return { ok: true, saleId: result.rows[0].sale_id };
  } catch (error) {
    await client.query('rollback');
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end();
  }
}

const admin = new Client({ connectionString });
await admin.connect();
try {
  await admin.query('insert into auth.users(id) values($1)', [ownerId]);

  await admin.query('begin');
  await asAuthenticated(admin, ownerId);
  await admin.query("select create_tenant('Sale Concurrency Co',$1,'Main Shop',$2)", [slug, `tenant-${randomUUID()}`]);
  const ids = await admin.query(`
    select current_tenant_id() as tenant_id,
           (select id from shops where tenant_id=current_tenant_id() and is_default limit 1) as shop_id
  `);
  const { tenant_id: tenantId, shop_id: shopId } = ids.rows[0];
  const item = await admin.query(
    `insert into items(tenant_id,name,sku,unit1,tax_rate_bp,client_id)
     values($1,'Concurrency Item',$2,'piece',0,$3)
     returning id`,
    [tenantId, `CON-${randomUUID()}`, `item-${randomUUID()}`],
  );
  const itemId = item.rows[0].id;
  await admin.query(
    `insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id)
     values($1,$2,$3,'retail',1,100,now()-interval '1 minute',$4)`,
    [tenantId, itemId, shopId, `price-${randomUUID()}`],
  );
  await admin.query(
    `select post_purchase($1::uuid,null,'SEED',current_date,0,0,$2,
      jsonb_build_array(jsonb_build_object('item_id',$3::text,'unit_level',1,'qty',5,'unit_price_paise',50)),null)`,
    [shopId, seedClientId, itemId],
  );
  await admin.query('commit');

  const race = await Promise.all([
    postSale({ shopId, itemId, clientId: `race-a-${randomUUID()}`, qty: 4 }),
    postSale({ shopId, itemId, clientId: `race-b-${randomUUID()}`, qty: 4 }),
  ]);
  const raceSuccesses = race.filter((r) => r.ok);
  const raceFailures = race.filter((r) => !r.ok);
  if (raceSuccesses.length !== 1 || raceFailures.length !== 1) {
    throw new Error(`expected exactly one 4-of-5 stock race sale to succeed: ${JSON.stringify(race)}`);
  }
  if (!/insufficient stock/i.test(raceFailures[0].message)) {
    throw new Error(`stock-race loser failed for wrong reason: ${raceFailures[0].message}`);
  }

  const afterRace = await admin.query(
    'select on_hand from stock_current where tenant_id=$1 and shop_id=$2 and item_id=$3',
    [tenantId, shopId, itemId],
  );
  if (Number(afterRace.rows[0].on_hand) !== 1) {
    throw new Error(`expected one unit after 4-of-5 race, found ${afterRace.rows[0].on_hand}`);
  }

  const duplicateClientId = `duplicate-${randomUUID()}`;
  const duplicate = await Promise.all([
    postSale({ shopId, itemId, clientId: duplicateClientId, qty: 1 }),
    postSale({ shopId, itemId, clientId: duplicateClientId, qty: 1 }),
  ]);
  if (!duplicate.every((r) => r.ok)) {
    throw new Error(`simultaneous duplicate client_id should converge on one sale: ${JSON.stringify(duplicate)}`);
  }
  if (duplicate[0].saleId !== duplicate[1].saleId) {
    throw new Error(`duplicate client_id returned different sale ids: ${JSON.stringify(duplicate)}`);
  }

  const proof = await admin.query(
    `select
      (select count(*)::int from sale_invoices where tenant_id=$1 and client_id=$4) as sale_count,
      (select count(*)::int from stock_movements where tenant_id=$1 and client_id like ($4 || ':stock:%')) as movement_count,
      (select on_hand from stock_current where tenant_id=$1 and shop_id=$2 and item_id=$3) as on_hand`,
    [tenantId, shopId, itemId, duplicateClientId],
  );
  const row = proof.rows[0];
  if (row.sale_count !== 1 || row.movement_count !== 1 || Number(row.on_hand) !== 0) {
    throw new Error(`duplicate idempotency proof failed: ${JSON.stringify(row)}`);
  }

  console.log('sale concurrency: 4+4 against stock 5 produced exactly one sale; duplicate client_id converged without double stock');
} finally {
  await admin.end();
}
