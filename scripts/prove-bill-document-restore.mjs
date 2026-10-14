import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import pg from 'pg';
import {
  capture,
  readInventory,
  restoreLocal,
  verify,
  download,
  sha256,
  origin,
  loopback,
} from './bill-document-backup.mjs';
import { dockerDump } from './bill-document-backup-cli.mjs';

const run = promisify(execFile);
const source = JSON.parse(await readFile(process.argv[2], 'utf8'));
const target = JSON.parse(await readFile(process.argv[3], 'utf8'));
for (const config of [source, target]) {
  assert(loopback(new URL(origin(config.API_URL)).hostname), 'Proof endpoints must be local.');
  assert(loopback(new URL(config.DB_URL).hostname), 'Proof databases must be local.');
}
assert.notEqual(source.API_URL, target.API_URL);
assert.notEqual(source.DB_URL, target.DB_URL);
const root = await mkdtemp(join(tmpdir(), 'dsb-document-proof-'));
const nightly = await readFile('.github/workflows/backup.yml', 'utf8');
function nightlyStep(name) {
  const start = nightly.indexOf(`      - name: ${name}\n`);
  assert(start >= 0, `Nightly step disappeared: ${name}`);
  const end = nightly.indexOf('      - name:', start + 8);
  const chunk = nightly.slice(start, end < 0 ? undefined : end);
  const script = chunk.split('        run: |\n')[1];
  assert(script, 'Nightly step must be an executable block.');
  return script
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}
async function nightlyRun(name, replacements, env = {}) {
  let script = nightlyStep(name);
  for (const [key, value] of Object.entries(replacements))
    script = script.split(`\u0024{{ ${key} }}`).join(value);
  assert(
    !script.includes('\u0024{{'),
    'Unresolved workflow inputs; never use production secrets in a proof.',
  );
  await run('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024,
  });
}
async function connect(config) {
  const db = new pg.Client({ connectionString: config.DB_URL });
  await db.connect();
  return db;
}
const admin = await connect(source),
  targetDb = await connect(target);
const authHeaders = {
  apikey: source.SERVICE_ROLE_KEY,
  Authorization: `Bearer ${source.SERVICE_ROLE_KEY}`,
};
const email = `document-proof-${randomUUID()}@example.test`,
  password = 'DisposableOnly-2026!';
async function store(config, path, bytes, upsert = false) {
  const response = await fetch(`${config.API_URL}/storage/v1/object/bill-documents/${path}`, {
    method: 'POST',
    headers: {
      apikey: config.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${config.SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': String(upsert),
    },
    body: bytes,
  });
  assert(response.ok, `Fixture storage upload failed (${response.status}).`);
}
let owner, tenant, shop, item;
async function authenticated(db, fn) {
  await db.query('begin');
  try {
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: owner, role: 'authenticated' }),
    ]);
    const value = await fn(db);
    await db.query('commit');
    return value;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}
async function post(client, path) {
  const writer = await connect(source);
  try {
    return await authenticated(
      writer,
      async (db) =>
        (
          await db.query(
            `select post_purchase($1,null,$2,current_date,0,0,$3,
  jsonb_build_array(jsonb_build_object('item_id',$4::text,'qty','2','unit_price_paise',100)),$5) as id`,
            [shop, `DOC-${client.slice(0, 8)}`, client, item, path],
          )
        ).rows[0].id,
    );
  } finally {
    await writer.end();
  }
}
try {
  const created = await fetch(`${source.API_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  assert(created.ok, 'Disposable Auth fixture could not be created.');
  owner = (await created.json()).id;
  await authenticated(admin, async (db) => {
    await db.query("select create_tenant('Document Restore Proof',$1,'Proof Shop',$2)", [
      `document-${randomUUID()}`,
      randomUUID(),
    ]);
    const data = (
      await db.query(
        'select current_tenant_id() as tenant,(select id from shops where tenant_id=current_tenant_id() and is_default limit 1) as shop',
      )
    ).rows[0];
    ({ tenant, shop } = data);
    item = (
      await db.query(
        "insert into items(tenant_id,name,unit1,client_id) values($1,'Restore Proof Item','piece',$2) returning id",
        [tenant, randomUUID()],
      )
    ).rows[0].id;
  });
  const client1 = randomUUID(),
    client2 = randomUUID(),
    body = Buffer.from('%PDF-1.7 synthetic original supplier bill');
  const path1 = `${tenant}/${shop}/${client1}/${randomUUID()}.pdf`,
    path2 = `${tenant}/${shop}/${client2}/${randomUUID()}.pdf`;
  await store(source, path1, body);
  await store(source, path2, Buffer.from('%PDF-1.7 retained unfinished upload'));
  await admin.query(
    "update storage.objects set created_at=now()-interval '60 days' where bucket_id='bill-documents' and name=$1",
    [path2],
  );
  await post(client1, path1);
  const directory = join(root, 'document-backup'),
    publicDump = join(root, 'public.pgcustom'),
    authDump = join(root, 'auth.pgcustom');
  const manifest = await capture({
    db: admin,
    source: source.API_URL,
    key: source.SERVICE_ROLE_KEY,
    directory,
    publicDump,
    dump: async (snapshot, file) => {
      // Commit a purchase while the exporter is open. The dump must retain the
      // exported snapshot, not this later financial state; its bytes stay retained.
      await post(client2, path2);
      await dockerDump(source.DB_URL, snapshot, file);
    },
    freshInventory: async () => {
      const fresh = await connect(source);
      try {
        return await readInventory(fresh);
      } finally {
        await fresh.end();
      }
    },
  });
  assert.equal(manifest.references.length, 1);
  assert.equal(manifest.objects.length, 2);
  assert.equal(manifest.unusedUploads.length, 1);
  assert.equal(manifest.unusedUploads[0].path, path2);
  assert.equal(manifest.summary.purchase_count, 1);
  assert.equal(manifest.summary.purchase_total, '200');
  await dockerDump(source.DB_URL, null, authDump, 'auth');
  // Prove encryption/decryption with an ephemeral key, never a production key.
  const keyFile = join(root, 'test.agekey');
  await run('age-keygen', ['-o', keyFile]);
  const recipient = (await run('age-keygen', ['-y', keyFile])).stdout.trim();
  const tar = join(root, 'documents.tar.gz'),
    encrypted = join(root, 'documents.tar.gz.age'),
    decrypted = join(root, 'decrypted.tar.gz');
  await run('tar', ['-czf', tar, '-C', directory, '.']);
  const outputsFile = join(root, 'workflow-outputs');
  await nightlyRun(
    'Encrypt and checksum all three layers',
    {
      'vars.AGE_PUBLIC_KEY': recipient,
      'github.run_id': 'disposable-proof',
      'github.run_attempt': '1',
    },
    { GITHUB_OUTPUT: outputsFile },
  );
  const outputs = Object.fromEntries(
    (await readFile(outputsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  const rcloneConfig = join(root, 'test-rclone.conf');
  await writeFile(rcloneConfig, '[b2]\ntype = local\n[r2]\ntype = local\n', { mode: 0o600 });
  await nightlyRun(
    'Upload all three artifacts to B2 and R2 and verify',
    Object.fromEntries(
      Object.entries(outputs).map(([key, value]) => [`steps.checksum.outputs.${key}`, value]),
    ),
    { RCLONE_CONFIG: rcloneConfig },
  );
  // Test the exact record step too: six verified destinations, correct quoting,
  // matching artifact set. Private aggregates stay in a file, not Actions env logs.
  await nightlyRun('Build financial manifest from the captured snapshot', {});
  const backupId = (
    await admin.query(
      "insert into backup_runs(started_at,status) values(now(),'running') returning id",
    )
  ).rows[0].id;
  await nightlyRun(
    'Mark backup succeeded',
    {},
    {
      DB_URL: source.DB_URL,
      RUN_ID: backupId,
      PUBLIC_SHA: outputs.public_sha,
      AUTH_SHA: outputs.auth_sha,
      DOCUMENTS_SHA: outputs.documents_sha,
      BACKUP_NAME: outputs.name,
      APP_VERSION: 'disposable-proof',
    },
  );
  const recorded = (
    await admin.query(
      'select status,schema_version,destinations,manifest from backup_runs where id=$1',
      [backupId],
    )
  ).rows[0];
  assert.equal(recorded.status, 'success');
  assert.equal(recorded.schema_version, 4);
  assert.equal(recorded.destinations.length, 6);
  assert.equal(recorded.manifest.artifactSet, outputs.name);
  for (const destination of recorded.destinations) {
    const folder = destination.name === 'b2' ? 'APD-BB' : 'apd-dsb';
    assert.equal(sha256(await readFile(join(root, folder, destination.file))), destination.sha256);
  }
  await run('age', ['-d', '-i', keyFile, '-o', decrypted, encrypted]);
  assert.equal(sha256(await readFile(tar)), sha256(await readFile(decrypted)));
  const extracted = join(root, 'recovered');
  await mkdir(extracted, { mode: 0o700 });
  await run('tar', ['-xzf', decrypted, '-C', extracted]);
  await verify(extracted, publicDump);
  await run('bash', ['scripts/restore-to-local-supabase.sh', publicDump, authDump, target.DB_URL], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const counts = (
    await targetDb.query(
      'select count(*) as count,sum(total_paise)::text as total from purchase_bills',
    )
  ).rows[0];
  assert.equal(counts.count, '1');
  assert.equal(counts.total, '200');
  assert.equal(
    (
      await targetDb.query(
        'select qty_base::text as qty from stock_current where shop_id=$1 and item_id=$2',
        [shop, item],
      )
    ).rows[0].qty,
    '2.000000',
  );
  assert.equal(
    (await admin.query('select count(*) as count from purchase_bills')).rows[0].count,
    '2',
  );
  assert.equal((await readInventory(targetDb)).objects.length, 0);
  const settings = {
    directory: extracted,
    publicDump,
    db: targetDb,
    target: target.API_URL,
    key: target.SERVICE_ROLE_KEY,
    disposable: true,
  };
  let first = true;
  await restoreLocal({
    ...settings,
    request: async (url, options) => {
      const response = await fetch(url, options);
      if (options.method === 'POST' && first) {
        first = false;
        assert(response.ok);
        throw Error('lost upload answer after commit');
      }
      return response;
    },
  });
  await restoreLocal(settings); // Already-present originals are identical, never overwritten.
  assert.equal((await readInventory(targetDb)).objects.length, 2);
  const saved = await download(
    target.API_URL,
    target.SERVICE_ROLE_KEY,
    manifest.objects.find((r) => r.path === path1),
  );
  assert.deepEqual(saved, body);
  // Restored Auth identity can read its permitted shop through the actual RLS/API.
  const login = await fetch(`${target.API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: target.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert(login.ok, 'Recovered owner could not sign in.');
  const token = (await login.json()).access_token;
  const ownerRead = await fetch(`${target.API_URL}/storage/v1/object/bill-documents/${path1}`, {
    headers: { apikey: target.ANON_KEY, Authorization: `Bearer ${token}` },
  });
  assert(ownerRead.ok, 'Restored owner RLS could not open the original.');
  assert.deepEqual(Buffer.from(await ownerRead.arrayBuffer()), body);
  const anonymous = await fetch(
    `${target.API_URL}/storage/v1/object/public/bill-documents/${path1}`,
    { headers: { apikey: target.ANON_KEY } },
  );
  assert(!anonymous.ok, 'Private restored original became public.');
  const changed = Buffer.alloc(body.length, 88);
  await store(target, path1, changed, true);
  await assert.rejects(restoreLocal(settings), /different bytes|changed/);
  assert.deepEqual(
    await download(target.API_URL, target.SERVICE_ROLE_KEY, {
      ...rowFor(path1, manifest),
      size: changed.length,
    }),
    changed,
  );
  await store(target, path1, body, true);
  // A late corrupt file is refused before even the first valid file is uploaded.
  const objectFile = join(extracted, 'objects', `${manifest.objects[1].sha256}.bin`);
  await writeFile(objectFile, Buffer.alloc(manifest.objects[1].size, 32));
  let writes = 0;
  await assert.rejects(
    restoreLocal({
      ...settings,
      request: async () => {
        writes++;
        throw Error('must not write');
      },
    }),
    /changed/,
  );
  assert.equal(writes, 0);
  console.log(
    'DOCUMENT BACKUP/RESTORE PROOF: PASS — exported financial snapshot, 2 exact private objects, retained unfinished upload, encrypted roundtrip, second-target financial/Auth restore, lost-answer/exact replay and corruption/no-overwrite refusals.',
  );
} finally {
  await admin.end();
  await targetDb.end();
  await rm(root, { recursive: true, force: true });
}
function rowFor(path, manifest) {
  return manifest.objects.find((row) => row.path === path);
}
