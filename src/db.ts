// Kleine IndexedDB-Hülle. Alles bleibt lokal auf dem Gerät.

const DB_NAME = 'hausnummern-finder';
const DB_VERSION = 2;
export type StoreName = 'packages' | 'houseinfo' | 'points' | 'ustreets' | 'kv' | 'photos';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('packages')) db.createObjectStore('packages', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('houseinfo')) db.createObjectStore('houseinfo', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('points')) db.createObjectStore('points', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('ustreets')) db.createObjectStore('ustreets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      // Version 2: Fotos pro Haus (Schlüssel wie Haus-Infos)
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function getAll<T>(name: StoreName): Promise<T[]> {
  return wrap((await store(name, 'readonly')).getAll()) as Promise<T[]>;
}
export async function get<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return wrap((await store(name, 'readonly')).get(key)) as Promise<T | undefined>;
}
export async function put(name: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  await wrap((await store(name, 'readwrite')).put(value, key));
}
export async function del(name: StoreName, key: IDBValidKey): Promise<void> {
  await wrap((await store(name, 'readwrite')).delete(key));
}
export async function clear(name: StoreName): Promise<void> {
  await wrap((await store(name, 'readwrite')).clear());
}

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  return ((await get<T>('kv', key)) ?? fallback) as T;
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  await put('kv', value, key);
}
