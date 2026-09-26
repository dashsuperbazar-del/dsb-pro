#!/usr/bin/env node
// Node pg transaction runner for the Phase 6 upgrade manifest (Packet P1).
//
// Replaces raw `psql --single-transaction` for groups at or after "p1" so
// that, in the same transaction as the SQL files, we can also insert
// parameterized app_migration_receipts rows before COMMIT (mechanism
// point 3). This avoids shell/SQL quoting hazards from generating receipt
// INSERT statements as text.
//
// Invocation (unchanged from the shell script, plus this is what
// scripts/apply-phase6-upgrade.sh now delegates to):
//   node scripts/apply-migrations-with-receipts.mjs <database-url> <group> [<group> ...]
//   node scripts/apply-migrations-with-receipts.mjs <database-url> all
//
// Never logs the database URL or any connection string.
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadManifest, ALLOWED_GROUPS, ManifestError, REPO_ROOT } from './verify-migration-manifest.mjs';

const { Client } = pg;

// Same order the legacy classifier (scripts/inspect-phase6-upgrade-state.sh)
// emits its needs_<group> flags in. This is the one place that ordering is
// duplicated as data (not logic) -- the actual state determination stays in
// the shell classifier; this file only reads its output.
const GROUP_ORDER = ['foundation', 'hardening', 'phase65', 'batcha', 'batchb', 'p1'];

/**
 * Shells out to the same classifier the live CI/attended-upgrade path uses,
 * so this runner cannot be invoked directly against an under-migrated
 * database and bypass the prerequisite checks that classifier already
 * proves (mechanism point 2's "preceding-state compatibility", finding:
 * "prove direct runner invocation cannot bypass these checks"). Refusing
 * here reuses the classifier's own refusal (partial/out-of-order schema,
 * wrong Phase 5 baseline) rather than re-implementing that logic.
 */
export function getClassifierState(databaseUrl, { repoRoot = REPO_ROOT } = {}) {
  const scriptPath = join(repoRoot, 'scripts', 'inspect-phase6-upgrade-state.sh');
  const output = execFileSync('bash', [scriptPath, databaseUrl], { encoding: 'utf8' });
  const state = {};
  for (const line of output.split('\n')) {
    const match = /^needs_(\w+)=(true|false)$/.exec(line.trim());
    if (match) state[match[1]] = match[2] === 'true';
  }
  return state;
}

/**
 * Pure prerequisite check, separated from the shell-out above so it can be
 * unit-tested without a live database. Every group ordered strictly before
 * the earliest requested group must already be satisfied (needs_<group>
 * === false). This does NOT require the requested groups themselves to be
 * unsatisfied -- rerunning an already-applied group is a deliberate no-op
 * (proof matrix requirement), handled separately by the checksum-match
 * skip logic below, not by this gate.
 */
export function checkPrerequisites(requestedGroups, classifierState) {
  const requestedIndices = [...requestedGroups]
    .map((group) => GROUP_ORDER.indexOf(group))
    .filter((index) => index >= 0);
  if (requestedIndices.length === 0) return;
  const earliestIndex = Math.min(...requestedIndices);
  for (let i = 0; i < earliestIndex; i += 1) {
    const group = GROUP_ORDER[i];
    if (classifierState[group] !== false) {
      throw new Error(
        `Refusing to apply group(s) starting at "${GROUP_ORDER[earliestIndex]}": prerequisite group ` +
          `"${group}" is not yet satisfied on this database (classifier reports needs_${group}=` +
          `${classifierState[group]}). Migrations must be applied in order; this is not a repairable ` +
          `local skip.`,
      );
    }
  }
}

function usageError(message) {
  console.error(message);
  console.error(`usage: node scripts/apply-migrations-with-receipts.mjs <database-url> <${ALLOWED_GROUPS.join('|')}|all> [...]`);
  process.exitCode = 2;
}

function redact() {
  // Placeholder for symmetry with the shell wrapper's comment; this module
  // never prints process.argv[2] (the database URL) anywhere, by
  // construction — every log line below is written by hand from named
  // values, never by interpolating argv or the connection string.
}

async function main(argv) {
  const [databaseUrl, ...groupArgs] = argv;
  if (!databaseUrl || groupArgs.length === 0) {
    usageError('database URL and at least one group are required');
    return;
  }
  redact();

  const requested = new Set();
  for (const arg of groupArgs) {
    if (arg === 'all') {
      for (const g of ALLOWED_GROUPS) requested.add(g);
      continue;
    }
    if (!ALLOWED_GROUPS.includes(arg)) {
      usageError(`Unknown migration group: ${arg}`);
      return;
    }
    requested.add(arg);
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

  const selected = entries.filter((entry) => requested.has(entry.group));
  if (selected.length === 0) {
    console.error('No migrations selected for the requested group(s)');
    process.exitCode = 1;
    return;
  }

  // Preceding-state compatibility, enforced by reusing the trusted
  // classifier rather than re-deriving schema state here: a direct
  // invocation of this runner (bypassing scripts/apply-phase6-upgrade.sh
  // and whatever preflight its caller normally runs) cannot skip ahead of
  // an unmet prerequisite group.
  const classifierState = getClassifierState(databaseUrl);
  checkPrerequisites(requested, classifierState);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let receiptTableExists = await tableExists(client, 'app_migration_receipts');

    for (const entry of selected) {
      console.log(`Queued migration: ${entry.relativePath}`);
    }

    await client.query('begin');
    try {
      for (const entry of selected) {
        // Legacy migrations (0030-0043, versioned below 0044) predate the
        // receipts mechanism entirely: app_migration_receipts does not
        // exist while they are being applied for the first time (e.g. the
        // CI proof job applies foundation/hardening/phase65/batcha/batchb
        // before p1). Never attempt to read or write that table for them -
        // doing so unconditionally would fail with "relation does not
        // exist" the first time any legacy group runs on a pre-P1 database.
        const tracksReceipts = entry.version >= '0044';

        if (tracksReceipts && receiptTableExists) {
          // Skip-if-already-applied-with-matching-receipt makes a rerun of
          // a completed group a no-op (proof matrix: "rerun completed
          // group is no-op only after matching receipt/schema").
          const existing = await client.query(
            'select checksum_sha256 from app_migration_receipts where version = $1',
            [entry.version],
          );
          if (existing.rowCount > 0) {
            const recordedChecksum = existing.rows[0].checksum_sha256;
            if (recordedChecksum !== entry.checksumSha256) {
              throw new Error(
                `Checksum mismatch for already-applied migration ${entry.version}: ` +
                  `recorded receipt does not match the file on disk. Refusing to reapply or ` +
                  `silently accept drift; this requires reviewed forward repair, not automatic action.`,
              );
            }
            console.log(`Skipping ${entry.relativePath}: matching receipt already recorded (no-op).`);
            continue;
          }
        }

        const sql = entry.bytes.toString('utf8');
        await client.query(sql);

        if (tracksReceipts) {
          // Migration 0044 itself creates app_migration_receipts; only
          // after that statement has just run in this same transaction can
          // we insert into it, including its own receipt. Every later
          // receipt-tracked entry in this same loop can now see the table
          // too, even though `receiptTableExists` was computed before the
          // transaction began.
          await client.query(
            `insert into app_migration_receipts (version, checksum_sha256)
             values ($1, $2)
             on conflict (version) do nothing`,
            [entry.version, entry.checksumSha256],
          );
          receiptTableExists = true;
        }
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }

    console.log(`Applied and recorded receipts for ${selected.length} migration(s).`);
  } finally {
    await client.end();
  }
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `select to_regclass('public.' || $1) is not null as present`,
    [tableName],
  );
  return result.rows[0].present === true;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message ?? String(error));
    process.exitCode = 1;
  });
}

export { main };
