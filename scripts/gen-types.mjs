// Cross-platform wrapper for `supabase gen types` — package.json scripts run
// via cmd.exe on Windows, which doesn't understand `"$VAR"` bash expansion,
// so the DEV_DB_URL substitution has to happen in JS instead of the shell.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const dbUrl = process.env.DEV_DB_URL;
if (!dbUrl) {
  console.error('gen:types requires DEV_DB_URL to be set (the dev Supabase project\'s direct Postgres connection string).');
  process.exit(1);
}

mkdirSync('packages/db/src', { recursive: true });

const result = spawnSync('supabase', ['gen', 'types', 'typescript', '--db-url', dbUrl], {
  encoding: 'utf8',
  shell: true,
});

if (result.status !== 0) {
  console.error(result.stderr || result.error?.message || 'supabase gen types failed');
  process.exit(result.status ?? 1);
}

const { writeFileSync } = await import('node:fs');
writeFileSync('packages/db/src/types.ts', result.stdout);
console.error('Wrote packages/db/src/types.ts');
