import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, previewImport } from '../js/store/store.js';
import { MemoryBackend } from '../js/store/db.js';

let store;
beforeEach(async () => {
  MemoryBackend._m = {};
  store = new Store();
  await store.init();
});
afterEach(async () => { try { await store.db.destroy(); } catch {} });

test('add/list/update/remove round trip', async () => {
  const t = await store.add('task', { title: 'Write tests' });
  assert.ok(t.id);
  assert.equal(store.list('task').length, 1);
  const u = await store.update('task', t.id, { status: 'done' });
  assert.equal(u.status, 'done');
  assert.equal(store.list('task').length, 1, 'update must not duplicate');
  const removed = await store.remove('task', t.id);
  assert.equal(removed.id, t.id);
  assert.equal(store.list('task').length, 0);
});

test('persistence across instances (same backend)', async () => {
  await store.add('note', { title: 'persist me', body: 'hello' });
  const s2 = new Store();
  await s2.init();
  assert.equal(s2.list('note').length, 1);
  assert.equal(s2.list('note')[0].title, 'persist me');
});

test('corrupt/primitive collection data does not crash loading', async () => {
  await store.db.kvSet('note', 'not-an-array');
  await store.db.kvSet('task', [{ title: 'ok' }, null, 42, 'junk']);
  const s2 = new Store();
  await s2.init();
  assert.ok(Array.isArray(s2.list('note')));
  assert.equal(s2.list('note').length, 0);
  // primitives are dropped, valid objects kept
  assert.ok(s2.list('task').some(t => t.title === 'ok'));
});

test('export / preview import / replaceAll', async () => {
  await store.add('task', { title: 'A' });
  await store.add('person', { name: 'John' });
  const snapshot = await store.exportState();
  assert.equal(snapshot.app, 'brain');
  const preview = previewImport(JSON.stringify(snapshot));
  assert.equal(preview.ok, true);
  assert.equal(preview.counts.task, 1);
  assert.equal(preview.counts.person, 1);
  // replace into a fresh store
  MemoryBackend._m = {};
  const fresh = new Store();
  await fresh.init();
  await fresh.replaceAll(snapshot.collections, snapshot.settings);
  assert.equal(fresh.list('task').length, 1);
  assert.equal(fresh.list('person').length, 1);
});

test('previewImport rejects non-backup / malformed', () => {
  assert.throws(() => previewImport('{bad'), /not-a-backup|JSON/);
  assert.throws(() => previewImport('{"hello":1}'), /not-a-backup/);
});

test('wipe clears everything', async () => {
  await store.add('task', { title: 'x' });
  await store.wipe();
  assert.equal(store.list('task').length, 0);
});
