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
import { getClassifierState } from './apply-migrations-with-receipts.mjs';

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

  // Schema assurance: this target must already be at the full end-state
  // every manifest entry claims to represent -- every group the classifier
  // knows about must report needs_<group>=false. Without this, a database
  // that only ran a partial `supabase db reset` (or was reset against a
  // stale migrations directory) would get backfilled with receipts for
  // migrations whose schema was never actually applied, which is exactly
  // the "receipts prove applied bytes, not absence of tampering" gap this
  // bootstrap must not add to. `getClassifierState` shells out to the same
  // trusted classifier the runner and live job use, not a re-derived check.
  const classifierState = getClassifierState(databaseUrl);
  // needs_upgrade is the classifier's own summary flag ("is anything still
  // needed at all"), not a real group name -- exclude it from the list of
  // named unsatisfied groups.
  const unsatisfied = Object.entries(classifierState).filter(
    ([group, needed]) => needed === true && group !== 'upgrade',
  );
  if (unsatisfied.length > 0) {
    console.error(
      `Refusing to bootstrap: this database is not at the full expected schema state ` +
        `(still needs: ${unsatisfied.map(([group]) => group).join(', ')}). The disposable bootstrap ` +
        `only backfills receipts for schema that genuinely already exists; it never creates schema.`,
    );
    process.exitCode = 1;
    return;
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
        const existing = await client.query(
          'select checksum_sha256 from app_migration_receipts where version = $1',
          [entry.version],
        );
        if (existing.rowCount > 0) {
          if (existing.rows[0].checksum_sha256 !== entry.checksumSha256) {
            throw new Error(
              `Refusing to bootstrap: an existing receipt for ${entry.version} does not match the ` +
                `file on disk. A silent ON CONFLICT DO NOTHING would hide this mismatch instead of ` +
                `surfacing it; bootstrapping never overwrites a conflicting receipt.`,
            );
          }
          continue;
        }
        await client.query(
          `insert into app_migration_receipts (version, checksum_sha256)
           values ($1, $2)`,
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
