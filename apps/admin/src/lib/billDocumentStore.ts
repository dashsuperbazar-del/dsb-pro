// Binary draft attachments are kept out of localStorage. Each photo ID has immutable bytes;
// separate editor snapshots can share it without overwriting each other.
const database = 'dsb-pro-bill-documents-v1';
type Record = { key: string; bytes: ArrayBuffer; mime: string };
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    let abandoned = false;
    request.onupgradeneeded = () =>
      request.result.createObjectStore('documents', { keyPath: 'key' });
    request.onsuccess = () => {
      if (abandoned) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => {
      abandoned = true;
      reject(new Error('This device cannot open bill document storage.'));
    };
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('Close another old window to open document storage.'));
    };
  });
}
export async function documentBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('Document bytes cannot be read.'));
    reader.readAsArrayBuffer(blob);
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', mode);
    const request = run(tx.objectStore('documents'));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(new Error('This device could not keep the bill document. Free storage and retry.'));
    };
  });
}
export async function saveLocalDocument(scope: string, id: string, blob: Blob): Promise<void> {
  const key = scope + id;
  const row: Record = { key, bytes: await documentBytes(blob), mime: blob.type };
  await transaction('readwrite', (s) => s.add(row));
  const saved = await transaction<Record | undefined>('readonly', (s) => s.get(key));
  if (!saved || saved.bytes.byteLength !== row.bytes.byteLength || saved.mime !== row.mime)
    throw new Error('This device did not keep the bill document.');
}
export async function readLocalDocument(scope: string, id: string): Promise<Blob | null> {
  const row = await transaction<Record | undefined>('readonly', (s) => s.get(scope + id));
  return row ? new Blob([row.bytes], { type: row.mime }) : null;
}
export async function removeLocalDocument(scope: string, id: string): Promise<void> {
  await transaction('readwrite', (s) => s.delete(scope + id));
}
