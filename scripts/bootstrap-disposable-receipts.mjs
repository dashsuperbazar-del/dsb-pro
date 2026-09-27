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
import { verifyReceiptsSchema } from './verify-receipts-schema.mjs';

const { Client } = pg;

/**
 * Pure predicate, exported for direct testing: is this connection string's
 * host structurally consistent with a disposable/local target?
 *
 * This is one safety layer, not target identity: a loopback address can
 * be a forwarded tunnel to a real database. Identity comes from the
 * harness marker checked in main(): the harness that creates a disposable
 * target writes a per-run DISPOSABLE_TARGET_TOKEN into
 * disposable_harness.marker, and bootstrap refuses unless the database it
 * actually connected to holds that exact token.
 */
export function isLocalHost(databaseUrl) {
  let host;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return false;
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

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
  if (!isLocalHost(databaseUrl)) {
    console.error(
      'Refusing to bootstrap receipts: target host is not localhost/127.0.0.1/::1. Flags alone ' +
        '(--disposable-target-only, DISPOSABLE_RECEIPTS_BOOTSTRAP=1) are caller-supplied claims, not ' +
        'proof of target identity -- this checks the actual connection string.',
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

  const expectedToken = process.env.DISPOSABLE_TARGET_TOKEN;
  if (!expectedToken) {
    console.error(
      'Refusing to bootstrap receipts: DISPOSABLE_TARGET_TOKEN is not set. The harness that created this ' +
        'disposable target must write the same token into disposable_harness.marker and pass it here.',
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    try {
      // Target identity, read through the actual connection: only a
      // database the CI/local harness itself created carries this marker
      // with this run's token. A forwarded tunnel to a real database, or a
      // real-but-empty database, has no such marker and is refused.
      const markerPresent = (
        await client.query(`select to_regclass('disposable_harness.marker') is not null as present`)
      ).rows[0].present;
      if (!markerPresent) {
        throw new RefusalError('this database has no disposable_harness.marker -- it was not created by the disposable-target harness.');
      }
      const markerRows = await client.query('select token from disposable_harness.marker');
      if (markerRows.rowCount !== 1 || markerRows.rows[0].token !== expectedToken) {
        throw new RefusalError('disposable_harness.marker does not hold this run\'s DISPOSABLE_TARGET_TOKEN -- wrong target.');
      }

      const receiptsPresent = (
        await client.query(`select to_regclass('public.app_migration_receipts') is not null as present`)
      ).rows[0].present;
      if (!receiptsPresent) throw new RefusalError('app_migration_receipts does not exist; migration 0044 must have run first.');
      await client.query('lock table public.app_migration_receipts in access exclusive mode');

      const problems = await verifyReceiptsSchema(client);
      if (problems.length > 0) {
        throw new RefusalError(`app_migration_receipts does not exactly match 0044:\n  - ${problems.join('\n  - ')}`);
      }

      // Defense in depth, not identity: a harness-created target has no
      // business data yet.
      const data = (
        await client.query('select (select count(*) from tenants) as tenants, (select count(*) from shops) as shops')
      ).rows[0];
      if (Number(data.tenants) > 0 || Number(data.shops) > 0) {
        throw new RefusalError(`target has real tenant/shop data (${data.tenants} tenant(s), ${data.shops} shop(s)).`);
      }

      for (const entry of entries) {
        const existing = await client.query('select checksum_sha256 from app_migration_receipts where version = $1', [entry.version]);
        if (existing.rowCount > 0) {
          if (existing.rows[0].checksum_sha256 !== entry.checksumSha256) {
            throw new RefusalError(`an existing receipt for ${entry.version} does not match the file on disk.`);
          }
          continue;
        }
        await client.query('insert into app_migration_receipts (version, checksum_sha256) values ($1, $2)', [
          entry.version,
          entry.checksumSha256,
        ]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    console.log(`Bootstrapped ${entries.length} baseline receipt(s) on disposable target.`);
  } catch (error) {
    if (error instanceof RefusalError) {
      console.error(`Refusing to bootstrap: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await client.end();
  }
}

class RefusalError extends Error {}

// Guard CLI execution behind an isMain check (matching apply-migrations-
// with-receipts.mjs's own pattern) -- without this, any import of this
// module (e.g. `import { isLocalHost } from './bootstrap-disposable-
// receipts.mjs'` for testing the exported predicate in isolation) would
// unconditionally invoke main() with the IMPORTING process's own argv,
// which never matches this script's usage, setting process.exitCode = 2
// on the importing process even though nothing it actually asked for
// failed. Confirmed as the exact cause of CI run 36283021722's failure:
// the new "Prove bootstrap target-identity checks" step imports
// isLocalHost for testing and was failing this way despite every
// predicate check passing.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message ?? String(error));
    process.exitCode = 1;
  });
}

export { main };
