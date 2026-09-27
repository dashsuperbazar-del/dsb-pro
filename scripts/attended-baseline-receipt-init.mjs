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
    const tableExists = (
      await client.query(`select to_regclass('public.app_migration_receipts') is not null as present`)
    ).rows[0].present;
    if (!tableExists) {
      console.error('Refusing: app_migration_receipts does not exist. Migration 0044 must have actually run first.');
      process.exitCode = 1;
      return;
    }

    // Exact column-level comparison, not merely "these 4 names exist" --
    // type, nullability and default all checked against what 0044 itself
    // creates. GPT's finding: "counts four column names... do not validate
    // types, nullability, defaults" was correct; this replaces that shape
    // check.
    const EXPECTED_COLUMNS = {
      version: { data_type: 'text', is_nullable: 'NO', column_default: null },
      checksum_sha256: { data_type: 'text', is_nullable: 'NO', column_default: null },
      applied_at: { data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
      applied_by: { data_type: 'text', is_nullable: 'NO', column_default: 'CURRENT_USER' },
    };
    const columns = await client.query(`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema='public' and table_name='app_migration_receipts'
    `);
    const actualColumns = Object.fromEntries(columns.rows.map((r) => [r.column_name, r]));
    const columnMismatches = [];
    for (const [name, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const actual = actualColumns[name];
      if (!actual) {
        columnMismatches.push(`${name}: missing`);
        continue;
      }
      if (actual.data_type !== expected.data_type) {
        columnMismatches.push(`${name}: type is "${actual.data_type}", expected "${expected.data_type}"`);
      }
      if (actual.is_nullable !== expected.is_nullable) {
        columnMismatches.push(`${name}: nullable is "${actual.is_nullable}", expected "${expected.is_nullable}"`);
      }
      const normalizedDefault = actual.column_default?.replace(/::\w+(\([^)]*\))?$/, '').trim() ?? null;
      const expectedDefault = expected.column_default;
      if (expectedDefault !== null && normalizedDefault !== expectedDefault) {
        columnMismatches.push(`${name}: default is "${actual.column_default}", expected "${expectedDefault}"`);
      }
    }
    const extraColumns = Object.keys(actualColumns).filter((name) => !(name in EXPECTED_COLUMNS));
    if (extraColumns.length > 0) columnMismatches.push(`unexpected extra column(s): ${extraColumns.join(', ')}`);

    // Primary key and both CHECK constraints, by actual definition, not by
    // name alone -- a same-named constraint with a weaker/different
    // condition would not be caught by an existence check.
    const constraints = await client.query(`
      select conname, contype, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = to_regclass('public.app_migration_receipts')
    `);
    const pk = constraints.rows.find((r) => r.contype === 'p');
    const checksumCheck = constraints.rows.find((r) => r.contype === 'c' && r.conname === 'app_migration_receipts_checksum_format');
    const versionCheck = constraints.rows.find((r) => r.contype === 'c' && r.conname === 'app_migration_receipts_version_format');
    if (!pk || !pk.definition.includes('(version)')) {
      columnMismatches.push('primary key on (version) is missing or different');
    }
    if (!checksumCheck || !checksumCheck.definition.includes('0-9a-f') || !checksumCheck.definition.includes('64')) {
      columnMismatches.push('checksum_sha256 CHECK constraint is missing or does not match the expected 64-hex-char pattern');
    }
    if (!versionCheck || !versionCheck.definition.includes('0-9')) {
      columnMismatches.push('version CHECK constraint is missing or does not match the expected 4-digit pattern');
    }

    const rlsEnabled = (
      await client.query(`select relrowsecurity from pg_class where oid = to_regclass('public.app_migration_receipts')`)
    ).rows[0]?.relrowsecurity === true;
    if (!rlsEnabled) columnMismatches.push('row level security is not enabled');

    const publicGrants = await client.query(`
      select grantee, privilege_type from information_schema.role_table_grants
      where table_schema='public' and table_name='app_migration_receipts'
        and grantee in ('anon','authenticated','PUBLIC')
    `);
    if (publicGrants.rowCount > 0) {
      columnMismatches.push(
        `unexpected grant(s) to anon/authenticated/PUBLIC: ${publicGrants.rows.map((r) => `${r.grantee}:${r.privilege_type}`).join(', ')}`,
      );
    }

    // Effective privilege check, not just "no grant row exists": ask
    // Postgres directly whether anon/authenticated can actually select,
    // which also catches a stray role membership or a PUBLIC-inherited
    // grant that a role_table_grants row alone wouldn't show.
    const effectivePrivileges = await client.query(`
      select
        has_table_privilege('anon', 'public.app_migration_receipts', 'SELECT') as anon_can_select,
        has_table_privilege('authenticated', 'public.app_migration_receipts', 'SELECT') as authenticated_can_select
    `);
    if (effectivePrivileges.rows[0].anon_can_select || effectivePrivileges.rows[0].authenticated_can_select) {
      columnMismatches.push('anon or authenticated has effective SELECT privilege (via role membership, not just a direct grant)');
    }

    // backup_ro coverage, per 0044's own intent ("Include it in operator
    // backup/export, not ordinary cashier data") -- only asserted when the
    // role exists, matching 0044's own conditional grant.
    const backupRoExists = (await client.query(`select 1 from pg_roles where rolname='backup_ro'`)).rowCount > 0;
    if (backupRoExists) {
      const canBackupRead = (
        await client.query(`select has_table_privilege('backup_ro', 'public.app_migration_receipts', 'SELECT') as can_read`)
      ).rows[0].can_read;
      if (!canBackupRead) columnMismatches.push('backup_ro role exists but cannot SELECT app_migration_receipts');
    }

    if (columnMismatches.length > 0) {
      console.error(`Refusing: app_migration_receipts does not exactly match the expected schema:\n  - ${columnMismatches.join('\n  - ')}`);
      process.exitCode = 1;
      return;
    }

    const existing = await client.query(
      'select 1 from app_migration_receipts where version = $1',
      [entry0044.version],
    );
    if (existing.rowCount > 0) {
      console.error(
        'Refusing: a receipt for 0044 already exists. This script is for the one-time transition ' +
          'onto the receipts system, not for repeated use -- there is nothing to initialize here.',
      );
      process.exitCode = 1;
      return;
    }

    await client.query(
      `insert into app_migration_receipts (version, checksum_sha256) values ($1, $2)`,
      [entry0044.version, entry0044.checksumSha256],
    );
    console.log(`Initialized the 0044 baseline receipt on an attended, human-confirmed target.`);
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message ?? String(error));
  process.exitCode = 1;
});
