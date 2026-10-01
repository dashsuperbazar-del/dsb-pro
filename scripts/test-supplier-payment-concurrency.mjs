// Packet C1 gate (COMPLETE_REMAINING_BUILD_PLAN v1.1 C27-C30): real multi-connection proof that
//  C27 two 60000 payments racing for one 100000 bill: exactly one allocates,
//  C28 two allocations racing on one 60000 advance cannot exceed its budget,
//  C29 two payments allocating the same bills in reversed order never deadlock,
//  C30 allocation racing a bill void ends in an allowed serial result.
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ownerId = randomUUID();

async function connect() {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function asOwner(client) {
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: ownerId, role: 'authenticated' }),
  ]);
}

async function tx(sql, params) {
  const client = await connect();
  try {
    await client.query('begin');
    await asOwner(client);
    await client.query("set local lock_timeout = '10s'");
    const r = await client.query(sql, params);
    await client.query('commit');
    return { ok: true, value: r.rows[0] };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end();
  }
}

const recordSql = `select record_supplier_payment($1::uuid,$2::uuid,current_date,$3::bigint,'cash',null,$4::jsonb,$5) as id`;
const allocSql = `select allocate_supplier_payment($1::uuid,$2::jsonb,$3) as r`;
const alloc = (bill, amount) => ({ purchase_bill_id: bill, amount_paise: amount });
const fail = (msg, detail) => {
  throw new Error(`${msg}: ${JSON.stringify(detail)}`);
};

const admin = await connect();
try {
  await admin.query('insert into auth.users(id) values($1)', [ownerId]);
  await admin.query('begin');
  await asOwner(admin);
  await admin.query("select create_tenant('Supplier Race Co',$1,'Main Shop',$2)", [
    `c1-race-${randomUUID()}`,
    `tenant-${randomUUID()}`,
  ]);
  const base = await admin.query(`select current_tenant_id() as t,
    (select id from shops where tenant_id=current_tenant_id() and is_default limit 1) as s`);
  const { t: tenantId, s: shopId } = base.rows[0];
  const item = await admin.query(
    `insert into items(tenant_id,name,unit1,client_id) values($1,'Race Item','piece',$2) returning id`,
    [tenantId, `item-${randomUUID()}`],
  );
  const party = await admin.query(
    `insert into parties(tenant_id,name,client_id) values($1,'Race Supplier',$2) returning id`,
    [tenantId, `party-${randomUUID()}`],
  );
  const partyId = party.rows[0].id;
  const bill = async (qty) =>
    (
      await admin.query(
        `select post_purchase($1::uuid,$2::uuid,$3,current_date,0,0,$4,
          jsonb_build_array(jsonb_build_object('item_id',$5::text,'unit_level',1,'qty',$6::int,'unit_price_paise',100)),null) as id`,
        [shopId, partyId, `B-${randomUUID()}`, `bill-${randomUUID()}`, item.rows[0].id, qty],
      )
    ).rows[0].id;
  const b27 = await bill(1000);
  const b28a = await bill(1000);
  const b28b = await bill(1000);
  const b29a = await bill(1000);
  const b29b = await bill(1000);
  const b30 = await bill(1000);
  const adv = (await admin.query(recordSql, [shopId, partyId, 60000, '[]', randomUUID()])).rows[0]
    .id;
  await admin.query('commit');

  // C27
  const c27 = await Promise.all(
    [0, 1].map(() =>
      tx(recordSql, [shopId, partyId, 60000, JSON.stringify([alloc(b27, 60000)]), randomUUID()]),
    ),
  );
  if (c27.filter((r) => r.ok).length !== 1) fail('C27 expected exactly one winner', c27);
  if (!/DSB_ALLOCATION_EXCEEDS_BILL/.test(c27.find((r) => !r.ok).message))
    fail('C27 loser wrong reason', c27);

  // C28
  const c28 = await Promise.all([
    tx(allocSql, [adv, JSON.stringify([alloc(b28a, 40000)]), randomUUID()]),
    tx(allocSql, [adv, JSON.stringify([alloc(b28b, 40000)]), randomUUID()]),
  ]);
  if (c28.filter((r) => r.ok).length !== 1) fail('C28 expected exactly one winner', c28);
  if (!/exceeds/i.test(c28.find((r) => !r.ok).message)) fail('C28 loser wrong reason', c28);
  const used = await admin.query(
    `select coalesce(sum(amount_paise),0)::bigint n from payment_allocations where payment_id=$1 and status='POSTED'`,
    [adv],
  );
  if (Number(used.rows[0].n) > 60000) fail('C28 advance over-allocated', used.rows[0]);

  // C29 (both fit: 2 x (30000+30000) <= 100000 per bill)
  const c29 = await Promise.all([
    tx(recordSql, [
      shopId,
      partyId,
      60000,
      JSON.stringify([alloc(b29a, 30000), alloc(b29b, 30000)]),
      randomUUID(),
    ]),
    tx(recordSql, [
      shopId,
      partyId,
      60000,
      JSON.stringify([alloc(b29b, 30000), alloc(b29a, 30000)]),
      randomUUID(),
    ]),
  ]);
  if (c29.some((r) => !r.ok)) fail('C29 reversed bill order failed (deadlock?)', c29);

  // C30 allocation vs void of the same bill
  const c30 = await Promise.all([
    tx(recordSql, [shopId, partyId, 50000, JSON.stringify([alloc(b30, 50000)]), randomUUID()]),
    tx(`select void_purchase($1::uuid,$2) as id`, [b30, `void-${randomUUID()}`]),
  ]);
  const [pay30, void30] = c30;
  const st = (await admin.query(`select status from purchase_bills where id=$1`, [b30])).rows[0]
    .status;
  const active = Number(
    (
      await admin.query(
        `select count(*) n from payment_allocations where purchase_bill_id=$1 and status='POSTED'`,
        [b30],
      )
    ).rows[0].n,
  );
  const payFirst = pay30.ok && !void30.ok && st === 'POSTED' && active === 1;
  const voidFirst =
    !pay30.ok &&
    void30.ok &&
    st === 'VOID' &&
    active === 0 &&
    /DSB_BILL_UNAVAILABLE/.test(pay30.message);
  if (!payFirst && !voidFirst) fail('C30 non-serial result', { c30, st, active });
  if (c30.some((r) => !r.ok && /deadlock/i.test(r.message))) fail('C30 deadlock', c30);

  console.log(
    `C1 SUPPLIER PAYMENT CONCURRENCY: PASS (C27 one winner; C28 budget held; C29 no deadlock; C30 ${payFirst ? 'pay-then-void-refused' : 'void-then-pay-refused'})`,
  );
} finally {
  await admin.end();
}
