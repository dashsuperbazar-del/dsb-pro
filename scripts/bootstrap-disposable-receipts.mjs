#!/usr/bin/env node
// Disposable-target-only baseline-receipt bootstrap (mechanism point 5).
//
// `supabase db reset` (and the equivalent bare `psql -f` replay used by the
// disposable proof harness) applies every migration file directly. It does
// not go through scripts/apply-migrations-with-receipts.mjs, so it never
// writes app_migration_receipts rows. That is fine for a schema that is
// about to be thrown away, but it means CI's pgTAP suite and the upgrade
// proof job would otherwise see zero receipts on a freshly reset database
// even though every migration up to and including 0044 really did run.
//
// This script inserts one receipt per manifest entry, computed from the
// same on-disk file bytes/checksums as the real runner, for a database
// this process just reset. It refuses to run against anything that is not
// a disposable target: the caller must pass --disposable-target-only, and
// the script additionally requires DISPOSABLE_RECEIPTS_BOOTSTRAP=1 in the
// environment as a second, deliberate opt-in. Production tooling never
// sets that variable and never passes that flag. There is no other way to
// invoke this bootstrap.
//
// Usage:
//   DISPOSABLE_RECEIPTS_BOOTSTRAP=1 \
//     node scripts/bootstrap-disposable-receipts.mjs <database-url> --disposable-target-only
import pg from 'pg';
import { loadManifest, ManifestError } from './verify-migration-manifest.mjs';

const { Client } = pg;

async function main(argv) {
  const [databaseUrl, ...rest] = argv;
  if (!databaseUrl || !rest.includes('--disposable-target-only')) {
    console.error('usage: node scripts/bootstrap-disposable-receipts.mjs <database-url> --disposable-target-only');
    process.exitCode = 2;
    return;
  }
  if (process.env.DISPOSABLE_RECEIPTS_BOOTSTRAP !== '1') {
    console.error(
      'Refusing to bootstrap receipts: DISPOSABLE_RECEIPTS_BOOTSTRAP=1 is not set. ' +
        'This bootstrap exists only for disposable CI/local reset targets; production ' +
        'schemas must go through the attended legacy-baseline-receipt initialization path instead.',
    );
    process.exitCode = 1;
    return;
  }

  let entries;
  try {
    entries = loadManifest();
  } catch (error) {
    if (error instanceof ManifestError) {
      console.error(`Manifest validation failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const receiptTable = await client.query(
      `select to_regclass('public.app_migration_receipts') is not null as present`,
    );
    if (!receiptTable.rows[0].present) {
      console.error('app_migration_receipts does not exist on this database; refusing to bootstrap.');
      process.exitCode = 1;
      return;
    }

    await client.query('begin');
    try {
      for (const entry of entries) {
        await client.query(
          `insert into app_migration_receipts (version, checksum_sha256)
           values ($1, $2)
           on conflict (version) do nothing`,
          [entry.version, entry.checksumSha256],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    console.log(`Bootstrapped ${entries.length} baseline receipt(s) on disposable target.`);
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message ?? String(error));
  process.exitCode = 1;
});
