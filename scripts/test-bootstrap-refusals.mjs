#!/usr/bin/env node
// Refusal tests for scripts/bootstrap-disposable-receipts.mjs, run as real
// child processes against a real disposable target. Every refusal case also
// asserts no receipt row was written. The harness marker is restored to its
// original state afterward.
//
// Usage: node scripts/test-bootstrap-refusals.mjs <database-url>
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

function runBootstrap(databaseUrl, token) {
  const env = { ...process.env, DISPOSABLE_RECEIPTS_BOOTSTRAP: '1' };
  if (token === undefined) delete env.DISPOSABLE_TARGET_TOKEN;
  else env.DISPOSABLE_TARGET_TOKEN = token;
  const result = spawnSync(
    'node',
    ['scripts/bootstrap-disposable-receipts.mjs', databaseUrl, '--disposable-target-only'],
    { env, encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function main(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const receiptSnapshot = async () =>
    (await client.query('select version, checksum_sha256 from app_migration_receipts order by version')).rows
      .map((r) => `${r.version}:${r.checksum_sha256}`)
      .join(',');
  const markerExists = (await client.query(`select to_regclass('disposable_harness.marker') is not null as p`)).rows[0].p;
  const originalToken = markerExists
    ? (await client.query('select token from disposable_harness.marker')).rows[0]?.token
    : undefined;
  const token = randomUUID();
  let failures = 0;
  const expectRefusal = async (name, run, expectText) => {
    const before = await receiptSnapshot();
    const { status, output } = run();
    const after = await receiptSnapshot();
    const ok = status !== 0 && output.includes(expectText) && before === after;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` -- status=${status} receiptsChanged=${before !== after} output=${JSON.stringify(output.trim())}`}`);
    if (!ok) failures += 1;
  };

  try {
    await client.query('drop schema if exists disposable_harness cascade');
    await expectRefusal(
      'no harness marker in target',
      () => runBootstrap(databaseUrl, token),
      'no disposable_harness.marker',
    );

    await client.query('create schema disposable_harness');
    await client.query('create table disposable_harness.marker (token text not null)');
    await client.query('insert into disposable_harness.marker (token) values ($1)', [token]);

    await expectRefusal('token env not set', () => runBootstrap(databaseUrl, undefined), 'DISPOSABLE_TARGET_TOKEN is not set');
    await expectRefusal('wrong token (different target)', () => runBootstrap(databaseUrl, randomUUID()), 'wrong target');
    await expectRefusal(
      'non-local host',
      () => runBootstrap('postgresql://u:p@db.example.invalid:5432/postgres', token),
      'not localhost',
    );

    const tenantId = randomUUID();
    await client.query('insert into tenants (id, name, slug, created_by) values ($1, $2, $3, $4)', [
      tenantId,
      'p1-followup refusal test',
      `p1-followup-refusal-${tenantId}`,
      randomUUID(),
    ]);
    try {
      await expectRefusal('non-empty target (tenant data present)', () => runBootstrap(databaseUrl, token), 'real tenant/shop data');
    } finally {
      await client.query('delete from tenants where id = $1', [tenantId]);
    }

    const ok = runBootstrap(databaseUrl, token);
    const accepted = ok.status === 0;
    console.log(`${accepted ? 'OK  ' : 'FAIL'} correct marker + token on empty target is accepted${accepted ? '' : ` -- ${ok.output.trim()}`}`);
    if (!accepted) failures += 1;
  } finally {
    await client.query('drop schema if exists disposable_harness cascade');
    if (originalToken !== undefined) {
      await client.query('create schema disposable_harness');
      await client.query('create table disposable_harness.marker (token text not null)');
      await client.query('insert into disposable_harness.marker (token) values ($1)', [originalToken]);
    }
    await client.end();
  }

  if (failures > 0) {
    console.error(`${failures} bootstrap refusal test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('BOOTSTRAP REFUSALS: PASS');
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (!process.argv[2]) {
    console.error('usage: node scripts/test-bootstrap-refusals.mjs <database-url>');
    process.exitCode = 2;
  } else {
    main(process.argv[2]).catch((error) => {
      console.error(error.message ?? String(error));
      process.exitCode = 1;
    });
  }
}
