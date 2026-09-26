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
  let output;
  try {
    output = execFileSync('bash', [scriptPath, databaseUrl], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // execFileSync's own thrown error includes the full command and argv
    // (the database URL, which may carry a password) in its .message --
    // confirmed directly: `execFileSync('bash', ['-c','exit 1'])`'s error
    // message is literally "Command failed: bash -c exit 1". GitHub
    // Actions happens to mask a registered secret in its own log rendering,
    // but that is a coincidental safety net this code must not depend on --
    // a local run, a different log sink, or an unregistered credential
    // would all leak it. Re-throw a sanitized error with only the
    // classifier's own stderr (the actual refusal reason: partial/
    // out-of-order schema, wrong Phase 5 baseline), never the command/argv.
    const rawStderr = typeof error.stderr === 'string' ? error.stderr.trim() : String(error.stderr ?? '').trim();
    // Defense in depth beyond stripping argv above: also redact any
    // URI-shaped substring (scheme://[user[:pass]@]host...) that the
    // classifier's own stderr might contain. No real psql failure mode
    // observed in this session's own probes actually echoes the
    // connection string back, but a reviewer's simulated-child probe
    // reasonably raised it as plausible for some libpq error path or a
    // future wrapped tool -- this makes it unconditionally safe rather
    // than dependent on today's observed psql behavior never changing.
    const stderr = rawStderr.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, '<redacted-connection-string>');
    // Deliberate: `cause` must NOT be the caught error itself here.
    // execFileSync's error carries the full command/argv (the database
    // URL, possibly with a password) in its own .message/.cmd fields --
    // exactly what this catch block exists to strip out. Attaching it as
    // `cause` would silently reopen the same leak for any logger that
    // prints an error's cause chain. Only a sanitized subset (exit status/
    // signal) is preserved.
    /* eslint-disable preserve-caught-error -- see comment above */
    throw new Error(`Classifier refused: ${stderr || 'non-zero exit, no stderr captured'}`, {
      cause: { status: error.status ?? null, signal: error.signal ?? null },
    });
    /* eslint-enable preserve-caught-error */
  }
  const state = {};
  for (const line of output.split('\n')) {
    const match = /^needs_(\w+)=(true|false)$/.exec(line.trim());
    if (match) state[match[1]] = match[2] === 'true';
  }
  return state;
}

/**
 * Pure prerequisite check, separated from the shell-out above so it can be
 * unit-tested without a live database. Every group ordered at or before the
 * HIGHEST requested group's position, that is not itself requested in this
 * same invocation, must already be satisfied (needs_<group> === false).
 *
 * A first draft only checked groups before the EARLIEST requested group,
 * which missed gaps between requested groups: requesting {foundation, p1}
 * together on a fully-unmigrated database passed silently, silently
 * skipping hardening/phase65/batcha/batchb entirely. Checking up to the
 * highest requested index catches that.
 *
 * This does NOT require the requested groups themselves to be unsatisfied
 * -- rerunning an already-applied group is a deliberate no-op (proof
 * matrix requirement), handled separately by the checksum-match skip logic
 * below, not by this gate.
 */
export function checkPrerequisites(requestedGroups, classifierState) {
  const requestedIndices = [...requestedGroups]
    .map((group) => GROUP_ORDER.indexOf(group))
    .filter((index) => index >= 0);
  if (requestedIndices.length === 0) return;
  const highestIndex = Math.max(...requestedIndices);
  for (let i = 0; i <= highestIndex; i += 1) {
    const group = GROUP_ORDER[i];
    if (requestedGroups.has(group)) continue;
    if (classifierState[group] !== false) {
      throw new Error(
        `Refusing to apply requested group(s): prerequisite group "${group}" (ordered before or among ` +
          `the requested groups) is not itself requested and is not yet satisfied on this database ` +
          `(classifier reports needs_${group}=${classifierState[group]}). Migrations must be applied ` +
          `in order, with no gaps; this is not a repairable local skip.`,
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

  // One transaction PER GROUP, not one transaction spanning every selected
  // group (mechanism point 3: "opens one SQL transaction per explicitly
  // selected group"). A first draft wrapped the whole invocation in a
  // single transaction; besides being a more literal reading of the spec,
  // per-group transactions are also strictly safer for a multi-group
  // invocation (e.g. "all" on a fresh install): a failure partway through
  // one group no longer forces rolling back an earlier group that already
  // committed successfully, so a retry doesn't have to redo already-good
  // work. Each individual group is still fully atomic on its own.
  const groupsInOrder = GROUP_ORDER.filter((group) => requested.has(group));
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let totalApplied = 0;
    for (const group of groupsInOrder) {
      const groupEntries = selected.filter((entry) => entry.group === group);
      if (groupEntries.length === 0) continue;

      let receiptTableExists = await tableExists(client, 'app_migration_receipts');
      for (const entry of groupEntries) {
        console.log(`Queued migration: ${entry.relativePath}`);
      }

      await client.query('begin');
      try {
        for (const entry of groupEntries) {
          // Legacy migrations (0030-0043, versioned below 0044) predate the
          // receipts mechanism entirely: app_migration_receipts does not
          // exist while they are being applied for the first time (e.g. the
          // CI proof job applies foundation/hardening/phase65/batcha/batchb
          // before p1). Never attempt to read or write that table for them
          // - doing so unconditionally would fail with "relation does not
          // exist" the first time any legacy group runs on a pre-P1 database.
          const tracksReceipts = entry.version >= '0044';

          if (tracksReceipts && receiptTableExists) {
            // Skip-if-already-applied-with-matching-receipt makes a rerun
            // of a completed group a no-op (proof matrix: "rerun completed
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

          if (entry.version === '0044' && receiptTableExists) {
            // 0044's own schema (app_migration_receipts) already exists
            // but has no receipt yet -- exactly the state every fresh
            // `supabase db reset` + disposable bootstrap passes through,
            // and the classifier now reports as needs_p1=true without
            // refusing (per the p1-tuple fix above). Blindly re-running
            // 0044's CREATE TABLE here would fail with "relation already
            // exists" instead of gracefully recording the missing receipt
            // for schema that is already correct. This is deliberately
            // narrow to 0044: it is the only migration this runner can
            // verify is idempotent-by-construction (its own target table's
            // existence IS the check). Any OTHER receipt-tracked migration
            // reaching this exact state (schema-shaped-object exists, no
            // receipt, but this isn't 0044) is genuinely ambiguous -- it
            // could be a legitimate first-time apply of brand-new schema,
            // or content applied outside this tooling -- and must go
            // through the attended baseline-receipt initialization path,
            // never be silently guessed here.
            console.log(`Skipping ${entry.relativePath}'s SQL: schema already present; recording its receipt.`);
            await client.query(
              `insert into app_migration_receipts (version, checksum_sha256)
               values ($1, $2)
               on conflict (version) do nothing`,
              [entry.version, entry.checksumSha256],
            );
            continue;
          }

          const sql = entry.bytes.toString('utf8');
          await client.query(sql);

          if (tracksReceipts) {
            // Migration 0044 itself creates app_migration_receipts; only
            // after that statement has just run in this same transaction
            // can we insert into it, including its own receipt.
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
      totalApplied += groupEntries.length;
    }

    console.log(`Applied and recorded receipts for ${totalApplied} migration(s) across ${groupsInOrder.length} group(s).`);
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
