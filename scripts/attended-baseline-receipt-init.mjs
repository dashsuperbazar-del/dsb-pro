#!/usr/bin/env node
// Attended legacy-baseline receipt initialization (P1 mechanism point 5,
// tracked as a P1 follow-up item). Distinct from
// scripts/bootstrap-disposable-receipts.mjs, which only ever targets a
// disposable CI/local-reset database: this script is for an EXISTING,
// already-running database (legacy schema through 0043 already applied by
// whatever means, plus 0044's own schema already applied) that has never
// had any app_migration_receipts row -- the one-time transition onto the
// receipts system. Legacy migrations (0030-0043) never get receipts by
// design; only 0044 does.
//
// This requires a human to have actually looked at the target and the
// file, not merely to have passed a flag:
//   1. --i-attest-this-schema-was-verified-by-a-human is required and does
//      nothing on its own -- it exists so the invocation itself documents
//      that a human, not a script, made this call.
//   2. The operator must supply the EXPECTED checksum for 0044 as an
//      explicit argument, computed and reviewed by that human beforehand
//      (e.g. `sha256sum supabase/migrations/0044_upgrade_receipts.sql`).
//      This script refuses unless that value matches what it independently
//      computes from the file on disk -- catching a wrong-target mixup,
//      not just recomputing and trusting its own answer.
//   3. Every legacy classifier signal (foundation..batchb) must already be
//      satisfied, and 0044's own schema (shape/RLS/no-grants) must already
//      exist -- this never creates schema, only records that it exists.
//   4. There must be no existing 0044 receipt already (if one exists,
//      this is not the right tool -- nothing to initialize).
//
// This round (P1-FOLLOWUP): implemented and tested only against disposable
// local targets, per the reviewing peer's explicit instruction not to
// initialize live receipts in this round. Running it against an actual
// live database remains an operator's own future decision, gated by the
// same checks above plus their own judgment -- this script does not
// itself distinguish "live" from "disposable" the way the bootstrap
// script's isLocalHost/data-emptiness checks do, because its entire
// purpose is to run against a real, already-populated database.
//
// Usage:
//   node scripts/attended-baseline-receipt-init.mjs <database-url> \
//     --i-attest-this-schema-was-verified-by-a-human \
//     --expected-checksum=<sha256 of 0044, computed by the operator>
import pg from 'pg';
import { loadManifest, ManifestError } from './verify-migration-manifest.mjs';
import { getClassifierState } from './apply-migrations-with-receipts.mjs';
import { verifyReceiptsSchema } from './verify-receipts-schema.mjs';

const { Client } = pg;

const LEGACY_GROUPS = ['foundation', 'hardening', 'phase65', 'batcha', 'batchb'];
const ATTESTATION_FLAG = '--i-attest-this-schema-was-verified-by-a-human';
const CHECKSUM_PREFIX = '--expected-checksum=';

async function main(argv) {
  const [databaseUrl, ...rest] = argv;
  const checksumArg = rest.find((arg) => arg.startsWith(CHECKSUM_PREFIX));
  const expectedChecksum = checksumArg?.slice(CHECKSUM_PREFIX.length);

  if (!databaseUrl || !rest.includes(ATTESTATION_FLAG) || !expectedChecksum) {
    console.error(
      `usage: node scripts/attended-baseline-receipt-init.mjs <database-url> ${ATTESTATION_FLAG} ` +
        `${CHECKSUM_PREFIX}<sha256 of 0044_upgrade_receipts.sql, computed and reviewed by a human first>`,
    );
    process.exitCode = 2;
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

  const entry0044 = entries.find((e) => e.version === '0044');
  if (!entry0044) {
    console.error('Manifest has no 0044 entry -- nothing to initialize.');
    process.exitCode = 1;
    return;
  }
  if (entry0044.checksumSha256 !== expectedChecksum) {
    console.error(
      `Refusing: the checksum you supplied (${expectedChecksum}) does not match the file on disk ` +
        `(${entry0044.checksumSha256}). This mismatch is exactly what forcing an operator-supplied ` +
        `checksum is for -- verify you are pointed at the correct file/target before retrying.`,
    );
    process.exitCode = 1;
    return;
  }

  const classifierState = getClassifierState(databaseUrl);
  const unsatisfiedLegacy = LEGACY_GROUPS.filter((group) => classifierState[group] !== false);
  if (unsatisfiedLegacy.length > 0) {
    console.error(
      `Refusing: this database is not at the full expected legacy schema state (still needs: ` +
        `${unsatisfiedLegacy.join(', ')}). This script only records a receipt for schema that ` +
        `genuinely already exists; it never creates schema.`,
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Verification and insertion share one transaction, and the table is
    // locked ACCESS EXCLUSIVE first, so no concurrent DDL or write can
    // change what was verified before the receipt is recorded.
    await client.query('begin');
    try {
      const present = (
        await client.query(`select to_regclass('public.app_migration_receipts') is not null as present`)
      ).rows[0].present;
      if (!present) throw new RefusalError('app_migration_receipts does not exist. Migration 0044 must have actually run first.');
      await client.query('lock table public.app_migration_receipts in access exclusive mode');

      const problems = await verifyReceiptsSchema(client);
      if (problems.length > 0) {
        throw new RefusalError(`app_migration_receipts does not exactly match 0044:\n  - ${problems.join('\n  - ')}`);
      }

      const existing = await client.query('select 1 from app_migration_receipts where version = $1', [entry0044.version]);
      if (existing.rowCount > 0) {
        throw new RefusalError(
          'a receipt for 0044 already exists. This script is for the one-time transition onto the receipts ' +
            'system -- there is nothing to initialize here.',
        );
      }

      await client.query('insert into app_migration_receipts (version, checksum_sha256) values ($1, $2)', [
        entry0044.version,
        entry0044.checksumSha256,
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    console.log('Initialized the 0044 baseline receipt on an attended, human-confirmed target.');
  } catch (error) {
    if (error instanceof RefusalError) {
      console.error(`Refusing: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await client.end();
  }
}

class RefusalError extends Error {}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message ?? String(error));
    process.exitCode = 1;
  });
}

export { main };
