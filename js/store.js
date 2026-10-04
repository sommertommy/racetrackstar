// IndexedDB-lag: biler, løbstyper og løbshistorik gemmes lokalt på enheden.
const DB_NAME = 'racetrackstar';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cars')) db.createObjectStore('cars', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('types')) db.createObjectStore('types', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('races')) db.createObjectStore('races', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const out = fn(store);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function getAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName).objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export const put = (storeName, obj) => tx(storeName, 'readwrite', s => s.put(obj));
export const del = (storeName, id) => tx(storeName, 'readwrite', s => s.delete(id));

// Nedskalerer et foto til max 640 px og returnerer en JPEG-blob til lagring.
export async function shrinkPhoto(file, maxSize = 640) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
    return blob || file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Sår to standard-løbstyper første gang appen åbnes.
export async function seedDefaults() {
  const types = await getAll('types');
  if (types.length > 0) return;
  const defaults = [
    { id: uid(), name: 'Sprint · 10 omgange', mode: 'laps', laps: 10, minutes: 5, minLapSec: 4, trailSec: 3, flying: true, tracking: 'camera', createdAt: Date.now() },
    { id: uid(), name: '5 minutters heat', mode: 'time', laps: 10, minutes: 5, minLapSec: 4, trailSec: 3, flying: true, tracking: 'camera', createdAt: Date.now() + 1 },
  ];
  for (const t of defaults) await put('types', t);
}
