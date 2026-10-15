import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { validateExport, restore } from './restore-business-json.mjs';

const manifest = JSON.parse(readFileSync(new URL('./export-tables.json', import.meta.url), 'utf8'));
const tenant = '11111111-1111-4111-8111-111111111111';
function fixture() {
  return {
    schemaVersion: 4,
    exportKind: 'portable-business-data',
    tenantId: tenant,
    shopId: '22222222-2222-4222-8222-222222222222',
    exportedAt: '2026-10-14T00:00:00Z',
    ...Object.fromEntries(manifest.tables.map((t) => [t.key, t.single ? { id: tenant } : []])),
  };
}
for (const value of ['9007199254740993', '-9007199254740993', '0.123456789012345678901']) {
  test(`restored row JSON preserves the exact input number ${value}`, () => {
    const doc = fixture();
    doc.accountOpenings = [{ tenant_id: tenant, amount_paise: JSON.rawJSON(value) }];
    const raw = JSON.stringify(doc);
    const parsed = validateExport(raw);
    const rows = parsed.tables.find((t) => t.key === 'accountOpenings').rows;
    assert.equal(JSON.stringify(rows), `[{"tenant_id":"${tenant}","amount_paise":${value}}]`);
  });
}
test('programmatic restore refuses a remote target before opening a connection', async (t) => {
  const connect = t.mock.method(pg.Client.prototype, 'connect', async () => {
    throw new Error('CONNECT SHOULD NOT RUN');
  });
  await assert.rejects(
    restore({ raw: JSON.stringify(fixture()), target: 'postgresql://u:p@db.example.com/postgres' }),
    /not allowed/,
  );
  assert.equal(connect.mock.calls.length, 0);
});
for (const key of ['TEST_DATABASE_URL', 'RESTORE_SUPER_URL']) {
  test(`the destructive proof refuses a remote ${key} before connecting`, () => {
    const code =
      "import pg from 'pg'; pg.Client.prototype.connect=async()=>{throw new Error('CONNECT SHOULD NOT RUN')}; await import('./scripts/test-restore-business-json.mjs');";
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
        RESTORE_SUPER_URL: 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres',
        [key]: 'postgresql://u:p@db.example.com/postgres',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not allowed/);
    assert.doesNotMatch(result.stderr, /CONNECT SHOULD NOT RUN/);
  });
}
