import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export const BUCKET = 'bill-documents';
export const MAX_BYTES = 5242880;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH = new RegExp(`^(${UUID})/(${UUID})/(${UUID})/(${UUID})\\.(webp|jpg|png|pdf)$`);
const MIME = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const loopback = (host) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
const endpoint = (base) => {
  const url = new URL(base);
  return `${loopback(url.hostname) ? 'loopback' : url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
};

export function origin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('A valid Supabase origin is required.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname)))
  )
    throw new Error(
      'Supabase origin must use HTTPS (HTTP only on loopback), without credentials or a path.',
    );
  return url.origin;
}
export function checkBucket(bucket) {
  if (
    !bucket ||
    bucket.public !== false ||
    Number(bucket.file_size_limit) !== MAX_BYTES ||
    !Array.isArray(bucket.allowed_mime_types) ||
    bucket.allowed_mime_types.length !== 4 ||
    !Object.values(MIME).every((mime) => bucket.allowed_mime_types.includes(mime))
  )
    throw new Error('Bill-document bucket is missing or its private/size/type settings changed.');
}
function checkObject(row) {
  const parts = PATH.exec(row.path);
  if (
    !parts ||
    !Number.isSafeInteger(row.size) ||
    row.size <= 0 ||
    row.size > MAX_BYTES ||
    row.mime !== MIME[parts[5]] ||
    typeof row.id !== 'string' ||
    !row.id ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    !Number.isFinite(Date.parse(row.createdAt))
  )
    throw new Error('Unsupported bill-document inventory row. Backup refused.');
  return parts;
}
function orderedRefs(refs) {
  return [...refs].sort((a, b) => a.id.localeCompare(b.id));
}
export function validateInventory(inventory) {
  if (!Array.isArray(inventory.objects) || !Array.isArray(inventory.references))
    throw new Error('Document inventory is incomplete.');
  if (inventory.bucket) checkBucket(inventory.bucket);
  else if (inventory.objects.length || inventory.references.length)
    throw new Error('Bill references exist without their private bucket.');
  const objects = new Map();
  for (const row of inventory.objects) {
    checkObject(row);
    if (objects.has(row.path)) throw new Error('Duplicate document path in inventory.');
    objects.set(row.path, row);
  }
  const ids = new Set();
  for (const ref of inventory.references) {
    const parts = PATH.exec(ref.path);
    if (
      !parts ||
      !objects.has(ref.path) ||
      !ref.id ||
      ids.has(ref.id) ||
      ref.tenantId !== parts[1] ||
      ref.shopId !== parts[2] ||
      ref.clientId !== parts[3]
    )
      throw new Error('A purchase document is missing or bound to the wrong tenant/shop/request.');
    ids.add(ref.id);
  }
}
export function retentionReport(objects, references, now) {
  const used = new Set(references.map((r) => r.path));
  return objects
    .filter((row) => !used.has(row.path))
    .map((row) => ({
      path: row.path,
      size: row.size,
      ageDays: Math.max(0, Math.floor((now - Date.parse(row.createdAt)) / 86400000)),
      disposition: 'retained; an unfinished device draft may still reference this upload',
    }));
}
export async function readInventory(db) {
  const bucket =
    (
      await db.query(
        `select public,file_size_limit,allowed_mime_types from storage.buckets where id=$1`,
        [BUCKET],
      )
    ).rows[0] ?? null;
  const objects = (
    await db.query(
      `select id::text,name as path,metadata->>'mimetype' as mime,
    metadata->>'size' as size,created_at::text as "createdAt",updated_at::text as "updatedAt"
    from storage.objects where bucket_id=$1 order by name`,
      [BUCKET],
    )
  ).rows.map((row) => ({ ...row, size: Number(row.size) }));
  // Do not filter status/deleted_at: original bills still own their original documents.
  const references = (
    await db.query(`select id::text,tenant_id::text as "tenantId",shop_id::text as "shopId",
    client_id as "clientId",bill_image_path as path from public.purchase_bills
    where bill_image_path is not null order by id`)
  ).rows;
  return { bucket, objects, references };
}
export async function financialSummary(db) {
  return (
    await db.query(`select json_build_object(
    'scope','public','authArtifact','separate','invariants','separately-checked',
    'sale_count',(select count(*) from sale_invoices),'sale_total',(select coalesce(sum(total_paise),0)::text from sale_invoices where status='FINALIZED'),
    'payment_count',(select count(*) from payments),'payment_total',(select coalesce(sum(amount_paise),0)::text from payments where status='POSTED'),
    'purchase_count',(select count(*) from purchase_bills),'purchase_total',(select coalesce(sum(total_paise),0)::text from purchase_bills where status='POSTED'),
    'stock_movement_count',(select count(*) from stock_movements),
    'expense_count',(select count(*) from expenses),'expense_total',(select coalesce(sum(amount_paise),0)::text from expenses where status='POSTED')
  ) as summary`)
  ).rows[0].summary;
}
function headers(key) {
  if (!key) throw new Error('Server-only document-download credentials are required.');
  return { apikey: key, Authorization: `Bearer ${key}` };
}
function objectUrl(base, path) {
  if (!PATH.test(path)) throw new Error('Invalid document path.');
  return `${origin(base)}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
export async function download(base, key, row, request = globalThis.fetch) {
  const response = await request(objectUrl(base, row.path), {
    headers: headers(key),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Private document download failed (HTTP ${response.status}).`);
  if (response.headers.get('content-type')?.split(';')[0].trim() !== row.mime)
    throw new Error('Private document MIME type changed.');
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== row.size)
    throw new Error('Private document size changed.');
  if (!response.body) throw new Error('Private document download is empty.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > row.size || size > MAX_BYTES)
      throw new Error('Private document download exceeds its recorded size.');
    chunks.push(Buffer.from(chunk));
  }
  if (size !== row.size) throw new Error('Private document download is incomplete.');
  return Buffer.concat(chunks);
}
async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error('Backup files must be regular files; links are refused.');
  return stat;
}
export async function capture({
  db,
  source,
  key,
  directory,
  publicDump,
  dump,
  freshInventory,
  request,
  now = new Date(),
}) {
  directory = resolve(directory);
  publicDump = resolve(publicDump);
  await mkdir(directory, { mode: 0o700 }); // Refuse to overwrite an old/partial archive.
  let begun = false;
  try {
    await mkdir(join(directory, 'objects'), { mode: 0o700 });
    await db.query('begin isolation level repeatable read read only');
    begun = true;
    const inventory = await readInventory(db);
    validateInventory(inventory);
    const sourceOrigin = inventory.bucket ? origin(source) : null;
    if (inventory.objects.length) headers(key);
    const summary = await financialSummary(db);
    const exported = (
      await db.query(
        'select pg_export_snapshot() as snapshot, transaction_timestamp()::text as captured_at',
      )
    ).rows[0];
    const snapshot = exported.snapshot;
    const capturedAt = exported.captured_at ? new Date(exported.captured_at) : now;
    await dump(snapshot, publicDump);
    await regularFile(publicDump);
    const publicDumpSha256 = sha256(await readFile(publicDump));
    await db.query('commit');
    begun = false;
    // The dump and inventory are fixed. Do not pin vacuum during downloads;
    // immutable originals and the fresh version check detect replacement/removal.
    const objects = [];
    for (const row of inventory.objects) {
      const bytes = await download(sourceOrigin, key, row, request);
      const digest = sha256(bytes);
      await writeFile(join(directory, 'objects', `${digest}.bin`), bytes, {
        mode: 0o600,
        flag: 'wx',
      }).catch(async (error) => {
        if (
          error.code !== 'EEXIST' ||
          sha256(await readFile(join(directory, 'objects', `${digest}.bin`))) !== digest
        )
          throw error;
      });
      objects.push({ ...row, sha256: digest });
    }
    const fresh = await freshInventory();
    const current = new Map(fresh.objects.map((row) => [row.path, row]));
    if (inventory.bucket) checkBucket(fresh.bucket);
    for (const original of inventory.objects) {
      if (JSON.stringify(current.get(original.path)) !== JSON.stringify(original))
        throw new Error('A source document changed during backup. Retry the complete snapshot.');
    }
    const manifest = {
      version: 1,
      bucket: BUCKET,
      installed: Boolean(inventory.bucket),
      sourceOrigin,
      capturedAt: capturedAt.toISOString(),
      publicDumpSha256,
      summary,
      objects,
      references: orderedRefs(inventory.references),
      unusedUploads: retentionReport(objects, inventory.references, capturedAt.getTime()),
    };
    // A partial download never gets a completion manifest.
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    return manifest;
  } catch (error) {
    if (begun) await db.query('rollback').catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function verify(directory, publicDump) {
  directory = resolve(directory);
  if (
    !(await lstat(directory)).isDirectory() ||
    !(await lstat(join(directory, 'objects'))).isDirectory()
  )
    throw new Error('Backup directories must be real directories; links are refused.');
  await regularFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (
    manifest.version !== 1 ||
    manifest.bucket !== BUCKET ||
    typeof manifest.installed !== 'boolean' ||
    !Number.isFinite(Date.parse(manifest.capturedAt)) ||
    !/^[a-f0-9]{64}$/.test(manifest.publicDumpSha256)
  )
    throw new Error('Unsupported/incomplete document backup manifest.');
  if (manifest.installed) origin(manifest.sourceOrigin);
  validateInventory({
    ...manifest,
    bucket: manifest.installed
      ? {
          public: false,
          file_size_limit: MAX_BYTES,
          allowed_mime_types: Object.values(MIME),
        }
      : null,
  });
  await regularFile(publicDump);
  if (sha256(await readFile(publicDump)) !== manifest.publicDumpSha256)
    throw new Error('This document archive belongs to a different public dump.');
  for (const row of manifest.objects) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid document digest.');
    const path = join(directory, 'objects', `${row.sha256}.bin`);
    if ((await regularFile(path)).size !== row.size || sha256(await readFile(path)) !== row.sha256)
      throw new Error('Document archive bytes are missing, truncated or changed.');
  }
  return manifest;
}
export async function restoreLocal({
  directory,
  publicDump,
  target,
  key,
  db,
  disposable,
  request = globalThis.fetch,
}) {
  const base = origin(target);
  if (
    disposable !== true ||
    !loopback(new URL(base).hostname) ||
    !loopback(db?.connectionParameters?.host)
  )
    throw new Error('Restore requires an explicitly acknowledged loopback disposable target.');
  const manifest = await verify(directory, publicDump); // All bytes before any target write.
  if (manifest.objects.length) headers(key);
  if (manifest.sourceOrigin && endpoint(manifest.sourceOrigin) === endpoint(base))
    throw new Error('Restoring into the source endpoint is refused.');
  const targetInventory = await readInventory(db);
  if (manifest.installed) checkBucket(targetInventory.bucket);
  if (
    JSON.stringify(orderedRefs(targetInventory.references)) !== JSON.stringify(manifest.references)
  )
    throw new Error('Target purchase references do not match the paired financial snapshot.');
  if (manifest.installed) {
    // Public-schema restore drops policies dependent on its permission helpers.
    // Rebuild only file RLS on the acknowledged local target; never rewrite money RPCs.
    await db.query('begin');
    try {
      await db.query(
        await readFile(new URL('./restore-bill-document-policies.sql', import.meta.url), 'utf8'),
      );
      await db.query('commit');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  }
  for (const row of manifest.objects) {
    const bytes = await readFile(join(resolve(directory), 'objects', `${row.sha256}.bin`));
    let response;
    try {
      response = await request(objectUrl(base, row.path), {
        method: 'POST',
        headers: { ...headers(key), 'Content-Type': row.mime, 'x-upsert': 'false' },
        body: bytes,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      /* A lost upload answer must still be reconciled by identical bytes. */
    }
    // Also verify successful writes; metadata alone is not a restore proof.
    let stored;
    try {
      stored = await download(base, key, row, request);
    } catch {
      throw new Error(
        `Document restore is unconfirmed${response ? ` (HTTP ${response.status})` : ''}. Retry without overwriting.`,
      );
    }
    if (sha256(stored) !== row.sha256)
      throw new Error('Target original has different bytes. It was not overwritten.');
  }
  return {
    objectsVerified: manifest.objects.length,
    referencesVerified: manifest.references.length,
  };
}
