// Store — in-memory snapshot + write-through persistence.
// Collections live in memory for instant queries; each collection is persisted
// as one JSON blob in the DB (atomic per collection). All writes are sanitized
// through validate.js so nothing untrusted ever reaches the store.

import { openDb } from './db.js';
import * as V from './validate.js';
import { clone, nowISO } from '../util/util.js';
import { SCHEMA_VERSION } from '../util/constants.js';
import { readLegacy } from './migrate.js';

const KEY_SETTINGS = 'settings';
const KEY_SCHEMA = 'schema';

const defaultSettings = () => ({
  name: '', currency: '₹', locale: 'en-IN', notifEnabled: true,
  reducedMotion: false, onboarded: false
});

export class Store {
  constructor() {
    this.db = null;
    this.schema = 0;
    this.collections = V.emptyCollections();
    this.settings = defaultSettings();
    this.ready = false;
  }

  async init() {
    this.db = await openDb(true);
    // schema
    const schema = await this.db.kvGet(KEY_SCHEMA);
    this.schema = schema && schema.version ? schema.version : 0;
    // settings
    const settings = await this.db.kvGet(KEY_SETTINGS);
    this.settings = Object.assign(defaultSettings(), settings || {});
    // collections
    for (const c of V.COLLECTIONS) {
      const raw = await this.db.kvGet(c);
      this.collections[c] = Array.isArray(raw) ? this._sanitizeAll(c, raw) : [];
    }
    // Brand-new store? Offer to lift any legacy (v1 localStorage) data over,
    // so an upgrade never orphans what the user already entered.
    if (this.schema === 0) {
      const legacy = readLegacy();
      if (legacy) {
        for (const c of V.COLLECTIONS) {
          const migrated = this._sanitizeAll(c, legacy.collections[c] || []);
          if (migrated.length) this.collections[c] = migrated;
        }
        this.settings = Object.assign(defaultSettings(), this.settings, legacy.settings);
        try { this.db.clearAll(); } catch (e) {} // new schema owns the keys now
        // The legacy blob may live outside the current backend; remove it too.
        try { (globalThis.localStorage || {}).removeItem('brain.state.v1'); } catch (e) {}
      }
      this.schema = SCHEMA_VERSION;
      await this._persistSchema();
      await Promise.all(V.COLLECTIONS.map(c => this._saveCol(c)));
      await this._saveSettings();
    }
    this.ready = true;
    return this;
  }

  _sanitizeAll(type, arr) {
    const out = [];
    for (const r of arr) { const s = V.sanitizeRecord(type, r); if (s) out.push(s); }
    return out;
  }

  async _persistSchema() { if (this.db) await this.db.kvSet(KEY_SCHEMA, { version: this.schema }); }

  async _saveCol(type) { if (this.db) await this.db.kvSet(type, this.collections[type]); }
  async _saveSettings() { if (this.db) await this.db.kvSet(KEY_SETTINGS, this.settings); }

  // ---- reads ----
  list(type) { return this.collections[type] || []; }

  /** Global query helper used by search and "everything about X". */
  allOpen() {
    const out = {};
    for (const c of V.COLLECTIONS) out[c] = this.list(c);
    return out;
  }

  // ---- writes ----
  async add(type, obj) {
    const rec = V.sanitizeRecord(type, obj);
    if (!rec) return null;
    this.collections[type].push(rec);
    await this._saveCol(type);
    return rec;
  }

  async update(type, id, patch) {
    const col = this.collections[type];
    const i = col.findIndex(r => r.id === id);
    if (i < 0) return null;
    const merged = Object.assign({}, col[i], patch, { id: col[i].id, type: col[i].type, updatedAt: nowISO() });
    col[i] = V.sanitizeRecord(type, merged);
    await this._saveCol(type);
    return col[i];
  }

  async remove(type, id) {
    const col = this.collections[type];
    const i = col.findIndex(r => r.id === id);
    if (i < 0) return null;
    const [removed] = col.splice(i, 1);
    await this._saveCol(type);
    return removed;
  }

  async replaceAll(collections, settings) {
    for (const c of V.COLLECTIONS) this.collections[c] = this._sanitizeAll(c, collections[c] || []);
    if (settings) this.settings = Object.assign(defaultSettings(), settings);
    this.schema = SCHEMA_VERSION;
    const writes = V.COLLECTIONS.map(c => this._saveCol(c));
    await Promise.all(writes);
    await this._saveSettings();
    await this._persistSchema();
  }

  // ---- synchronous in-memory ops with debounced write-behind (for snappy UI) ----
  addSync(type, obj) {
    const rec = V.sanitizeRecord(type, obj);
    if (!rec) return null;
    this.collections[type].push(rec);
    this._dirty(type);
    return rec;
  }
  updateSync(type, id, patch) {
    const col = this.collections[type];
    const i = col.findIndex(r => r.id === id);
    if (i < 0) return null;
    const merged = Object.assign({}, col[i], patch, { id: col[i].id, type: col[i].type, createdAt: col[i].createdAt, updatedAt: nowISO() });
    col[i] = V.sanitizeRecord(type, merged);
    this._dirty(type);
    return col[i];
  }
  removeSync(type, id) {
    const col = this.collections[type];
    const i = col.findIndex(r => r.id === id);
    if (i < 0) return null;
    const [removed] = col.splice(i, 1);
    this._dirty(type);
    return removed;
  }
  _dirty(type) {
    if (!this._dirtySet) this._dirtySet = new Set();
    this._dirtySet.add(type);
    this._scheduleFlush();
  }
  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(async () => {
      this._flushTimer = null;
      await this.flush();
    }, 120);
  }
  async flush() {
    if (!this._dirtySet || this._dirtySet.size === 0) return;
    const types = [...this._dirtySet];
    this._dirtySet.clear();
    for (const t of types) { try { await this._saveCol(t); } catch (e) { this._dirtySet.add(t); } }
  }

  async updateSettings(patch) {
    this.settings = Object.assign(this.settings, patch);
    await this._saveSettings();
    return this.settings;
  }

  /** Export full state for backup. */
  async exportState() {
    return {
      app: 'brain', schema: SCHEMA_VERSION, exportedAt: nowISO(),
      settings: clone(this.settings), collections: clone(this.collections),
      meta: { counts: this.counts() }
    };
  }

  counts() {
    const c = {};
    for (const k of V.COLLECTIONS) c[k] = this.collections[k].length;
    return c;
  }

  async wipe() {
    for (const c of V.COLLECTIONS) this.collections[c] = [];
    this.settings = defaultSettings();
    this.schema = SCHEMA_VERSION;
    await Promise.all(V.COLLECTIONS.map(c => this._saveCol(c)));
    await this._saveSettings();
    await this._persistSchema();
  }
}

/** Validate + preview an imported JSON document without applying it. */
export function previewImport(raw) {
  let parsed;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { throw new Error('not-a-backup'); } }
  else parsed = raw;
  const parse = parsed;
  const isBrain = parse && parse.app === 'brain' && parse.collections && typeof parse.collections === 'object';
  if (!isBrain) throw new Error('not-a-backup');
  const schema = +parse.schema || SCHEMA_VERSION;
  const counts = {};
  const errors = [];
  for (const c of V.COLLECTIONS) {
    const arr = Array.isArray(parse.collections[c]) ? parse.collections[c] : [];
    let ok = 0;
    for (const r of arr) { const s = V.sanitizeRecord(c, r); if (s && (s.id)) ok++; else errors.push(c); }
    counts[c] = ok;
  }
  return { ok: true, schema, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), fromSchema: schema, errors: [...new Set(errors)] };
}

export { V };
