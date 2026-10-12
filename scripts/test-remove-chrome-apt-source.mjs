import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/remove-chrome-apt-source.sh');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsb-apt-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = join(root, 'sources');
  const bin = join(root, 'bin');
  mkdirSync(sources);
  mkdirSync(bin);
  const stub = (name, body) =>
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  stub('sudo', 'exec "$@"');
  return {
    sources,
    stub,
    add(name, content) {
      const path = join(sources, name);
      writeFileSync(path, content);
      return path;
    },
    run() {
      return spawnSync('bash', ['-euo', 'pipefail', script, sources], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    },
  };
}

test('empty optional source directory succeeds under strict bash', (t) => {
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
});
test('unrelated apt sources remain when Chrome is absent', (t) => {
  const f = fixture(t);
  const other = f.add('ubuntu.sources', 'deb https://archive.ubuntu.com/ubuntu noble main');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(other));
});
test('only matching Chrome sources are removed, including unusual filenames', (t) => {
  const f = fixture(t);
  const chrome = f.add(
    'google chrome\n.list',
    'deb https://dl.google.com/linux/chrome/deb/ stable main',
  );
  const other = f.add('other.list', 'deb https://dlXgoogleXcom/linux/chrome/deb/ stable main');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(chrome), false);
  assert.ok(existsSync(other));
});
test('grep errors remain fatal and do not delete partial matches', (t) => {
  const f = fixture(t);
  const source = f.add('chrome.list', 'chrome');
  f.stub('grep', `printf '%s\\0' '${source}'; exit 2`);
  const r = f.run();
  assert.equal(r.status, 2);
  assert.ok(existsSync(source));
});
test('a deletion failure remains fatal', (t) => {
  const f = fixture(t);
  const source = f.add('chrome.list', 'https://dl.google.com/linux/chrome');
  f.stub('sudo', 'exit 42');
  assert.equal(f.run().status, 42);
  assert.ok(existsSync(source));
});
