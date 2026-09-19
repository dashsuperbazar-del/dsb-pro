import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ownerId = randomUUID();
const slug = `stock-recovery-${randomUUID()}`;

function jwt(userId) {
  return JSON.stringify({ sub: userId, role: 'authenticated' });
}

async function asAuthenticated(client) {
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claims', $1, true)", [jwt(ownerId)]);
}

async function runAuthenticated(sql, params) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    await asAuthenticated(client);
    await client.query(sql, params);
    await client.query('commit');
    return { ok: true };
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
  await asAuthenticated(admin);
  await admin.query("select create_tenant('Stock Recovery Race',$1,'Main Shop',$2)", [slug, `tenant-${randomUUID()}`]);
  const ids = await admin.query(`
    select current_tenant_id() as tenant_id,
           (select id from shops where tenant_id=current_tenant_id() and is_default limit 1) as shop_id
  `);
  const { tenant_id: tenantId, shop_id: shopId } = ids.rows[0];
  const item = await admin.query(
    `insert into items(tenant_id,name,unit1,tax_rate_bp,client_id)
     values($1,'Recovery Race Item','piece',0,$2) returning id`,
    [tenantId, `item-${randomUUID()}`],
  );
  const itemId = item.rows[0].id;
  await admin.query(
    `insert into item_prices(tenant_id,item_id,shop_id,kind,unit_level,price_paise,effective_from,client_id)
     values($1,$2,$3,'retail',1,100,now()-interval '1 minute',$4)`,
    [tenantId, itemId, shopId, `price-${randomUUID()}`],
  );
  await admin.query(
    `select update_shop_settings($1::uuid,'Main Shop','','','','Asia/Kolkata','80mm',4::smallint,true)`,
    [shopId],
  );
  await admin.query(
    `select post_sale($1::uuid,null,current_date,0,0,$2,
      jsonb_build_array(jsonb_build_object('item_id',$3::text,'unit_level',1,'qty',3,'price_kind','retail')),
      jsonb_build_array(jsonb_build_object('amount_paise',300,'mode','cash')),null)`,
    [shopId, `oversell-${randomUUID()}`, itemId],
  );
  await admin.query('commit');

  const purchaseClientId = `recover-${randomUUID()}`;
  const saleClientId = `sell-${randomUUID()}`;
  const results = await Promise.all([
    runAuthenticated(
      `select post_purchase($1::uuid,null,'RACE-RECOVERY',current_date,0,0,$2,
       jsonb_build_array(jsonb_build_object('item_id',$3::text,'unit_level',1,'qty',2,'unit_price_paise',50)),null)`,
      [shopId, purchaseClientId, itemId],
    ),
    runAuthenticated(
      `select post_sale($1::uuid,null,current_date,0,0,$2,
       jsonb_build_array(jsonb_build_object('item_id',$3::text,'unit_level',1,'qty',1,'price_kind','retail')),
       jsonb_build_array(jsonb_build_object('amount_paise',100,'mode','cash')),null)`,
      [shopId, saleClientId, itemId],
    ),
  ]);
  if (!results.every((result) => result.ok)) {
    throw new Error(`concurrent recovery and authorized sale must both succeed: ${JSON.stringify(results)}`);
  }

  const proof = await admin.query(
    `select
       (select on_hand from stock_current where tenant_id=$1 and shop_id=$2 and item_id=$3) as on_hand,
       (select count(*)::int from stock_movements where tenant_id=$1 and item_id=$3
          and client_id in ($4 || ':stock:1',$5 || ':stock:1')) as movement_count`,
    [tenantId, shopId, itemId, purchaseClientId, saleClientId],
  );
  const row = proof.rows[0];
  if (Number(row.on_hand) !== -2 || row.movement_count !== 2) {
    throw new Error(`serialized projection lost or duplicated a movement: ${JSON.stringify(row)}`);
  }

  console.log('negative-stock recovery concurrency: +2 purchase and authorized -1 sale serialized from -3 to exactly -2 with both ledger movements preserved');
} finally {
  await admin.end();
}
