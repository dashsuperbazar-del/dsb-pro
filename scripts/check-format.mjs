import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

// M0's app scope is enforced in full. Existing repository-wide formatting debt
// stays separate; every supported file changed by a PR must also be formatted.
const base = process.env.FORMAT_BASE || '';
if (base && (!/^[a-f0-9]{40}$/i.test(base) || /^0+$/.test(base))) {
  throw new Error('FORMAT_BASE must be an existing nonzero commit SHA.');
}
const changed = run('git', ['diff', '--name-only', '-z', '--diff-filter=ACMR', base || 'HEAD'])
  .split('\0')
  .filter((path) => path && existsSync(path));
run('pnpm', [
  'exec',
  'prettier',
  '--check',
  '--ignore-unknown',
  '--',
  'apps/**/*.{ts,tsx,css,json,html}',
  ...changed,
]);
console.log(`Formatting passed: app scope and ${changed.length} changed files.`);
