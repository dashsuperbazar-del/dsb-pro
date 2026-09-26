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
import { readFileSync } from 'node:fs';
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

    entries.push({ version, group, relativePath, absolutePath, bytes, checksumSha256 });
    seenVersions.add(version);
    seenPaths.add(relativePath);
    previousVersion = version;
  }

  if (entries.length === 0) {
    throw new ManifestError('Manifest contained no migration rows');
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
