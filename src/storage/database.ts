/** Thin promise wrapper over IndexedDB. All project data stays on this device. */
export const DB_NAME = 'zino3d';
export const DB_VERSION = 1;

export const STORES = {
  projects: 'projects',
  documents: 'documents',
  assets: 'assets',
} as const;

type Upgrade = (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void;

/** Schema migrations by target version. Add a new entry (and bump DB_VERSION) for schema changes. */
const upgrades: Record<number, Upgrade> = {
  1: (db) => {
    db.createObjectStore(STORES.projects, { keyPath: 'id' });
    db.createObjectStore(STORES.documents, { keyPath: 'key' }).createIndex('projectId', 'projectId');
    db.createObjectStore(STORES.assets, { keyPath: 'key' }).createIndex('projectId', 'projectId');
  },
};

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error ?? new Error('Transaction failed'));
  });
}

const connections = new Map<string, Promise<IDBDatabase>>();

export function openDatabase(name = DB_NAME): Promise<IDBDatabase> {
  const existing = connections.get(name);
  if (existing) return existing;
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser does not provide IndexedDB storage, so projects cannot be saved.'));
      return;
    }
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction!;
      for (let v = event.oldVersion + 1; v <= DB_VERSION; v++) upgrades[v]?.(db, event.oldVersion, tx);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        connections.delete(name);
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
    request.onblocked = () =>
      reject(new Error('Local storage is blocked by another open Zino3D tab. Close other tabs and retry.'));
  });
  connections.set(name, promise);
  promise.catch(() => connections.delete(name));
  return promise;
}

export async function closeDatabase(name = DB_NAME): Promise<void> {
  const p = connections.get(name);
  connections.delete(name);
  if (p) (await p).close();
}
