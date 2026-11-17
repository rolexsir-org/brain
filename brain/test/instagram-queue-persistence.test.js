import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/store/store.js';
import { MemoryBackend } from '../js/store/db.js';
import { enqueue, getQueue, processQueue, setEmergencyStop } from '../js/instagram/queue.js';

let store;
beforeEach(async () => {
  MemoryBackend._m = {};
  setEmergencyStop(false);
  store = new Store();
  await store.init();
});
afterEach(async () => { await store.db.destroy(); });

async function readyDraft() {
  return store.add('instagramDraft', { videoName: 'reel.mp4', videoSize: 1000, status: 'READY' });
}

test('queue storage failures do not report a successful enqueue', async () => {
  const draft = await readyDraft();
  const write = store.db.kvSet;
  store.db.kvSet = async () => { throw new Error('quota exceeded'); };
  try {
    await assert.rejects(enqueue(store, draft.id), /quota/);
  } finally { store.db.kvSet = write; }
  assert.deepEqual(await getQueue(store), []);
  assert.notEqual(store.get('instagramDraft', draft.id).status, 'SCHEDULED');
});

test('queue read errors and malformed queue do not masquerade as empty', async () => {
  const read = store.db.kvGet;
  store.db.kvGet = async () => { throw new Error('storage unavailable'); };
  try { await assert.rejects(getQueue(store), /storage unavailable/); }
  finally { store.db.kvGet = read; }
  await store.db.kvSet('instagram:queue', { version: 1, entries: 'corrupt' });
  await assert.rejects(getQueue(store), /invalid/);
});

test('attempt is durably counted before a publishing callback and retry', async () => {
  const draft = await readyDraft();
  const result = await enqueue(store, draft.id, { scheduledAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(result.ok, true);
  let attemptsAtCall = 0;
  await processQueue(store, {}, { onPublish: async () => {
    attemptsAtCall = (await getQueue(store))[0].attempts;
    return { ok: false, error: 'network timeout' };
  } });
  assert.equal(attemptsAtCall, 1);
  const queue = await getQueue(store);
  assert.equal(queue[0].attempts, 1);
  assert.equal(queue[0].status, 'SCHEDULED');
});

test('failed attempt write prevents the external callback', async () => {
  const draft = await readyDraft();
  await enqueue(store, draft.id, { scheduledAt: new Date(Date.now() - 1000).toISOString() });
  const original = store.db.kvSet.bind(store.db);
  let writes = 0;
  store.db.kvSet = async (...args) => {
    if (args[0] === 'instagram:queue' && ++writes === 2) throw new Error('quota exceeded');
    return original(...args);
  };
  let called = false;
  try {
    await assert.rejects(processQueue(store, {}, { onPublish: async () => { called = true; } }), /quota/);
    assert.equal(called, false);
  } finally { store.db.kvSet = original; }
});

test('failed draft update removes the newly queued entry', async () => {
  const draft = await readyDraft();
  const original = store.db.kvSet.bind(store.db);
  store.db.kvSet = async (key, value) => {
    if (key === 'instagramDraft') throw new Error('quota exceeded');
    return original(key, value);
  };
  try {
    const result = await enqueue(store, draft.id);
    assert.equal(result.ok, false);
    assert.deepEqual(await getQueue(store), []);
    assert.equal(store.get('instagramDraft', draft.id).status, 'READY');
  } finally { store.db.kvSet = original; }
});
