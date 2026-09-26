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

  // Schema assurance in two parts, deliberately NOT both routed through the
  // classifier's combined p1 signal (which requires a 0044 receipt to
  // already exist -- reusing it whole here would create exactly the
  // circular refusal a first draft of this fix introduced: the classifier
  // reports p1 unsatisfied because the receipt is missing, so bootstrap
  // (whose entire job is to create that receipt) refuses to run at all).
  //
  // Part 1: every LEGACY group (foundation/hardening/phase65/batcha/
  // batchb) must already be satisfied. These don't depend on receipts at
  // all, so reusing the classifier for them is safe and avoids
  // re-deriving that logic.
  const classifierState = getClassifierState(databaseUrl);
  const LEGACY_GROUPS = ['foundation', 'hardening', 'phase65', 'batcha', 'batchb'];
  const unsatisfiedLegacy = LEGACY_GROUPS.filter((group) => classifierState[group] !== false);
  if (unsatisfiedLegacy.length > 0) {
    console.error(
      `Refusing to bootstrap: this database is not at the full expected legacy schema state ` +
        `(still needs: ${unsatisfiedLegacy.join(', ')}). The disposable bootstrap only backfills ` +
        `receipts for schema that genuinely already exists; it never creates schema.`,
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Part 2: app_migration_receipts' own SCHEMA (not its rows) must be
    // exactly what 0044 creates -- table with the right columns, RLS
    // enabled, no anon/authenticated grants. This checks the same three
    // structural signals the classifier's p1 dimension checks, directly,
    // without touching the fourth (a receipt for 0044 existing) since
    // that's what this script is about to create.
    const schemaCheck = await client.query(`
      select
        to_regclass('public.app_migration_receipts') is not null
          and (select count(*) from information_schema.columns
               where table_schema='public' and table_name='app_migration_receipts'
                 and column_name in ('version','checksum_sha256','applied_at','applied_by')) = 4
          as has_shape,
        coalesce((select relrowsecurity from pg_class
                  where oid = to_regclass('public.app_migration_receipts')), false)
          as rls_enabled,
        not exists(
          select 1 from information_schema.role_table_grants
          where table_schema='public' and table_name='app_migration_receipts'
            and grantee in ('anon','authenticated')
        ) as no_public_grants
    `);
    const { has_shape: hasShape, rls_enabled: rlsEnabled, no_public_grants: noPublicGrants } = schemaCheck.rows[0];
    if (!hasShape || !rlsEnabled || !noPublicGrants) {
      console.error(
        `Refusing to bootstrap: app_migration_receipts does not have the expected schema yet ` +
          `(shape=${hasShape}, rls=${rlsEnabled}, no-public-grants=${noPublicGrants}). Migration 0044 ` +
          `must have actually run before this bootstrap backfills receipts for it.`,
      );
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
