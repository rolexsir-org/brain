// Small persistence abstraction. IndexedDB is preferred; localStorage is a
// fallback; memory is a last resort for restricted browser contexts. Values are
// plain snapshots, never executable code.

import { DB_NAME, DB_VERSION } from '../util/constants.js';

const PREFIX = 'brain:v2:';
const OPEN_TIMEOUT_MS = 4_000;

function idbAvailable() { try { return typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function'; } catch { return false; } }
function lsAvailable() {
  try { localStorage.setItem('__brain_probe__', '1'); localStorage.removeItem('__brain_probe__'); return true; } catch { return false; }
}

function isClosedConnectionError(error) {
  const name = error && error.name;
  const message = String((error && error.message) || '');
  return name === 'InvalidStateError' || name === 'TransactionInactiveError' || /database connection is closing|connection.*closed/i.test(message);
}

const IdbBackend = {
  name: 'indexeddb',
  _db: null,
  _opening: null,
  async init() {
    if (this._db) return this;
    // Concurrent callers share a single open request instead of leaking
    // duplicate connections (which can block a future schema upgrade).
    if (this._opening) return this._opening;
    this._opening = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('IndexedDB open timed out')), OPEN_TIMEOUT_MS);
      let request;
      try { request = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (error) { finish(reject, error); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab asking for a newer schema must be able to upgrade; close
        // this connection and let the next operation reopen it.
        db.onversionchange = () => {
          try { db.close(); } catch {}
          if (IdbBackend._db === db) IdbBackend._db = null;
        };
        db.onclose = () => { if (IdbBackend._db === db) IdbBackend._db = null; };
        IdbBackend._db = db;
        finish(resolve, IdbBackend);
      };
      request.onerror = () => finish(reject, request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => {
        // Do not hang forever behind an old tab: reject so the store can fall
        // back, but give the versionchange handshake a moment first.
        setTimeout(() => finish(reject, new Error('IndexedDB is blocked by another open tab')), OPEN_TIMEOUT_MS);
      };
    }).finally(() => { this._opening = null; });
    return this._opening;
  },
  async _ready() {
    if (!this._db) await this.init();
    if (!this._db) throw new Error('IndexedDB unavailable');
    return this._db;
  },
  _transaction(mode) { return this._db.transaction('kv', mode); },
  async _withRetry(operation) {
    await this._ready();
    try {
      return await operation();
    } catch (error) {
      if (!isClosedConnectionError(error)) throw error;
      // The browser closed the connection (for example after a version upgrade
      // in another tab). Reopen once and retry the same operation.
      try { this._db.close(); } catch {}
      this._db = null;
      await this._ready();
      return operation();
    }
  },
  kvGet(key) {
    return this._withRetry(() => new Promise((resolve, reject) => {
      try {
        const request = this._transaction('readonly').objectStore('kv').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
      } catch (error) { reject(error); }
    }));
  },
  kvSet(key, value) { return this.kvSetMany([[key, value]]); },
  kvSetMany(entries) {
    return this._withRetry(() => new Promise((resolve, reject) => {
      try {
        const transaction = this._transaction('readwrite');
        const store = transaction.objectStore('kv');
        for (const [key, value] of entries) store.put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
      } catch (error) { reject(error); }
    }));
  },
  kvDel(key) {
    return this._withRetry(() => new Promise((resolve, reject) => {
      try {
        const transaction = this._transaction('readwrite');
        transaction.objectStore('kv').delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB delete failed'));
      } catch (error) { reject(error); }
    }));
  },
  listKeys() {
    return this._withRetry(() => new Promise((resolve, reject) => {
      try {
        const request = this._transaction('readonly').objectStore('kv').openCursor();
        const keys = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { keys.push(cursor.key); cursor.continue(); }
          else resolve(keys);
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed'));
      } catch (error) { reject(error); }
    }));
  },
  async clearAll() {
    return this._withRetry(() => new Promise((resolve, reject) => {
      try {
        const transaction = this._transaction('readwrite');
        transaction.objectStore('kv').clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB clear failed'));
      } catch (error) { reject(error); }
    }));
  },
  async destroy() {
    if (this._db) { try { this._db.close(); } catch {} this._db = null; }
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
    // localStorage has no transaction. Serialize everything first, then restore
    // the previous values if a quota error interrupts the multi-key write, so a
    // failed save cannot leave a half-updated snapshot behind.
    const serialized = entries.map(([key, value]) => [PREFIX + key, JSON.stringify(value)]);
    const previous = new Map();
    const written = [];
    try {
      for (const [key, value] of serialized) {
        previous.set(key, localStorage.getItem(key));
        localStorage.setItem(key, value);
        written.push(key);
      }
    } catch (error) {
      // Restore only the keys this write already changed.
      for (const key of written) {
        try {
          const oldValue = previous.get(key);
          if (oldValue == null) localStorage.removeItem(key);
          else localStorage.setItem(key, oldValue);
        } catch { /* best effort rollback */ }
      }
      return Promise.reject(error);
    }
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

export const __test = { IdbBackend, LsBackend, isClosedConnectionError };
