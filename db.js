// Tiny IndexedDB wrapper. Screenshots live here (on your machine) until you reset.

const NAME = 'pagecapture';
const STORE = 'shots';
const META = 'meta';
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'idx', autoIncrement: true });
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
    };
    r.onsuccess = () => {
      r.result.onclose = () => { dbp = null; };
      resolve(r.result);
    };
    r.onerror = () => { dbp = null; reject(r.error); };
  });
  return dbp;
}

function run(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const putShot = shot => run(STORE, 'readwrite', s => s.add(shot));
export const deleteShot = idx => run(STORE, 'readwrite', s => s.delete(idx));
export const countShots = () => run(STORE, 'readonly', s => s.count());
export const listShots = () => run(STORE, 'readonly', s => s.getAll());
export const putMeta = (key, value) => run(META, 'readwrite', s => s.put(value, key));
export const getMeta = key => run(META, 'readonly', s => s.get(key));

export async function clearShots() {
  await run(STORE, 'readwrite', s => s.clear());
  await run(META, 'readwrite', s => s.clear());
}

export function getLastShot() {
  return db().then(d => new Promise((resolve, reject) => {
    const r = d.transaction(STORE).objectStore(STORE).openCursor(null, 'prev');
    r.onsuccess = () => resolve(r.result ? r.result.value : null);
    r.onerror = () => reject(r.error);
  }));
}
