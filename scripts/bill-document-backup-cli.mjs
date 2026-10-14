import pg from 'pg';
import { spawn } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import {
  capture,
  readInventory,
  restoreLocal,
  verify,
  origin,
  loopback,
} from './bill-document-backup.mjs';

export function pgDockerEnvironment(connectionString) {
  const url = new URL(connectionString);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') || 'prefer',
  };
}
export async function dockerDump(connectionString, snapshot, path, schema = 'public') {
  if (snapshot && !/^[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+$/.test(snapshot))
    throw new Error('Invalid exported snapshot identifier.');
  path = resolve(path);
  const args = [
    'run',
    '--rm',
    '--network',
    'host',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '-v',
    `${dirname(path)}:/dump`,
    ...['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE'].flatMap((k) => [
      '-e',
      k,
    ]),
    'postgres:17',
    'pg_dump',
    '--format=custom',
    `--schema=${schema}`,
  ];
  if (snapshot) args.push(`--snapshot=${snapshot}`);
  if (schema === 'auth') args.push('--data-only');
  args.push('-f', `/dump/${basename(path)}`);
  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: pgDockerEnvironment(connectionString),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // DB credentials never enter command arguments or captured error text.
    child.stderr.resume();
    child.on('error', () => reject(new Error('PostgreSQL 17 dump could not start.')));
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('PostgreSQL 17 snapshot dump failed.')),
    );
  });
  await chmod(path, 0o600);
}
async function client(url) {
  if (!url) throw new Error('Database connection is required.');
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  return db;
}
export async function main(args = process.argv.slice(2)) {
  const [command, directory, dump, acknowledgement] = args;
  if (!directory || !dump || !['backup', 'verify', 'restore-local'].includes(command))
    throw new Error(
      'Usage: bill-document-backup-cli.mjs <backup|verify|restore-local> <new-archive-directory> <matching-public-dump> [--disposable-target-only]',
    );
  if (command === 'verify') {
    const manifest = await verify(directory, dump);
    console.log(
      `Document archive verified: ${manifest.objects.length} objects, ${manifest.references.length} purchase references.`,
    );
    return;
  }
  if (command === 'restore-local') {
    const dbUrl = new URL(process.env.DOCUMENT_TARGET_DB_URL || '');
    if (!loopback(dbUrl.hostname) || acknowledgement !== '--disposable-target-only')
      throw new Error('Restore database must also be an acknowledged loopback disposable target.');
    origin(process.env.DOCUMENT_TARGET_URL);
    const db = await client(dbUrl.href);
    try {
      const result = await restoreLocal({
        db,
        directory,
        publicDump: dump,
        target: process.env.DOCUMENT_TARGET_URL,
        key: process.env.DOCUMENT_TARGET_KEY,
        disposable: true,
      });
      console.log(
        `Immutable document restore verified: ${result.objectsVerified} objects, ${result.referencesVerified} references.`,
      );
    } finally {
      await db.end();
    }
    return;
  }
  const connection = process.env.DOCUMENT_SOURCE_DB_URL;
  const db = await client(connection);
  try {
    const manifest = await capture({
      db,
      directory,
      publicDump: dump,
      source: process.env.DOCUMENT_SOURCE_URL,
      key: process.env.DOCUMENT_SOURCE_KEY,
      dump: (snapshot, path) =>
        dockerDump(process.env.DOCUMENT_DUMP_DB_URL || connection, snapshot, path),
      freshInventory: async () => {
        const fresh = await client(connection);
        try {
          return await readInventory(fresh);
        } finally {
          await fresh.end();
        }
      },
    });
    console.log(
      `Snapshot backup complete: ${manifest.objects.length} documents; ${manifest.unusedUploads.length} unused uploads retained.`,
    );
  } finally {
    await db.end();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(() => {
    console.error(
      'Document backup/restore refused. Check the private bucket, matching dump, source/target configuration and archive; no success is recorded.',
    );
    process.exitCode = 1;
  });
}
