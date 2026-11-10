// Persistence backend tests: fallback ordering, localStorage rollback on quota
// errors, and IndexedDB connection recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openDb, MemoryBackend, __test } from '../js/store/db.js';

function installLocalStorage(failOnCall = Infinity) {
  const map = new Map();
  let writes = 0;
  const storage = {
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      writes += 1;
      if (writes >= failOnCall) {
        const error = new Error('QuotaExceededError: storage full');
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(key, String(value));
    },
    removeItem: key => { map.delete(key); },
    clear: () => map.clear()
  };
  globalThis.localStorage = storage;
  return storage;
}

test('openDb prefers IndexedDB when available', async () => {
  const db = await openDb(true);
  assert.equal(db.name, 'indexeddb');
  await db.kvSet('probe', { ok: true });
  assert.deepEqual(await db.kvGet('probe'), { ok: true });
});

test('openDb falls back to localStorage when IndexedDB is unavailable', async () => {
  const saved = globalThis.indexedDB;
  // A broken object that cannot open must not crash the store.
  __test.IdbBackend._db = null;
  __test.IdbBackend._opening = null;
  globalThis.indexedDB = { open() { throw new Error('blocked'); } };
  const storage = installLocalStorage();
  try {
    const db = await openDb(true);
    assert.equal(db.name, 'localstorage');
    await db.kvSet('alpha', [1, 2, 3]);
    assert.deepEqual(await db.kvGet('alpha'), [1, 2, 3]);
    assert.ok(storage.getItem('brain:v2:alpha'));
  } finally {
    globalThis.indexedDB = saved;
  }
});

test('localStorage multi-key write rolls back when quota is exceeded mid-write', async () => {
  const storage = installLocalStorage();
  const db = await openDb(false);
  await db.kvSet('first', { version: 1 });
  assert.deepEqual(await db.kvGet('first'), { version: 1 });

  // Fail when the second key is written: the first key must be restored.
  const original = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === 'brain:v2:second') {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    original(key, value);
  };
  await assert.rejects(db.kvSetMany([['first', { version: 2 }], ['second', { version: 2 }]]), /Quota/);
  assert.deepEqual(await db.kvGet('first'), { version: 1 }, 'previous value restored');
  assert.equal(await db.kvGet('second'), undefined, 'second key never persisted');
});

test('memory backend is the last resort', async () => {
  const savedIdb = globalThis.indexedDB;
  const savedLs = globalThis.localStorage;
  globalThis.indexedDB = undefined;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); }, key() { return null; }, length: 0 };
  try {
    const db = await openDb(true);
    assert.equal(db.name, 'memory');
    await db.kvSet('k', 'v');
    assert.equal(await db.kvGet('k'), 'v');
  } finally {
    globalThis.indexedDB = savedIdb;
    globalThis.localStorage = savedLs;
    MemoryBackend._m = {};
  }
});

test('a closed IndexedDB connection is reopened transparently', async () => {
  const db = await openDb(true);
  await db.kvSet('durable', { ok: 1 });
  // Simulate the browser closing the connection (version upgrade in another tab).
  db._db.close();
  const value = await db.kvGet('durable');
  assert.deepEqual(value, { ok: 1 });
  await db.kvSet('after-reopen', true);
  assert.equal(await db.kvGet('after-reopen'), true);
});

test('connection-loss errors are classified, application errors are not', () => {
  const closed = Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' });
  assert.equal(__test.isClosedConnectionError(closed), true);
  const quota = Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
  assert.equal(__test.isClosedConnectionError(quota), false);
});
