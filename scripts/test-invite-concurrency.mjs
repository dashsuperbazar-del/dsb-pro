import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ownerId = randomUUID();
const inviteeA = randomUUID();
const inviteeB = randomUUID();
const slug = `invite-concurrency-${randomUUID()}`;

function jwt(userId) {
  return JSON.stringify({ sub: userId, role: 'authenticated' });
}

async function asAuthenticated(client, userId) {
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claims', $1, true)", [jwt(userId)]);
}

async function redeem(token, userId, clientId) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    await asAuthenticated(client, userId);
    const result = await client.query('select accept_invite($1, $2) as tenant_id', [token, clientId]);
    await client.query('commit');
    return { ok: true, tenantId: result.rows[0].tenant_id };
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
  await admin.query('insert into auth.users (id) values ($1), ($2), ($3)', [ownerId, inviteeA, inviteeB]);

  await admin.query('begin');
  await asAuthenticated(admin, ownerId);
  await admin.query("select create_tenant('Concurrency Co', $1, 'Main Shop', $2)", [slug, `owner-${randomUUID()}`]);
  const invite = await admin.query("select token from create_invite('cashier', '{}'::uuid[])");
  await admin.query('commit');

  const token = invite.rows[0].token;
  const results = await Promise.all([
    redeem(token, inviteeA, `invitee-a-${randomUUID()}`),
    redeem(token, inviteeB, `invitee-b-${randomUUID()}`),
  ]);

  const successes = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  if (successes.length !== 1 || failures.length !== 1) {
    throw new Error(`expected exactly one concurrent redemption to succeed: ${JSON.stringify(results)}`);
  }
  if (!/invalid, expired, or already used/i.test(failures[0].message)) {
    throw new Error(`losing redemption failed for the wrong reason: ${failures[0].message}`);
  }

  const membershipCount = await admin.query(
    'select count(*)::int as count from tenant_users where user_id = any($1::uuid[])',
    [[inviteeA, inviteeB]],
  );
  if (membershipCount.rows[0].count !== 1) {
    throw new Error(`expected one invitee membership, found ${membershipCount.rows[0].count}`);
  }

  console.log('invite concurrency: exactly one of two simultaneous redemptions succeeded');
} finally {
  await admin.end();
}
