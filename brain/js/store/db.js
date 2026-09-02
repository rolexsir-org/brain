// Small persistence abstraction. IndexedDB is preferred; localStorage is a
// fallback; memory is a last resort for restricted browser contexts. Values are
// plain snapshots, never executable code.

import { DB_NAME, DB_VERSION } from '../util/constants.js';

const PREFIX = 'brain:v2:';

function idbAvailable() { try { return typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function'; } catch { return false; } }
function lsAvailable() {
  try { localStorage.setItem('__brain_probe__', '1'); localStorage.removeItem('__brain_probe__'); return true; } catch { return false; }
}

const IdbBackend = {
  name: 'indexeddb',
  _db: null,
  async init() {
    if (this._db) return this;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
      };
      request.onsuccess = () => { this._db = request.result; resolve(this); };
      request.onerror = () => reject(new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB is blocked by another open tab'));
    });
  },
  transaction(mode) { return this._db.transaction('kv', mode); },
  kvGet(key) {
    return new Promise((resolve, reject) => {
      try {
        const request = this.transaction('readonly').objectStore('kv').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
      } catch (error) { reject(error); }
    });
  },
  kvSet(key, value) { return this.kvSetMany([[key, value]]); },
  kvSetMany(entries) {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.transaction('readwrite');
        const store = transaction.objectStore('kv');
        for (const [key, value] of entries) store.put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
      } catch (error) { reject(error); }
    });
  },
  kvDel(key) {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.transaction('readwrite');
        transaction.objectStore('kv').delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB delete failed'));
      } catch (error) { reject(error); }
    });
  },
  listKeys() {
    return new Promise((resolve, reject) => {
      try {
        const request = this.transaction('readonly').objectStore('kv').openCursor();
        const keys = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { keys.push(cursor.key); cursor.continue(); }
          else resolve(keys);
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed'));
      } catch (error) { reject(error); }
    });
  },
  async clearAll() {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.transaction('readwrite');
        transaction.objectStore('kv').clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB clear failed'));
      } catch (error) { reject(error); }
    });
  },
  async destroy() {
    if (this._db) { this._db.close(); this._db = null; }
    try { indexedDB.deleteDatabase(DB_NAME); } catch {}
  }
};

const LsBackend = {
  name: 'localstorage',
  async init() { return this; },
  kvGet(key) {
    try {
      const value = localStorage.getItem(PREFIX + key);
      return Promise.resolve(value == null ? undefined : JSON.parse(value));
    } catch { return Promise.resolve(undefined); }
  },
  kvSet(key, value) { return this.kvSetMany([[key, value]]); },
  async kvSetMany(entries) {
    // localStorage has no transaction. Serialize all values before writing so a
    // malformed value never leaves a partial JSON record behind.
    const serialized = entries.map(([key, value]) => [PREFIX + key, JSON.stringify(value)]);
    try {
      for (const [key, value] of serialized) localStorage.setItem(key, value);
    } catch (error) { return Promise.reject(error); }
  },
  kvDel(key) { try { localStorage.removeItem(PREFIX + key); return Promise.resolve(); } catch { return Promise.resolve(); } },
  async listKeys() {
    const keys = [];
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && key.startsWith(PREFIX)) keys.push(key.slice(PREFIX.length));
      }
    } catch {}
    return keys;
  },
  async clearAll() { for (const key of await this.listKeys()) await this.kvDel(key); },
  async destroy() { await this.clearAll(); }
};

export const MemoryBackend = {
  name: 'memory',
  _m: {},
  async init() { return this; },
  kvGet(key) { return Promise.resolve(this._m[key]); },
  kvSet(key, value) { this._m[key] = value; return Promise.resolve(); },
  async kvSetMany(entries) { for (const [key, value] of entries) this._m[key] = value; },
  kvDel(key) { delete this._m[key]; return Promise.resolve(); },
  async listKeys() { return Object.keys(this._m); },
  async clearAll() { this._m = {}; },
  async destroy() { this._m = {}; }
};

export async function openDb(preferIdb = true) {
  if (preferIdb && idbAvailable()) {
    try { return await IdbBackend.init(); } catch { /* fall through */ }
  }
  if (lsAvailable()) return LsBackend.init();
  return MemoryBackend.init();
}
