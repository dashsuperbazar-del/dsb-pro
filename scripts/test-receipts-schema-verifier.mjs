#!/usr/bin/env node
// Negative tests for scripts/verify-receipts-schema.mjs against a real
// database that already has migration 0044 applied. Each case applies one
// drift inside a transaction, requires verifyReceiptsSchema() to report it,
// then rolls back -- the target is left exactly as found.
//
// Usage: node scripts/test-receipts-schema-verifier.mjs <database-url>
import pg from 'pg';
import { verifyReceiptsSchema } from './verify-receipts-schema.mjs';

const DRIFT_CASES = [
  {
    name: 'checksum CHECK widened to 1-64 hex chars',
    sql: [
      'alter table app_migration_receipts drop constraint app_migration_receipts_checksum_format',
      "alter table app_migration_receipts add constraint app_migration_receipts_checksum_format check (checksum_sha256 ~ '^[0-9a-f]{1,64}$')",
    ],
    expect: 'app_migration_receipts_checksum_format: definition',
  },
  {
    name: 'version CHECK widened to 1-8 digits',
    sql: [
      'alter table app_migration_receipts drop constraint app_migration_receipts_version_format',
      "alter table app_migration_receipts add constraint app_migration_receipts_version_format check (version ~ '^[0-9]{1,8}$')",
    ],
    expect: 'app_migration_receipts_version_format: definition',
  },
  {
    name: 'checksum CHECK re-added NOT VALID',
    sql: [
      'alter table app_migration_receipts drop constraint app_migration_receipts_checksum_format',
      "alter table app_migration_receipts add constraint app_migration_receipts_checksum_format check (checksum_sha256 ~ '^[0-9a-f]{64}$') not valid",
    ],
    expect: 'app_migration_receipts_checksum_format: not validated',
  },
  {
    name: 'unexpected default on version',
    sql: ["alter table app_migration_receipts alter column version set default '0000'"],
    expect: 'column version: column_default',
  },
  {
    name: 'unexpected default on checksum_sha256',
    sql: ["alter table app_migration_receipts alter column checksum_sha256 set default ''"],
    expect: 'column checksum_sha256: column_default',
  },
  {
    name: 'applied_by made nullable',
    sql: ['alter table app_migration_receipts alter column applied_by drop not null'],
    expect: 'column applied_by: is_nullable',
  },
  {
    name: 'unexpected extra column',
    sql: ['alter table app_migration_receipts add column note text'],
    expect: 'unexpected column: note',
  },
  {
    name: 'anon granted INSERT directly',
    sql: ['grant insert on app_migration_receipts to anon'],
    expect: 'anon has effective INSERT',
  },
  {
    name: 'authenticated inherits INSERT via role membership',
    sql: [
      'create role p1_followup_inherited_writer nologin',
      'grant insert on app_migration_receipts to p1_followup_inherited_writer',
      'grant p1_followup_inherited_writer to authenticated',
    ],
    expect: 'authenticated has effective INSERT',
  },
  {
    name: 'PUBLIC granted TRUNCATE',
    sql: ['grant truncate on app_migration_receipts to public'],
    expect: 'public has effective TRUNCATE',
  },
  {
    name: 'RLS disabled',
    sql: ['alter table app_migration_receipts disable row level security'],
    expect: 'row level security is not enabled',
  },
  {
    name: 'missing required backup_ro SELECT',
    sql: [
      "do $$ begin if not exists (select 1 from pg_roles where rolname = 'backup_ro') then create role backup_ro nologin; end if; end $$",
      'revoke select on app_migration_receipts from backup_ro',
    ],
    expect: 'backup_ro exists but lacks required SELECT',
  },
];

async function main(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let failures = 0;
  try {
    await client.query('begin');
    const baseline = await verifyReceiptsSchema(client);
    await client.query('rollback');
    if (baseline.length > 0) {
      console.log(`FAIL baseline: expected an exact match, got:\n  - ${baseline.join('\n  - ')}`);
      failures += 1;
    } else {
      console.log('OK   baseline: unmodified 0044 schema verifies clean');
    }

    for (const drift of DRIFT_CASES) {
      await client.query('begin');
      try {
        for (const statement of drift.sql) await client.query(statement);
        const problems = await verifyReceiptsSchema(client);
        const caught = problems.some((p) => p.includes(drift.expect));
        console.log(`${caught ? 'OK  ' : 'FAIL'} ${drift.name}${caught ? '' : ` -- got: ${JSON.stringify(problems)}`}`);
        if (!caught) failures += 1;
      } finally {
        await client.query('rollback');
      }
    }
  } finally {
    await client.end();
  }
  if (failures > 0) {
    console.error(`${failures} verifier test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('RECEIPTS SCHEMA VERIFIER: PASS');
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (!process.argv[2]) {
    console.error('usage: node scripts/test-receipts-schema-verifier.mjs <database-url>');
    process.exitCode = 2;
  } else {
    main(process.argv[2]).catch((error) => {
      console.error(error.message ?? String(error));
      process.exitCode = 1;
    });
  }
}
