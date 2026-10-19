import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pgDockerEnvironment } from './bill-document-backup-cli.mjs';
import {
  capture,
  verify,
  restoreLocal,
  validateInventory,
  retentionReport,
  download,
  sha256,
  MAX_BYTES,
} from './bill-document-backup.mjs';

const tenant = '10000000-0000-0000-0000-000000000001',
  shop = '10000000-0000-0000-0000-000000000002';
const client = '10000000-0000-0000-0000-000000000003',
  photo = '10000000-0000-0000-0000-000000000004';
const bytes = Buffer.from('%PDF-original-bill'),
  path = `${tenant}/${shop}/${client}/${photo}.pdf`;
const row = {
  id: photo,
  path,
  mime: 'application/pdf',
  size: bytes.length,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
};
const ref = { id: 'bill', tenantId: tenant, shopId: shop, clientId: client, path };
const bucket = {
  public: false,
  file_size_limit: MAX_BYTES,
  allowed_mime_types: ['image/webp', 'image/jpeg', 'image/png', 'application/pdf'],
};
function inventory() {
  return { bucket: { ...bucket }, objects: [{ ...row }], references: [{ ...ref }] };
}
function fakeDb(data = inventory()) {
  const calls = [];
  return {
    connectionParameters: { host: '127.0.0.1' },
    calls,
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('from storage.buckets')) return { rows: data.bucket ? [data.bucket] : [] };
      if (sql.includes('from storage.objects')) return { rows: data.objects };
      // billextras (0064): image table state and image-row references are read separately.
      if (sql.includes("to_regclass('public.purchase_bill_images')"))
        return { rows: 'imageTable' in data ? data.imageTable : [{ present: true }] };
      if (sql.includes('from public.purchase_bill_images'))
        return { rows: data.imageReferences ?? [] };
      if (sql.includes('from public.purchase_bills')) return { rows: data.references };
      if (sql.includes('json_build_object'))
        return { rows: [{ summary: { purchase_count: 1, purchase_total: '200' } }] };
      if (sql.includes('pg_export_snapshot'))
        return { rows: [{ snapshot: '00000001-00000002-1' }] };
      return { rows: [] };
    },
  };
}
const response = (body = bytes, type = row.mime) =>
  new Response(body, { headers: { 'content-type': type } });
async function fixture(t, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsb-document-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'archive'),
    publicDump = join(root, 'public.pgcustom'),
    db = fakeDb(opts.inventory);
  const args = {
    db,
    directory,
    publicDump,
    source: 'https://source.supabase.test',
    key: 'test-only',
    now: new Date('2026-10-14T00:00:00Z'),
    request: async () => response(),
    freshInventory: async () => opts.inventory ?? inventory(),
    dump: async (snapshot, file) => {
      assert.equal(snapshot, '00000001-00000002-1');
      assert(!db.calls.includes('commit'));
      await writeFile(file, Buffer.alloc(1000, 42));
    },
    ...opts,
  };
  return { root, args, db, directory, publicDump };
}
test('snapshot backup preserves exact original bytes, paired dump and retained unused uploads', async (t) => {
  const data = inventory();
  data.references = [];
  const f = await fixture(t, { inventory: data });
  const m = await capture(f.args);
  await verify(f.directory, f.publicDump);
  assert.equal(m.objects[0].sha256, sha256(bytes));
  assert.equal(m.unusedUploads[0].ageDays, 74);
  assert.match(m.unusedUploads[0].disposition, /unfinished device draft/);
  assert.deepEqual(await readFile(join(f.directory, 'objects', `${sha256(bytes)}.bin`)), bytes);
  assert.match(f.db.calls[0], /repeatable read read only/);
  assert.equal(f.db.calls.at(-1), 'commit');
});
test('a missing purchase original refuses backup before dumping, with no completion manifest', async (t) => {
  const data = inventory();
  data.objects = [];
  let dumped = false;
  const f = await fixture(t, {
    inventory: data,
    dump: async () => {
      dumped = true;
    },
  });
  await assert.rejects(capture(f.args), /missing or bound/);
  assert.equal(dumped, false);
  await assert.rejects(readFile(join(f.directory, 'manifest.json')));
  assert.equal(f.db.calls.at(-1), 'rollback');
});
test('all bill references are protected, including void/deleted bills and wrong shop/client binding', () => {
  for (const change of [{ shopId: tenant }, { tenantId: shop }, { clientId: photo }]) {
    const data = inventory();
    Object.assign(data.references[0], change);
    assert.throws(() => validateInventory(data), /bound/);
  }
  const data = inventory();
  Object.assign(data.references[0], { status: 'VOID', deletedAt: '2026-01-01' });
  validateInventory(data);
  assert.equal(retentionReport(data.objects, data.references, Date.now()).length, 0);
});
test('a public bucket or expanded limits/types cannot produce a private-backup claim', () => {
  for (const change of [
    { public: true },
    { file_size_limit: MAX_BYTES + 1 },
    { allowed_mime_types: [...bucket.allowed_mime_types, 'text/html'] },
  ]) {
    const data = inventory();
    Object.assign(data.bucket, change);
    assert.throws(() => validateInventory(data), /settings changed/);
  }
});
test('missing bucket is explicitly not installed, not a successful empty document backup', async (t) => {
  const f = await fixture(t, { inventory: { bucket: null, objects: [], references: [] } });
  const m = await capture(f.args);
  assert.equal(m.installed, false);
  assert.equal(m.sourceOrigin, null);
  assert.equal(m.objects.length, 0);
});
test('truncation, wrong MIME, oversized response and server refusal leave no completion manifest', async (t) => {
  for (const request of [
    async () => response(bytes.subarray(0, -1)),
    async () => response(bytes, 'text/html'),
    async () => response(Buffer.concat([bytes, bytes])),
    async () => new Response(null, { status: 403 }),
  ]) {
    const f = await fixture(t, { request });
    await assert.rejects(capture(f.args));
    await assert.rejects(readFile(join(f.directory, 'manifest.json')));
  }
});
test('credentials and redirects fail closed without forwarding server keys to another host', async () => {
  let called = 0;
  await assert.rejects(
    download('https://source.supabase.test', '', row, async () => {
      called++;
      return response();
    }),
    /credentials/,
  );
  assert.equal(called, 0);
  await download('https://source.supabase.test', 'test-key', row, async (url, options) => {
    assert.equal(new URL(url).hostname, 'source.supabase.test');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return response();
  });
});
test('source object replacement/deletion during capture invalidates the entire snapshot', async (t) => {
  for (const fresh of [
    { ...inventory(), objects: [] },
    { ...inventory(), objects: [{ ...row, updatedAt: '2026-10-14T00:00:00Z' }] },
  ]) {
    const f = await fixture(t, { freshInventory: async () => fresh });
    await assert.rejects(capture(f.args), /changed during backup/);
    await assert.rejects(readFile(join(f.directory, 'manifest.json')));
  }
});
test('new uploads after the snapshot are excluded without losing snapshot-owned bytes', async (t) => {
  const f = await fixture(t, {
    freshInventory: async () => ({
      ...inventory(),
      objects: [row, { ...row, path: path.replace(photo, client) }],
    }),
  });
  const m = await capture(f.args);
  assert.equal(m.objects.length, 1);
  assert.equal(m.references.length, 1);
});
test('an existing archive directory is never overwritten', async (t) => {
  const f = await fixture(t);
  await capture(f.args);
  const before = await readFile(join(f.directory, 'manifest.json'));
  await assert.rejects(capture(f.args));
  assert.deepEqual(await readFile(join(f.directory, 'manifest.json')), before);
});
test('same-size corrupted bytes and mismatched financial dumps refuse before any restore writes', async (t) => {
  for (const poison of ['bytes', 'dump']) {
    const f = await fixture(t);
    await capture(f.args);
    const file =
      poison === 'bytes' ? join(f.directory, 'objects', `${sha256(bytes)}.bin`) : f.publicDump;
    await writeFile(file, Buffer.alloc(poison === 'bytes' ? bytes.length : 1000, 33));
    let calls = 0;
    await assert.rejects(
      restoreLocal({
        ...f,
        target: 'http://127.0.0.1:55321',
        disposable: true,
        key: 'test',
        request: async () => {
          calls++;
          return response();
        },
      }),
      /changed|different public dump/,
    );
    assert.equal(calls, 0);
  }
});
test('manifest traversal, symlinks and duplicate object paths are refused', async (t) => {
  for (const poison of ['digest', 'link', 'duplicate']) {
    const f = await fixture(t);
    const m = await capture(f.args);
    if (poison === 'digest') m.objects[0].sha256 = '../../private-key';
    if (poison === 'duplicate') m.objects.push({ ...m.objects[0] });
    if (poison === 'link') {
      const file = join(f.directory, 'objects', `${sha256(bytes)}.bin`);
      await rm(file);
      await writeFile(join(f.root, 'outside'), bytes);
      await symlink(join(f.root, 'outside'), file);
    } else await writeFile(join(f.directory, 'manifest.json'), JSON.stringify(m));
    await assert.rejects(verify(f.directory, f.publicDump));
  }
});
test('hosted or unacknowledged target and loopback source aliases refuse any upload', async (t) => {
  const f = await fixture(t);
  const m = await capture(f.args);
  let calls = 0;
  const common = {
    ...f,
    key: 'test',
    request: async () => {
      calls++;
      return response();
    },
  };
  await assert.rejects(
    restoreLocal({ ...common, target: 'https://production.supabase.test', disposable: true }),
    /loopback/,
  );
  await assert.rejects(
    restoreLocal({ ...common, target: 'http://127.0.0.1:55321', disposable: false }),
    /acknowledged/,
  );
  m.sourceOrigin = 'http://localhost:55321';
  await writeFile(join(f.directory, 'manifest.json'), JSON.stringify(m));
  await assert.rejects(
    restoreLocal({ ...common, target: 'http://127.0.0.1:55321', disposable: true }),
    /source endpoint/,
  );
  assert.equal(calls, 0);
});
test('wrong target financial references refuse before any storage writes', async (t) => {
  const f = await fixture(t);
  await capture(f.args);
  let called = false;
  await assert.rejects(
    restoreLocal({
      ...f,
      db: fakeDb({ ...inventory(), references: [] }),
      target: 'http://127.0.0.1:55321',
      key: 'test',
      disposable: true,
      request: async () => {
        called = true;
        return response();
      },
    }),
    /references do not match/,
  );
  assert.equal(called, false);
});
test('lost upload answers/existing identical objects reconcile by bytes, never by size alone', async (t) => {
  const f = await fixture(t);
  await capture(f.args);
  let posts = 0;
  const common = { ...f, target: 'http://127.0.0.1:55321', key: 'test', disposable: true };
  const result = await restoreLocal({
    ...common,
    request: async (url, options) => {
      if (options.method === 'POST') {
        posts++;
        assert.equal(options.headers['x-upsert'], 'false');
        throw Error('answer lost');
      }
      return response();
    },
  });
  assert.equal(result.objectsVerified, 1);
  assert.equal(posts, 1);
  await assert.rejects(
    restoreLocal({
      ...common,
      request: async (url, options) =>
        options.method === 'POST'
          ? new Response(null, { status: 409 })
          : response(Buffer.alloc(bytes.length, 32)),
    }),
    /different bytes/,
  );
});

test('direct restore-helper callers cannot pair a local API with a remote database', async (t) => {
  const f = await fixture(t);
  await capture(f.args);
  const db = fakeDb();
  db.connectionParameters.host = 'db.production.supabase.test';
  let calls = 0;
  await assert.rejects(
    restoreLocal({
      ...f,
      db,
      target: 'http://127.0.0.1:55321',
      key: 'test',
      disposable: true,
      request: async () => {
        calls++;
        return response();
      },
    }),
    /loopback/,
  );
  assert.equal(db.calls.length, 0);
  assert.equal(calls, 0);
});

test('snapshot dump passes encoded credentials through environment and normalizes IPv6 hosts', () => {
  const env = pgDockerEnvironment(
    'postgresql://backup_ro:test%3Aonly%40pw@[::1]:55322/backup%20db?sslmode=require',
  );
  assert.equal(env.PGHOST, '::1');
  assert.equal(env.PGPORT, '55322');
  assert.equal(env.PGUSER, 'backup_ro');
  assert.equal(env.PGPASSWORD, 'test:only@pw');
  assert.equal(env.PGDATABASE, 'backup db');
  assert.equal(env.PGSSLMODE, 'require');
});

// billextras (0064): a second bill image lives only in purchase_bill_images. It is a referenced
// original (protected, never an "unused upload"), validated like bill_image_path.
function imageInventory() {
  const data = inventory();
  const second = '10000000-0000-0000-0000-000000000005';
  const imagePath = `${tenant}/${shop}/${client}/${second}.pdf`;
  data.objects.push({ ...row, id: second, path: imagePath });
  data.imageReferences = [
    { id: 'image-0', tenantId: tenant, shopId: shop, clientId: client, path },
    { id: 'image-1', tenantId: tenant, shopId: shop, clientId: client, path: imagePath },
  ];
  return { data, imagePath };
}
test('an image-row path is a referenced original, not an unused upload', async (t) => {
  const { data, imagePath } = imageInventory();
  const f = await fixture(t, { inventory: data });
  const m = await capture(f.args);
  assert.equal(m.unusedUploads.length, 0);
  assert(m.references.some((r) => r.id === 'image-1' && r.path === imagePath));
  assert.equal(m.objects.length, 2);
});
test('without its image row the same upload is reported as unused (retained)', async (t) => {
  const { data, imagePath } = imageInventory();
  data.imageReferences = [];
  const f = await fixture(t, { inventory: data });
  const m = await capture(f.args);
  assert.deepEqual(
    m.unusedUploads.map((u) => u.path),
    [imagePath],
  );
});
test('an image row bound to another request is refused like a bill reference', async (t) => {
  const { data } = imageInventory();
  data.imageReferences[1].clientId = photo;
  const f = await fixture(t, { inventory: data });
  await assert.rejects(capture(f.args), /missing or bound/);
});
test('an older schema without the image table reads bill references only', async (t) => {
  const data = inventory();
  data.imageTable = [{ present: false }];
  data.imageReferences = [
    { id: 'never-read', tenantId: tenant, shopId: shop, clientId: client, path },
  ];
  const f = await fixture(t, { inventory: data });
  const m = await capture(f.args);
  assert(!m.references.some((r) => r.id === 'never-read'));
  assert(!f.db.calls.some((sql) => sql.includes('from public.purchase_bill_images')));
});
test('an unreadable image table state fails with a clear error, not a TypeError', async (t) => {
  const data = inventory();
  data.imageTable = [];
  const f = await fixture(t, { inventory: data });
  await assert.rejects(capture(f.args), /bill image table state could not be read/);
  assert.equal(f.db.calls.at(-1), 'rollback');
});
