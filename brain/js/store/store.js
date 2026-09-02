// Offline-first state store. Records are held in memory for responsive search,
// then serialized through a single write queue so a late write cannot overwrite
// a newer edit. Every input path goes through validate.js.

import { openDb } from './db.js';
import * as V from './validate.js';
import { clone, nowISO } from '../util/util.js';
import { SCHEMA_VERSION } from '../util/constants.js';
import { readLegacy } from './migrate.js';

const KEY_SETTINGS = 'settings';
const KEY_SCHEMA = 'schema';
const MAX_RECORDS_PER_COLLECTION = 10_000;
const MAX_BACKUP_CHARS = 25 * 1024 * 1024;

function defaultSettings() {
  return {
    name: '', currency: '₹', locale: 'en-IN', countryCode: '',
    notifEnabled: true, reducedMotion: false, onboarded: false,
    briefDate: '', lastBackupAt: ''
  };
}

function cleanSettings(raw = {}) {
  const base = defaultSettings();
  const input = raw && typeof raw === 'object' ? raw : {};
  const countryCode = String(input.countryCode || '').replace(/\D/g, '').slice(0, 3);
  return {
    ...base,
    name: V.cleanText(input.name, 100).trim(),
    currency: V.cleanText(input.currency, 10).trim() || base.currency,
    locale: V.cleanText(input.locale, 40).trim() || base.locale,
    countryCode,
    notifEnabled: input.notifEnabled !== false,
    reducedMotion: !!input.reducedMotion,
    onboarded: !!input.onboarded,
    briefDate: /^\d{4}-\d{2}-\d{2}$/.test(String(input.briefDate || '')) ? String(input.briefDate) : '',
    lastBackupAt: (() => { const d = new Date(input.lastBackupAt); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); })()
  };
}

function isCollection(type) { return V.COLLECTIONS.includes(type); }
function fingerprint(type, record) {
  const copy = { ...record };
  // IDs and write bookkeeping differ across devices and must not turn an
  // otherwise identical backup record into a duplicate on merge.
  delete copy.id; delete copy.createdAt; delete copy.updatedAt; delete copy.deletedAt;
  delete copy.nextTaskId; delete copy.nextAt; delete copy.lastFiredKey; delete copy.lastSnoozeKey; delete copy.acknowledgedAt; delete copy.settledAt;
  return `${type}:${stableJson(copy)}`;
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export class Store {
  constructor() {
    this.db = null;
    this.schema = 0;
    this.collections = V.emptyCollections();
    this.settings = defaultSettings();
    this.ready = false;
    this.lastPersistenceError = null;
    this._dirtySet = new Set();
    this._flushTimer = null;
    this._writeQueue = Promise.resolve();
    this._listeners = new Set();
  }

  onPersistenceError(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _reportPersistenceError(error) {
    this.lastPersistenceError = error instanceof Error ? error : new Error(String(error || 'Storage error'));
    for (const listener of this._listeners) {
      try { listener(this.lastPersistenceError); } catch {}
    }
  }

  _queueWrite(operation) {
    const run = this._writeQueue.catch(() => {}).then(operation);
    this._writeQueue = run.catch(error => { this._reportPersistenceError(error); });
    return run;
  }

  async init() {
    this.db = await openDb(true);
    const schema = await this.db.kvGet(KEY_SCHEMA);
    this.schema = schema && Number.isFinite(+schema.version) ? +schema.version : 0;
    this.settings = cleanSettings(await this.db.kvGet(KEY_SETTINGS));
    let repairedOnLoad = false;
    for (const collection of V.COLLECTIONS) {
      const raw = await this.db.kvGet(collection);
      const sanitized = Array.isArray(raw) ? this._sanitizeAll(collection, raw) : [];
      this.collections[collection] = sanitized;
      // Persist only structural repairs for a current schema. Normal field
      // normalization is harmless in memory; malformed/missing records should
      // not be re-read forever on every launch.
      if (raw != null && (!Array.isArray(raw) || sanitized.length !== raw.length)) repairedOnLoad = true;
    }

    // A new v2 schema may legitimately coexist with a legacy localStorage blob.
    // Do not clear the database here: the old implementation had an un-awaited
    // clear that could race its first save and lose migrated records.
    if (this.schema === 0) {
      const legacy = readLegacy();
      if (legacy) {
        for (const collection of V.COLLECTIONS) {
          const migrated = this._sanitizeAll(collection, legacy.collections[collection] || []);
          if (migrated.length && !this.collections[collection].length) this.collections[collection] = migrated;
        }
        this.settings = cleanSettings({ ...this.settings, ...legacy.settings });
        try { globalThis.localStorage && globalThis.localStorage.removeItem('brain.state.v1'); } catch {}
      }
      this.schema = SCHEMA_VERSION;
      this._repairReferences();
      await this._saveSnapshot();
    } else if (this.schema < SCHEMA_VERSION) {
      // Sanitizing on load is the migration for additive record fields. Persist
      // the upgraded snapshots together so the next launch does not repeat it.
      this.schema = SCHEMA_VERSION;
      this._repairReferences();
      await this._saveSnapshot();
    } else {
      // A journal attachment is meaningful only while its matching local photo
      // exists. Repair dangling imported/corrupt references before rendering.
      if (this._repairReferences()) repairedOnLoad = true;
      if (repairedOnLoad) await this._saveSnapshot();
    }
    this.ready = true;
    return this;
  }

  _sanitizeAll(type, values) {
    const output = [];
    const ids = new Set();
    for (const raw of Array.isArray(values) ? values.slice(0, MAX_RECORDS_PER_COLLECTION) : []) {
      const record = V.sanitizeRecord(type, raw);
      // A photo without a validated image payload is not a usable attachment.
      // Skip it rather than retaining a card that can never be opened/exported.
      if (!record || (type === 'photo' && !record.dataUrl) || ids.has(record.id)) continue;
      ids.add(record.id);
      output.push(record);
    }
    return output;
  }

  _repairReferences() {
    const photoIds = new Set(this.collections.photo.filter(photo => photo && photo.dataUrl).map(photo => photo.id));
    let changed = false;
    this.collections.journal = this.collections.journal.map(journal => {
      if (journal && journal.photoId && !photoIds.has(journal.photoId)) {
        changed = true;
        return { ...journal, photoId: null };
      }
      return journal;
    });
    return changed;
  }

  _saveCollection(type) {
    const snapshot = clone(this.collections[type] || []);
    return this._queueWrite(() => this.db.kvSet(type, snapshot));
  }

  _saveSettings() {
    const snapshot = clone(this.settings);
    return this._queueWrite(() => this.db.kvSet(KEY_SETTINGS, snapshot));
  }

  _saveSnapshot() {
    const entries = [
      ...V.COLLECTIONS.map(collection => [collection, clone(this.collections[collection])]),
      [KEY_SETTINGS, clone(this.settings)],
      [KEY_SCHEMA, { version: this.schema }]
    ];
    return this._queueWrite(() => this.db.kvSetMany(entries));
  }

  // ---------- reads ----------
  list(type) { return isCollection(type) ? this.collections[type] || [] : []; }
  get(type, id) { return this.list(type).find(record => record.id === id) || null; }
  allOpen() { return Object.fromEntries(V.COLLECTIONS.map(collection => [collection, this.list(collection)])); }
  counts() { return Object.fromEntries(V.COLLECTIONS.map(collection => [collection, this.list(collection).length])); }

  // ---------- durable async writes ----------
  async add(type, raw) {
    const record = this._newRecord(type, raw);
    if (!record) return null;
    this.collections[type] = [...this.collections[type], record];
    try {
      await this._saveCollection(type);
      return record;
    } catch (error) {
      // A later update may already have replaced this object. In that case,
      // leave the newer in-memory state alone instead of deleting it.
      this.collections[type] = this.collections[type].filter(item => item !== record);
      this._reportPersistenceError(error);
      return null;
    }
  }

  async update(type, id, patch) {
    const previous = this.get(type, id);
    if (!previous) return null;
    const record = this._updatedRecord(type, previous, patch);
    this.collections[type] = this.collections[type].map(item => item.id === id ? record : item);
    try {
      await this._saveCollection(type);
      return record;
    } catch (error) {
      // Do not let a late failed editor write roll back a newer in-memory
      // mutation (for example, a reminder scheduler update) made meanwhile.
      const index = this.collections[type].findIndex(item => item.id === id);
      if (index >= 0 && this.collections[type][index] === record) this.collections[type][index] = previous;
      this._reportPersistenceError(error);
      return null;
    }
  }

  async remove(type, id) {
    const record = this.get(type, id);
    if (!record) return null;
    const affected = type === 'photo' ? ['photo', 'journal'] : [type];
    const before = Object.fromEntries(affected.map(collection => [collection, this.collections[collection]]));
    this._removeInMemory(type, id);
    const after = Object.fromEntries(affected.map(collection => [collection, this.collections[collection]]));
    try {
      await this._saveAffected(type);
      return record;
    } catch (error) {
      // Restore an untouched collection wholesale. If another mutation replaced
      // its array while the write was pending, preserve that newer work and put
      // back only the record this failed delete removed.
      for (const collection of affected) {
        if (this.collections[collection] === after[collection]) {
          this.collections[collection] = before[collection];
          continue;
        }
        const prior = before[collection].find(item => item.id === id);
        if (prior && !this.collections[collection].some(item => item.id === id)) {
          const oldIndex = before[collection].findIndex(item => item.id === id);
          const next = [...this.collections[collection]];
          next.splice(Math.min(Math.max(0, oldIndex), next.length), 0, prior);
          this.collections[collection] = next;
        }
      }
      // A newer journal mutation can coexist with a failed photo deletion.
      // Restore only the attachment that the delete cleared; do not replace the
      // newer journal text, mood, or date.
      if (type === 'photo' && this.collections.journal !== before.journal) {
        const priorJournals = new Map(before.journal.map(journal => [journal.id, journal]));
        this.collections.journal = this.collections.journal.map(journal => {
          const prior = priorJournals.get(journal.id);
          return prior && prior.photoId === id && !journal.photoId ? { ...journal, photoId: id } : journal;
        });
      }
      this._reportPersistenceError(error);
      return null;
    }
  }

  // ---------- responsive write-behind operations ----------
  _newRecord(type, raw) {
    if (!isCollection(type) || this.list(type).length >= MAX_RECORDS_PER_COLLECTION) {
      this._reportPersistenceError(new Error('Collection limit reached'));
      return null;
    }
    const record = V.sanitizeRecord(type, raw);
    if (!record || this.get(type, record.id)) return null;
    return record;
  }

  _updatedRecord(type, previous, patch) {
    return V.sanitizeRecord(type, {
      ...previous,
      ...(patch && typeof patch === 'object' ? patch : {}),
      id: previous.id,
      type: previous.type,
      createdAt: previous.createdAt,
      updatedAt: nowISO()
    });
  }

  addSync(type, raw) {
    const record = this._newRecord(type, raw);
    if (!record) return null;
    this.collections[type] = [...this.collections[type], record];
    this._dirty(type);
    return record;
  }

  updateSync(type, id, patch) {
    const previous = this.get(type, id);
    if (!previous) return null;
    const record = this._updatedRecord(type, previous, patch);
    this.collections[type] = this.collections[type].map(item => item.id === id ? record : item);
    this._dirty(type);
    return record;
  }

  _removeInMemory(type, id) {
    const removed = this.get(type, id);
    if (!removed) return null;
    this.collections[type] = this.collections[type].filter(item => item.id !== id);
    // A removed photo must not leave a broken journal attachment behind.
    if (type === 'photo') {
      this.collections.journal = this.collections.journal.map(journal => (
        journal.photoId === id ? this._updatedRecord('journal', journal, { photoId: null }) : journal
      ));
      this._dirtySet.add('journal');
    }
    return removed;
  }

  removeSync(type, id) {
    if (!isCollection(type)) return null;
    const removed = this._removeInMemory(type, id);
    if (!removed) return null;
    this._dirty(type);
    return removed;
  }

  _dirty(type) {
    if (!isCollection(type)) return;
    this._dirtySet.add(type);
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch(error => this._reportPersistenceError(error));
    }, 120);
  }

  async _saveAffected(type) {
    const affected = type === 'photo' ? ['photo', 'journal'] : [type];
    const entries = affected.map(collection => [collection, clone(this.collections[collection])]);
    return this._queueWrite(() => this.db.kvSetMany(entries));
  }

  async flush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    let failure = null;
    // New mutations may land while awaiting a write; drain a bounded number of
    // passes so export/restore captures the current state without spinning.
    for (let pass = 0; pass < 5 && this._dirtySet.size; pass += 1) {
      const types = [...this._dirtySet];
      this._dirtySet.clear();
      try {
        const entries = types.map(type => [type, clone(this.collections[type])]);
        await this._queueWrite(() => this.db.kvSetMany(entries));
      } catch (error) {
        for (const type of types) this._dirtySet.add(type);
        failure = error;
        this._reportPersistenceError(error);
        break;
      }
    }
    return failure ? { ok: false, error: failure } : { ok: this._dirtySet.size === 0 };
  }

  async updateSettings(patch) {
    const previous = this.settings;
    const updated = cleanSettings({ ...this.settings, ...(patch && typeof patch === 'object' ? patch : {}) });
    this.settings = updated;
    try {
      await this._saveSettings();
      return updated;
    } catch (error) {
      // Avoid overwriting a newer settings save that completed meanwhile.
      if (this.settings === updated) this.settings = previous;
      this._reportPersistenceError(error);
      return null;
    }
  }

  async replaceAll(collections = {}, settings = undefined) {
    const beforeCollections = this.collections;
    const beforeSettings = this.settings;
    const beforeSchema = this.schema;
    const input = collections && typeof collections === 'object' ? collections : {};
    this.collections = Object.fromEntries(V.COLLECTIONS.map(collection => [collection, this._sanitizeAll(collection, input[collection] || [])]));
    this._repairReferences();
    if (settings !== undefined) this.settings = cleanSettings(settings);
    this.schema = SCHEMA_VERSION;
    this._dirtySet.clear();
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    try {
      await this._saveSnapshot();
      return { ok: true };
    } catch (error) {
      this.collections = beforeCollections;
      this.settings = beforeSettings;
      this.schema = beforeSchema;
      this._reportPersistenceError(error);
      return { ok: false, error };
    }
  }

  async mergeBackup(raw) {
    const parsed = parseBackup(raw);
    const incoming = Object.fromEntries(V.COLLECTIONS.map(collection => [collection, []]));
    const invalid = [];
    for (const collection of V.COLLECTIONS) {
      const seen = new Set();
      for (const item of Array.isArray(parsed.collections[collection]) ? parsed.collections[collection] : []) {
        // Backups must carry IDs; generating fresh ones would make selecting the
        // same backup twice duplicate records.
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) { invalid.push(collection); continue; }
        const record = V.sanitizeRecord(collection, item);
        if (!record || seen.has(record.id) || (collection === 'photo' && !record.dataUrl)) { invalid.push(collection); continue; }
        seen.add(record.id);
        incoming[collection].push(record);
      }
    }
    const next = clone(this.collections);
    let added = 0;
    let duplicates = 0;

    // Photos need special treatment before journals. A backup exported on a
    // second device can contain the same image under a different ID. When that
    // image is deduplicated, remap incoming journal.photoId to the local ID
    // instead of silently dropping the attachment during reference repair.
    const photoIdMap = new Map();
    const photoIds = new Set(next.photo.map(record => record.id));
    const photosByFingerprint = new Map(next.photo.map(record => [fingerprint('photo', record), record.id]));
    for (const incomingPhoto of incoming.photo) {
      const key = fingerprint('photo', incomingPhoto);
      const existingId = photoIds.has(incomingPhoto.id) ? incomingPhoto.id : photosByFingerprint.get(key);
      if (existingId) {
        photoIdMap.set(incomingPhoto.id, existingId);
        duplicates += 1;
        continue;
      }
      if (next.photo.length >= MAX_RECORDS_PER_COLLECTION) { invalid.push('photo'); continue; }
      next.photo.push(incomingPhoto);
      photoIds.add(incomingPhoto.id);
      photosByFingerprint.set(key, incomingPhoto.id);
      photoIdMap.set(incomingPhoto.id, incomingPhoto.id);
      added += 1;
    }

    for (const collection of V.COLLECTIONS) {
      if (collection === 'photo') continue;
      const ids = new Set(next[collection].map(record => record.id));
      const fingerprints = new Set(next[collection].map(record => fingerprint(collection, record)));
      for (const incomingRecord of incoming[collection]) {
        // Preserve an attachment to either a newly imported photo or an
        // equivalent existing one. An invalid/missing source photo is safely
        // represented as no attachment rather than as a dangling ID.
        const record = collection === 'journal' && incomingRecord.photoId
          ? {
            ...incomingRecord,
            photoId: photoIdMap.get(incomingRecord.photoId) || (photoIds.has(incomingRecord.photoId) ? incomingRecord.photoId : null)
          }
          : incomingRecord;
        const key = fingerprint(collection, record);
        if (ids.has(record.id) || fingerprints.has(key)) { duplicates += 1; continue; }
        if (next[collection].length >= MAX_RECORDS_PER_COLLECTION) { invalid.push(collection); continue; }
        next[collection].push(record); ids.add(record.id); fingerprints.add(key); added += 1;
      }
    }
    const result = await this.replaceAll(next, this.settings);
    if (!result.ok) return { ...result, added: 0, duplicates, invalid: [...new Set(invalid)] };
    return { ok: true, added, duplicates, invalid: [...new Set(invalid)] };
  }

  async exportState() {
    const flushed = await this.flush();
    if (!flushed.ok) throw new Error('Could not save the latest changes before backup');
    return {
      app: 'brain', schema: SCHEMA_VERSION, exportedAt: nowISO(),
      settings: clone(this.settings), collections: clone(this.collections),
      meta: { counts: this.counts() }
    };
  }

  async storageEstimate() {
    try {
      if (navigator.storage && typeof navigator.storage.estimate === 'function') return await navigator.storage.estimate();
    } catch {}
    return null;
  }

  async wipe() {
    return this.replaceAll(V.emptyCollections(), defaultSettings());
  }
}

function parseBackup(raw) {
  if (typeof raw === 'string') {
    if (raw.length > MAX_BACKUP_CHARS) throw new Error('backup-too-large');
    try { return JSON.parse(raw); } catch { throw new Error('not-a-backup'); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not-a-backup');
  return raw;
}

/** Validate and summarize a backup without changing state. */
export function previewImport(raw) {
  const parsed = parseBackup(raw);
  if (parsed.app !== 'brain' || !parsed.collections || typeof parsed.collections !== 'object' || Array.isArray(parsed.collections)) {
    throw new Error('not-a-backup');
  }
  const schema = Number(parsed.schema) || SCHEMA_VERSION;
  const counts = {};
  const errors = [];
  for (const collection of V.COLLECTIONS) {
    const records = Array.isArray(parsed.collections[collection]) ? parsed.collections[collection] : [];
    const seen = new Set();
    let valid = 0;
    for (const rawRecord of records) {
      if (!rawRecord || typeof rawRecord !== 'object' || typeof rawRecord.id !== 'string' || !rawRecord.id || seen.has(rawRecord.id)) { errors.push(collection); continue; }
      const record = V.sanitizeRecord(collection, rawRecord);
      if (!record || (collection === 'photo' && !record.dataUrl)) { errors.push(collection); continue; }
      seen.add(rawRecord.id); valid += 1;
    }
    counts[collection] = valid;
  }
  return {
    ok: true,
    schema,
    counts,
    total: Object.values(counts).reduce((total, value) => total + value, 0),
    fromSchema: schema,
    errors: [...new Set(errors)]
  };
}

export { V, defaultSettings, MAX_BACKUP_CHARS };
