// DB abstraction. Uses IndexedDB when available (fast, durable, async), and
// transparently falls back to localStorage when IndexedDB is blocked/unavailable
// (e.g. some sandboxed contexts / older setups). Both expose the same promise API.
//
// Backend B is a single key/value object store; keys include 'task','reminder',...
// 'settings','schema','meta' etc. Each value is a JSON blob. Writes are whole-key
// so a crash cannot leave a half-written record.

import { DB_NAME, DB_VERSION } from '../util/constants.js';

const PREFIX = 'brain:v2:';

function idbAvailable() {
  try { return typeof indexedDB !== 'undefined' && !!indexedDB.open; } catch { return false; }
}
function lsAvailable() {
  try { localStorage.setItem('__brain_t','1'); localStorage.removeItem('__brain_t'); return true; } catch { return false; }
}

const IdbBackend = {
  name: 'indexeddb',
  _db: null,
  async init() {
    if (this._db) return this;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => { this._db = req.result; resolve(this); };
      req.onerror = () => reject(new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  },
  _tx(mode) {
    const tx = this._db.transaction('kv', mode);
    return tx.objectStore('kv');
  },
  kvGet(key) { return new Promise((res, rej) => { try { const r = this._tx('readonly').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
  kvSet(key, val) { return new Promise((res, rej) => { try { const r = this._tx('readwrite').put(val, key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
  kvDel(key) { return new Promise((res, rej) => { try { const r = this._tx('readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
  async listKeys() {
    return new Promise((res, rej) => { try { const r = this._tx('readonly').openCursor(); const keys = []; r.onsuccess = () => { const c = r.result; if (c) { keys.push(c.key); c.continue(); } else res(keys); }; r.onerror = () => rej(r.error); } catch (e) { rej(e); } });
  },
  async clearAll() { const keys = await this.listKeys(); for (const k of keys) await this.kvDel(k); },
  async destroy() { if (this._db) { this._db.close(); this._db = null; } try { indexedDB.deleteDatabase(DB_NAME); } catch {} }
};

const LsBackend = {
  name: 'localstorage',
  async init() { return this; },
  kvGet(key) { try { const v = localStorage.getItem(PREFIX + key); return Promise.resolve(v == null ? undefined : JSON.parse(v)); } catch { return Promise.resolve(undefined); } },
  kvSet(key, val) { try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); return Promise.resolve(); } catch (e) { return Promise.reject(e); } },
  kvDel(key) { try { localStorage.removeItem(PREFIX + key); return Promise.resolve(); } catch { return Promise.resolve(); } },
  async listKeys() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length)); } } catch {} return out; },
  async clearAll() { const keys = await this.listKeys(); for (const k of keys) try { localStorage.removeItem(PREFIX + k); } catch {} },
  async destroy() { await this.clearAll(); }
};

export const MemoryBackend = {
  name: 'memory', _m: {},
  async init() { return this; },
  kvGet(key) { return Promise.resolve(this._m[key]); },
  kvSet(key, val) { this._m[key] = val; return Promise.resolve(); },
  kvDel(key) { delete this._m[key]; return Promise.resolve(); },
  async listKeys() { return Object.keys(this._m); },
  async clearAll() { this._m = {}; },
  async destroy() { this._m = {}; }
};

export async function openDb(preferIdb = true) {
  let backend = null;
  if (preferIdb && idbAvailable()) {
    try { backend = await IdbBackend.init(); }
    catch { backend = null; }
  }
  if (!backend && lsAvailable()) backend = await LsBackend.init();
  if (!backend) backend = MemoryBackend;
  return backend;
}
