#!/usr/bin/env node
// Validates supabase/phase6-upgrade-manifest.txt before any apply runs:
//  - strictly ascending, zero-padded 4-digit version order
//  - unique paths (no migration file listed twice)
//  - each path exists on disk and matches supabase/migrations/<version>_*.sql
//  - group membership is one of the allowed registry entries
//  - computes and returns the SHA-256 of every migration file's bytes
//
// This is a pure validation/read module: it never opens a database
// connection and never runs SQL. scripts/apply-migrations-with-receipts.mjs
// imports parseManifest()/verifyManifest() from here so the same rules
// govern both the standalone `node scripts/verify-migration-manifest.mjs`
// CLI check and the apply runner's pre-flight, per mechanism point 2
// ("validate manifest order, path uniqueness, group membership, checksums
// and preceding-state compatibility before running SQL").
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const MANIFEST_PATH = join(REPO_ROOT, 'supabase', 'phase6-upgrade-manifest.txt');

// Explicit allowed group registry (mechanism point 8). Adding a new packet
// group means appending here and to the manifest — never inventing a group
// name inline in a shell case statement again.
export const ALLOWED_GROUPS = Object.freeze([
  'foundation',
  'hardening',
  'phase65',
  'batcha',
  'batchb',
  'p1',
]);

const VERSION_RE = /^[0-9]{4}$/;

export class ManifestError extends Error {}

// Frozen historical registry for migrations 0030-0043 (pre-P1, immutable per
// CLAUDE.md's forward-only-migrations rule). These predate app_migration_
// receipts, so nothing in the database can ever detect drift in their
// manifest membership. Without this hardcoded registry, editing the
// manifest to drop an entry, reassign it to the wrong group, or point it at
// a byte-for-byte-edited file would all validate silently: loadManifest()
// only re-derives a checksum from whatever bytes are on disk right now, so
// a tampered file "verifies" against its own tampered bytes.
//
// version -> [group, relativePath, checksumSha256]. Checksums independently
// verified against `sha256sum` on the actual files at the time this
// registry was written; they must never change, because these files must
// never change.
const EXPECTED_LEGACY_ENTRIES = Object.freeze({
  '0030': ['foundation', 'supabase/migrations/0030_phase6_ledgers_reports_dr.sql', 'b5dcc58cdf6712abbaa189657e15282ab5462d470b5983d7c8922a2bce2ece77'],
  '0031': ['hardening', 'supabase/migrations/0031_phase6_sync_page_size.sql', '090a63a72920dba253324ab5d99624f2222dc7fd5c75e1708482ce0d9e6df145'],
  '0032': ['hardening', 'supabase/migrations/0032_phase6_parallel_sync_pulls.sql', 'fb8908afef1e6fa09fc08c8835a8d94d8977a8aa6df93097d0af230793d5f446'],
  '0033': ['hardening', 'supabase/migrations/0033_phase6_streaming_page_size.sql', '11c5a6ac4937344625fb219c14b7a430257b1c22355d6f599c9833daeca9115b'],
  '0034': ['hardening', 'supabase/migrations/0034_phase6_integrity_hardening.sql', '10f8f2927db0f810eb585370c1fac7067e44fd6cabd453aea400fd7ec9a82a47'],
  '0035': ['hardening', 'supabase/migrations/0035_phase6_complete_export.sql', 'abe8eedd012ced9e75bb2f2a99a6870f34f0ee19c10b4e10c7db107b3fc69eba'],
  '0036': ['phase65', 'supabase/migrations/0036_phase65_returns.sql', '9f9e9794573185f75c94b5954859a1699f60cf4b57eec265dcf3da3ae8ba21b3'],
  '0037': ['phase65', 'supabase/migrations/0037_phase65_offline_returns.sql', 'b443710de3b4db7ddee75a10d8b658266a63cb55ae154f60b5a62ca0bb9c0977'],
  '0038': ['phase65', 'supabase/migrations/0038_phase65_shop_settings.sql', 'ef32cef9e6ff6d3a57b1cc25e244240b2496039c42a9904ce6fe9e85149c57d2'],
  '0039': ['phase65', 'supabase/migrations/0039_phase65_negative_stock_override.sql', '07f5ebbcb775a28a5e6267293699cf23fc9ebf2860ce232875ffb5c025b2c7b6'],
  '0040': ['phase65', 'supabase/migrations/0040_phase65_missing_reports.sql', 'e954abf3aa72278b84caef22636f0862b72b4e5a55a1ebef5c52c3b1c04daccb'],
  '0041': ['batcha', 'supabase/migrations/0041_phase65_sync_cost_confidentiality.sql', '0cde20371bd91d9b1ed5f25483fa941232778f8acbf38c1fc199624b34e2ed24'],
  '0042': ['batcha', 'supabase/migrations/0042_phase65_negative_stock_recovery.sql', 'a0935d9405eb4af10d20fdf6bb90d6238b1d89a8ea60cec6470913f06c25ee65'],
  '0043': ['batchb', 'supabase/migrations/0043_phase65_fixed_point_sale_ack.sql', 'cb191c062c3ed9edcfdd1a4ffcb330f969fa647031176c287f95f63511d4730e'],
});

// Group/path can be frozen for an in-flight (not yet merged) entry the
// instant its PR author commits to a name, even though its checksum can
// still change under review (unlike 0030-0043, which are genuinely
// immutable once merged). There is no reason to wait for merge to catch
// "reassigned to the wrong group" for a migration this same PR already
// controls -- version -> [group, relativePath], checksum intentionally
// omitted. Move an entry here into EXPECTED_LEGACY_ENTRIES (with its
// checksum) once it has actually merged to `main`.
const EXPECTED_IN_FLIGHT_GROUP_AND_PATH = Object.freeze({
  '0044': ['p1', 'supabase/migrations/0044_upgrade_receipts.sql'],
});

/**
 * Reads and validates the manifest. Returns an ordered array of
 * { version, group, relativePath, absolutePath, bytes, checksumSha256 }.
 * Throws ManifestError with a precise, non-connection-string message on
 * any violation.
 */
export function loadManifest({ manifestPath = MANIFEST_PATH, repoRoot = REPO_ROOT } = {}) {
  const raw = readFileSync(manifestPath, 'utf8');
  const lines = raw.split('\n');

  const entries = [];
  const seenVersions = new Set();
  const seenPaths = new Set();
  let previousVersion = '0000';

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const fields = line.split(/\s+/);
    if (fields.length !== 3) {
      throw new ManifestError(`Manifest line ${index + 1}: expected "version group path", got: ${JSON.stringify(line)}`);
    }
    const [version, group, relativePath] = fields;

    if (!VERSION_RE.test(version)) {
      throw new ManifestError(`Manifest line ${index + 1}: invalid version "${version}" (expected 4 digits)`);
    }
    if (seenVersions.has(version)) {
      throw new ManifestError(`Manifest line ${index + 1}: duplicate version "${version}"`);
    }
    if (!(version > previousVersion)) {
      throw new ManifestError(`Manifest line ${index + 1}: version "${version}" is not strictly greater than preceding "${previousVersion}" (manifest must be in strictly ascending order)`);
    }
    if (!ALLOWED_GROUPS.includes(group)) {
      throw new ManifestError(`Manifest line ${index + 1}: unknown group "${group}" (allowed: ${ALLOWED_GROUPS.join(', ')})`);
    }
    if (seenPaths.has(relativePath)) {
      throw new ManifestError(`Manifest line ${index + 1}: duplicate path "${relativePath}"`);
    }
    const expectedPrefix = `supabase/migrations/${version}_`;
    if (!(relativePath.startsWith(expectedPrefix) && relativePath.endsWith('.sql'))) {
      throw new ManifestError(`Manifest line ${index + 1}: path "${relativePath}" does not match version "${version}" (expected ${expectedPrefix}*.sql)`);
    }

    const absolutePath = join(repoRoot, relativePath);
    let bytes;
    try {
      bytes = readFileSync(absolutePath);
    } catch {
      throw new ManifestError(`Manifest line ${index + 1}: missing migration file "${relativePath}"`);
    }
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');

    const expectedLegacy = EXPECTED_LEGACY_ENTRIES[version];
    if (expectedLegacy) {
      const [expectedGroup, expectedPath, expectedChecksum] = expectedLegacy;
      if (group !== expectedGroup || relativePath !== expectedPath || checksumSha256 !== expectedChecksum) {
        throw new ManifestError(
          `Manifest line ${index + 1}: entry "${version}" does not match its frozen historical record ` +
            `(expected group "${expectedGroup}", path "${expectedPath}", checksum "${expectedChecksum}"). ` +
            `Migrations 0030-0043 are immutable; this is either manifest tampering or a historical file ` +
            `was edited in place, neither of which is a repairable local change.`,
        );
      }
    }

    const expectedInFlight = EXPECTED_IN_FLIGHT_GROUP_AND_PATH[version];
    if (expectedInFlight) {
      const [expectedGroup, expectedPath] = expectedInFlight;
      if (group !== expectedGroup || relativePath !== expectedPath) {
        throw new ManifestError(
          `Manifest line ${index + 1}: entry "${version}" does not match its expected group/path ` +
            `(expected group "${expectedGroup}", path "${expectedPath}"). This entry hasn't merged yet, ` +
            `so its checksum may still change, but its group and path are already committed for this PR.`,
        );
      }
    }

    entries.push({ version, group, relativePath, absolutePath, bytes, checksumSha256 });
    seenVersions.add(version);
    seenPaths.add(relativePath);
    previousVersion = version;
  }

  if (entries.length === 0) {
    throw new ManifestError('Manifest contained no migration rows');
  }

  for (const version of Object.keys(EXPECTED_LEGACY_ENTRIES)) {
    if (!seenVersions.has(version)) {
      throw new ManifestError(
        `Manifest is missing required historical entry "${version}". Migrations 0030-0043 are ` +
          `immutable and required in every valid manifest; an entry cannot be silently dropped.`,
      );
    }
  }

  // Completeness in the other direction: every migration file actually on
  // disk at or after 0030 (where this manifest system starts -- 0001-0029
  // predate it and are not manifest-tracked) must appear in the manifest.
  // Without this, deleting a manifest row for a file that still exists on
  // disk (e.g. removing 0044's row while 0044_upgrade_receipts.sql remains)
  // would validate silently and simply never get applied.
  const migrationsDir = join(repoRoot, 'supabase', 'migrations');
  const onDiskVersions = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .map((name) => name.slice(0, 4))
    .filter((version) => version >= '0030');
  for (const version of onDiskVersions) {
    if (!seenVersions.has(version)) {
      throw new ManifestError(
        `Migration file for version "${version}" exists on disk under supabase/migrations/ but has ` +
          `no manifest entry. Every migration at or after 0030 must be listed in the manifest.`,
      );
    }
  }

  return entries;
}

/** Convenience: validate and print a summary; used by the CLI entry point. */
export function verifyManifest(options = {}) {
  const entries = loadManifest(options);
  const byGroup = new Map();
  for (const entry of entries) {
    byGroup.set(entry.group, (byGroup.get(entry.group) ?? 0) + 1);
  }
  return { entries, byGroup };
}

function main() {
  try {
    const { entries, byGroup } = verifyManifest();
    console.log(`Manifest OK: ${entries.length} migrations across ${byGroup.size} groups.`);
    for (const [group, count] of byGroup) {
      console.log(`  ${group}: ${count} file(s)`);
    }
    for (const entry of entries) {
      console.log(`  ${entry.version} ${entry.group} ${entry.relativePath} sha256=${entry.checksumSha256}`);
    }
  } catch (error) {
    if (error instanceof ManifestError) {
      console.error(`Manifest validation failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
